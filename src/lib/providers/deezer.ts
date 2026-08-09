import "server-only";

import { REVALIDATE, providerEnabled } from "../core/config";
import { buildUrl, fetchJson, timedFetchJson } from "../core/fetcher";
import { fromText, ok, unavailable } from "../core/maybe";
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
 * Deezer — public API, no key.
 *
 * ---------------------------------------------------------------------------
 * WHAT WE ACTUALLY MEASURED (live, from this network — see the session report)
 * ---------------------------------------------------------------------------
 * Deezer serves 200 OK for every endpoint below, but *strips the payload* from
 * its aggregated track/album collections while entity-scoped listings return in
 * full. This is not a rate limit and not an error — it is a silent empty list.
 *
 *   /chart/{genreId}/tracks        200  {"data":[],"total":0}     EMPTY
 *   /chart/{genreId}/albums        200  {"data":[],"total":0}     EMPTY
 *   /chart            (tracks)     200  tracks/albums empty       EMPTY
 *   /editorial/{id}/charts         200  tracks/albums empty       EMPTY
 *   /editorial/{id}/releases       200  {"data":[],"total":0}     EMPTY
 *   /search/track?q=…              200  data:[] but total:196     EMPTY
 *   /search/album?q=…              200  data:[] but total:83      EMPTY
 *
 *   /genre                         200  full genre list           OK
 *   /chart/{genreId}/playlists     200  full playlist list        OK
 *   /search/playlist?q=…           200  full playlist list        OK
 *   /user/637006841/playlists      200  all 102 chart playlists   OK
 *   /playlist/{id}                 200  full, tracks embedded     OK
 *   /playlist/{id}/tracks          200  full track objects        OK
 *   /track/{id}                    200  full track object         OK
 *   /album/{id}/tracks             200  full track objects        OK
 *
 * Adding a browser `User-Agent` + `Accept-Language` changed nothing: the chart
 * and track-search endpoints stayed empty byte-for-byte. So the empty charts
 * are a server-side decision about those endpoints, not a client-fingerprint
 * problem, and there is no header, parameter or index that unlocks them.
 *
 * ---------------------------------------------------------------------------
 * THE PATH THIS ADAPTER IS BUILT ON
 * ---------------------------------------------------------------------------
 * Deezer publishes its official country charts as playlists owned by the
 * first-party account "Deezer Charts" (user 637006841): "Top USA", "Top UK",
 * "Top Worldwide", 100 tracks each, ordered by chart position. Those playlists
 * return complete track objects. So:
 *
 *   COUNTRY axis  ->  /user/637006841/playlists  (discover the chart playlist
 *                     id at runtime by title — no playlist id is hard-coded)
 *                     then /playlist/{id}/tracks
 *   GENRE axis    ->  /chart/{genreId}/playlists (Deezer's own ranking of
 *                     playlists inside that genre) then the #1 playlist's
 *                     /playlist/{id}/tracks
 *
 * Rank is the track's position in the source playlist. For the country charts
 * that position IS the chart position. For the genre axis it is the ordering
 * Deezer itself gives the tracks inside the genre's top-ranked playlist — it is
 * read from the response, never computed or assigned by us.
 *
 * Nothing here is synthesised. If Deezer publishes no chart for the requested
 * country (India is one such country — Deezer does not operate there and there
 * is no "Top India") this returns an empty array, and the rail renders empty.
 * We do not fall back to "Top Worldwide" and pass it off as a country chart.
 *
 * CAVEAT ON PREVIEWS: Deezer preview URLs are signed and short-lived. Measured
 * live: `hdnea=exp=` is ~900s (15 min) after the request, and the URL returns
 * 200 audio/mpeg until then. REVALIDATE.musicCharts is 3600s, so a cached
 * preview URL is expired for most of its cache window. The URL is still real
 * data straight from Deezer so it is passed through as-is; the player must
 * treat a failed preview as unavailable rather than as a bug.
 */

