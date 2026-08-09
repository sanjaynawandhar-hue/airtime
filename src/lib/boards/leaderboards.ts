import "server-only";
import { isOk, ok, unavailable } from "@/lib/core/maybe";
import { BAYESIAN, INDIAN_LANGUAGES } from "@/lib/core/config";
import type { FilmRecord, Rating } from "@/lib/core/types";
import tmdbProvider, {
  fetchExternalImdbIds,
  fetchIndianPool,
  fetchTopRatedPool,
  type TmdbPoolCandidate,
} from "@/lib/providers/tmdb";
import { fetchRatingsBatch } from "@/lib/providers/omdb";
import { computeDivergence } from "@/lib/rank/divergence";
import { methodologyLine, rankByBayesian } from "@/lib/rank/bayesian";

/**
 * The three all-time boards. These are OUR rankings, not anybody else's list.
 *
 * Every board here is labelled in the UI with the methodology string this
 * module generates, which states the basis, the vote floor and the pool size —
 * generated from the same numbers the ranking used, so the printed claim cannot
 * drift from the maths. See lib/rank/bayesian.ts for the legal reasoning.
 */

export type BoardId = "international" | "indian" | "critics";

export interface Leaderboard {
  readonly id: BoardId;
  readonly title: string;
  readonly films: readonly FilmRecord[];
  readonly methodology: string;
  readonly fetchedAt: string;
  readonly note: string | null;
}

const BOARD_TITLES: Record<BoardId, string> = {
  international: "Highest rated worldwide",
  indian: "Highest rated Indian cinema",
  critics: "Best reviewed by critics",
};

/**
 * "TMDB had nothing" and "we never asked TMDB" are different facts. A board
 * that has not been queried must not claim an empty result.
 */
const NOT_CONNECTED_NOTE =
  "This board needs a TMDB API token, which isn't set. We haven't asked TMDB " +
  "anything yet — this is not TMDB reporting an empty result.";

function emptyBoard(id: BoardId, note: string): Leaderboard {
  const resolved = tmdbProvider.isEnabled() ? note : NOT_CONNECTED_NOTE;
  return {
    id,
    title: BOARD_TITLES[id],
    films: [],
    methodology: "",
    fetchedAt: new Date().toISOString(),
    note: resolved,
  };
}

/**
 * Turn a ranked pool candidate into the FilmRecord the cards consume.
 *
 * TMDB's own user vote average is included as a rating in its own right,
 * labelled "TMDB Users" so it is never confused with IMDb's public vote — the
 * divergence calculation uses it only as a fallback audience side.
 */
function toFilmRecord(
  candidate: TmdbPoolCandidate,
  rank: number,
  extraRatings: readonly Rating[],
): FilmRecord {
  const tmdbRating: Rating = {
    source: "tmdb",
    label: "TMDB Users",
    value: ok(candidate.voteAverage),
    scale: "ten",
    voteCount: ok(candidate.voteCount),
    sourceUrl: ok(`https://www.themoviedb.org/movie/${candidate.tmdbId}`),
  };
  const ratings = [...extraRatings, tmdbRating];

  return {
    key: candidate.key,
    tmdbId: candidate.tmdbId,
    imdbId: unavailable("not_in_source"),
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    originalLanguage: candidate.originalLanguage,
    overview: candidate.overview,
    posterUrl: candidate.posterUrl,
    backdropUrl: candidate.backdropUrl,
    genres: [],
    runtimeMinutes: unavailable("not_in_source"),
    ratings,
    divergence: computeDivergence(ratings),
    rank: ok(rank),
    // These boards are recomputed weekly over a slow-moving pool; a
    // week-over-week "movement" on an all-time list would be noise, so it is
    // explicitly not tracked rather than shown as flat.
    movement: unavailable("not_in_source"),
    rail: "top-rated",
    // An all-time board says nothing about where you can watch a film today.
    // Leaving this null is the honest answer; the title page resolves it.
    availability: null,
    provenance: candidate.provenance,
  };
}

