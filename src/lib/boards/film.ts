import "server-only";
import { isOk, ok, unavailable } from "@/lib/core/maybe";
import type { CountryCode, FilmRecord, Rating, SourceId } from "@/lib/core/types";
import tmdbProvider, {
  fetchExternalImdbIds,
  fetchOtt,
  fetchTheatrical,
  fetchUpcoming,
} from "@/lib/providers/tmdb";
import { fetchRatingsBatch } from "@/lib/providers/omdb";
import { WATCH_PROVIDERS } from "@/lib/core/config";
import { computeDivergence } from "@/lib/rank/divergence";
import {
  computeMovement,
  loadPreviousSnapshot,
  recordSnapshot,
} from "@/lib/rank/movement";

/**
 * The two film rails, composed.
 *
 * The pipelines stay distinct end to end — separate TMDB calls, separate
 * ranking, separate availability context — and this module never copies data
 * from one rail's result into the other's. The only thing they share is the
 * ratings enrichment below, which is a property of the TITLE, not of where you
 * can watch it, so sharing it is correct.
 */

export interface Board {
  readonly films: readonly FilmRecord[];
  /** When we fetched. Drives the "last checked" line. */
  readonly fetchedAt: string;
  /** True when the source failed and we are showing what we had. */
  readonly stale: boolean;
  readonly sources: readonly SourceId[];
  /** Set when the rail is empty for a reason worth telling the reader. */
  readonly note: string | null;
}

const emptyBoard = (note: string, sources: readonly SourceId[] = ["tmdb"]): Board => ({
  films: [],
  fetchedAt: new Date().toISOString(),
  stale: false,
  sources,
  note,
});

/**
 * "TMDB has no films for this region" and "we never asked TMDB because there is
 * no API token" are completely different facts, and telling a reader the first
 * when the second is true is a lie about the data. Every empty film rail routes
 * through here so it cannot claim a data absence it did not observe.
 */
const NOT_CONNECTED_NOTE =
  "This rail needs a TMDB API token, which isn't set. We haven't asked TMDB " +
  "anything — this is not TMDB reporting an empty result. Add TMDB_READ_TOKEN " +
  "and it fills in on the next request.";

function emptyFor(reason: string): Board {
  return emptyBoard(tmdbProvider.isEnabled() ? reason : NOT_CONNECTED_NOTE);
}

/**
 * Attach IMDb, Rotten Tomatoes and Metacritic scores from OMDb, then compute
 * the critic/audience divergence.
 *
 * Two lookups per title are needed: TMDB's list endpoints do not carry
 * `imdb_id`, so we resolve it from /external_ids (cached weekly — it never
 * changes) and then hit OMDb once per IMDb id. A title with no IMDb id, or one
 * OMDb has never heard of, keeps its TMDB rating and shows "not available" for
 * the rest. Nothing is filled in.
 */
async function enrichRatings(
  films: readonly FilmRecord[],
): Promise<readonly FilmRecord[]> {
  if (films.length === 0) return films;

  const imdbIds = await fetchExternalImdbIds(films.map((f) => f.tmdbId));
  const wanted = [...new Set(imdbIds.values())];
  if (wanted.length === 0) return films;

  const byImdbId = await fetchRatingsBatch(wanted);

  return films.map((film) => {
    const imdbId = imdbIds.get(film.tmdbId);
    if (!imdbId) return film;

    const external = byImdbId.get(imdbId) ?? [];
    if (external.length === 0) {
      return { ...film, imdbId: ok(imdbId) };
    }

    // TMDB's own vote average stays in the list — it is a real, separate
    // signal — but OMDb's bodies come first because they are what the card and
    // the divergence calculation lead with.
    const ratings: readonly Rating[] = [...external, ...film.ratings];

    return {
      ...film,
      imdbId: ok(imdbId),
      ratings,
      divergence: computeDivergence(ratings),
    };
  });
}

/**
 * Attach week-over-week movement and record today's positions.
 *
 * `boardKey` namespaces the snapshot by source, country and rail, so the
 * theatrical and OTT rails never compare against each other's history.
 */
async function withMovement(
  boardKey: string,
  films: readonly FilmRecord[],
): Promise<readonly FilmRecord[]> {
  if (films.length === 0) return films;

  const snapshot = await loadPreviousSnapshot(boardKey);

  const withRanks = films.map((film) => {
    if (!isOk(film.rank)) return film;
    return {
      ...film,
      movement: computeMovement(film.key, film.rank.value, snapshot),
    };
  });

  // Fire and forget would lose errors silently; awaiting costs one round trip
  // against a cached page render, which is acceptable for a daily rail.
  await recordSnapshot(
    boardKey,
    films.flatMap((f) => (isOk(f.rank) ? [{ itemKey: f.key, rank: f.rank.value }] : [])),
  );

  return withRanks;
}

