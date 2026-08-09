/**
 * Our own weighted ranking. Read this before touching the leaderboards.
 *
 * LEGAL NOTE, because it drives the whole design of this module:
 * IMDb's "Top 250" and Rotten Tomatoes' "Top 100" are proprietary, branded
 * lists. We do not have a licence to reproduce either, so we do not. What we
 * ship are OUR OWN rankings, computed here from TMDB's licensed vote data and
 * OMDb's licensed rating data, and every board in the UI must state what it was
 * built from and what its vote threshold is. Never label a board "IMDb Top 250"
 * unless we are actually serving IMDb's licensed list — which would require
 * IMDb's commercial API via AWS Data Exchange (a paid licence, noted as a
 * future path). IMDb's free downloadable datasets are licensed for personal and
 * non-commercial use only and are therefore unusable for a public product.
 *
 * THE FORMULA — the Bayesian weighted average whose shape IMDb publishes:
 *
 *     WR = (v / (v + m)) * R  +  (m / (v + m)) * C
 *
 *   R = the title's own mean vote          (TMDB vote_average, 0-10)
 *   v = the title's vote count             (TMDB vote_count)
 *   m = minimum votes to enter the pool    (per-board, from config BAYESIAN)
 *   C = the mean vote across the candidate pool
 *
 * C is computed at request time from the pool we actually fetched. It is
 * deliberately NOT a hard-coded constant: a constant would be a number we
 * invented, and it would drift out of date silently as TMDB's catalogue moves.
 *
 * What it does: `v/(v+m)` is the confidence we have in the title's own average.
 * A film with 9 votes and a perfect 10, against m = 2000, keeps 9/2009 ≈ 0.4%
 * of its own score and is pulled almost entirely to the pool mean — so it
 * cannot top the board. A film with 20,000 votes keeps 20000/22000 ≈ 91% of its
 * own average and is ranked essentially on merit.
 */

/** The only two fields the maths needs. Anything carrying them can be ranked. */
export interface RankCandidate {
  readonly voteAverage: number;
  readonly voteCount: number;
}

export interface RankedCandidate<T extends RankCandidate> {
  readonly item: T;
  /** The weighted rating, 0-10. This is the number the board is sorted by. */
  readonly weightedRating: number;
  readonly rank: number;
}

export interface BayesianParams {
  /** m — minimum votes to enter the pool. */
  readonly minVotes: number;
  /**
   * C — pool mean. Computed from the pool by `poolMean` unless overridden for
   * a test.
   */
  readonly poolMean: number;
}

/**
 * C — the mean vote across every candidate that clears the vote floor.
 * Candidates below the floor are excluded from the mean as well as from the
 * board, so a long tail of 1-vote entries cannot drag C down.
 */
export function poolMean(
  candidates: readonly RankCandidate[],
  minVotes: number,
): number {
  const eligible = candidates.filter((c) => c.voteCount >= minVotes);
  if (eligible.length === 0) return 0;
  const total = eligible.reduce((sum, c) => sum + c.voteAverage, 0);
  return total / eligible.length;
}

/** WR for a single title. Exported so the UI can explain a specific ranking. */
export function weightedRating(
  voteAverage: number,
  voteCount: number,
  params: BayesianParams,
): number {
  const { minVotes: m, poolMean: C } = params;
  const v = voteCount;
  const R = voteAverage;
  if (v + m === 0) return 0;
  return (v / (v + m)) * R + (m / (v + m)) * C;
}

/**
 * Rank a candidate pool. Titles below the vote floor are dropped — not
 * ranked-last, dropped — because a board that silently includes titles we said
 * we excluded is a lie about the methodology we printed next to it.
 */
export function rankByBayesian<T extends RankCandidate>(
  candidates: readonly T[],
  minVotes: number,
  limit?: number,
): {
  readonly ranked: readonly RankedCandidate<T>[];
  readonly params: BayesianParams;
  readonly poolSize: number;
} {
  const C = poolMean(candidates, minVotes);
  const params: BayesianParams = { minVotes, poolMean: C };

  const eligible = candidates.filter((c) => c.voteCount >= minVotes);

  const scored = eligible
    .map((item) => ({
      item,
      weightedRating: weightedRating(item.voteAverage, item.voteCount, params),
    }))
    .sort((a, b) => b.weightedRating - a.weightedRating);

  const ranked = (limit ? scored.slice(0, limit) : scored).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  return { ranked, params, poolSize: eligible.length };
}

/**
 * The methodology sentence printed under every board. It is generated from the
 * same numbers the ranking actually used, so the copy cannot drift away from
 * the maths.
 */
export function methodologyLine(opts: {
  readonly boardName: string;
  readonly minVotes: number;
  readonly poolSize: number;
  readonly poolMean: number;
  readonly basis: string;
}): string {
  return (
    `Airtime's own ranking. ${opts.boardName} scored with a Bayesian weighted ` +
    `average over ${opts.basis}, across a pool of ${opts.poolSize.toLocaleString()} ` +
    `titles with at least ${opts.minVotes.toLocaleString()} votes ` +
    `(pool mean ${opts.poolMean.toFixed(2)}/10). Not affiliated with, and not a ` +
    `reproduction of, IMDb's or Rotten Tomatoes' own lists.`
  );
}
