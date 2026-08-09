import "server-only";

import { REVALIDATE, providerEnabled } from "../core/config";
import { fetchJson, timedFetchJson } from "../core/fetcher";
import {
  fromText,
  ok,
  unavailable,
  type Maybe,
} from "../core/maybe";
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
import { upscaleAppleArtwork } from "./itunes";

/**
 * Apple Music charts, via the public RSS "marketing tools" feed.
 *
 *   https://rss.marketingtools.apple.com/api/v2/{storefront}/music/most-played/{n}/{kind}.json
 *
 * No API key, no auth. Everything below was verified live against the real
 * endpoint before it was written — see the notes on each constant.
 *
 * What this feed does NOT contain: preview audio, play counts, chart movement.
 * Those fields are therefore `unavailable("not_in_source")` here. Previews are
 * filled in afterwards by `enrichWithPreview` in ./itunes, which attaches its
 * own provenance so the UI can still say which source each piece came from.
 */

const RSS_BASE = "https://rss.marketingtools.apple.com/api/v2";

/**
 * Feed kinds verified live (storefronts `in`, `us`, `gb`, all HTTP 200):
 *   most-played/{n}/songs.json         200
 *   most-played/{n}/albums.json        200
 *   most-played/{n}/music-videos.json  200
 *   most-played/{n}/playlists.json     200
 *
 * Other names commonly cited for this API do NOT exist — `top-songs`,
 * `hot-tracks`, `most-played-songs`, `new-releases` and `coming-soon` all
 * returned HTTP 404 on the `in` storefront.
 */
export type AppleFeedKind = "songs" | "albums" | "music-videos" | "playlists";

/**
 * `n` is a free integer, not a fixed enum: 1, 7, 10, 20, 25, 50 and 100 all
 * returned 200 with exactly `n` results. 101, 110, 150, 200 and 1000 returned
 * HTTP 500. So the accepted range is 1-100 inclusive.
 */
const MIN_FEED_SIZE = 1;
const MAX_FEED_SIZE = 100;

/** Chart depth when the caller does not ask for one. */
const DEFAULT_LIMIT = 25;

/**
 * An unknown storefront (`zz`, `xx`, `qq`) does NOT 404 — it returns an HTML
 * body with HTTP 500. Either way `fetchJson` gives us `ok: false` and we return
 * an empty list rather than throwing, per the provider contract.
 */
const storefrontOf = (country: CountryCode): string =>
  country.trim().toLowerCase();

const clampSize = (limit: number | undefined): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_FEED_SIZE, Math.max(MIN_FEED_SIZE, Math.trunc(limit)));
};

const feedUrl = (
  storefront: string,
  size: number,
  kind: AppleFeedKind,
): string => `${RSS_BASE}/${storefront}/music/most-played/${size}/${kind}.json`;

/* ------------------------------------------------------------------ *
 * Wire shapes — exactly the fields the live feed returns
 * ------------------------------------------------------------------ */

interface AppleRssGenre {
  readonly genreId?: string;
  readonly name?: string;
  readonly url?: string;
}

interface AppleRssResult {
  readonly artistName?: string;
  readonly id?: string;
  readonly name?: string;
  readonly releaseDate?: string;
  readonly kind?: string;
  readonly artistId?: string;
  readonly artistUrl?: string;
  readonly artworkUrl100?: string;
  readonly genres?: readonly AppleRssGenre[];
  readonly url?: string;
  /** Present on `songs` feeds in some storefronts; absent in others. */
  readonly collectionName?: string;
}

interface AppleRssFeed {
  readonly feed?: {
    readonly title?: string;
    readonly id?: string;
    readonly copyright?: string;
    readonly country?: string;
    /** e.g. "Sun, 2 Aug 2026 16:44:43 +0000" — RFC 1123-ish, not ISO. */
    readonly updated?: string;
    readonly results?: readonly AppleRssResult[];
  };
}

/* ------------------------------------------------------------------ *
 * Chart freshness — "Apple last updated this chart at …"
 * ------------------------------------------------------------------ */

export interface AppleChartMeta {
  readonly country: CountryCode;
  readonly kind: AppleFeedKind;
  /** e.g. "Top Songs". */
  readonly feedTitle: Maybe<string>;
  /** `feed.updated` exactly as Apple sent it. */
  readonly updatedRaw: Maybe<string>;
  /** ISO 8601 form of `feed.updated`, only when it actually parses. */
  readonly updatedIso: Maybe<string>;
  /** `feed.copyright` — render this next to the chart. */
  readonly copyright: Maybe<string>;
  /** When we called Apple. `unavailable` when the call failed. */
  readonly fetchedAt: Maybe<string>;
}