/* ------------------------------------------------------------------ *
 * Theatrical
 * ------------------------------------------------------------------ */

export async function theatricalBoard(
  country: CountryCode,
  limit = 20,
): Promise<Board> {
  const films = await fetchTheatrical(country, limit);

  if (films.length === 0) {
    return emptyFor(
      "TMDB isn't listing any films currently in cinemas for this country. " +
        "That usually means the region has no theatrical data rather than that " +
        "nothing is playing.",
    );
  }

  const enriched = await enrichRatings(films);
  const ranked = await withMovement(`tmdb:${country}:theatrical`, enriched);

  return {
    films: ranked,
    fetchedAt: films[0].provenance.fetchedAt,
    stale: films.some((f) => f.provenance.stale === true),
    sources: ["tmdb", "omdb"],
    note: null,
  };
}

/* ------------------------------------------------------------------ *
 * OTT
 * ------------------------------------------------------------------ */

/**
 * @param platform  A PlatformId from WATCH_PROVIDERS. Narrows the rail to one
 *   service using TMDB's own `with_watch_providers` filter, so the result is
 *   still TMDB confirming availability rather than us filtering a general list
 *   and hoping. An unknown platform is ignored rather than returning nothing.
 */
export async function ottBoard(
  country: CountryCode,
  limit = 20,
  platform?: string,
): Promise<Board> {
  const provider = platform
    ? WATCH_PROVIDERS.find((p) => p.platform === platform)
    : undefined;

  const films = await fetchOtt(
    country,
    limit,
    provider ? [provider.tmdbProviderId] : undefined,
  );

  if (films.length === 0) {
    if (provider) {
      return emptyFor(
        `TMDB has nothing currently trending on ${provider.name} in this country. ` +
          `That is TMDB's availability data saying no, not a failed request.`,
      );
    }
    return emptyFor(
      "No streaming titles confirmed available in this country right now. " +
        "We only list a film here once TMDB's watch-providers data says it is " +
        "genuinely on a service where you are.",
    );
  }

  const enriched = await enrichRatings(films);
  // Snapshot key includes the platform so a per-service rail never compares
  // its ranks against the unfiltered one.
  const ranked = await withMovement(
    `tmdb:${country}:ott${provider ? `:${provider.platform}` : ""}`,
    enriched,
  );

  return {
    films: ranked,
    fetchedAt: films[0].provenance.fetchedAt,
    stale: films.some((f) => f.provenance.stale === true),
    sources: ["tmdb", "omdb"],
    note: null,
  };
}

/* ------------------------------------------------------------------ *
 * Coming soon
 * ------------------------------------------------------------------ */

/**
 * Upcoming titles carry NO ratings — they do not exist yet — so this rail
 * deliberately skips the OMDb enrichment entirely rather than calling it and
 * getting empty results. The UI shows our own anticipation signal instead.
 *
 * Movement is also skipped: an upcoming rail is ordered by release date, and a
 * "rank change" on a date-ordered list would mean nothing.
 */
export async function upcomingBoard(
  country: CountryCode,
  limit = 20,
): Promise<Board> {
  const films = await fetchUpcoming(country, limit);

  if (films.length === 0) {
    return emptyFor(
      "TMDB has no dated upcoming releases for this country yet. Release " +
        "schedules are often published late, especially in India.",
    );
  }

  return {
    films,
    fetchedAt: films[0].provenance.fetchedAt,
    stale: films.some((f) => f.provenance.stale === true),
    sources: ["tmdb"],
    note: null,
  };
}

/* ------------------------------------------------------------------ *
 * Cross-rail overlap
 * ------------------------------------------------------------------ */

/**
 * A title can legitimately be in cinemas AND on a streaming service at the same
 * time — an early digital release overlapping a theatrical run, or a re-release
 * of something already streaming.
 *
 * We surface that rather than hiding it, but the two records stay separate: the
 * theatrical record keeps its theatrical context and the OTT record keeps its
 * offers. This helper only reports WHICH tmdbIds appear in both, so the cards
 * can add an "also in cinemas" / "also streaming" cross-reference. It never
 * merges the two availability contexts.
 */
export function overlappingIds(a: Board, b: Board): ReadonlySet<number> {
  const inB = new Set(b.films.map((f) => f.tmdbId));
  return new Set(a.films.filter((f) => inB.has(f.tmdbId)).map((f) => f.tmdbId));
}

/** Anticipation for an unreleased title — never a rating. */
export const anticipationPlaceholder = () => unavailable<number>("not_yet_rated");
