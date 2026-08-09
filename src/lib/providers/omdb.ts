import "server-only";

import { keys, providerEnabled, REVALIDATE } from "@/lib/core/config";
import { buildUrl, fetchJson, timedFetchJson } from "@/lib/core/fetcher";
import {
  fromNumeric,
  ok,
  unavailable,
  type Maybe,
} from "@/lib/core/maybe";
import type {
  DeepLink,
  DetailsQuery,
  FilmRecord,
  HealthStatus,
  Provider,
  Rating,
  RatingScale,
  TrendingQuery,
} from "@/lib/core/types";

/**
 * OMDb — IMDb / Rotten Tomatoes / Metacritic scores, keyed on IMDb ID.
 *
 * OMDb is not a catalogue source for us. It has no charts, no discovery and no
 * TMDB IDs, so it contributes exactly one thing: the `Rating[]` for a title the
 * TMDB pipeline already found. `fetchRatings` is the real entry point;
 * the `Provider` surface below exists so /status can health-check it uniformly.
 *
 * Verified live 2026-08-02 (see FIELD NOTES at the bottom of this file):
 *   GET https://www.omdbapi.com/?i=tt0111161            -> 401
 *       {"Response":"False","Error":"No API key provided."}
 *   GET https://www.omdbapi.com/?apikey=deadbeef&i=...   -> 401
 *       {"Response":"False","Error":"Invalid API key!"}
 *
 * Attribution: content is CC BY-NC 4.0 and OMDb is explicitly "not endorsed by
 * or affiliated with IMDb.com" — so the UI credits OMDb, never IMDb directly.
 */

const OMDB_BASE = "https://www.omdbapi.com/";

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ *
 *
 * Free tier is 1,000 requests/day for the whole key — not per IP, not per
 * deploy. That is the hard ceiling on how many titles can carry a critic score.
 *
 * The critics leaderboard is the expensive consumer: BAYESIAN.criticsPoolSize
 * is 200, and every candidate needs its own OMDb lookup because OMDb has no
 * batch endpoint. One leaderboard rebuild therefore burns ~200 of the 1,000
 * daily calls — a fifth of the quota for a single weekly board, before any
 * title-detail page has asked for anything. Two rebuilds plus normal browsing
 * and the day is gone; every later caller gets "Request limit reached!" and the
 * UI degrades to "No score on file" for the rest of the day.
 *
 * The $1/month Patreon tier raises this to 100,000/day. For the one number this
 * whole product is built around, that is the cheapest line item in the stack.
 * Until then, MAX_IN_FLIGHT keeps us from hammering the endpoint (which is what
 * gets a free key rate-limited early) and every rebuild should be cached hard.
 */
const MAX_IN_FLIGHT = 5;

/* ------------------------------------------------------------------ *
 * Wire types — exactly what OMDb sends, nothing normalised yet
 * ------------------------------------------------------------------ */

interface OmdbRatingEntry {
  readonly Source?: string;
  readonly Value?: string;
}

interface OmdbTitlePayload {
  /**
   * OMDb's own success flag, sent as the STRING "True" / "False".
   * See CRITICAL below — this, not the HTTP status, decides success.
   */
  readonly Response?: string;
  readonly Error?: string;
  readonly imdbID?: string;
  readonly Title?: string;
  readonly Year?: string;
  readonly Type?: string;
  readonly imdbRating?: string;
  /** Comma-formatted, e.g. "2,943,101". `fromNumeric` strips the commas. */
  readonly imdbVotes?: string;
  readonly Metascore?: string;
  readonly Ratings?: readonly OmdbRatingEntry[];
}

/* ------------------------------------------------------------------ *
 * Rating-body mapping
 * ------------------------------------------------------------------ */

/**
 * OMDb's `Ratings[].Source` strings, mapped to our display labels and scales.
 * Metacritic arrives as "74/100" and is therefore already a percent — we
 * record scale "percent" and keep the numerator, we do not rescale anything.
 *
 * Anything OMDb sends whose Source is not in this table is DROPPED rather than
 * guessed at, because we would not know its scale, and a score on an unknown
 * scale is indistinguishable from a wrong score.
 */
interface RatingBody {
  readonly label: string;
  readonly scale: RatingScale;
}

const RATING_BODIES: Record<string, RatingBody> = {
  "Internet Movie Database": { label: "IMDb", scale: "ten" },
  "Rotten Tomatoes": { label: "Rotten Tomatoes", scale: "percent" },
  Metacritic: { label: "Metacritic", scale: "percent" },
};

/** The bodies we always report on, so the UI can say "not available" per body. */
const REPORTED_LABELS = ["IMDb", "Rotten Tomatoes", "Metacritic"] as const;

const SCALE_BY_LABEL: Record<string, RatingScale> = {
  IMDb: "ten",
  "Rotten Tomatoes": "percent",
  Metacritic: "percent",
};

