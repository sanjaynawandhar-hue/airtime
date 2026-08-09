import "server-only";

import { REVALIDATE, keys, providerEnabled } from "../core/config";
import { buildUrl, fetchJson, timedFetchJson } from "../core/fetcher";
import { fromNumeric, fromText, ok, unavailable, type Maybe } from "../core/maybe";
import type {
  DeepLink,
  DetailsQuery,
  HealthStatus,
  Movement,
  Provenance,
  Provider,
  TrackRecord,
  TrendingQuery,
} from "../core/types";

/**
 * Last.fm — the GENRE and COUNTRY axes that Apple and YouTube don't cover.
 *
 * ---------------------------------------------------------------------------
 * CONFIRMED LIVE (this session)
 * ---------------------------------------------------------------------------
 * No API key is present in this environment, so a 200 was impossible. What was
 * verified by actually calling the API:
 *
 *   ?method=geo.gettoptracks&country=India&format=json          (no api_key)
 *     -> HTTP 400 {"message":"Invalid parameters - Your request is missing a
 *                  required parameter","error":6}
 *   ?method=tag.gettoptracks&tag=pop&format=json                (no api_key)
 *     -> HTTP 400 {"message":"Invalid parameters - …","error":6}
 *   …&api_key=<32 hex chars that are not a real key>
 *     -> HTTP 403 {"message":"Invalid API key - You must be granted a valid
 *                  key by last.fm","error":10}
 *
 * Two consequences baked into this file: Last.fm signals failure with a real
 * HTTP error status (so `fetchJson` reports `http_error` and we never see the
 * body), AND it can also return an `error` field inside an otherwise-fine
 * payload — both are handled.
 *
 * CONFIRMED FROM THE LIVE DOCS (last.fm/api/show/…):
 *   geo.getTopTracks — required: country, api_key. Optional: location, limit,
 *     page. `country` is documented verbatim as "A country name, as defined by
 *     the ISO 3166-1 country names standard" — a NAME, not a code. Hence the
 *     ISO-2 -> name map below.
 *   tag.getTopTracks — required: tag, api_key. Optional: limit, page.
 *   Both respond with a `tracks` wrapper containing `track[]`, each track
 *     carrying an @attr rank, name, mbid, url, streamable, artist{name,mbid,
 *     url} and an image[] array.
 *   geo.getTopTracks documents `playcount` on the track; tag.getTopTracks does
 *     NOT document playcount or listeners. So the genre axis will usually have
 *     no play figure, and that is correct — it renders as unavailable rather
 *     than as a zero.
 *
 * ASSUMED, NOT CONFIRMED (no key to verify against): that live geo responses
 * also include `listeners` and `duration` alongside `playcount`. Those fields
 * are read defensively — absent means unavailable, never a substituted number.
 */

const BASE = "https://ws.audioscrobbler.com/2.0/";

/**
 * Last.fm's deprecated placeholder star image. It is served as a real URL for
 * artwork Last.fm does not have, so rendering it would put a fake-looking
 * cover on the card. Any image URL containing this hash maps to unavailable.
 */
const PLACEHOLDER_IMAGE_HASH = "2a96cbd8b46e442fc41c2b86b821562f";

/** Largest first — we take the best image the source actually provided. */
const IMAGE_SIZE_PREFERENCE = ["mega", "extralarge", "large", "medium", "small"];

/**
 * ISO 3166-1 alpha-2 -> the country NAME Last.fm expects.
 *
 * API QUIRK: geo.getTopTracks takes a country *name* ("India", "United
 * States"), not an ISO code. Passing "IN" or "US" is not an error — it simply
 * returns nothing, which is the worst possible failure mode for us. This map is
 * the only place codes are translated, and a country that is not in it returns
 * an empty rail rather than a guessed name.
 *
 * Names follow the ISO 3166-1 English short names, which is what the docs cite.
 */
