/**
 * The single most important type in this codebase.
 *
 * Ratings, chart positions, availability and view counts are the entire value
 * proposition of an aggregator. A number that was guessed, estimated,
 * interpolated or defaulted-to-zero is worse than no number at all, because the
 * user cannot tell the difference.
 *
 * So: no value that originates from an external source is ever typed as a bare
 * `number | null`. It is a `Maybe<T>`, which forces every call site — including
 * every React component — to decide what to render when the source had nothing.
 * `unavailable` carries a plain-language reason that the UI is allowed to show.
 */
export interface MaybeOk<T> {
  readonly status: "ok";
  readonly value: T;
}

export interface MaybeUnavailable {
  readonly status: "unavailable";
  readonly reason: UnavailableReason;
}

/**
 * Named members, rather than an inline union, so that `isOk`'s type predicate
 * names an actual constituent of the union. An inline structural predicate does
 * not reliably narrow the false branch, which silently costs you the
 * `.reason` you need to render the unavailable state.
 */
export type Maybe<T> = MaybeOk<T> | MaybeUnavailable;

export type UnavailableReason =
  /** The source responded successfully but had no entry for this field. */
  | "not_in_source"
  /** The source is not configured (missing API key). */
  | "not_configured"
  /** The source errored or timed out on this request. */
  | "source_error"
  /** This provider is intentionally disabled in config. */
  | "provider_disabled"
  /** The value does not exist yet — e.g. ratings for an unreleased film. */
  | "not_yet_rated"
  /** Licensing forbids us from serving this value. */
  | "not_licensed";

export const ok = <T>(value: T): Maybe<T> => ({ status: "ok", value });

export const unavailable = <T = never>(
  reason: UnavailableReason,
): Maybe<T> => ({ status: "unavailable", reason });

/**
 * Lift a nullish external value. This is the ONLY sanctioned way to turn raw
 * API JSON into a Maybe — it never invents a fallback.
 */
export function fromNullable<T>(
  value: T | null | undefined,
  reason: UnavailableReason = "not_in_source",
): Maybe<T> {
  return value === null || value === undefined ? unavailable(reason) : ok(value);
}

/**
 * Lift a numeric external value, rejecting the sentinel values that APIs use to
 * mean "we don't know": 0, NaN, and empty string. TMDB returns vote_average 0
 * for unrated titles; OMDb returns the string "N/A".
 */
export function fromNumeric(
  value: unknown,
  reason: UnavailableReason = "not_in_source",
): Maybe<number> {
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    return ok(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "N/A") return unavailable(reason);
    const parsed = Number(trimmed.replace(/[%,]/g, ""));
    if (Number.isFinite(parsed) && parsed !== 0) return ok(parsed);
  }
  return unavailable(reason);
}

/** Lift a string, treating empty/whitespace/"N/A" as absent. */
export function fromText(
  value: unknown,
  reason: UnavailableReason = "not_in_source",
): Maybe<string> {
  if (typeof value !== "string") return unavailable(reason);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "N/A") return unavailable(reason);
  return ok(trimmed);
}

export const isOk = <T>(m: Maybe<T>): m is MaybeOk<T> => m.status === "ok";

export const isUnavailable = <T>(m: Maybe<T>): m is MaybeUnavailable =>
  m.status === "unavailable";

export function mapMaybe<T, U>(m: Maybe<T>, fn: (value: T) => U): Maybe<U> {
  return m.status === "ok" ? ok(fn(m.value)) : m;
}

/** Read a Maybe for internal computation (sorting, ranking). Never for display. */
export function valueOr<T>(m: Maybe<T>, fallback: T): T {
  return m.status === "ok" ? m.value : fallback;
}

/** Plain-language copy for an unavailable value. Used directly in the UI. */
export const UNAVAILABLE_COPY: Record<UnavailableReason, string> = {
  not_in_source: "No score on file",
  not_configured: "Source not connected",
  source_error: "Source unreachable",
  provider_disabled: "Source turned off",
  not_yet_rated: "Not rated yet",
  not_licensed: "Not licensed to show",
};