/**
 * OMDb rating values arrive in three shapes: "8.5/10", "87%", "74/100".
 * We take the numerator; `fromNumeric` already strips "%" and thousands commas.
 *
 * Known, accepted trade-off: `fromNumeric` treats 0 as a sentinel for "unknown"
 * (TMDB uses vote_average 0 for unrated titles), so a genuine Rotten Tomatoes
 * 0% renders as "No score on file" rather than as a zero. We keep that
 * behaviour rather than special-casing it here, because inventing a bypass in
 * one adapter would make 0 mean two different things across the codebase.
 */
function parseRatingValue(raw: string | undefined): Maybe<number> {
  if (typeof raw !== "string") return unavailable("not_in_source");
  const numerator = raw.split("/")[0];
  return fromNumeric(numerator);
}

const imdbTitleUrl = (imdbId: string): string =>
  `https://www.imdb.com/title/${imdbId}/`;

/**
 * Build the per-body `sourceUrl`.
 *
 * IMDb: OMDb keys on the IMDb ID, so the canonical title URL is derivable and
 * real. Rotten Tomatoes and Metacritic: OMDb returns NO url for them, and their
 * slugs are not derivable from a title string. `unavailable("not_in_source")`
 * is the answer. We do NOT construct a guessed rottentomatoes.com/m/<slug> URL
 * (it would 404 more often than not), and we do not scrape rottentomatoes.com
 * anywhere in this codebase to fill the gap.
 */
function sourceUrlFor(label: string, imdbId: string): Maybe<string> {
  return label === "IMDb" ? ok(imdbTitleUrl(imdbId)) : unavailable("not_in_source");
}

/* ------------------------------------------------------------------ *
 * The one fetch
 * ------------------------------------------------------------------ */

type TitleOutcome =
  | { readonly kind: "ok"; readonly payload: OmdbTitlePayload }
  /** OMDb answered, and said it has nothing for this ID. */
  | { readonly kind: "not_found"; readonly detail: string }
  /** Transport, auth, quota or parse failure. */
  | { readonly kind: "error"; readonly detail: string };

/**
 * CRITICAL — OMDb signals failure in the BODY, not (only) in the status line.
 *
 * A successful-looking HTTP 200 can still carry
 *     {"Response":"False","Error":"Movie not found!"}
 *     {"Response":"False","Error":"Incorrect IMDb ID."}
 * so `response.ok` is NOT proof of a usable payload, and `fetchJson` returning
 * `{ ok: true }` is NOT proof either — it only proves the status was 2xx and
 * the body parsed as JSON. Every caller must check `Response === "False"`
 * before touching a single field. This is the one thing in this adapter that
 * will silently produce wrong ratings if it is ever removed.
 *
 * The auth/quota failures additionally come back as HTTP 401 with the same body
 * shape (verified live, see FIELD NOTES), so both paths are handled below.
 */
async function fetchTitle(imdbId: string): Promise<TitleOutcome> {
  if (!keys.omdb) {
    return { kind: "error", detail: "not_configured: OMDB_API_KEY is unset" };
  }

  const url = buildUrl(OMDB_BASE, {
    apikey: keys.omdb,
    i: imdbId,
    r: "json",
  });

  const outcome = await fetchJson<OmdbTitlePayload>({
    source: "omdb",
    url,
    // Ratings move slowly and the daily cap is tight, so we cache them for the
    // same window as the rest of a title's metadata.
    revalidate: REVALIDATE.titleDetails,
    tags: ["omdb", `omdb:${imdbId}`],
  });

  if (!outcome.ok) {
    // 401 here is auth OR quota: "No API key provided.", "Invalid API key!",
    // "Request limit reached!" all share this status.
    return { kind: "error", detail: outcome.detail };
  }

  const payload = outcome.data;

  // ---- the check the whole adapter hangs on ----
  if (payload?.Response === "False") {
    const message = typeof payload.Error === "string" ? payload.Error : "unknown OMDb error";
    // "Movie not found!" / "Incorrect IMDb ID." are answers, not outages.
    const isMiss = /not found|incorrect imdb id/i.test(message);
    return isMiss
      ? { kind: "not_found", detail: message }
      : { kind: "error", detail: `omdb: ${message}` };
  }

  if (!payload || typeof payload.imdbID !== "string") {
    return { kind: "error", detail: "omdb: payload had no imdbID" };
  }

  return { kind: "ok", payload };
}

/* ------------------------------------------------------------------ *
 * fetchRatings — the primary use
 * ------------------------------------------------------------------ */