const API = "https://api.deezer.com";
const WEB = "https://www.deezer.com";

/** First-party Deezer account that owns every official "Top …" chart playlist. */
const DEEZER_CHARTS_USER_ID = 637006841;

/**
 * ISO 3166-1 alpha-2 -> the exact playlist TITLE Deezer Charts publishes.
 *
 * These are endpoint identifiers, not data: the playlist *id* is still resolved
 * at runtime from /user/637006841/playlists, so if Deezer renumbers or retires
 * a chart we return empty rather than pointing at a stale id.
 *
 * Every entry below was read off a live /user/637006841/playlists response.
 * Deezer's own titles are inconsistent ("Top UK", "Top USA", "Top Czech
 * Republic"), which is why this cannot be generated from Intl.DisplayNames.
 *
 * Countries absent from this map have no Deezer chart. Notably: INDIA. Deezer
 * publishes no "Top India", so `fetchTrending({country:"IN"})` returns [].
 */
const CHART_PLAYLIST_TITLE_BY_COUNTRY: Readonly<Record<string, string>> = {
  DZ: "Top Algeria",
  AR: "Top Argentina",
  AU: "Top Australia",
  AT: "Top Austria",
  BE: "Top Belgium",
  BO: "Top Bolivia",
  BR: "Top Brazil",
  BG: "Top Bulgaria",
  CA: "Top Canada",
  CL: "Top Chile",
  CO: "Top Colombia",
  CR: "Top Costa Rica",
  HR: "Top Croatia",
  CZ: "Top Czech Republic",
  DK: "Top Denmark",
  EC: "Top Ecuador",
  EG: "Top Egypt",
  SV: "Top El Salvador",
  EE: "Top Estonia",
  FI: "Top Finland",
  FR: "Top France",
  DE: "Top Germany",
  GT: "Top Guatemala",
  HN: "Top Honduras",
  HU: "Top Hungary",
  ID: "Top Indonesia",
  IE: "Top Ireland",
  IL: "Top Israel",
  IT: "Top Italy",
  CI: "Top Ivory Coast",
  JM: "Top Jamaica",
  JP: "Top Japan",
  JO: "Top Jordan",
  KE: "Top Kenya",
  LV: "Top Latvia",
  LB: "Top Lebanon",
  LT: "Top Lithuania",
  MY: "Top Malaysia",
  MX: "Top Mexico",
  MA: "Top Morocco",
  NL: "Top Netherlands",
  NG: "Top Nigeria",
  NO: "Top Norway",
  PY: "Top Paraguay",
  PE: "Top Peru",
  PH: "Top Philippines",
  PL: "Top Poland",
  PT: "Top Portugal",
  RO: "Top Romania",
  RU: "Top Russia",
  SA: "Top Saudi Arabia",
  SN: "Top Senegal",
  RS: "Top Serbia",
  SG: "Top Singapore",
  SK: "Top Slovakia",
  SI: "Top Slovenia",
  ZA: "Top South Africa",
  KR: "Top South Korea",
  ES: "Top Spain",
  SE: "Top Sweden",
  CH: "Top Switzerland",
  TH: "Top Thailand",
  TN: "Top Tunisia",
  TR: "Top Turkey",
  GB: "Top UK",
  UA: "Top Ukraine",
  AE: "Top United Arab Emirates",
  US: "Top USA",
  VE: "Top Venezuela",
  /** Not an ISO country — an explicit opt-in for the global chart. */
  WW: "Top Worldwide",
};

/** Countries Deezer charts. Exported so the UI can hide the rail up front. */
export const DEEZER_CHART_COUNTRIES: readonly string[] = Object.keys(
  CHART_PLAYLIST_TITLE_BY_COUNTRY,
);

/* ------------------------------------------------------------------ *
 * Raw Deezer payloads
 * ------------------------------------------------------------------ */

