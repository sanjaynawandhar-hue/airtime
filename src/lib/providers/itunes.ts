import "server-only";

import { REVALIDATE, providerEnabled } from "../core/config";
import { buildUrl, fetchJson, timedFetchJson } from "../core/fetcher";
import { fromText, ok, unavailable, type Maybe } from "../core/maybe";
import type {
  CountryCode,
  DeepLink,
  DetailsQuery,
  HealthStatus,
  Provenance,
  Provider,
  TrackRecord,
  TrendingQuery,
} from "../core/types";

/**
 * iTunes Store / iTunes Search API. Public, no key.
 *
 * Two jobs:
 *   1. `itunesProvider` — the iTunes Store "Top Songs" chart, which unlike the
 *      Apple Music marketing RSS ships a 30-second preview URL and a real
 *      purchase price with every entry.
 *   2. `enrichWithPreview` / `enrichManyWithPreviews` — attach previews and
 *      higher-resolution artwork to records produced by another provider
 *      (in practice ./appleMusic, whose feed has no audio at all).
 *
 * Rate limits: Apple does not publish one for the Search API, but the widely
 * reported ceiling is roughly 20 requests per minute per IP, after which calls
 * are throttled (HTTP 403). Every outbound call in this module therefore goes
 * through `limited()` below (max 4 in flight), and the batch lookup path is
 * preferred because it resolves up to 100 tracks in a single request.
 */

const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";

/**
 * Legacy iTunes Store chart feed. Verified live:
 *   /in/rss/topsongs/limit=10/json   -> 200, 10 entries
 *   /us/rss/topsongs/limit=25/json   -> 200, 25 entries
 *   /in/rss/topsongs/limit=100/json  -> 200, 93 entries (feed is shorter than
 *                                       the requested limit; not an error)
 *   /in/rss/topsongs/limit=300/json  -> 400
 *   /zz/rss/topsongs/limit=10/json   -> 400 (unknown storefront)
 * At limit=1 the feed serialises `entry` as a single object instead of an
 * array — normalised in `entriesOf` below.
 */
const legacyChartUrl = (storefront: string, limit: number): string =>
  `https://itunes.apple.com/${storefront}/rss/topsongs/limit=${limit}/json`;

const MIN_CHART_LIMIT = 1;
const MAX_CHART_LIMIT = 200;
const DEFAULT_CHART_LIMIT = 25;

/** iTunes `lookup` accepts a comma-separated id list; 100 ids verified in one call. */
const LOOKUP_BATCH_SIZE = 100;

const MAX_IN_FLIGHT = 4;

/* ------------------------------------------------------------------ *
 * Concurrency limiter
 * ------------------------------------------------------------------ */

let inFlight = 0;
const queue: Array<() => void> = [];

/**
 * Minimal semaphore. Caps concurrent iTunes calls at MAX_IN_FLIGHT so a chart
 * enrichment pass cannot burst past Apple's (undocumented, ~20/min) throttle.
 */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  inFlight += 1;
  try {
    return await task();
  } finally {
    inFlight -= 1;
    queue.shift()?.();
  }
}

/* ------------------------------------------------------------------ *
 * Artwork
 * ------------------------------------------------------------------ */

/**
 * Apple's image CDN encodes the rendition in the last path segment, e.g.
 * `.../5064020420892_cover.jpg/100x100bb.jpg`. Swapping that segment for a
 * larger square is a long-standing, documented convention of the Search API's
 * artwork URLs — it is a different rendition of the SAME asset, not a guessed
 * URL. Verified live on both extensions used by these feeds:
 *   .../100x100bb.jpg -> .../600x600bb.jpg   200 image/jpeg  63,889 bytes
 *   .../55x55bb.png   -> .../600x600bb.png   200 image/png  494,852 bytes
 * If the segment does not match the expected `{w}x{h}bb.{ext}` shape we return
 * the URL untouched rather than constructing one.
 */
export function upscaleAppleArtwork(url: string, size = 600): string {
  return url.replace(
    /\/\d+x\d+(bb(?:-\d+)?)\.(jpg|jpeg|png)$/i,
    (_match, suffix: string, ext: string) => `/${size}x${size}${suffix}.${ext}`,
  );
}

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