/**
 * Ratings for one IMDb ID.
 *
 * Return contract, which the UI depends on:
 *   - `[]`                     -> we never got an answer (no key, HTTP failure,
 *                                 quota exhausted). The status page explains it.
 *   - non-empty array          -> OMDb answered. Every body in REPORTED_LABELS
 *                                 is present; a body OMDb had no score for
 *                                 carries `value: unavailable("not_in_source")`
 *                                 so the card can render "No score on file"
 *                                 instead of silently omitting the row.
 *
 * Nothing here is ever estimated, back-filled from another body, or defaulted.
 */
export async function fetchRatings(imdbId: string): Promise<readonly Rating[]> {
  const outcome = await fetchTitle(imdbId);

  if (outcome.kind === "error") return [];

  if (outcome.kind === "not_found") {
    // OMDb answered and genuinely has no entry: report every body as absent.
    return REPORTED_LABELS.map((label) => ({
      source: "omdb" as const,
      label,
      value: unavailable<number>("not_in_source"),
      scale: SCALE_BY_LABEL[label],
      voteCount: unavailable<number>("not_in_source"),
      sourceUrl: sourceUrlFor(label, imdbId),
    }));
  }

  return ratingsFromPayload(outcome.payload, imdbId);
}

function ratingsFromPayload(
  payload: OmdbTitlePayload,
  requestedImdbId: string,
): readonly Rating[] {
  // Prefer the ID OMDb echoed back; fall back to the one we asked for.
  const imdbId =
    typeof payload.imdbID === "string" && payload.imdbID.trim() !== ""
      ? payload.imdbID.trim()
      : requestedImdbId;

  // 1. Everything OMDb listed in `Ratings`, keyed by our label.
  const byLabel = new Map<string, Maybe<number>>();
  for (const entry of payload.Ratings ?? []) {
    const body = entry.Source ? RATING_BODIES[entry.Source] : undefined;
    if (!body) continue; // unknown scale -> dropped, never guessed
    byLabel.set(body.label, parseRatingValue(entry.Value));
  }

  // 2. The top-level `imdbRating` is the same number as the "Internet Movie
  //    Database" array entry, but it is the only place the vote count lives.
  //    Prefer it, and fall back to the array entry when it is "N/A".
  const topLevelImdb = fromNumeric(payload.imdbRating);
  const imdbValue =
    topLevelImdb.status === "ok"
      ? topLevelImdb
      : byLabel.get("IMDb") ?? unavailable<number>("not_in_source");
  byLabel.set("IMDb", imdbValue);

  // "2,943,101" -> 2943101. fromNumeric strips the commas for us.
  const imdbVotes = fromNumeric(payload.imdbVotes);

  return REPORTED_LABELS.map((label) => ({
    source: "omdb" as const,
    label,
    value: byLabel.get(label) ?? unavailable<number>("not_in_source"),
    scale: SCALE_BY_LABEL[label],
    // OMDb exposes a vote count for IMDb only. RT's critic count and
    // Metacritic's review count are simply not in the payload.
    voteCount: label === "IMDb" ? imdbVotes : unavailable<number>("not_in_source"),
    sourceUrl: sourceUrlFor(label, imdbId),
  }));
}

/* ------------------------------------------------------------------ *
 * fetchRatingsBatch — leaderboard path
 * ------------------------------------------------------------------ */

/**
 * Ratings for many IDs, at most `concurrency` requests in flight.
 *
 * OMDb has no batch endpoint, so N titles is genuinely N HTTP calls against the
 * daily cap documented at MAX_IN_FLIGHT. IDs that fail are absent from the map
 * (not present-with-empty-array), so the caller can tell "we did not ask / did
 * not get an answer" apart from "we asked and the score is not there".
 */
export async function fetchRatingsBatch(
  imdbIds: readonly string[],
  concurrency: number = MAX_IN_FLIGHT,
): Promise<Map<string, readonly Rating[]>> {
  const results = new Map<string, readonly Rating[]>();
  if (!providerEnabled.omdb || !keys.omdb) return results;

  // De-duplicate: a leaderboard pool can easily contain the same ID twice, and
  // each duplicate would otherwise cost a request against a 1,000/day cap.
  const unique = [...new Set(imdbIds.filter((id) => id.trim() !== ""))];
  const limit = Math.max(1, Math.min(concurrency, MAX_IN_FLIGHT));

  const pairs = await mapWithConcurrency(unique, limit, async (imdbId) => {
    const ratings = await fetchRatings(imdbId);
    return [imdbId, ratings] as const;
  });

  for (const [imdbId, ratings] of pairs) {
    if (ratings.length > 0) results.set(imdbId, ratings);
  }
  return results;
}

/**
 * Bounded-concurrency map. A fixed pool of `limit` workers pulls from a shared
 * cursor, so exactly `limit` requests are in flight at any moment — unlike
 * chunked `Promise.all`, which idles at the end of every chunk.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Provider surface
 * ------------------------------------------------------------------ */