/** Deezer reports failures inside a 200 body, so every payload may carry this. */
interface DeezerError {
  readonly type?: string;
  readonly message?: string;
  readonly code?: number;
}

interface DeezerList<T> {
  readonly data?: readonly T[];
  readonly total?: number;
  readonly error?: DeezerError;
}

interface DeezerArtistRef {
  readonly id?: number;
  readonly name?: string;
  readonly link?: string;
}

interface DeezerAlbumRef {
  readonly id?: number;
  readonly title?: string;
  readonly cover_xl?: string;
  readonly cover_big?: string;
  readonly cover_medium?: string;
  readonly cover_small?: string;
  readonly release_date?: string;
}

interface DeezerTrack {
  readonly id?: number;
  readonly title?: string;
  readonly title_short?: string;
  readonly link?: string;
  readonly duration?: number;
  /** Deezer's internal popularity index (0–1,000,000). NOT a play count. */
  readonly rank?: number;
  readonly preview?: string;
  readonly release_date?: string;
  readonly artist?: DeezerArtistRef;
  readonly album?: DeezerAlbumRef;
  readonly error?: DeezerError;
}

interface DeezerPlaylistRef {
  readonly id?: number;
  readonly title?: string;
  readonly nb_tracks?: number;
  readonly link?: string;
}

interface DeezerGenre {
  readonly id?: number;
  readonly name?: string;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? 50), 1), 100);

const normalise = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const tag = (...parts: (string | number)[]): string =>
  ["deezer", ...parts.map((p) => String(p))].join(":");

function provenanceFor(track: DeezerTrack, fetchedAt: string): Provenance {
  return {
    source: "deezer",
    fetchedAt,
    sourceUrl: track.link ?? `${WEB}/track/${track.id ?? ""}`,
  };
}

/** Deezer's own canonical link for the track. The only link we can verify. */
function deepLinksFor(track: DeezerTrack, fetchedAt: string): readonly DeepLink[] {
  const url = track.link ?? (track.id ? `${WEB}/track/${track.id}` : undefined);
  if (!url) return [];
  return [
    {
      platform: "deezer",
      platformName: "Deezer",
      url,
      offerType: "listen",
      price: unavailable<string>("not_in_source"),
      verified: true,
      provenance: provenanceFor(track, fetchedAt),
    },
  ];
}

/**
 * Map one Deezer track. Returns null when the source did not give us a title or
 * an artist — a record we cannot name is dropped, never filled in.
 *
 * `rank` is the caller-supplied 1-based position read from the source ordering.
 */
function mapTrack(
  track: DeezerTrack,
  rank: number,
  fetchedAt: string,
): TrackRecord | null {
  const id = track.id;
  const title = (track.title ?? track.title_short ?? "").trim();
  const artist = (track.artist?.name ?? "").trim();
  if (id === undefined || title === "" || artist === "") return null;

  const artwork =
    track.album?.cover_xl ??
    track.album?.cover_big ??
    track.album?.cover_medium ??
    track.album?.cover_small;

  return {
    key: `deezer:${id}`,
    sourceId: String(id),
    title,
    artist,
    album: fromText(track.album?.title),
    artworkUrl: fromText(artwork),
    previewUrl: fromText(track.preview),
    rank,
    /**
     * Deezer exposes no previous chart position anywhere in the public API, so
     * movement is genuinely not in the source. Airtime's own snapshot diffing
     * is what fills this in later; this adapter must not guess it.
     */
    movement: unavailable<Movement>("not_in_source"),
    /**
     * Deliberately NOT `track.rank`. Deezer's `rank` is an opaque internal
     * popularity index, not a number of plays. Reporting it as playCount would
     * put a fabricated-looking figure on the card.
     */
    playCount: unavailable<number>("not_in_source"),
    /** Playlist track objects carry no genre and we will not infer one. */
    genres: [],
    releaseDate: fromText(track.album?.release_date ?? track.release_date),
    links: deepLinksFor(track, fetchedAt),
    provenance: provenanceFor(track, fetchedAt),
  };
}

