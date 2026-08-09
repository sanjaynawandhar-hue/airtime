import { isOk, ok, unavailable, type Maybe } from "@/lib/core/maybe";
import type { Rating, RatingDivergence } from "@/lib/core/types";

/**
 * Critics vs audience. The gap is the most interesting thing in this data and
 * almost nobody surfaces it, so it goes on the card rather than in a tooltip.
 *
 * Hard rule: divergence is only produced when BOTH sides are real `ok` values.
 * We never infer a gap from one score, and we never fill the missing side with
 * a pool average — a fabricated gap would be worse than no gap, because the
 * whole point of the feature is that it reveals something true.
 */

/** Everything normalises to 0-100 so the two sides are comparable at all. */
function toPercent(rating: Rating): Maybe<number> {
  if (!isOk(rating.value)) return rating.value;
  const v = rating.value.value;
  switch (rating.scale) {
    case "percent":
      return ok(v);
    case "ten":
      return ok(v * 10);
    case "five":
      return ok(v * 20);
  }
}

/**
 * Below this, critics and audiences broadly agree and saying so is noise.
 * 20 points on a 100-point scale is roughly "one full grade apart" — e.g. RT
 * 85% critics against a 6.5/10 audience score.
 */
export const DIVERGENCE_THRESHOLD = 20;

/**
 * Critic side: Rotten Tomatoes' Tomatometer first, Metacritic second — both are
 * aggregations of professional reviews.
 * Audience side: IMDb, which is a public vote.
 * TMDB's vote_average is also a public vote and is used only if IMDb is absent.
 */
export function computeDivergence(
  ratings: readonly Rating[],
): Maybe<RatingDivergence> {
  const find = (label: string) => ratings.find((r) => r.label === label);

  const criticRating = find("Rotten Tomatoes") ?? find("Metacritic");
  const audienceRating = find("IMDb") ?? find("TMDB Users");

  if (!criticRating || !audienceRating) {
    return unavailable("not_in_source");
  }

  const critic = toPercent(criticRating);
  const audience = toPercent(audienceRating);

  if (!isOk(critic) || !isOk(audience)) {
    return unavailable("not_in_source");
  }

  const gap = critic.value - audience.value;

  if (Math.abs(gap) < DIVERGENCE_THRESHOLD) {
    return unavailable("not_in_source");
  }

  return ok({
    criticPercent: Math.round(critic.value),
    audiencePercent: Math.round(audience.value),
    gap: Math.round(gap),
    verdict: gap > 0 ? "critics_favour" : "audience_favour",
    criticLabel: criticRating.label,
    audienceLabel: audienceRating.label,
  });
}

/** Plain-language card copy. Reads as a finding, not a warning. */
export function divergenceCopy(d: RatingDivergence): string {
  const points = Math.abs(d.gap);
  return d.verdict === "critics_favour"
    ? `Critics are ${points} points warmer than audiences`
    : `Audiences are ${points} points warmer than critics`;
}