export const omdbProvider: Provider<FilmRecord> = {
  id: "omdb",
  kind: "ratings",
  displayName: "OMDb",
  attribution: "Ratings via OMDb API (CC BY-NC 4.0). Not affiliated with IMDb.com.",

  isEnabled(): boolean {
    return providerEnabled.omdb && Boolean(keys.omdb);
  },

  /**
   * OMDb has no charts, no discovery and no trending endpoint of any kind —
   * `?s=` is a title search, not a ranking. There is nothing honest to return.
   */
  async fetchTrending(_query: TrendingQuery): Promise<readonly FilmRecord[]> {
    void _query;
    return [];
  },

  /**
   * Deliberately null, always.
   *
   * `FilmRecord.tmdbId` is a required `number` because the catalogue is keyed on
   * TMDB IDs, and an OMDb payload contains no TMDB ID and no way to derive one.
   * Returning a record would mean putting 0 or -1 in `tmdbId` — exactly the kind
   * of sentinel this codebase exists to avoid, and it would collide in any map
   * keyed on `key`. OMDb's contribution reaches a FilmRecord through
   * `fetchRatings`, called by the TMDB pipeline that already knows the tmdbId.
   */
  async fetchTitleDetails(_id: string, _query: DetailsQuery): Promise<FilmRecord | null> {
    void _id;
    void _query;
    return null;
  },

  /**
   * OMDb sells nothing and reports no availability. The IMDb title URL we can
   * derive is carried as the `sourceUrl` of the IMDb rating instead — putting it
   * in a DeepLink would force an `offerType`, and none of
   * subscription/rent/buy/free/ads/ticket/listen describes "information page".
   */
  async resolveDeepLink(_record: FilmRecord, _query: DetailsQuery): Promise<readonly DeepLink[]> {
    void _record;
    void _query;
    return [];
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!keys.omdb) {
      return {
        source: "omdb",
        ok: false,
        detail: "not_configured — OMDB_API_KEY is unset. Ratings will read 'Source not connected'.",
        latencyMs: unavailable<number>("not_configured"),
        checkedAt,
      };
    }
    if (!providerEnabled.omdb) {
      return {
        source: "omdb",
        ok: false,
        detail: "provider_disabled — OMDb is switched off in config.",
        latencyMs: unavailable<number>("provider_disabled"),
        checkedAt,
      };
    }

    // A stable, always-present title (The Shawshank Redemption). `revalidate: 0`
    // so the probe measures the upstream, not the Next.js data cache.
    const { outcome, latencyMs } = await timedFetchJson<OmdbTitlePayload>({
      source: "omdb",
      url: buildUrl(OMDB_BASE, { apikey: keys.omdb, i: "tt0111161", r: "json" }),
      revalidate: 0,
      timeoutMs: 5_000,
    });

    if (!outcome.ok) {
      const hint =
        outcome.status === 401
          ? " (401 = bad key, or the 1,000/day free-tier cap is spent)"
          : "";
      return {
        source: "omdb",
        ok: false,
        detail: `${outcome.detail}${hint}`,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    // 200 is not success here. Check the body.
    if (outcome.data?.Response === "False") {
      return {
        source: "omdb",
        ok: false,
        detail: `omdb: ${outcome.data.Error ?? "Response=False"}`,
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    return {
      source: "omdb",
      ok: true,
      detail: "OMDb reachable; ratings live.",
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};

/* ------------------------------------------------------------------ *
 * FIELD NOTES — verified live 2026-08-02, no key available
 * ------------------------------------------------------------------ *
 *
 * $ curl -s -w '%{http_code}' 'https://www.omdbapi.com/?i=tt0111161'
 *   401  {"Response":"False","Error":"No API key provided."}
 *
 * $ curl -s -w '%{http_code}' 'https://www.omdbapi.com/?apikey=&i=tt0111161'
 *   401  {"Response":"False","Error":"No API key provided."}
 *
 * $ curl -s -w '%{http_code}' 'https://www.omdbapi.com/?apikey=deadbeef&i=tt0111161'
 *   401  {"Response":"False","Error":"Invalid API key!"}
 *
 * Note the status: auth failures are 401, NOT 200. Both are handled — the 401
 * path via `fetchJson`'s http_error, the 200 + Response:"False" path via the
 * explicit body check in `fetchTitle`. The 200 + Response:"False" case (e.g.
 * "Movie not found!") could NOT be exercised without a key and is the one
 * behaviour in this file still taken on documentation rather than observation.
 *
 * Parameter names confirmed against https://www.omdbapi.com/ and
 * https://www.omdbapi.com/swagger.json (fetched 200): apikey, i, t, type, y,
 * plot, r, callback, v. Swagger declares exactly two responses for /?i —
 * "200 Successful operation" and "401 Not authenticated".
 */