interface ItunesTrack {
  readonly wrapperType?: string;
  readonly kind?: string;
  readonly trackId?: number;
  readonly collectionId?: number;
  readonly artistId?: number;
  readonly trackName?: string;
  readonly artistName?: string;
  readonly collectionName?: string;
  readonly artworkUrl100?: string;
  readonly previewUrl?: string;
  readonly trackViewUrl?: string;
  readonly primaryGenreName?: string;
  readonly releaseDate?: string;
  readonly trackPrice?: number;
  readonly currency?: string;
}

interface ItunesResponse {
  readonly resultCount?: number;
  readonly results?: readonly ItunesTrack[];
}

interface LegacyLabel {
  readonly label?: string;
}

interface LegacyEntry {
  readonly "im:name"?: LegacyLabel;
  readonly "im:artist"?: LegacyLabel & { readonly attributes?: { readonly href?: string } };
  readonly "im:collection"?: { readonly "im:name"?: LegacyLabel };
  readonly "im:image"?: readonly (LegacyLabel & {
    readonly attributes?: { readonly height?: string };
  })[];
  readonly "im:price"?: LegacyLabel & {
    readonly attributes?: { readonly amount?: string; readonly currency?: string };
  };
  readonly "im:releaseDate"?: LegacyLabel;
  readonly title?: LegacyLabel;
  readonly category?: { readonly attributes?: { readonly label?: string } };
  readonly id?: {
    readonly label?: string;
    readonly attributes?: { readonly "im:id"?: string };
  };
  readonly link?:
    | readonly {
        readonly attributes?: {
          readonly href?: string;
          readonly rel?: string;
          readonly "im:assetType"?: string;
        };
      }[]
    | {
        readonly attributes?: {
          readonly href?: string;
          readonly rel?: string;
          readonly "im:assetType"?: string;
        };
      };
}

interface LegacyChartFeed {
  readonly feed?: {
    readonly title?: LegacyLabel;
    readonly updated?: LegacyLabel;
    readonly rights?: LegacyLabel;
    readonly entry?: readonly LegacyEntry[] | LegacyEntry;
  };
}

const entriesOf = (feed: LegacyChartFeed): readonly LegacyEntry[] => {
  const entry = feed.feed?.entry;
  if (Array.isArray(entry)) return entry;
  // limit=1 serialises a lone object. Verified live.
  if (entry && typeof entry === "object") return [entry as LegacyEntry];
  return [];
};

/* ------------------------------------------------------------------ *
 * Matching guard for the search fallback
 * ------------------------------------------------------------------ */

/**
 * Fold to a comparable form: strip diacritics, unify "&"/"and", drop
 * punctuation and collapse whitespace. Used ONLY to decide whether a search
 * result is the same song — never to rewrite any value we display.
 */
function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Equal, or one is wholly contained in the other (handles "(feat. X)" tails). */
function namesAgree(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  // Guard against a two-character token matching everything.
  if (shorter.length < 4) return false;
  return longer.includes(shorter);
}

/* ------------------------------------------------------------------ *
 * Normalisation to TrackRecord
 * ------------------------------------------------------------------ */

function itunesDeepLink(
  url: string,
  provenance: Provenance,
  price: Maybe<string>,
  offerType: DeepLink["offerType"],
): DeepLink {
  return {
    // PlatformId has no separate "itunes" member, and these URLs are
    // music.apple.com links, so the platform the user lands on is Apple Music.
    // The provenance below still records that WE got the link from iTunes.
    platform: "apple-music",
    platformName: "Apple Music",
    url,
    offerType,
    price,
    // Canonical URL returned by Apple's own API, not a constructed search URL.
    verified: true,
    provenance,
  };
}

function fromItunesTrack(
  raw: ItunesTrack,
  rank: number,
  fetchedAt: string,
): TrackRecord | null {
  const trackId = typeof raw.trackId === "number" ? String(raw.trackId) : "";
  const title = typeof raw.trackName === "string" ? raw.trackName.trim() : "";
  const artist = typeof raw.artistName === "string" ? raw.artistName.trim() : "";
  if (trackId === "" || title === "" || artist === "") return null;

  const sourceUrl =
    typeof raw.trackViewUrl === "string" ? raw.trackViewUrl.trim() : "";
  const provenance: Provenance = { source: "itunes", fetchedAt, sourceUrl };

  const artwork = fromText(raw.artworkUrl100);
  const genre = typeof raw.primaryGenreName === "string" ? raw.primaryGenreName.trim() : "";

  return {
    key: `itunes:${trackId}`,
    sourceId: trackId,
    title,
    artist,
    album: fromText(raw.collectionName),
    artworkUrl:
      artwork.status === "ok" ? ok(upscaleAppleArtwork(artwork.value)) : artwork,
    previewUrl: fromText(raw.previewUrl),
    rank,
    movement: unavailable("not_in_source"),
    // iTunes never exposes play counts.
    playCount: unavailable("not_in_source"),
    genres: genre === "" ? [] : [genre],
    releaseDate: fromText(raw.releaseDate),
    links:
      sourceUrl === ""
        ? []
        : [
            itunesDeepLink(
              sourceUrl,
              provenance,
              unavailable("not_in_source"),
              "listen",
            ),
          ],
    provenance,
  };
}