const LASTFM_COUNTRY_NAME: Readonly<Record<string, string>> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  PT: "Portugal",
  NL: "Netherlands",
  BE: "Belgium",
  CH: "Switzerland",
  AT: "Austria",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  CZ: "Czech Republic",
  RU: "Russian Federation",
  UA: "Ukraine",
  TR: "Turkey",
  GR: "Greece",
  BR: "Brazil",
  MX: "Mexico",
  AR: "Argentina",
  CL: "Chile",
  CO: "Colombia",
  JP: "Japan",
  KR: "Korea, Republic of",
  CN: "China",
  ID: "Indonesia",
  PH: "Philippines",
  MY: "Malaysia",
  SG: "Singapore",
  TH: "Thailand",
  VN: "Viet Nam",
  PK: "Pakistan",
  BD: "Bangladesh",
  LK: "Sri Lanka",
  NP: "Nepal",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  IL: "Israel",
  EG: "Egypt",
  ZA: "South Africa",
  NG: "Nigeria",
  KE: "Kenya",
};

/** Countries we can ask Last.fm about. Exported so the UI can offer only these. */
export const LASTFM_COUNTRIES: readonly string[] = Object.keys(LASTFM_COUNTRY_NAME);

/* ------------------------------------------------------------------ *
 * Raw Last.fm payloads
 * ------------------------------------------------------------------ */

interface LastfmImage {
  readonly "#text"?: string;
  readonly size?: string;
}

interface LastfmArtistRef {
  readonly name?: string;
  readonly mbid?: string;
  readonly url?: string;
}

interface LastfmTrack {
  readonly name?: string;
  readonly mbid?: string;
  readonly url?: string;
  readonly duration?: string | number;
  readonly playcount?: string | number;
  readonly listeners?: string | number;
  readonly artist?: LastfmArtistRef;
  readonly image?: readonly LastfmImage[];
  readonly "@attr"?: { readonly rank?: string | number };
}

interface LastfmErrorBody {
  readonly error?: number;
  readonly message?: string;
}

interface LastfmTrackListWrapper {
  /** Last.fm collapses a single-item array into a bare object. */
  readonly track?: readonly LastfmTrack[] | LastfmTrack;
  readonly "@attr"?: Record<string, unknown>;
}

/**
 * Last.fm uses TWO different wrapper keys for what is the same shape, and which
 * one you get depends on the method. Verified against live responses
 * (2026-08-04):
 *
 *   geo.getTopTracks    -> tracks
 *   tag.getTopTracks    -> tracks
 *   chart.getTopTracks  -> tracks
 *   artist.getTopTracks -> toptracks
 *
 * The docs show `toptracks` generally, and coding to that alone silently
 * produced an empty rail — the request succeeded and the parse found nothing,
 * which is the worst failure shape there is. Both are declared, and every read
 * goes through `trackListFrom` so no call site has to remember which is which.
 */
interface LastfmTopTracks extends LastfmErrorBody {
  readonly tracks?: LastfmTrackListWrapper;
  readonly toptracks?: LastfmTrackListWrapper;
}

interface LastfmTrackInfo extends LastfmErrorBody {
  readonly track?: LastfmTrack & {
    readonly album?: {
      readonly title?: string;
      readonly url?: string;
      readonly image?: readonly LastfmImage[];
    };
    readonly toptags?: { readonly tag?: readonly { readonly name?: string }[] };
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? 50), 1), 1000);

const tag = (...parts: (string | number)[]): string =>
  ["lastfm", ...parts.map((p) => String(p))].join(":");

