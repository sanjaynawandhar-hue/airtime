import "server-only";

import { keys, providerEnabled, REVALIDATE, WATCH_PROVIDERS } from "../core/config";
import { buildUrl, fetchJson, timedFetchJson, type FetchOutcome } from "../core/fetcher";
import {
  fromNullable,
  fromNumeric,
  fromText,
  ok,
  unavailable,
  valueOr,
  type Maybe,
} from "../core/maybe";
import type {
  CastMember,
  CountryCode,
  CriticReview,
  CrewMember,
  DeepLink,
  DetailsQuery,
  FilmDetails,
  FilmRecord,
  HealthStatus,
  LanguageCode,
  OfferType,
  OttContext,
  PlatformId,
  Provenance,
  Provider,
  Rating,
  TheatricalContext,
  Trailer,
  TrendingQuery,
} from "../core/types";
import type {
  TmdbConfiguration,
  TmdbDatedPaged,
  TmdbExternalIds,
  TmdbGenreList,
  TmdbMovieDetails,
  TmdbMovieListItem,
  TmdbPaged,
  TmdbReleaseDateEntry,
  TmdbReleaseDatesCountry,
  TmdbReleaseDatesResponse,
  TmdbVideo,
  TmdbWatchCountry,
  TmdbWatchProvidersResponse,
} from "./tmdb.types";

/**
 * TMDB adapter.
 *
 * Rules this file obeys without exception:
 *
 *  1. Nothing is invented. Every rating, vote count, certification, date, price
 *     and availability flag either came out of a TMDB response or is returned
 *     as `unavailable(...)`. There is no `?? 0`, no `?? "N/A"`, no placeholder
 *     poster, no default certification, no estimated price.
 *  2. `vote_average: 0` is TMDB's sentinel for "nobody has rated this", not a
 *     score of zero — `fromNumeric` rejects it, and a record whose rating is
 *     unavailable simply carries an empty `ratings` array rather than a 0.
 *  3. Availability is never inherited. A title's OTT offers come only from that
 *     title's `watch/providers` response, read at the user's own country key.
 *     No country key, no OTT card.
 *  4. No key means empty results, never a throw and never a fabricated payload.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const API = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

/**
 * How long after its local release date a film is still treated as being in
 * cinemas. Theatrical runs almost never exceed this, so past it we report the
 * release as history rather than as a current showing. Deliberately generous —
 * long-running Indian titles are common — and it is only ever the CLAIM that
 * changes, never the underlying date or certification.
 */
const THEATRICAL_RUN_DAYS = 90;

function isCurrentlyRunning(isoDate: string, now: number): boolean {
  const released = Date.parse(isoDate);
  if (Number.isNaN(released)) return false;
  // A future-dated release has not opened yet either.
  if (released > now) return false;
  return now - released <= THEATRICAL_RUN_DAYS * 24 * 60 * 60 * 1000;
}

const POSTER_SIZE = "w500";
const BACKDROP_SIZE = "w1280";
const PROFILE_SIZE = "w185";

/** TMDB caps list endpoints at 20 results per page. */
const PAGE_SIZE = 20;

/** Concurrent per-title confirmation requests. Keeps us under TMDB's limiter. */
const CONCURRENCY = 6;

const ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data provided by JustWatch.";

/** Cache tags, one per rail, so a single rail can be revalidated on demand. */
const tag = {
  theatrical: (country: CountryCode) => `tmdb:theatrical:${country.toUpperCase()}`,
  ott: (country: CountryCode) => `tmdb:ott:${country.toUpperCase()}`,
  upcoming: (country: CountryCode) => `tmdb:upcoming:${country.toUpperCase()}`,
  title: (id: number) => `tmdb:title:${id}`,
  poolTopRated: () => "tmdb:pool:top-rated",
  poolIndian: (language: string) => `tmdb:pool:indian:${language}`,
  genres: (language: string) => `tmdb:genres:${language}`,
  health: () => "tmdb:health",
} as const;

const TYPE_THEATRICAL_LIMITED = 2;
const TYPE_THEATRICAL = 3;

/* ------------------------------------------------------------------ *
 * Auth + low-level helpers
 * ------------------------------------------------------------------ */

function isConfigured(): boolean {
  return providerEnabled.tmdb && Boolean(keys.tmdb);
}

/** v4 Bearer only. The v3 `api_key` query param is never used. */
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${keys.tmdb ?? ""}` };
}

async function get<T>(
  url: string,
  revalidate: number,
  tags: readonly string[],
): Promise<FetchOutcome<T>> {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", detail: "TMDB_READ_TOKEN is not set" };
  }
  return fetchJson<T>({ source: "tmdb", url, headers: authHeaders(), revalidate, tags });
}

/** Bounded-parallelism map. Preserves input order. */
async function mapLimited<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const out = new Array<O>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    }),
  );
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? time : null;
}

/**
 * TMDB's release_dates entries are full timestamps ("2026-05-31T00:00:00.000Z")
 * while list endpoints send plain days. Normalise to the day only — a reformat,
 * never a substitution.
 */
function toIsoDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Base language subtag: "en-US" -> "en". */
function baseLanguage(value: string | undefined): string | undefined {
  const cleaned = nonEmpty(value);
  return cleaned ? cleaned.toLowerCase().split("-")[0] : undefined;
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

function imageUrl(path: string | null | undefined, size: string): Maybe<string> {
  const cleaned = nonEmpty(path);
  // A null poster_path means TMDB has no artwork. There is no placeholder.
  if (!cleaned) return unavailable("not_in_source");
  return ok(`${IMAGE_BASE}/${size}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`);
}

export const posterUrl = (path: string | null | undefined): Maybe<string> =>
  imageUrl(path, POSTER_SIZE);
export const backdropUrl = (path: string | null | undefined): Maybe<string> =>
  imageUrl(path, BACKDROP_SIZE);
export const profileUrl = (path: string | null | undefined): Maybe<string> =>
  imageUrl(path, PROFILE_SIZE);

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

const tmdbTitleUrl = (id: number): string => `https://www.themoviedb.org/movie/${id}`;

function provenanceFor(id: number, fetchedAt: string): Provenance {
  return { source: "tmdb", fetchedAt, sourceUrl: tmdbTitleUrl(id) };
}

/* ------------------------------------------------------------------ *
 * Genres
 * ------------------------------------------------------------------ */

/**
 * List endpoints return `genre_ids`, not names. We resolve them against TMDB's
 * own genre list rather than shipping a hard-coded id->name table that would
 * silently rot. If the lookup fails the record carries no genres at all — an
 * empty array is the honest answer, a guessed genre is not.
 */