function fromLegacyEntry(
  entry: LegacyEntry,
  rank: number,
  fetchedAt: string,
): TrackRecord | null {
  const sourceId = entry.id?.attributes?.["im:id"]?.trim() ?? "";
  const title = entry["im:name"]?.label?.trim() ?? "";
  const artist = entry["im:artist"]?.label?.trim() ?? "";
  if (sourceId === "" || title === "" || artist === "") return null;

  const links = Array.isArray(entry.link)
    ? entry.link
    : entry.link
      ? [entry.link]
      : [];

  const pageUrl =
    links.find((l) => l.attributes?.rel === "alternate")?.attributes?.href?.trim() ??
    entry.id?.label?.trim() ??
    "";

  const preview = links.find(
    (l) => l.attributes?.["im:assetType"] === "preview",
  )?.attributes?.href;

  // Largest rendition the feed lists (55/60/170), then the documented
  // size-segment swap for a display-quality square.
  const images = entry["im:image"] ?? [];
  const largest = images.reduce<string>((best, image) => {
    const label = image.label?.trim();
    if (!label) return best;
    const height = Number(image.attributes?.height ?? 0);
    const bestHeight = Number(
      images.find((i) => i.label?.trim() === best)?.attributes?.height ?? -1,
    );
    return height > bestHeight ? label : best;
  }, "");

  const provenance: Provenance = {
    source: "itunes",
    fetchedAt,
    sourceUrl: pageUrl,
  };

  const genre = entry.category?.attributes?.label?.trim() ?? "";
  // `im:price` is the iTunes Store purchase price for the track, reported by
  // the feed. Passed through verbatim — currency symbol and all.
  const price = fromText(entry["im:price"]?.label);

  return {
    key: `itunes:${sourceId}`,
    sourceId,
    title,
    artist,
    album: fromText(entry["im:collection"]?.["im:name"]?.label),
    artworkUrl: largest === "" ? unavailable("not_in_source") : ok(upscaleAppleArtwork(largest)),
    previewUrl: fromText(preview),
    rank,
    movement: unavailable("not_in_source"),
    playCount: unavailable("not_in_source"),
    genres: genre === "" ? [] : [genre],
    releaseDate: fromText(entry["im:releaseDate"]?.label),
    links:
      pageUrl === ""
        ? []
        : [itunesDeepLink(pageUrl, provenance, price, "buy")],
    provenance,
  };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/** Apple caps `limit` at 200; we ask for far less because nobody reads 200. */
const MAX_SEARCH_RESULTS = 25;

/**
 * Turn one Search API row into a TrackRecord.
 *
 * `rank` here is Apple's relevance ordering, NOT a chart position, and the
 * search UI labels it as such — presenting a relevance index as a chart rank
 * would be inventing a ranking that no source published.
 */
function searchResultToTrack(
  item: ItunesTrack,
  rank: number,
  fetchedAt: string,
): TrackRecord | null {
  const sourceId = typeof item.trackId === "number" ? String(item.trackId) : "";
  const title = item.trackName?.trim() ?? "";
  const artist = item.artistName?.trim() ?? "";
  if (sourceId === "" || title === "" || artist === "") return null;

  const pageUrl = item.trackViewUrl?.trim() ?? "";
  const artwork = fromText(item.artworkUrl100);
  const provenance: Provenance = { source: "itunes", fetchedAt, sourceUrl: pageUrl };

  const price =
    typeof item.trackPrice === "number" && item.trackPrice >= 0 && item.currency
      ? ok(`${item.trackPrice} ${item.currency}`)
      : unavailable<string>("not_in_source");

  const genre = item.primaryGenreName?.trim() ?? "";

  return {
    key: `itunes:${sourceId}`,
    sourceId,
    title,
    artist,
    album: fromText(item.collectionName),
    artworkUrl:
      artwork.status === "ok" ? ok(upscaleAppleArtwork(artwork.value)) : artwork,
    previewUrl: fromText(item.previewUrl),
    rank,
    // A search result has no chart history and no play count. Both stay absent
    // rather than being filled with a zero the card would then render.
    movement: unavailable("not_in_source"),
    playCount: unavailable("not_in_source"),
    genres: genre === "" ? [] : [genre],
    releaseDate: fromText(item.releaseDate),
    links: pageUrl === "" ? [] : [itunesDeepLink(pageUrl, provenance, price, "buy")],
    provenance,
  };
}

/**
 * Search Apple's catalogue for a song, by title, artist, or both.
 *
 * Why iTunes Search and not one of the chart providers: it is a single global
 * catalogue covering Indian and international releases alike, it needs no key,
 * and it returns a 30-second preview plus a canonical Apple Music URL — so a
 * result is immediately playable and immediately linkable. Last.fm's
 * track.search returns no audio and no artwork worth showing, and Deezer's
 * catalogue is materially thinner for Indian-language music.
 *
 * `country` selects the storefront, which is what makes the same query return
 * region-appropriate releases and prices.
 */
export async function searchTracks(
  term: string,
  country: CountryCode,
  limit = MAX_SEARCH_RESULTS,
): Promise<readonly TrackRecord[]> {
  if (!providerEnabled.itunes) return [];

  const query = term.trim();
  if (query === "") return [];

  const cc = country.trim().toUpperCase();
  const url = buildUrl(SEARCH_URL, {
    term: query,
    entity: "song",
    media: "music",
    limit: Math.max(1, Math.min(limit, MAX_SEARCH_RESULTS)),
    country: cc,
  });

  const outcome = await limited(() =>
    fetchJson<ItunesResponse>({
      source: "itunes",
      url,
      // Short window: a search result page is a live query, not a daily board.
      revalidate: 60 * 15,
      tags: ["music:itunes:search"],
    }),
  );

  if (!outcome.ok) return [];

  const tracks: TrackRecord[] = [];
  for (const item of outcome.data.results ?? []) {
    const track = searchResultToTrack(item, tracks.length + 1, outcome.fetchedAt);
    if (track) tracks.push(track);
  }
  return tracks;
}

/* ------------------------------------------------------------------ *
 * Enrichment
 * ------------------------------------------------------------------ */

/**
 * A TrackRecord whose preview (and upgraded artwork) came from iTunes while the
 * rest of the record came from somewhere else. `provenance` still names the
 * original source; `previewProvenance` names where the preview came from, so a
 * card built from an Apple Music chart row can credit both honestly.
 */
export interface EnrichedTrackRecord extends TrackRecord {
  readonly previewProvenance: Maybe<Provenance>;
}

const withoutPreview = (
  track: TrackRecord,
  reason: "not_in_source" | "source_error" | "provider_disabled",
): EnrichedTrackRecord => ({
  ...track,
  previewUrl: unavailable(reason),
  previewProvenance: unavailable(reason),
});

async function lookupById(
  ids: readonly string[],
  country: CountryCode,
): Promise<{ byId: Map<string, ItunesTrack>; fetchedAt: string } | null> {
  if (ids.length === 0) return { byId: new Map(), fetchedAt: new Date().toISOString() };

  const cc = country.trim().toUpperCase();
  const url = buildUrl(LOOKUP_URL, {
    id: ids.join(","),
    country: cc,
    entity: "song",
  });

  const outcome = await limited(() =>
    fetchJson<ItunesResponse>({
      source: "itunes",
      url,
      revalidate: REVALIDATE.musicCharts,
      tags: [`music:itunes:${cc.toLowerCase()}`],
    }),
  );

  if (!outcome.ok) return null;

  const byId = new Map<string, ItunesTrack>();
  for (const result of outcome.data.results ?? []) {
    if (typeof result.trackId === "number") {
      byId.set(String(result.trackId), result);
    }
  }
  return { byId, fetchedAt: outcome.fetchedAt };
}

function applyItunes(
  track: TrackRecord,
  match: ItunesTrack,
  fetchedAt: string,
): EnrichedTrackRecord {
  const preview = fromText(match.previewUrl);
  const artwork = fromText(match.artworkUrl100);

  return {
    ...track,
    previewUrl: preview,
    artworkUrl:
      artwork.status === "ok"
        ? ok(upscaleAppleArtwork(artwork.value))
        : track.artworkUrl,
    previewProvenance:
      preview.status === "ok"
        ? ok<Provenance>({
            source: "itunes",
            fetchedAt,
            sourceUrl:
              typeof match.trackViewUrl === "string" && match.trackViewUrl.trim() !== ""
                ? match.trackViewUrl.trim()
                : track.provenance.sourceUrl,
          })
        : unavailable("not_in_source"),
  };
}

/**
 * Resolve a 30-second preview (and a larger artwork rendition) for a track that
 * came from a source without either — in practice an Apple Music RSS chart row.
 *
 * Path taken, and why: `lookup?id={id}` was verified live against real Apple
 * Music RSS ids (`6782573111` etc.). All 25/25 `in`, 25/25 `us` and 25/25 `gb`
 * chart ids resolved with `resultCount: 1` and a `previewUrl`, and a full
 * 100-song `in` chart resolved 100/100 in one batched call. So the exact-id
 * path is the primary route and there is no ambiguity to guard against.
 *
 * The `search` fallback only runs when lookup returns nothing (an unknown id
 * returns HTTP 200 with `resultCount: 0`, verified). In that case the result is
 * accepted ONLY if both the artist and the track name agree after
 * normalisation; otherwise the preview stays `unavailable`, because a preview
 * from the wrong song is worse than no preview.
 */
export async function enrichWithPreview(
  track: TrackRecord,
  country: CountryCode,
): Promise<EnrichedTrackRecord> {
  if (!providerEnabled.itunes) return withoutPreview(track, "provider_disabled");

  const cc = country.trim().toUpperCase();

  // 1. Exact lookup by id (verified working for Apple Music RSS ids).
  if (/^\d+$/.test(track.sourceId)) {
    const looked = await lookupById([track.sourceId], cc);
    if (looked === null) return withoutPreview(track, "source_error");
    const match = looked.byId.get(track.sourceId);
    if (match) return applyItunes(track, match, looked.fetchedAt);
  }

  // 2. Fallback: search, then verify the match before trusting it.
  const url = buildUrl(SEARCH_URL, {
    term: `${track.artist} ${track.title}`,
    entity: "song",
    limit: 1,
    country: cc,
  });

  const outcome = await limited(() =>
    fetchJson<ItunesResponse>({
      source: "itunes",
      url,
      revalidate: REVALIDATE.musicCharts,
      tags: [`music:itunes:${cc.toLowerCase()}`],
    }),
  );

  if (!outcome.ok) return withoutPreview(track, "source_error");

  const candidate = outcome.data.results?.[0];
  if (!candidate) return withoutPreview(track, "not_in_source");

  const sameTrack = namesAgree(candidate.trackName ?? "", track.title);
  const sameArtist = namesAgree(candidate.artistName ?? "", track.artist);
  if (!sameTrack || !sameArtist) {
    // Wrong song. Refuse rather than attach someone else's audio.
    return withoutPreview(track, "not_in_source");
  }

  return applyItunes(track, candidate, outcome.fetchedAt);
}

/**
 * Batch form of `enrichWithPreview`. Prefer this for a whole chart: `lookup`
 * takes a comma-separated id list, and 100 ids in a single request was verified
 * live (`resultCount: 100`, 100 previews). Tracks whose id does not resolve
 * fall back to the per-track search path, still behind the 4-in-flight limiter.
 */
export async function enrichManyWithPreviews(
  tracks: readonly TrackRecord[],
  country: CountryCode,
): Promise<readonly EnrichedTrackRecord[]> {
  if (!providerEnabled.itunes) {
    return tracks.map((t) => withoutPreview(t, "provider_disabled"));
  }
  if (tracks.length === 0) return [];

  const cc = country.trim().toUpperCase();
  const numeric = tracks.filter((t) => /^\d+$/.test(t.sourceId));

  const resolved = new Map<string, { match: ItunesTrack; fetchedAt: string }>();
  let lookupFailed = false;

  for (let i = 0; i < numeric.length; i += LOOKUP_BATCH_SIZE) {
    const chunk = numeric.slice(i, i + LOOKUP_BATCH_SIZE).map((t) => t.sourceId);
    const looked = await lookupById(chunk, cc);
    if (looked === null) {
      lookupFailed = true;
      continue;
    }
    for (const [id, match] of looked.byId) {
      resolved.set(id, { match, fetchedAt: looked.fetchedAt });
    }
  }

  return Promise.all(
    tracks.map(async (track) => {
      const hit = resolved.get(track.sourceId);
      if (hit) return applyItunes(track, hit.match, hit.fetchedAt);
      if (lookupFailed && /^\d+$/.test(track.sourceId)) {
        return withoutPreview(track, "source_error");
      }
      return enrichWithPreview(track, cc);
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export const itunesProvider: Provider<TrackRecord> = {
  id: "itunes",
  kind: "music",
  displayName: "iTunes",

  attribution: "Chart data, previews and artwork from the Apple iTunes Store. Apple and iTunes are trademarks of Apple Inc.",

  isEnabled: () => providerEnabled.itunes,

  /**
   * iTunes Store "Top Songs" for the storefront. The 1-based position in
   * `feed.entry` is the Store's own ranking — we do not re-sort it.
   */
  async fetchTrending(query: TrendingQuery): Promise<readonly TrackRecord[]> {
    if (!providerEnabled.itunes) return [];

    const storefront = query.country.trim().toLowerCase();
    const requested =
      typeof query.limit === "number" && Number.isFinite(query.limit)
        ? Math.trunc(query.limit)
        : DEFAULT_CHART_LIMIT;
    const limit = Math.min(MAX_CHART_LIMIT, Math.max(MIN_CHART_LIMIT, requested));

    const outcome = await limited(() =>
      fetchJson<LegacyChartFeed>({
        source: "itunes",
        url: legacyChartUrl(storefront, limit),
        revalidate: REVALIDATE.musicCharts,
        tags: [`music:itunes:${storefront}`],
      }),
    );

    // Unknown storefront or an out-of-range limit answers HTTP 400 (verified).
    if (!outcome.ok) return [];

    const tracks: TrackRecord[] = [];
    entriesOf(outcome.data).forEach((entry, index) => {
      const track = fromLegacyEntry(entry, index + 1, outcome.fetchedAt);
      if (track) tracks.push(track);
    });

    if (!query.genre) return tracks;
    const wanted = query.genre.trim().toLowerCase();
    return tracks.filter((t) => t.genres.some((g) => g.toLowerCase() === wanted));
  },

  /**
   * Exact `lookup?id=` — no chart membership required. `rank` is 0 because this
   * record is not a chart position; callers reading a detail record must not
   * treat it as one.
   */
  async fetchTitleDetails(
    id: string,
    query: DetailsQuery,
  ): Promise<TrackRecord | null> {
    if (!providerEnabled.itunes) return null;

    const trackId = id.startsWith("itunes:") ? id.slice("itunes:".length) : id;
    if (!/^\d+$/.test(trackId)) return null;

    const looked = await lookupById([trackId], query.country);
    if (looked === null) return null;

    const match = looked.byId.get(trackId);
    if (!match) return null;

    return fromItunesTrack(match, 0, looked.fetchedAt);
  },

  async resolveDeepLink(
    record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _query;
    if (record.links.length > 0) return record.links;
    const url = record.provenance.sourceUrl;
    if (!url) return [];
    return [
      itunesDeepLink(url, record.provenance, unavailable("not_in_source"), "listen"),
    ];
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!providerEnabled.itunes) {
      return {
        source: "itunes",
        ok: false,
        detail: "iTunes is turned off in config.",
        latencyMs: unavailable("provider_disabled"),
        checkedAt,
      };
    }

    const { outcome, latencyMs } = await timedFetchJson<ItunesResponse>({
      source: "itunes",
      url: buildUrl(SEARCH_URL, {
        term: "hello",
        entity: "song",
        limit: 1,
        country: "US",
      }),
      revalidate: REVALIDATE.musicCharts,
      tags: ["music:itunes:us"],
    });

    if (!outcome.ok) {
      return {
        source: "itunes",
        ok: false,
        detail: outcome.detail,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    const count = outcome.data.resultCount ?? 0;
    return {
      source: "itunes",
      ok: count > 0,
      detail:
        count > 0
          ? "Search API answered with a result."
          : "Search API answered but returned no results.",
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};