function mapTrackList(
  tracks: readonly DeezerTrack[],
  fetchedAt: string,
): readonly TrackRecord[] {
  const records: TrackRecord[] = [];
  tracks.forEach((track, index) => {
    // Position is taken from the source ordering; skipped rows keep their slot
    // so the remaining ranks stay faithful to the chart.
    const record = mapTrack(track, index + 1, fetchedAt);
    if (record) records.push(record);
  });
  return records;
}

/* ------------------------------------------------------------------ *
 * Chart resolution
 * ------------------------------------------------------------------ */

/** Resolve the Deezer Charts playlist id for a country, at runtime, by title. */
async function resolveCountryChartPlaylistId(
  country: string,
): Promise<number | null> {
  const wanted = CHART_PLAYLIST_TITLE_BY_COUNTRY[country.toUpperCase()];
  if (!wanted) return null;

  const outcome = await fetchJson<DeezerList<DeezerPlaylistRef>>({
    source: "deezer",
    url: buildUrl(`${API}/user/${DEEZER_CHARTS_USER_ID}/playlists`, { limit: 200 }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("charts-index")],
  });
  if (!outcome.ok || outcome.data.error) return null;

  const match = (outcome.data.data ?? []).find(
    (playlist) =>
      typeof playlist.title === "string" &&
      normalise(playlist.title) === normalise(wanted),
  );
  return match?.id ?? null;
}

/** Resolve a genre name to a Deezer genre id from the live /genre list. */
async function resolveGenreId(genre: string): Promise<number | null> {
  const outcome = await fetchJson<DeezerList<DeezerGenre>>({
    source: "deezer",
    url: `${API}/genre`,
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("genres")],
  });
  if (!outcome.ok || outcome.data.error) return null;

  const genres = (outcome.data.data ?? []).filter(
    (g): g is DeezerGenre & { id: number; name: string } =>
      typeof g.id === "number" && typeof g.name === "string",
  );
  const wanted = normalise(genre);
  return (
    genres.find((g) => normalise(g.name) === wanted)?.id ??
    genres.find((g) => normalise(g.name).includes(wanted))?.id ??
    null
  );
}

/** The #1 playlist in Deezer's own chart of playlists for that genre. */
async function resolveGenreChartPlaylistId(
  genreId: number,
): Promise<number | null> {
  const outcome = await fetchJson<DeezerList<DeezerPlaylistRef>>({
    source: "deezer",
    url: buildUrl(`${API}/chart/${genreId}/playlists`, { limit: 1 }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("genre-chart", genreId)],
  });
  if (!outcome.ok || outcome.data.error) return null;
  return outcome.data.data?.[0]?.id ?? null;
}