/** Parse Apple's RFC-1123-style stamp. Never guesses — bad input stays absent. */
function toIso(updated: string | undefined): Maybe<string> {
  if (typeof updated !== "string" || updated.trim() === "") {
    return unavailable("not_in_source");
  }
  const ms = Date.parse(updated);
  if (!Number.isFinite(ms)) return unavailable("not_in_source");
  return ok(new Date(ms).toISOString());
}

/**
 * Chart freshness for the storefront, so the UI can print "Apple updated this
 * chart at HH:MM" instead of implying it is live.
 */
export async function fetchChartMeta(
  country: CountryCode,
  kind: AppleFeedKind = "songs",
): Promise<AppleChartMeta> {
  const storefront = storefrontOf(country);
  const empty = unavailable<string>("source_error");

  if (!providerEnabled["apple-music"]) {
    const off = unavailable<string>("provider_disabled");
    return {
      country,
      kind,
      feedTitle: off,
      updatedRaw: off,
      updatedIso: off,
      copyright: off,
      fetchedAt: off,
    };
  }

  const outcome = await fetchJson<AppleRssFeed>({
    source: "apple-music",
    // Smallest feed that still carries the header block.
    url: feedUrl(storefront, MIN_FEED_SIZE, kind),
    revalidate: REVALIDATE.musicCharts,
    tags: [`music:apple:${storefront}`],
  });

  if (!outcome.ok) {
    return {
      country,
      kind,
      feedTitle: empty,
      updatedRaw: empty,
      updatedIso: empty,
      copyright: empty,
      fetchedAt: empty,
    };
  }

  const feed = outcome.data.feed;
  return {
    country,
    kind,
    feedTitle: fromText(feed?.title),
    updatedRaw: fromText(feed?.updated),
    updatedIso: toIso(feed?.updated),
    copyright: fromText(feed?.copyright),
    fetchedAt: ok(outcome.fetchedAt),
  };
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

const APPLE_MUSIC_LINK_PLATFORM = "apple-music" as const;

function buildDeepLink(url: string, provenance: Provenance): DeepLink {
  return {
    platform: APPLE_MUSIC_LINK_PLATFORM,
    platformName: "Apple Music",
    url,
    offerType: "listen",
    // Apple's RSS carries no price for a stream. Never invented.
    price: unavailable("not_in_source"),
    // `verified: true` because the URL is Apple's own canonical link for the
    // item, taken verbatim from their feed — not a constructed search URL.
    verified: true,
    provenance,
  };
}

function toTrack(
  raw: AppleRssResult,
  rank: number,
  fetchedAt: string,
): TrackRecord | null {
  const sourceId = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.name === "string" ? raw.name.trim() : "";
  const artist = typeof raw.artistName === "string" ? raw.artistName.trim() : "";
  // Without an id, a title and an artist there is no record to speak of. We drop
  // the row rather than filling the gaps.
  if (sourceId === "" || title === "" || artist === "") return null;

  const sourceUrl =
    typeof raw.url === "string" && raw.url.trim() !== "" ? raw.url.trim() : "";

  const provenance: Provenance = {
    source: "apple-music",
    fetchedAt,
    sourceUrl,
  };

  const artwork = fromText(raw.artworkUrl100);

  return {
    key: `apple-music:${sourceId}`,
    sourceId,
    title,
    artist,
    // The songs feed does not carry an album name in any storefront we checked.
    album: fromText(raw.collectionName),
    artworkUrl:
      artwork.status === "ok"
        ? ok(upscaleAppleArtwork(artwork.value))
        : artwork,
    // Apple's RSS has no preview audio at all. ./itunes fills this in.
    previewUrl: unavailable("not_in_source"),
    rank,
    // Movement is derived by comparing our own stored snapshots, not by Apple.
    movement: unavailable("not_in_source"),
    // Apple publishes the ordering but never the underlying play counts.
    playCount: unavailable("not_in_source"),
    genres: (raw.genres ?? [])
      .map((g) => (typeof g.name === "string" ? g.name.trim() : ""))
      .filter((name) => name !== ""),
    releaseDate: fromText(raw.releaseDate),
    links: sourceUrl === "" ? [] : [buildDeepLink(sourceUrl, provenance)],
    provenance,
  };
}

/**
 * Apple publishes four most-played feeds per storefront — songs, albums,
 * music-videos and playlists — all keyless and all real. `fetchTrending` only
 * uses `songs` because that is what the Provider interface asks for, but the
 * other feeds are genuine chart data and this export lets the board layer show
 * them. Verified live for `in`: songs/albums/music-videos all return 50 entries
 * at n=50; playlists caps out at 25.
 */
export const fetchAppleFeed = (
  country: CountryCode,
  kind: AppleFeedKind,
  limit?: number,
): Promise<readonly TrackRecord[]> => fetchFeed(country, kind, limit);

async function fetchFeed(
  country: CountryCode,
  kind: AppleFeedKind,
  limit: number | undefined,
): Promise<readonly TrackRecord[]> {
  if (!providerEnabled["apple-music"]) return [];

  const storefront = storefrontOf(country);
  const size = clampSize(limit);

  const outcome = await fetchJson<AppleRssFeed>({
    source: "apple-music",
    url: feedUrl(storefront, size, kind),
    revalidate: REVALIDATE.musicCharts,
    tags: [`music:apple:${storefront}`],
  });

  // Unknown storefront => HTTP 500 (verified), oversized `n` => HTTP 500,
  // network trouble => timeout/bad_payload. All of them mean "no chart", and
  // none of them may throw.
  if (!outcome.ok) return [];

  const results = outcome.data.feed?.results;
  if (!Array.isArray(results)) return [];

  const tracks: TrackRecord[] = [];
  results.forEach((raw, index) => {
    // The 1-based position in `feed.results` IS Apple's published ranking.
    const track = toTrack(raw, index + 1, outcome.fetchedAt);
    if (track) tracks.push(track);
  });
  return tracks;
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export const appleMusicProvider: Provider<TrackRecord> = {
  id: "apple-music",
  kind: "music",
  displayName: "Apple Music",

  /**
   * Apple's RSS feed terms require visible attribution wherever the data is
   * shown. The per-storefront copyright line is also available via
   * `fetchChartMeta().copyright`.
   */
  attribution: "Chart data from Apple Music. Apple, the Apple logo and Apple Music are trademarks of Apple Inc.",

  isEnabled: () => providerEnabled["apple-music"],

  async fetchTrending(query: TrendingQuery): Promise<readonly TrackRecord[]> {
    const tracks = await fetchFeed(query.country, "songs", query.limit);
    if (!query.genre) return tracks;

    // Apple exposes no genre-filtered "most-played" feed, so this filters the
    // real chart on the genre names Apple itself attached to each row. Ranks
    // are assigned before filtering and left untouched, so a filtered list
    // still shows each track's true chart position.
    const wanted = query.genre.trim().toLowerCase();
    return tracks.filter((t) =>
      t.genres.some((g) => g.toLowerCase() === wanted),
    );
    // `query.language` is ignored: the storefront is the only regional axis
    // this feed has. Silently filtering by language would be a guess.
  },

  /**
   * The marketing RSS has no per-item endpoint — the chart response is the only
   * thing it serves. So we look the id up inside the storefront's full 100-song
   * chart and return `null` when it is not charting, rather than inventing a
   * record. Use `itunesProvider.fetchTitleDetails` for an id that is off-chart.
   */
  async fetchTitleDetails(
    id: string,
    query: DetailsQuery,
  ): Promise<TrackRecord | null> {
    const tracks = await fetchFeed(query.country, "songs", MAX_FEED_SIZE);
    return tracks.find((t) => t.sourceId === id || t.key === id) ?? null;
  },

  async resolveDeepLink(
    record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _query;
    if (record.links.length > 0) return record.links;
    const url = record.provenance.sourceUrl;
    if (!url) return [];
    return [buildDeepLink(url, record.provenance)];
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!providerEnabled["apple-music"]) {
      return {
        source: "apple-music",
        ok: false,
        detail: "Apple Music is turned off in config.",
        latencyMs: unavailable("provider_disabled"),
        checkedAt,
      };
    }

    const { outcome, latencyMs } = await timedFetchJson<AppleRssFeed>({
      source: "apple-music",
      url: feedUrl("us", 10, "songs"),
      revalidate: REVALIDATE.musicCharts,
      tags: ["music:apple:us"],
    });

    if (!outcome.ok) {
      return {
        source: "apple-music",
        ok: false,
        detail: outcome.detail,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    const count = outcome.data.feed?.results?.length ?? 0;
    return {
      source: "apple-music",
      ok: count > 0,
      detail:
        count > 0
          ? `US Top Songs feed returned ${count} entries.`
          : "US Top Songs feed responded but carried no entries.",
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};