async function loadGenreNames(language: string): Promise<Map<number, string>> {
  const url = buildUrl(`${API}/genre/movie/list`, { language });
  const outcome = await get<TmdbGenreList>(url, REVALIDATE.titleDetails, [tag.genres(language)]);
  const map = new Map<number, string>();
  if (!outcome.ok) return map;
  for (const genre of outcome.data.genres ?? []) {
    const name = nonEmpty(genre.name);
    if (typeof genre.id === "number" && name) map.set(genre.id, name);
  }
  return map;
}

function namesForGenreIds(
  ids: readonly number[] | undefined,
  lookup: Map<number, string>,
): readonly string[] {
  if (!ids) return [];
  const names: string[] = [];
  for (const id of ids) {
    const name = lookup.get(id);
    if (name) names.push(name);
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * Ratings
 * ------------------------------------------------------------------ */

/**
 * The TMDB user score. `fromNumeric` drops `vote_average: 0`, which TMDB sends
 * for every unrated title — that is an absence, not a zero. When the score is
 * absent the caller emits an empty ratings array rather than a rating with a
 * hole in it.
 */
function tmdbRating(
  item: { id: number; vote_average?: number; vote_count?: number },
): Rating {
  return {
    source: "tmdb",
    label: "TMDB users",
    value: fromNumeric(item.vote_average),
    scale: "ten",
    voteCount: fromNumeric(item.vote_count),
    sourceUrl: ok(tmdbTitleUrl(item.id)),
  };
}

function ratingsFor(item: { id: number; vote_average?: number; vote_count?: number }): readonly Rating[] {
  const rating = tmdbRating(item);
  return rating.value.status === "ok" ? [rating] : [];
}

/* ------------------------------------------------------------------ *
 * Release-date resolution
 * ------------------------------------------------------------------ */

export interface ReleasePick {
  /** ISO day, exactly as TMDB reported it (trimmed to the day). */
  readonly date: string;
  readonly type: number;
  readonly certification: string | undefined;
  /** The country whose release_dates block this actually came from. */
  readonly fromCountry: string;
}

function countryBlock(
  results: readonly TmdbReleaseDatesCountry[] | undefined,
  country: CountryCode,
): TmdbReleaseDatesCountry | undefined {
  const wanted = country.toUpperCase();
  return results?.find((entry) => entry.iso_3166_1?.toUpperCase() === wanted);
}

function firstCertification(entries: readonly TmdbReleaseDateEntry[]): string | undefined {
  for (const entry of entries) {
    const certification = nonEmpty(entry.certification);
    if (certification) return certification;
  }
  return undefined;
}

/**
 * Pick the cinema release for `country`.
 *
 * Only types 2 (limited) and 3 (theatrical) qualify — a title whose country
 * block holds nothing but type 4 (digital) or 6 (TV) never had a cinema run
 * here and is dropped from the theatrical rail entirely.
 *
 * Where a country has several qualifying entries (re-releases, limited-then-wide
 * rollouts) we take the most recent one already in the past, because that is the
 * run the user can currently buy a ticket for; if every qualifying entry is in
 * the future we take the earliest of those instead.
 */
function pickTheatricalRelease(
  results: readonly TmdbReleaseDatesCountry[] | undefined,
  country: CountryCode,
  now: number,
): ReleasePick | null {
  const block = countryBlock(results, country);
  if (!block) return null;

  const entries = block.release_dates ?? [];
  const qualifying = entries
    .map((entry) => ({ entry, time: parseTime(entry.release_date) }))
    .filter(
      (candidate) =>
        candidate.time !== null &&
        (candidate.entry.type === TYPE_THEATRICAL ||
          candidate.entry.type === TYPE_THEATRICAL_LIMITED),
    ) as ReadonlyArray<{ entry: TmdbReleaseDateEntry; time: number }>;

  if (qualifying.length === 0) return null;

  const past = qualifying.filter((c) => c.time <= now).sort((a, b) => b.time - a.time);
  const future = qualifying.filter((c) => c.time > now).sort((a, b) => a.time - b.time);
  const chosen = past[0] ?? future[0];

  const rawDate = nonEmpty(chosen.entry.release_date);
  if (!rawDate) return null;

  return {
    date: toIsoDay(rawDate),
    type: chosen.entry.type ?? TYPE_THEATRICAL,
    // Prefer the certification attached to the run we picked; otherwise any
    // certification this country's board issued for the title.
    certification: nonEmpty(chosen.entry.certification) ?? firstCertification(entries),
    fromCountry: (block.iso_3166_1 ?? country).toUpperCase(),
  };
}

/**
 * Pick the release the upcoming rail should sort on: the earliest date for this
 * country that has not happened yet, preferring cinema types when the country
 * block offers both a cinema and a digital date on different days. Titles with
 * no dated entry for the country are dropped — the rail's entire claim is
 * "this is when it opens where you are", and we will not fabricate that from
 * the global `release_date`.
 */
function pickUpcomingRelease(
  results: readonly TmdbReleaseDatesCountry[] | undefined,
  country: CountryCode,
  now: number,
): ReleasePick | null {
  const block = countryBlock(results, country);
  if (!block) return null;

  const entries = block.release_dates ?? [];
  const dated = entries
    .map((entry) => ({ entry, time: parseTime(entry.release_date) }))
    .filter((candidate) => candidate.time !== null) as ReadonlyArray<{
    entry: TmdbReleaseDateEntry;
    time: number;
  }>;
  if (dated.length === 0) return null;

  const future = dated.filter((c) => c.time >= now).sort((a, b) => a.time - b.time);
  const cinemaFuture = future.filter(
    (c) => c.entry.type === TYPE_THEATRICAL || c.entry.type === TYPE_THEATRICAL_LIMITED,
  );
  const chosen =
    cinemaFuture[0] ?? future[0] ?? [...dated].sort((a, b) => b.time - a.time)[0];

  const rawDate = nonEmpty(chosen.entry.release_date);
  if (!rawDate) return null;

  return {
    date: toIsoDay(rawDate),
    type: chosen.entry.type ?? 0,
    certification: nonEmpty(chosen.entry.certification) ?? firstCertification(entries),
    fromCountry: (block.iso_3166_1 ?? country).toUpperCase(),
  };
}

function releaseTypeLabel(type: number): Maybe<"theatrical" | "theatrical_limited"> {
  if (type === TYPE_THEATRICAL) return ok("theatrical");
  if (type === TYPE_THEATRICAL_LIMITED) return ok("theatrical_limited");
  return unavailable("not_in_source");
}

async function fetchReleaseDates(
  tmdbId: number,
  revalidate: number,
  tags: readonly string[],
): Promise<TmdbReleaseDatesResponse | null> {
  const outcome = await get<TmdbReleaseDatesResponse>(
    `${API}/movie/${tmdbId}/release_dates`,
    revalidate,
    tags,
  );
  return outcome.ok ? outcome.data : null;
}

/* ------------------------------------------------------------------ *
 * BookMyShow — search fallback, never an availability claim
 * ------------------------------------------------------------------ */

/**
 * BookMyShow has no public API and we hold no licence for their showtimes or
 * their ratings, so this is a SEARCH url and nothing more: it drops the user on
 * BMS's own movie search for the title, and BMS decides whether it has anything.
 *
 * `verified: false` is therefore mandatory. We are not claiming the title is
 * bookable, we are claiming we know where to look. `price` is unavailable for
 * the same reason — we have never seen a ticket price. No showtime, no seat
 * count, and no BMS rating is ever carried on this link.
 *
 * URL shape: in.bookmyshow.com/explore/movies + `q`. The city-scoped variant
 * (`/explore/movies-{citySlug}?q=`) could NOT be confirmed — BookMyShow answers
 * automated requests with HTTP 403 (bot protection), for both the city-scoped
 * and the plain path. Per brief, we therefore ship the unscoped path.
 */
function bookMyShowSearchLink(title: string, fetchedAt: string): DeepLink {
  const url = `https://in.bookmyshow.com/explore/movies?q=${encodeURIComponent(title)}`;
  return {
    platform: "bookmyshow",
    platformName: "BookMyShow",
    url,
    offerType: "ticket",
    price: unavailable("not_licensed"),
    verified: false,
    provenance: {
      // Constructed by us, not returned by any source — attributed accordingly.
      source: "airtime",
      fetchedAt,
      sourceUrl: url,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rail 1 — theatrical
 * ------------------------------------------------------------------ */

/** How many days of decay the recency term spans. See the ranking note below. */
const RECENCY_WINDOW_DAYS = 45;
const WEIGHT_POPULARITY = 0.6;
const WEIGHT_RECENCY = 0.4;
const MS_PER_DAY = 86_400_000;

/** Min-max normalise to 0-1. A flat set carries no signal, so it scores 1 flat. */
function normalise(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const range = max - min;
  if (range <= 0) return 1;
  return (value - min) / range;
}

interface TheatricalCandidate {
  readonly item: TmdbMovieListItem;
  readonly release: ReleasePick;
  readonly popularity: number;
}

/**
 * WHAT THE THEATRICAL RANK MEANS
 * ------------------------------
 * "What is worth going to the cinema for this week, in your country."
 *
 * It is NOT a quality ranking and NOT a box-office ranking — we have neither
 * gross receipts nor an admissions feed, and we will not proxy them with a
 * rating. It is a blend of exactly two things TMDB genuinely reports:
 *
 *   score = 0.6 * popularityNorm + 0.4 * recencyNorm
 *
 *   popularityNorm  TMDB's own `popularity` field, min-max normalised to 0-1
 *                   across the candidate set that survived the release-type
 *                   filter (NOT across all of TMDB — the number is only
 *                   comparable within one fetch).
 *   recencyNorm     1 at the country release date, falling linearly to 0 at
 *                   RECENCY_WINDOW_DAYS (45) days after it, clamped at both
 *                   ends. Measured from the country-specific date out of
 *                   release_dates, never the global `release_date`.
 *
 * Why 0.6 / 0.4: popularity is the stronger signal of what people actually
 * want to see, so it leads; but popularity alone pins a blockbuster to the top
 * of the rail for its entire multi-month run and buries everything that opened
 * on Friday, which is the opposite of what a "now in cinemas" rail is for. The
 * 0.4 recency term is large enough to lift a fresh release above a stale hit
 * of similar draw, and small enough that a genuinely dominant title still wins
 * its opening month.
 *
 * Why 45 days: that is roughly the theatrical window before the digital drop in
 * the markets we serve, so a title at day 45 has effectively stopped being a
 * cinema recommendation and its recency contribution should have reached zero.
 *
 * Titles whose country release date is unparseable contribute no recency term
 * at all: they are scored on popularity alone (renormalised), rather than being
 * handed a made-up date or a default recency of 0.
 */
function scoreTheatrical(candidate: TheatricalCandidate, min: number, max: number, now: number): number {
  const popularityNorm = normalise(candidate.popularity, min, max);
  const releaseTime = parseTime(candidate.release.date);
  if (releaseTime === null) {
    // No usable date -> popularity only, weights renormalised to sum to 1.
    return popularityNorm;
  }
  const daysSince = (now - releaseTime) / MS_PER_DAY;
  const recencyNorm = Math.max(0, Math.min(1, 1 - daysSince / RECENCY_WINDOW_DAYS));
  return WEIGHT_POPULARITY * popularityNorm + WEIGHT_RECENCY * recencyNorm;
}

export async function fetchTheatrical(
  country: CountryCode,
  limit: number,
): Promise<readonly FilmRecord[]> {
  if (!isConfigured()) return [];
  const wanted = clampInt(limit, 0, 100);
  if (wanted === 0) return [];

  const tags = [tag.theatrical(country)];
  // Over-fetch: the release-type cross-check drops a meaningful share of
  // now_playing (digital-only titles, closed windows), so one page of 20 does
  // not reliably yield 20 survivors.
  const pages = clampInt(Math.ceil((wanted * 2) / PAGE_SIZE), 1, 3);

  const pageOutcomes = await Promise.all(
    Array.from({ length: pages }, (_unused, index) =>
      get<TmdbDatedPaged<TmdbMovieListItem>>(
        buildUrl(`${API}/movie/now_playing`, {
          region: country.toUpperCase(),
          language: "en-US",
          page: index + 1,
        }),
        REVALIDATE.theatrical,
        tags,
      ),
    ),
  );

  const firstOk = pageOutcomes.find((outcome) => outcome.ok);
  if (!firstOk || !firstOk.ok) return [];
  const fetchedAt = firstOk.fetchedAt;

  const seen = new Set<number>();
  const items: TmdbMovieListItem[] = [];
  for (const outcome of pageOutcomes) {
    if (!outcome.ok) continue;
    for (const item of outcome.data.results ?? []) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  if (items.length === 0) return [];

  const now = Date.now();

  // Cross-check every candidate against its own release_dates. This is the step
  // that keeps digital-only titles and closed theatrical windows off the rail.
  const picks = await mapLimited(items, CONCURRENCY, async (item) => {
    const response = await fetchReleaseDates(item.id, REVALIDATE.theatrical, tags);
    return pickTheatricalRelease(response?.results, country, now);
  });

  const candidates: TheatricalCandidate[] = [];
  items.forEach((item, index) => {
    const release = picks[index];
    if (!release) return;
    candidates.push({
      item,
      release,
      // Read for ranking only — never rendered. valueOr is sanctioned for this.
      popularity: valueOr(fromNumeric(item.popularity), 0),
    });
  });
  if (candidates.length === 0) return [];

  const popularities = candidates.map((candidate) => candidate.popularity);
  const minPopularity = Math.min(...popularities);
  const maxPopularity = Math.max(...popularities);

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreTheatrical(candidate, minPopularity, maxPopularity, now),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, wanted);

  const genreLookup = await loadGenreNames("en-US");

  return ranked.map(({ candidate }, index) => {
    const { item, release } = candidate;
    const availability: TheatricalContext = {
      kind: "theatrical",
      country: release.fromCountry,
      // Sourced from /movie/now_playing — TMDB's own statement that this title
      // is in cinemas right now.
      currentlyRunning: true,
      releaseDate: ok(release.date),
      releaseType: releaseTypeLabel(release.type),
      certification: fromNullable(release.certification),
      booking:
        // BookMyShow is India-only. No other market gets a booking link,
        // because we have no search endpoint we can stand behind there.
        country.toUpperCase() === "IN" && nonEmpty(item.title)
          ? ok(bookMyShowSearchLink(item.title as string, fetchedAt))
          : unavailable("not_in_source"),
    };

    return {
      ...baseRecord(item, genreLookup, fetchedAt),
      // Position in this rail under the documented score above. It is our
      // ordering, not a chart position TMDB published.
      rank: ok(index + 1),
      ratings: ratingsFor(item),
      availability,
      rail: "theatrical",
    } satisfies FilmRecord;
  });
}

/* ------------------------------------------------------------------ *
 * Rail 2 — OTT
 * ------------------------------------------------------------------ */

const PLATFORM_IDS: ReadonlySet<string> = new Set<PlatformId>([
  "netflix",
  "prime",
  "jiohotstar",
  "sonyliv",
  "zee5",
  "appletv",
  "youtube",
  "apple-music",
  "spotify",
  "deezer",
  "gaana",
  "bookmyshow",
  "tmdb",
  "imdb",
]);

function toPlatformId(value: string): PlatformId | null {
  return PLATFORM_IDS.has(value) ? (value as PlatformId) : null;
}

/**
 * TMDB provider id -> our PlatformId, built from the configured allowlist in
 * config.ts. A provider we have no PlatformId for is omitted from the offers
 * rather than coerced into a neighbouring platform's identity.
 */
const PLATFORM_BY_TMDB_ID: ReadonlyMap<number, PlatformId> = new Map(
  WATCH_PROVIDERS.flatMap((entry) => {
    const platform = toPlatformId(entry.platform);
    return platform ? ([[entry.tmdbProviderId, platform]] as [number, PlatformId][]) : [];
  }),
);

/** TMDB's monetisation buckets, mapped 1:1 onto our OfferType. */
const OFFER_BUCKETS: ReadonlyArray<{ key: keyof TmdbWatchCountry; offerType: OfferType }> = [
  { key: "flatrate", offerType: "subscription" },
  { key: "free", offerType: "free" },
  { key: "ads", offerType: "ads" },
  { key: "rent", offerType: "rent" },
  { key: "buy", offerType: "buy" },
];

/**
 * Turn one country block of watch/providers into DeepLinks.
 *
 * `verified: true` here and only here: this came from TMDB's licensed
 * availability feed (JustWatch), so we are entitled to say the title is on that
 * service. Note that TMDB exposes a single country-level `link` (the JustWatch
 * -backed watch page) and no per-provider deep link, so every offer points at
 * that page — we do not synthesise netflix.com/title/... style URLs.
 *
 * TMDB does not return prices on this endpoint, so `price` is always
 * unavailable. If TMDB ever starts sending one it will need reading here; until
 * then there is nothing to read and nothing to invent.
 */
function offersFromWatchCountry(
  block: TmdbWatchCountry,
  fetchedAt: string,
): readonly DeepLink[] {
  const link = nonEmpty(block.link);
  // No outbound URL means we cannot honestly offer a link at all.
  if (!link) return [];

  const provenance: Provenance = { source: "tmdb", fetchedAt, sourceUrl: link };
  const offers: DeepLink[] = [];
  const seen = new Set<string>();

  for (const bucket of OFFER_BUCKETS) {
    const providers = block[bucket.key];
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
      if (typeof provider.provider_id !== "number") continue;
      const platform = PLATFORM_BY_TMDB_ID.get(provider.provider_id);
      if (!platform) continue;
      const dedupeKey = `${platform}:${bucket.offerType}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      offers.push({
        platform,
        platformName: nonEmpty(provider.provider_name) ?? platform,
        url: link,
        offerType: bucket.offerType,
        price: unavailable("not_in_source"),
        verified: true,
        provenance,
      });
    }
  }
  return offers;
}

export async function fetchOtt(
  country: CountryCode,
  limit: number,
  providerIds?: readonly number[],
): Promise<readonly FilmRecord[]> {
  if (!isConfigured()) return [];
  const wanted = clampInt(limit, 0, 100);
  if (wanted === 0) return [];

  const region = country.toUpperCase();
  const tags = [tag.ott(country)];
  const ids =
    providerIds && providerIds.length > 0
      ? providerIds
      : WATCH_PROVIDERS.filter((entry) => entry.regions.includes(region)).map(
          (entry) => entry.tmdbProviderId,
        );

  const requests: Array<Promise<FetchOutcome<TmdbPaged<TmdbMovieListItem>>>> = [
    get<TmdbPaged<TmdbMovieListItem>>(
      buildUrl(`${API}/trending/movie/week`, { language: "en-US" }),
      REVALIDATE.ott,
      tags,
    ),
  ];
  if (ids.length > 0) {
    requests.push(
      get<TmdbPaged<TmdbMovieListItem>>(
        buildUrl(`${API}/discover/movie`, {
          // `|` is TMDB's OR separator: on ANY of these services.
          with_watch_providers: ids.join("|"),
          watch_region: region,
          watch_monetization_types: "flatrate",
          sort_by: "popularity.desc",
          language: "en-US",
          page: 1,
        }),
        REVALIDATE.ott,
        tags,
      ),
    );
  }

  const outcomes = await Promise.all(requests);
  const firstOk = outcomes.find((outcome) => outcome.ok);
  if (!firstOk || !firstOk.ok) return [];
  const fetchedAt = firstOk.fetchedAt;

  const seen = new Set<number>();
  const merged: TmdbMovieListItem[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    for (const item of outcome.data.results ?? []) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  if (merged.length === 0) return [];

  // Ordering rule for this rail: TMDB `popularity`, descending. The two source
  // lists have different native orderings, so neither one's order survives the
  // merge; popularity is the one comparable number both carry.
  merged.sort((a, b) => valueOr(fromNumeric(b.popularity), 0) - valueOr(fromNumeric(a.popularity), 0));

  // Bound the confirmation fan-out: many candidates will not be streaming here.
  const candidates = merged.slice(0, Math.min(merged.length, wanted * 3));

  const confirmations = await mapLimited(candidates, CONCURRENCY, async (item) => {
    const outcome = await get<TmdbWatchProvidersResponse>(
      `${API}/movie/${item.id}/watch/providers`,
      REVALIDATE.watchProviders,
      tags,
    );
    if (!outcome.ok) return null;
    // Read the user's country key and ONLY the user's country key. Availability
    // is never inherited from another region or from the theatrical pipeline.
    const block = outcome.data.results?.[region];
    if (!block) return null;
    const offers = offersFromWatchCountry(block, outcome.fetchedAt);
    if (offers.length === 0) return null;
    return { offers, justWatchUrl: fromText(block.link) };
  });

  const genreLookup = await loadGenreNames("en-US");
  const records: FilmRecord[] = [];

  candidates.forEach((item, index) => {
    if (records.length >= wanted) return;
    const confirmation = confirmations[index];
    // No entry for this country -> dropped from the OTT rail entirely.
    if (!confirmation) return;

    const availability: OttContext = {
      kind: "ott",
      country: region,
      offers: confirmation.offers,
      justWatchUrl: confirmation.justWatchUrl,
    };

    records.push({
      ...baseRecord(item, genreLookup, fetchedAt),
      // Position under the documented popularity ordering above.
      rank: ok(records.length + 1),
      ratings: ratingsFor(item),
      availability,
      rail: "ott",
    });
  });

  return records;
}

/* ------------------------------------------------------------------ *
 * Rail 3 — upcoming
 * ------------------------------------------------------------------ */

export async function fetchUpcoming(
  country: CountryCode,
  limit: number,
): Promise<readonly FilmRecord[]> {
  if (!isConfigured()) return [];
  const wanted = clampInt(limit, 0, 100);
  if (wanted === 0) return [];

  const tags = [tag.upcoming(country)];
  const pages = clampInt(Math.ceil((wanted * 2) / PAGE_SIZE), 1, 3);

  const pageOutcomes = await Promise.all(
    Array.from({ length: pages }, (_unused, index) =>
      get<TmdbDatedPaged<TmdbMovieListItem>>(
        buildUrl(`${API}/movie/upcoming`, {
          region: country.toUpperCase(),
          language: "en-US",
          page: index + 1,
        }),
        REVALIDATE.upcoming,
        tags,
      ),
    ),
  );

  const firstOk = pageOutcomes.find((outcome) => outcome.ok);
  if (!firstOk || !firstOk.ok) return [];
  const fetchedAt = firstOk.fetchedAt;

  const seen = new Set<number>();
  const items: TmdbMovieListItem[] = [];
  for (const outcome of pageOutcomes) {
    if (!outcome.ok) continue;
    for (const item of outcome.data.results ?? []) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  if (items.length === 0) return [];

  const now = Date.now();
  const picks = await mapLimited(items, CONCURRENCY, async (item) => {
    const response = await fetchReleaseDates(item.id, REVALIDATE.upcoming, tags);
    return pickUpcomingRelease(response?.results, country, now);
  });

  const dated: Array<{ item: TmdbMovieListItem; release: ReleasePick; time: number }> = [];
  items.forEach((item, index) => {
    const release = picks[index];
    if (!release) return;
    const time = parseTime(release.date);
    if (time === null) return;
    dated.push({ item, release, time });
  });
  if (dated.length === 0) return [];

  // Ordered strictly by the COUNTRY-SPECIFIC date, soonest first.
  dated.sort((a, b) => a.time - b.time);
  const chosen = dated.slice(0, wanted);

  const genreLookup = await loadGenreNames("en-US");

  return chosen.map(({ item, release }, index) => {
    const availability: TheatricalContext = {
      kind: "theatrical",
      country: release.fromCountry,
      // Upcoming by construction — it has not opened yet.
      currentlyRunning: false,
      releaseDate: ok(release.date),
      releaseType: releaseTypeLabel(release.type),
      certification: fromNullable(release.certification),
      // Nothing is on sale yet as far as any source we hold can tell us.
      booking: unavailable("not_in_source"),
    };

    return {
      ...baseRecord(item, genreLookup, fetchedAt),
      // Position by country release date, soonest first.
      rank: ok(index + 1),
      // MANDATORY: an unreleased film has no ratings. TMDB will happily report a
      // vote_average from a handful of festival/pre-release votes; we do not
      // carry it, because a score on an unreleased title is meaningless.
      ratings: [],
      availability,
      rail: "upcoming",
    } satisfies FilmRecord;
  });
}

/* ------------------------------------------------------------------ *
 * Shared record builder
 * ------------------------------------------------------------------ */

function baseRecord(
  item: TmdbMovieListItem,
  genreLookup: Map<number, string>,
  fetchedAt: string,
): Omit<FilmRecord, "rail" | "availability" | "rank" | "ratings"> {
  return {
    key: `tmdb:${item.id}`,
    tmdbId: item.id,
    // List endpoints never carry an IMDb id. Details does.
    imdbId: unavailable("not_in_source"),
    title: nonEmpty(item.title) ?? nonEmpty(item.original_title) ?? `TMDB ${item.id}`,
    originalTitle: fromText(item.original_title),
    originalLanguage: fromText(item.original_language),
    overview: fromText(item.overview),
    posterUrl: posterUrl(item.poster_path),
    backdropUrl: backdropUrl(item.backdrop_path),
    genres: namesForGenreIds(item.genre_ids, genreLookup),
    // Not present on list endpoints.
    runtimeMinutes: unavailable("not_in_source"),
    // Divergence needs a critic score AND an audience score. TMDB has only the
    // audience side, so it is never computable from this provider alone.
    divergence: unavailable("not_in_source"),
    // Movement needs a previous snapshot, which lives in our own store, not here.
    movement: unavailable("not_in_source"),
    provenance: provenanceFor(item.id, fetchedAt),
  };
}

/* ------------------------------------------------------------------ *
 * Title details
 * ------------------------------------------------------------------ */

/** Crew roles we surface, matched on TMDB's `job` string — never by position. */
const CREW_JOBS: ReadonlyArray<{ readonly role: string; readonly jobs: readonly string[] }> = [
  { role: "director", jobs: ["Director"] },
  { role: "writer", jobs: ["Screenplay", "Writer", "Story"] },
  { role: "composer", jobs: ["Original Music Composer", "Music"] },
  { role: "cinematographer", jobs: ["Director of Photography"] },
  { role: "producer", jobs: ["Producer"] },
];

function selectCrew(details: TmdbMovieDetails): readonly CrewMember[] {
  const crew = details.credits?.crew ?? [];
  const out: CrewMember[] = [];
  const seen = new Set<string>();

  for (const { jobs } of CREW_JOBS) {
    for (const member of crew) {
      const job = nonEmpty(member.job);
      const name = nonEmpty(member.name);
      if (!job || !name) continue;
      // Exact job match. Position in the array means nothing in TMDB's payload.
      if (!jobs.some((wanted) => wanted.toLowerCase() === job.toLowerCase())) continue;
      const dedupeKey = `${member.id}:${job.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        personId: member.id,
        name,
        job,
        department: nonEmpty(member.department) ?? job,
        profileUrl: profileUrl(member.profile_path),
      });
    }
  }
  return out;
}

function selectCast(details: TmdbMovieDetails): readonly CastMember[] {
  return (details.credits?.cast ?? [])
    .filter((member) => typeof member.id === "number" && nonEmpty(member.name))
    .map((member, index) => ({
      personId: member.id,
      name: member.name as string,
      character: fromText(member.character),
      profileUrl: profileUrl(member.profile_path),
      // TMDB's own billing order where it sent one; otherwise the order it
      // listed them in. Not a rank we made up.
      order: typeof member.order === "number" ? member.order : index,
    }))
    .sort((a, b) => a.order - b.order);
}

function toTrailer(video: TmdbVideo): Maybe<Trailer> {
  const key = nonEmpty(video.key);
  const name = nonEmpty(video.name);
  if (!key || !name) return unavailable("not_in_source");
  return ok({
    youtubeKey: key,
    name,
    language: fromText(video.iso_639_1),
    official: video.official === true,
    publishedAt: fromText(video.published_at),
  });
}

/**
 * Trailer preference, in order:
 *   1. official Trailer in the requested language
 *   2. official Trailer in the film's original language
 *   3. any Trailer
 *   4. any Teaser
 * Nothing matching means `unavailable` — we do not fall back to a clip, a
 * featurette or a random YouTube search.
 */
function selectTrailer(details: TmdbMovieDetails, language: LanguageCode | undefined): Maybe<Trailer> {
  const videos = (details.videos?.results ?? []).filter(
    (video) => nonEmpty(video.site)?.toLowerCase() === "youtube" && nonEmpty(video.key),
  );
  if (videos.length === 0) return unavailable("not_in_source");

  const wantedLanguage = baseLanguage(language);
  const originalLanguage = baseLanguage(details.original_language);
  const isTrailer = (video: TmdbVideo) => nonEmpty(video.type)?.toLowerCase() === "trailer";
  const isTeaser = (video: TmdbVideo) => nonEmpty(video.type)?.toLowerCase() === "teaser";

  const officialInLanguage = (lang: string | undefined) =>
    lang
      ? videos.find(
          (video) => isTrailer(video) && video.official === true && baseLanguage(video.iso_639_1) === lang,
        )
      : undefined;

  const chosen =
    officialInLanguage(wantedLanguage) ??
    officialInLanguage(originalLanguage) ??
    videos.find(isTrailer) ??
    videos.find(isTeaser);

  return chosen ? toTrailer(chosen) : unavailable("not_in_source");
}

/**
 * TMDB reviews -> CriticReview.
 *
 * `publication` is unavailable because TMDB has no publication field: its
 * reviews come from TMDB user accounts, and passing a username off as a masthead
 * would be a fabricated attribution.
 *
 * There is deliberately no excerpt. Review prose is the reviewer's copyright;
 * the card is an attribution and a link out, which is what CriticReview models.
 * `content` is present in the payload and is never read.
 */
function toCriticReviews(details: TmdbMovieDetails, fetchedAt: string): readonly CriticReview[] {
  return (details.reviews?.results ?? [])
    .filter((review) => nonEmpty(review.id) && nonEmpty(review.author))
    .map((review) => ({
      id: review.id as string,
      author: review.author as string,
      publication: unavailable<string>("not_in_source"),
      // author_details.rating is 0-10 and null when the reviewer left no score.
      score: fromNumeric(review.author_details?.rating),
      scale: "ten" as const,
      url: fromText(review.url),
      provenance: {
        source: "tmdb" as const,
        fetchedAt,
        sourceUrl: nonEmpty(review.url) ?? tmdbTitleUrl(details.id),
      },
    }));
}

export interface ReleaseResolution {
  readonly certification: Maybe<string>;
  readonly localReleaseDate: Maybe<string>;
  /** Which entry we actually read: the country, the US fallback, or the global date. */
  readonly resolvedFrom: "country" | "us_fallback" | "global_release_date" | "none";
  /** The country block we read, when we read one. Feeds TheatricalContext.country. */
  readonly resolvedCountry: string | null;
  /** Cinema release for that block, when it had one. */
  readonly theatrical: ReleasePick | null;
}

/**
 * Certification + local release date, resolved country -> US -> global.
 *
 * `resolvedFrom` records which one we used. FilmDetails has no field to carry
 * that label, so the visible signal is `TheatricalContext.country`: it always
 * names the country block the date and certification actually came from, so a
 * US fallback shows as "US" and is never passed off as a local date.
 */
export function resolveRelease(
  results: readonly TmdbReleaseDatesCountry[] | undefined,
  globalReleaseDate: string | undefined,
  country: CountryCode,
  now: number,
): ReleaseResolution {
  for (const [candidateCountry, resolvedFrom] of [
    [country.toUpperCase(), "country"],
    ["US", "us_fallback"],
  ] as const) {
    const block = countryBlock(results, candidateCountry);
    if (!block) continue;
    const entries = block.release_dates ?? [];
    const theatrical = pickTheatricalRelease(results, candidateCountry, now);
    const dated = entries
      .map((entry) => ({ entry, time: parseTime(entry.release_date) }))
      .filter((candidate) => candidate.time !== null) as ReadonlyArray<{
      entry: TmdbReleaseDateEntry;
      time: number;
    }>;
    if (dated.length === 0 && !theatrical) continue;
    const earliest = [...dated].sort((a, b) => a.time - b.time)[0];
    const date = theatrical?.date ?? (earliest ? toIsoDay(nonEmpty(earliest.entry.release_date) ?? "") : "");
    return {
      certification: fromNullable(theatrical?.certification ?? firstCertification(entries)),
      localReleaseDate: fromText(date),
      resolvedFrom,
      resolvedCountry: candidateCountry,
      theatrical,
    };
  }

  const global = nonEmpty(globalReleaseDate);
  return {
    // A global release date carries no certification — certifications are issued
    // per country, so there is nothing to report here.
    certification: unavailable<string>("not_in_source"),
    localReleaseDate: global ? ok(toIsoDay(global)) : unavailable<string>("not_in_source"),
    resolvedFrom: global ? "global_release_date" : "none",
    resolvedCountry: null,
    theatrical: null,
  };
}

/**
 * ONE request per title. `append_to_response` folds credits, videos, images,
 * release_dates, external_ids and reviews into the same response, so a detail
 * page costs a single round trip rather than six.
 */
export async function fetchTitleDetails(
  tmdbId: number,
  country: CountryCode,
  language: LanguageCode = "en-US",
): Promise<FilmDetails | null> {
  if (!isConfigured()) return null;
  if (!Number.isFinite(tmdbId)) return null;

  const url = buildUrl(`${API}/movie/${Math.trunc(tmdbId)}`, {
    append_to_response: "credits,videos,images,release_dates,external_ids,reviews",
    language,
  });
  const outcome = await get<TmdbMovieDetails>(url, REVALIDATE.titleDetails, [
    tag.title(Math.trunc(tmdbId)),
  ]);
  if (!outcome.ok) return null;

  const details = outcome.data;
  const fetchedAt = outcome.fetchedAt;
  const now = Date.now();

  const resolution = resolveRelease(
    details.release_dates?.results,
    details.release_date,
    country,
    now,
  );

  const theatrical: TheatricalContext | null = resolution.theatrical
    ? {
        kind: "theatrical",
        // Names the block we actually read — "US" when we fell back to it.
        country: resolution.theatrical.fromCountry,
        currentlyRunning: isCurrentlyRunning(resolution.theatrical.date, now),
        releaseDate: ok(resolution.theatrical.date),
        releaseType: releaseTypeLabel(resolution.theatrical.type),
        certification: fromNullable(resolution.theatrical.certification),
        booking:
          resolution.theatrical.fromCountry === "IN" && nonEmpty(details.title)
            ? ok(bookMyShowSearchLink(details.title as string, fetchedAt))
            : unavailable("not_in_source"),
      }
    : null;

  const genres = (details.genres ?? [])
    .map((genre) => nonEmpty(genre.name))
    .filter((name): name is string => Boolean(name));

  const isReleased = nonEmpty(details.status)?.toLowerCase() === "released";

  return {
    key: `tmdb:${details.id}`,
    tmdbId: details.id,
    imdbId: fromText(details.external_ids?.imdb_id ?? details.imdb_id),
    title: nonEmpty(details.title) ?? nonEmpty(details.original_title) ?? `TMDB ${details.id}`,
    originalTitle: fromText(details.original_title),
    originalLanguage: fromText(details.original_language),
    overview: fromText(details.overview),
    posterUrl: posterUrl(details.poster_path),
    backdropUrl: backdropUrl(details.backdrop_path),
    genres,
    runtimeMinutes: fromNumeric(details.runtime),
    // An unreleased title carries no ratings, whatever TMDB's pre-release
    // vote_average says.
    ratings: isReleased
      ? ratingsFor(details)
      : [],
    divergence: unavailable("not_in_source"),
    rank: unavailable("not_in_source"),
    movement: unavailable("not_in_source"),
    availability: theatrical,
    // The detail request does not ask for watch/providers, so we make no OTT
    // availability claim here. resolveDeepLink() is the licensed path for that.
    rail: theatrical ? "theatrical" : "upcoming",
    provenance: provenanceFor(details.id, fetchedAt),

    tagline: fromText(details.tagline),
    status: fromText(details.status),
    studios: (details.production_companies ?? [])
      .map((company) => nonEmpty(company.name))
      .filter((name): name is string => Boolean(name)),
    cast: selectCast(details),
    crew: selectCrew(details),
    trailer: selectTrailer(details, language),
    certification: resolution.certification,
    localReleaseDate: resolution.localReleaseDate,
    criticReviews: toCriticReviews(details, fetchedAt),
    // YouTube's shelf is the YouTube provider's job, not TMDB's.
    videoReviews: [],
    theatrical,
    ott: null,
  };
}

/* ------------------------------------------------------------------ *
 * Leaderboard candidate pools
 * ------------------------------------------------------------------ */

/**
 * Raw pool candidate. `voteAverage` and `voteCount` stay plain numbers on
 * purpose: the ranking module needs the real figures to compute a Bayesian
 * weighted rating. A candidate only exists if TMDB reported BOTH — anything
 * missing or zero is dropped from the pool rather than defaulted.
 */
export interface TmdbPoolCandidate {
  readonly tmdbId: number;
  readonly key: string;
  readonly title: string;
  readonly originalTitle: Maybe<string>;
  readonly originalLanguage: Maybe<LanguageCode>;
  readonly overview: Maybe<string>;
  readonly posterUrl: Maybe<string>;
  readonly backdropUrl: Maybe<string>;
  readonly releaseDate: Maybe<string>;
  readonly voteAverage: number;
  readonly voteCount: number;
  readonly popularity: Maybe<number>;
  readonly genreIds: readonly number[];
  readonly provenance: Provenance;
}

function toPoolCandidate(item: TmdbMovieListItem, fetchedAt: string): TmdbPoolCandidate | null {
  const average = fromNumeric(item.vote_average);
  const count = fromNumeric(item.vote_count);
  // No genuine score or no genuine vote count -> not a leaderboard candidate.
  if (average.status !== "ok" || count.status !== "ok") return null;
  const title = nonEmpty(item.title) ?? nonEmpty(item.original_title);
  if (!title) return null;

  return {
    tmdbId: item.id,
    key: `tmdb:${item.id}`,
    title,
    originalTitle: fromText(item.original_title),
    originalLanguage: fromText(item.original_language),
    overview: fromText(item.overview),
    posterUrl: posterUrl(item.poster_path),
    backdropUrl: backdropUrl(item.backdrop_path),
    releaseDate: fromText(item.release_date),
    voteAverage: average.value,
    voteCount: count.value,
    popularity: fromNumeric(item.popularity),
    genreIds: item.genre_ids ?? [],
    provenance: provenanceFor(item.id, fetchedAt),
  };
}

/**
 * International leaderboard pool. Returns raw candidates — no ranking is applied
 * here, that is the ranking module's job.
 *
 * `minVotes` filters the pool; it is NOT used to fabricate a score.
 */
export async function fetchTopRatedPool(
  minVotes: number,
  pageCount: number,
): Promise<readonly TmdbPoolCandidate[]> {
  if (!isConfigured()) return [];
  const pages = clampInt(pageCount, 1, 20);
  const floor = Math.max(0, minVotes);

  const outcomes = await Promise.all(
    Array.from({ length: pages }, (_unused, index) =>
      get<TmdbPaged<TmdbMovieListItem>>(
        buildUrl(`${API}/movie/top_rated`, { language: "en-US", page: index + 1 }),
        REVALIDATE.leaderboards,
        [tag.poolTopRated()],
      ),
    ),
  );

  const seen = new Set<number>();
  const pool: TmdbPoolCandidate[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    for (const item of outcome.data.results ?? []) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      const candidate = toPoolCandidate(item, outcome.fetchedAt);
      if (candidate && candidate.voteCount >= floor) pool.push(candidate);
    }
  }
  return pool;
}

/**
 * Indian leaderboard pool: one /discover sweep per original language, so a
 * Malayalam title is not crowded out by the volume of Hindi releases.
 * `vote_count.gte` is applied server-side by TMDB and re-checked here.
 */
export async function fetchIndianPool(
  languages: readonly string[],
  minVotes: number,
  pagesPerLanguage = 1,
): Promise<readonly TmdbPoolCandidate[]> {
  if (!isConfigured()) return [];
  if (languages.length === 0) return [];
  const floor = Math.max(0, minVotes);
  const pages = clampInt(pagesPerLanguage, 1, 5);

  const requests = languages.flatMap((language) =>
    Array.from({ length: pages }, (_unused, index) =>
      get<TmdbPaged<TmdbMovieListItem>>(
        buildUrl(`${API}/discover/movie`, {
          with_original_language: language,
          sort_by: "vote_average.desc",
          "vote_count.gte": floor,
          language: "en-US",
          page: index + 1,
        }),
        REVALIDATE.leaderboards,
        [tag.poolIndian(language)],
      ),
    ),
  );

  const outcomes = await Promise.all(requests);
  const seen = new Set<number>();
  const pool: TmdbPoolCandidate[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    for (const item of outcome.data.results ?? []) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      const candidate = toPoolCandidate(item, outcome.fetchedAt);
      if (candidate && candidate.voteCount >= floor) pool.push(candidate);
    }
  }
  return pool;
}

/* ------------------------------------------------------------------ *
 * Deep links + health
 * ------------------------------------------------------------------ */

/**
 * Licensed availability for one title in one country. Returns [] when TMDB has
 * no entry for that country — never the offers from a different region.
 */
export async function resolveDeepLink(
  record: Pick<FilmRecord, "tmdbId">,
  query: DetailsQuery,
): Promise<readonly DeepLink[]> {
  if (!isConfigured()) return [];
  const region = query.country.toUpperCase();
  const outcome = await get<TmdbWatchProvidersResponse>(
    `${API}/movie/${record.tmdbId}/watch/providers`,
    REVALIDATE.watchProviders,
    [tag.ott(region)],
  );
  if (!outcome.ok) return [];
  const block = outcome.data.results?.[region];
  if (!block) return [];
  return offersFromWatchCountry(block, outcome.fetchedAt);
}

export async function healthCheck(): Promise<HealthStatus> {
  const checkedAt = new Date().toISOString();
  if (!isConfigured()) {
    return {
      source: "tmdb",
      ok: false,
      detail: "Not configured — TMDB_READ_TOKEN is missing.",
      latencyMs: unavailable("not_configured"),
      checkedAt,
    };
  }

  const { outcome, latencyMs } = await timedFetchJson<TmdbConfiguration>({
    source: "tmdb",
    url: `${API}/configuration`,
    headers: authHeaders(),
    // Health must reflect right now, so it is never served from cache.
    revalidate: 0,
    tags: [tag.health()],
  });

  if (!outcome.ok) {
    return {
      source: "tmdb",
      ok: false,
      detail:
        outcome.reason === "http_error" && outcome.status === 401
          ? "TMDB rejected the read token (401)."
          : outcome.detail,
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  }

  return {
    source: "tmdb",
    ok: true,
    detail: "TMDB reachable.",
    latencyMs: ok(latencyMs),
    checkedAt,
  };
}

/* ------------------------------------------------------------------ *
 * External IDs — the bridge to OMDb
 * ------------------------------------------------------------------ */

/**
 * The rail endpoints (`now_playing`, `discover`, `trending`, `top_rated`) do
 * not carry `imdb_id`, but OMDb is keyed on it — so ratings enrichment needs
 * one extra lookup per title. `/movie/{id}/external_ids` is the cheapest way to
 * get it: a tiny payload, and the mapping never changes, so it is cached for a
 * week alongside title metadata.
 *
 * Returns a map of tmdbId -> imdbId. Titles TMDB has no IMDb id for are simply
 * absent from the map; the caller then shows "not available" for their IMDb and
 * Rotten Tomatoes scores rather than inventing them.
 */
export async function fetchExternalImdbIds(
  tmdbIds: readonly number[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  if (!isConfigured() || tmdbIds.length === 0) return found;

  const results = await mapLimited(tmdbIds, 6, async (id) => {
    const outcome = await get<TmdbExternalIds>(
      `${API}/movie/${id}/external_ids`,
      REVALIDATE.titleDetails,
      [`tmdb:external-ids:${id}`],
    );
    if (!outcome.ok) return null;
    const imdbId = nonEmpty(outcome.data.imdb_id);
    return imdbId ? ([id, imdbId] as const) : null;
  });

  for (const entry of results) {
    if (entry) found.set(entry[0], entry[1]);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Provider surface
 * ------------------------------------------------------------------ */

const DEFAULT_LIMIT = 20;

export const tmdbProvider: Provider<FilmRecord> = {
  id: "tmdb",
  kind: "film",
  displayName: "TMDB",
  attribution: ATTRIBUTION,

  isEnabled: () => isConfigured(),

  fetchTrending: (query: TrendingQuery) => {
    const limit = query.limit ?? DEFAULT_LIMIT;
    switch (query.rail) {
      case "ott":
        return fetchOtt(query.country, limit);
      case "upcoming":
        return fetchUpcoming(query.country, limit);
      case "top-rated":
        // The top-rated board is built by the ranking module from
        // fetchTopRatedPool/fetchIndianPool, which need vote counts this
        // interface cannot carry. Returning [] rather than a lookalike list.
        return Promise.resolve([]);
      case "theatrical":
      default:
        return fetchTheatrical(query.country, limit);
    }
  },

  fetchTitleDetails: (id: string, query: DetailsQuery) => {
    const numeric = Number(id.startsWith("tmdb:") ? id.slice("tmdb:".length) : id);
    if (!Number.isFinite(numeric)) return Promise.resolve(null);
    return fetchTitleDetails(numeric, query.country, query.language ?? "en-US");
  },

  resolveDeepLink: (record: FilmRecord, query: DetailsQuery) => resolveDeepLink(record, query),

  healthCheck,
};

export default tmdbProvider;