async function fetchPlaylistTracks(
  playlistId: number,
  limit: number,
): Promise<readonly TrackRecord[]> {
  const outcome = await fetchJson<DeezerList<DeezerTrack>>({
    source: "deezer",
    url: buildUrl(`${API}/playlist/${playlistId}/tracks`, { limit }),
    revalidate: REVALIDATE.musicCharts,
    tags: [tag("playlist", playlistId, limit)],
  });
  if (!outcome.ok || outcome.data.error) return [];
  return mapTrackList(outcome.data.data ?? [], outcome.fetchedAt);
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export const deezerProvider: Provider<TrackRecord> = {
  id: "deezer",
  kind: "music",
  displayName: "Deezer",
  attribution: "Charts and previews from Deezer",

  isEnabled(): boolean {
    return providerEnabled.deezer;
  },

  async fetchTrending(query: TrendingQuery): Promise<readonly TrackRecord[]> {
    if (!providerEnabled.deezer) return [];
    const limit = clampLimit(query.limit);

    if (query.genre && query.genre.trim() !== "") {
      const genreId = await resolveGenreId(query.genre);
      if (genreId === null) return [];
      const playlistId = await resolveGenreChartPlaylistId(genreId);
      if (playlistId === null) return [];
      return fetchPlaylistTracks(playlistId, limit);
    }

    const playlistId = await resolveCountryChartPlaylistId(query.country);
    // No Deezer chart for this country (e.g. IN). Empty rail, no substitute.
    if (playlistId === null) return [];
    return fetchPlaylistTracks(playlistId, limit);
  },

  async fetchTitleDetails(
    id: string,
    _query: DetailsQuery,
  ): Promise<TrackRecord | null> {
    void _query; // Deezer's public track endpoint takes no region parameter.
    if (!providerEnabled.deezer) return null;
    const trackId = id.replace(/^deezer:/, "").trim();
    if (!/^\d+$/.test(trackId)) return null;

    const outcome = await fetchJson<DeezerTrack>({
      source: "deezer",
      url: `${API}/track/${trackId}`,
      revalidate: REVALIDATE.musicCharts,
      tags: [tag("track", trackId)],
    });
    if (!outcome.ok || outcome.data.error) return null;

    /**
     * A single-track lookup has NO chart position. `TrackRecord.rank` is a bare
     * number, so 0 is used as the explicit "no position" marker — 0 is not a
     * real chart rank, so it cannot be mistaken for one. Callers rendering a
     * record from fetchTitleDetails must not display rank.
     */
    return mapTrack(outcome.data, 0, outcome.fetchedAt);
  },

  async resolveDeepLink(
    record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _query;
    // The Deezer link is already attached at map time and is the only outbound
    // link we can verify from this source.
    return record.links;
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!providerEnabled.deezer) {
      return {
        source: "deezer",
        ok: false,
        detail: "Deezer is turned off in config.",
        latencyMs: unavailable<number>("provider_disabled"),
        checkedAt,
      };
    }

    // Probe the endpoint we actually depend on.
    const { outcome, latencyMs } = await timedFetchJson<
      DeezerList<DeezerPlaylistRef>
    >({
      source: "deezer",
      url: buildUrl(`${API}/user/${DEEZER_CHARTS_USER_ID}/playlists`, { limit: 200 }),
      revalidate: 0,
      tags: [tag("health")],
    });

    if (!outcome.ok) {
      return {
        source: "deezer",
        ok: false,
        detail: `Deezer chart playlists unreachable: ${outcome.detail}`,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }
    if (outcome.data.error) {
      return {
        source: "deezer",
        ok: false,
        detail: `Deezer returned an error: ${outcome.data.error.message ?? "unknown"}`,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    const charts = (outcome.data.data ?? []).filter(
      (p) => typeof p.title === "string" && p.title.startsWith("Top "),
    ).length;

    if (charts === 0) {
      return {
        source: "deezer",
        ok: false,
        detail:
          "Deezer answered but published no chart playlists, so no track charts are available.",
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    // Second probe: has Deezer's native track chart come back to life? If it
    // ever returns rows, this line is how we find out — the status page tells
    // the truth about which path is serving the data.
    const native = await fetchJson<DeezerList<DeezerTrack>>({
      source: "deezer",
      url: buildUrl(`${API}/chart/0/tracks`, { limit: 1 }),
      revalidate: 0,
      tags: [tag("health-native-chart")],
    });
    const nativeEmpty =
      !native.ok || !!native.data.error || (native.data.data ?? []).length === 0;

    return {
      source: "deezer",
      ok: true,
      detail: nativeEmpty
        ? `Serving ${charts} Deezer chart playlists. Deezer's own /chart/{id}/tracks and /search/track still return empty from this network, so charts are read from the official Top-<country> playlists instead.`
        : `Serving ${charts} Deezer chart playlists. Deezer's native /chart/{id}/tracks is returning rows again and could now be used directly.`,
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};