/**
 * Fetch OMDb ratings for a set of pool candidates. Returns a map keyed by
 * tmdbId. Titles OMDb has nothing for are absent — never zero-filled.
 */
async function ratingsForPool(
  candidates: readonly TmdbPoolCandidate[],
): Promise<Map<number, readonly Rating[]>> {
  const byTmdbId = new Map<number, readonly Rating[]>();
  if (candidates.length === 0) return byTmdbId;

  const imdbIds = await fetchExternalImdbIds(candidates.map((c) => c.tmdbId));
  const wanted = [...new Set(imdbIds.values())];
  if (wanted.length === 0) return byTmdbId;

  const byImdbId = await fetchRatingsBatch(wanted);

  for (const candidate of candidates) {
    const imdbId = imdbIds.get(candidate.tmdbId);
    if (!imdbId) continue;
    const ratings = byImdbId.get(imdbId);
    if (ratings && ratings.length > 0) byTmdbId.set(candidate.tmdbId, ratings);
  }
  return byTmdbId;
}

/* ------------------------------------------------------------------ *
 * 1. International
 * ------------------------------------------------------------------ */

export async function internationalBoard(limit = 30): Promise<Leaderboard> {
  // 5 pages ≈ 100 candidates from TMDB's top_rated, which is already
  // vote-count filtered on their side; we then apply our own, higher floor.
  const pool = await fetchTopRatedPool(BAYESIAN.internationalMinVotes, 5);

  if (pool.length === 0) {
    return emptyBoard(
      "international",
      "TMDB's top-rated list came back empty.",
    );
  }

  const { ranked, params, poolSize } = rankByBayesian(
    pool,
    BAYESIAN.internationalMinVotes,
    limit,
  );

  const omdbRatings = await ratingsForPool(ranked.map((r) => r.item));

  return {
    id: "international",
    title: BOARD_TITLES.international,
    films: ranked.map((entry) =>
      toFilmRecord(entry.item, entry.rank, omdbRatings.get(entry.item.tmdbId) ?? []),
    ),
    methodology: methodologyLine({
      boardName: "Films from every country",
      minVotes: params.minVotes,
      poolSize,
      poolMean: params.poolMean,
      basis: "TMDB user vote averages, then enriched with IMDb and Rotten Tomatoes scores from OMDb",
    }),
    fetchedAt: pool[0].provenance.fetchedAt,
    note: null,
  };
}

/* ------------------------------------------------------------------ *
 * 2. Indian
 * ------------------------------------------------------------------ */

/**
 * Indian-language titles collect far fewer TMDB votes than Hollywood ones, so
 * the international 2,000-vote floor would return an almost empty board. The
 * floor here is BAYESIAN.indianMinVotes, and `tuneIndianFloor` below reports
 * how many candidates clear each candidate floor against a live response so the
 * number can be re-tuned from data rather than guessed.
 */
export async function indianBoard(limit = 30): Promise<Leaderboard> {
  const pool = await fetchIndianPool(INDIAN_LANGUAGES, BAYESIAN.indianMinVotes, 2);

  if (pool.length === 0) {
    return emptyBoard(
      "indian",
      "TMDB returned no Indian-language titles clearing the vote floor.",
    );
  }

  const { ranked, params, poolSize } = rankByBayesian(
    pool,
    BAYESIAN.indianMinVotes,
    limit,
  );

  const omdbRatings = await ratingsForPool(ranked.map((r) => r.item));

  return {
    id: "indian",
    title: BOARD_TITLES.indian,
    films: ranked.map((entry) =>
      toFilmRecord(entry.item, entry.rank, omdbRatings.get(entry.item.tmdbId) ?? []),
    ),
    methodology: methodologyLine({
      boardName: `Films in ${INDIAN_LANGUAGES.length} Indian languages`,
      minVotes: params.minVotes,
      poolSize,
      poolMean: params.poolMean,
      basis:
        "TMDB user vote averages across Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali and Marathi",
    }),
    fetchedAt: pool[0].provenance.fetchedAt,
    note: null,
  };
}