/** Last.fm returns `track` as an object when there is exactly one result. */
function asArray<T>(value: readonly T[] | T | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

/**
 * Pick the largest real image. Empty `#text` strings and the deprecated
 * placeholder star both count as "no image".
 */
function pickImage(images: readonly LastfmImage[] | undefined) {
  if (!images) return unavailable<string>("not_in_source");

  const usable = images.filter((image) => {
    const url = (image["#text"] ?? "").trim();
    return url !== "" && !url.includes(PLACEHOLDER_IMAGE_HASH);
  });
  if (usable.length === 0) return unavailable<string>("not_in_source");

  for (const size of IMAGE_SIZE_PREFERENCE) {
    const match = usable.find((image) => (image.size ?? "").trim() === size);
    if (match) return fromText(match["#text"]);
  }
  // Unlabelled sizes: take the last, which is Last.fm's largest-last ordering.
  return fromText(usable[usable.length - 1]["#text"]);
}

/**
 * Play figure. `playcount` is the true play total and is preferred; `listeners`
 * is a distinct (smaller) unique-listener count and is only used when Last.fm
 * omitted playcount entirely. `fromNumeric` rejects 0 and "0", which is exactly
 * right here: Last.fm returns "0" for tracks it has no scrobble total for, and
 * that must render as "no figure", not as zero plays.
 */
function pickPlayCount(track: LastfmTrack) {
  const plays = fromNumeric(track.playcount);
  if (plays.status === "ok") return plays;
  return fromNumeric(track.listeners);
}

/** Stable id: the MusicBrainz id when Last.fm has one, else artist::title. */
function sourceIdFor(track: LastfmTrack, artist: string, title: string): string {
  const mbid = (track.mbid ?? "").trim();
  return mbid !== "" ? mbid : `${artist}::${title}`;
}

function provenanceFor(track: LastfmTrack, fetchedAt: string): Provenance {
  return {
    source: "lastfm",
    fetchedAt,
    sourceUrl: (track.url ?? "").trim() !== "" ? track.url! : "https://www.last.fm/",
  };
}

/**
 * Map one Last.fm track.
 *
 * `positionRank` is the 1-based position in the response, and it is the ONLY
 * thing we use.
 *
 * We deliberately ignore Last.fm's own `@attr.rank`, because the two endpoints
 * disagree about what it means. Measured live (2026-08-04):
 *
 *   geo.getTopTracks?country=India  ->  @attr.rank = 0, 1, 2, 3   (0-based)
 *   tag.getTopTracks?tag=rock       ->  @attr.rank = 1, 2, 3, 4   (1-based)
 *
 * Trusting that field produced a chart numbered 1, 1, 2 — the 0-based first
 * entry was rejected as falsy and fell back to position 1, colliding with the
 * second entry's declared rank of 1. Array order ascends correctly on both
 * endpoints, so position is the one signal that means the same thing
 * everywhere. This is still the source's ordering, not a rank we invented.
 *
 * `genres` carries the queried tag ONLY on the tag route, where the tag is
 * literally Last.fm's classification of that track. On the geo route it is
 * empty — we do not infer a genre from a country chart.
 */
function mapTrack(
  track: LastfmTrack,
  positionRank: number,
  fetchedAt: string,
  genres: readonly string[],
): TrackRecord | null {
  const title = (track.name ?? "").trim();
  const artist = (track.artist?.name ?? "").trim();
  if (title === "" || artist === "") return null;

  const rank = positionRank;

  const sourceId = sourceIdFor(track, artist, title);

  return {
    key: `lastfm:${sourceId}`,
    sourceId,
    title,
    artist,
    /** Top-track responses carry no album. track.getInfo does — see below. */
    album: unavailable<string>("not_in_source"),
    artworkUrl: pickImage(track.image),
    /** Last.fm serves no audio previews at all. */
    previewUrl: unavailable<string>("not_in_source"),
    rank,
    /** Last.fm publishes no previous position; Airtime's snapshots fill this. */
    movement: unavailable<Movement>("not_in_source"),
    playCount: pickPlayCount(track),
    genres,
    /** Not present on any top-tracks response. */
    releaseDate: unavailable<string>("not_in_source"),
    /**
     * Empty by design: `PlatformId` has no `lastfm` member, and Last.fm's track
     * page is not a listening destination. The canonical Last.fm URL travels on
     * `provenance.sourceUrl`, where the attribution line uses it.
     */
    links: [],
    provenance: provenanceFor(track, fetchedAt),
  };
}

function mapTrackList(
  tracks: readonly LastfmTrack[],
  fetchedAt: string,
  genres: readonly string[],
): readonly TrackRecord[] {
  const records: TrackRecord[] = [];
  tracks.forEach((track, index) => {
    const record = mapTrack(track, index + 1, fetchedAt, genres);
    if (record) records.push(record);
  });
  return records;
}

function endpoint(params: Record<string, string | number | undefined>): string {
  return buildUrl(BASE, {
    ...params,
    api_key: keys.lastfm,
    format: "json",
  });
}

/* ------------------------------------------------------------------ *
 * International: worldwide charts and per-artist tracks
 * ------------------------------------------------------------------ */

/**
 * Last.fm is inconsistent about which key wraps a track list. Measured live:
 *
 *   geo.getTopTracks    -> tracks
 *   tag.getTopTracks    -> tracks
 *   chart.getTopTracks  -> tracks
 *   artist.getTopTracks -> toptracks     <- the odd one out
 *
 * Reading only one of them is how the genre rail silently rendered empty
 * earlier, so every call site goes through this.
 */
function trackListFrom(data: LastfmTopTracks): readonly LastfmTrack[] {
  return asArray(data.tracks?.track ?? data.toptracks?.track);
}

export interface LastfmArtist {
  readonly name: string;
  readonly listeners: Maybe<number>;
  readonly url: string;
}

interface LastfmTopArtists extends LastfmErrorBody {
  readonly artists?: {
    readonly artist?:
      | readonly { name?: string; listeners?: string; url?: string }[]
      | { name?: string; listeners?: string; url?: string };
  };
}

/**
 * Worldwide top artists. Genuinely global — `chart.getTopArtists` has no
 * country parameter, which is exactly what an "international" view needs.
 */
export async function fetchTopArtists(
  limit = 24,
): Promise<readonly LastfmArtist[]> {
  if (!providerEnabled.lastfm || !keys.lastfm) return [];

  const outcome = await fetchJson<LastfmTopArtists>({
    source: "lastfm",
    url: endpoint({ method: "chart.gettopartists", limit: clampLimit(limit) }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("chart", "artists", limit)],
  });
  if (!outcome.ok || outcome.data.error) return [];

  return asArray(outcome.data.artists?.artist).flatMap((artist) => {
    const name = (artist.name ?? "").trim();
    if (name === "") return [];
    return [
      {
        name,
        listeners: fromNumeric(artist.listeners),
        url:
          nonEmptyUrl(artist.url) ??
          `https://www.last.fm/music/${encodeURIComponent(name)}`,
      },
    ];
  });
}

const nonEmptyUrl = (value: string | undefined): string | undefined =>
  value && value.trim() !== "" ? value.trim() : undefined;

/** A single artist's most-played tracks. The "by singer" axis. */
export async function fetchArtistTopTracks(
  artist: string,
  limit = 20,
): Promise<readonly TrackRecord[]> {
  if (!providerEnabled.lastfm || !keys.lastfm) return [];
  const name = artist.trim();
  if (name === "") return [];

  const outcome = await fetchJson<LastfmTopTracks>({
    source: "lastfm",
    url: endpoint({
      method: "artist.gettoptracks",
      artist: name,
      limit: clampLimit(limit),
    }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("artist", name.toLowerCase(), limit)],
  });
  if (!outcome.ok || outcome.data.error) return [];

  // No genre is attached: an artist chart says nothing about genre, and
  // inferring one would be us writing data the source did not give us.
  return mapTrackList(trackListFrom(outcome.data), outcome.fetchedAt, []);
}

/**
 * Worldwide top tracks. `chart.getTopTracks` takes no country, so this is the
 * one chart in the product that is legitimately "international" rather than a
 * country chart relabelled.
 */
export async function fetchWorldwideTracks(
  limit = 20,
): Promise<readonly TrackRecord[]> {
  if (!providerEnabled.lastfm || !keys.lastfm) return [];

  const outcome = await fetchJson<LastfmTopTracks>({
    source: "lastfm",
    url: endpoint({ method: "chart.gettoptracks", limit: clampLimit(limit) }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("chart", "tracks", limit)],
  });
  if (!outcome.ok || outcome.data.error) return [];

  return mapTrackList(trackListFrom(outcome.data), outcome.fetchedAt, []);
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export const lastfmProvider: Provider<TrackRecord> = {
  id: "lastfm",
  kind: "music",
  displayName: "Last.fm",
  attribution: "Listening data from Last.fm",

  isEnabled(): boolean {
    return providerEnabled.lastfm;
  },

  async fetchTrending(query: TrendingQuery): Promise<readonly TrackRecord[]> {
    // No key -> no request, no throw, no invented rows.
    if (!providerEnabled.lastfm || !keys.lastfm) return [];

    const limit = clampLimit(query.limit);
    const genre = query.genre?.trim();

    // GENRE axis.
    if (genre) {
      const outcome = await fetchJson<LastfmTopTracks>({
        source: "lastfm",
        url: endpoint({ method: "tag.gettoptracks", tag: genre, limit }),
        revalidate: REVALIDATE.musicCharts,
        tags: [tag("tag", genre.toLowerCase(), limit)],
      });
      if (!outcome.ok || outcome.data.error) return [];
      return mapTrackList(
        asArray(outcome.data.tracks?.track),
        outcome.fetchedAt,
        [genre],
      );
    }

    // COUNTRY axis. Last.fm wants the full name — see LASTFM_COUNTRY_NAME.
    const countryName = LASTFM_COUNTRY_NAME[query.country.toUpperCase()];
    if (!countryName) return [];

    const outcome = await fetchJson<LastfmTopTracks>({
      source: "lastfm",
      url: endpoint({ method: "geo.gettoptracks", country: countryName, limit }),
      revalidate: REVALIDATE.musicCharts,
      tags: [tag("geo", query.country.toUpperCase(), limit)],
    });
    if (!outcome.ok || outcome.data.error) return [];
    return mapTrackList(asArray(outcome.data.tracks?.track), outcome.fetchedAt, []);
  },

  async fetchTitleDetails(
    id: string,
    _query: DetailsQuery,
  ): Promise<TrackRecord | null> {
    void _query;
    if (!providerEnabled.lastfm || !keys.lastfm) return null;

    const raw = id.replace(/^lastfm:/, "").trim();
    if (raw === "") return null;

    // Either an mbid, or the `artist::title` id we minted in mapTrack.
    const separator = raw.indexOf("::");
    const params =
      separator === -1
        ? { method: "track.getinfo", mbid: raw }
        : {
            method: "track.getinfo",
            artist: raw.slice(0, separator),
            track: raw.slice(separator + 2),
          };

    const outcome = await fetchJson<LastfmTrackInfo>({
      source: "lastfm",
      url: endpoint(params),
      revalidate: REVALIDATE.musicCharts,
      tags: [tag("track", raw)],
    });
    if (!outcome.ok || outcome.data.error || !outcome.data.track) return null;

    const info = outcome.data.track;
    const genres = (info.toptags?.tag ?? [])
      .map((t) => (t.name ?? "").trim())
      .filter((name) => name !== "");

    /**
     * A detail lookup has no chart position. `TrackRecord.rank` is a bare
     * number, so 0 marks "no position" — 0 is never a real rank, so it cannot
     * be mistaken for one. Do not render rank for records from this method.
     */
    const base = mapTrack(info, 0, outcome.fetchedAt, genres);
    if (!base) return null;

    // track.getInfo is the one response that does carry album + album art.
    const albumArt = pickImage(info.album?.image);
    return {
      ...base,
      rank: 0,
      album: fromText(info.album?.title),
      artworkUrl: albumArt.status === "ok" ? albumArt : base.artworkUrl,
    };
  },

  async resolveDeepLink(
    _record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _record;
    void _query;
    /**
     * Last.fm is a scrobbling service, not a place to listen, and it exposes no
     * verified streaming links. We return nothing rather than guessing a
     * Spotify/Apple URL from an artist and title string.
     */
    return [];
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!keys.lastfm) {
      return {
        source: "lastfm",
        ok: false,
        detail:
          "Last.fm is not connected — set LASTFM_API_KEY (free key from last.fm/api/account/create).",
        latencyMs: unavailable<number>("not_configured"),
        checkedAt,
      };
    }
    if (!providerEnabled.lastfm) {
      return {
        source: "lastfm",
        ok: false,
        detail: "Last.fm is turned off in config.",
        latencyMs: unavailable<number>("provider_disabled"),
        checkedAt,
      };
    }

    const { outcome, latencyMs } = await timedFetchJson<LastfmTopTracks>({
      source: "lastfm",
      url: endpoint({
        method: "geo.gettoptracks",
        country: LASTFM_COUNTRY_NAME.IN,
        limit: 1,
      }),
      revalidate: 0,
      tags: [tag("health")],
    });

    if (!outcome.ok) {
      // 403 here means the key was rejected — worth saying plainly, since the
      // fix is a different key rather than waiting for the source to recover.
      const detail =
        outcome.reason === "http_error" && outcome.status === 403
          ? "Last.fm rejected the API key (HTTP 403, error 10 'Invalid API key')."
          : `Last.fm unreachable: ${outcome.detail}`;
      return {
        source: "lastfm",
        ok: false,
        detail,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }
    if (outcome.data.error) {
      return {
        source: "lastfm",
        ok: false,
        detail: `Last.fm error ${outcome.data.error}: ${outcome.data.message ?? "no message"}`,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    const count = asArray(outcome.data.tracks?.track).length;
    return {
      source: "lastfm",
      ok: count > 0,
      detail:
        count > 0
          ? "Last.fm is answering with track data."
          : "Last.fm answered but returned no tracks for the probe country.",
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};