/**
 * Diagnostic used to tune BAYESIAN.indianMinVotes against real data rather than
 * guessing it. Printed by `npm run verify`.
 */
export async function tuneIndianFloor(): Promise<
  readonly { readonly floor: number; readonly count: number }[]
> {
  const pool = await fetchIndianPool(INDIAN_LANGUAGES, 1, 3);
  return [10, 25, 50, 100, 200, 500, 1000, 2000].map((floor) => ({
    floor,
    count: pool.filter((c) => c.voteCount >= floor).length,
  }));
}

/* ------------------------------------------------------------------ *
 * 3. Critics
 * ------------------------------------------------------------------ */

/**
 * Ranked by the Rotten Tomatoes score OMDb returns, over a candidate pool of
 * BAYESIAN.criticsPoolSize titles. The pool size is stated in the UI because
 * "best reviewed" is only meaningful relative to how many films we looked at.
 *
 * Titles with no RT entry in OMDb are dropped from THIS board only — they are
 * not scored zero, and they still appear on the other two boards. RT has no
 * public API and we do not scrape rottentomatoes.com; OMDb is the whole source.
 */
export async function criticsBoard(limit = 30): Promise<Leaderboard> {
  const pool = await fetchTopRatedPool(BAYESIAN.criticsMinVotes, 10);

  if (pool.length === 0) {
    return emptyBoard(
      "critics",
      "TMDB's top-rated list didn't return a candidate pool.",
    );
  }

  const candidates = pool.slice(0, BAYESIAN.criticsPoolSize);
  const omdbRatings = await ratingsForPool(candidates);

  const scored = candidates.flatMap((candidate) => {
    const ratings = omdbRatings.get(candidate.tmdbId);
    if (!ratings) return [];
    const rt = ratings.find((r) => r.label === "Rotten Tomatoes");
    if (!rt || !isOk(rt.value)) return [];
    return [{ candidate, ratings, rtScore: rt.value.value }];
  });

  if (scored.length === 0) {
    return emptyBoard(
      "critics",
      omdbRatings.size === 0
        ? "This board needs an OMDb API key — Rotten Tomatoes scores come from OMDb, and Rotten Tomatoes has no public API of its own."
        : "OMDb had no Rotten Tomatoes scores for any title in the current pool.",
    );
  }

  scored.sort((a, b) => b.rtScore - a.rtScore);

  const films = scored
    .slice(0, limit)
    .map((entry, index) => toFilmRecord(entry.candidate, index + 1, entry.ratings));

  return {
    id: "critics",
    title: BOARD_TITLES.critics,
    films,
    methodology:
      `Airtime's own ranking, ordered by the Rotten Tomatoes critic score OMDb ` +
      `returns. We checked ${candidates.length.toLocaleString()} titles and ` +
      `${scored.length.toLocaleString()} of them had a Rotten Tomatoes score on ` +
      `file; the rest are not ranked here rather than scored zero. Candidates ` +
      `come from TMDB titles with at least ` +
      `${BAYESIAN.criticsMinVotes.toLocaleString()} votes. Not affiliated with, ` +
      `and not a reproduction of, Rotten Tomatoes' own Top 100.`,
    fetchedAt: pool[0].provenance.fetchedAt,
    note: null,
  };
}

export async function leaderboard(id: BoardId, limit = 30): Promise<Leaderboard> {
  switch (id) {
    case "indian":
      return indianBoard(limit);
    case "critics":
      return criticsBoard(limit);
    case "international":
      return internationalBoard(limit);
  }
}

export const BOARD_IDS: readonly BoardId[] = ["international", "indian", "critics"];

/**
 * A future path, noted and not built: IMDb's genuine Top 250 requires IMDb's
 * commercial API through AWS Data Exchange, which is a paid licence. IMDb's
 * free downloadable datasets are licensed for personal and non-commercial use
 * only and cannot back a public product.
 */
