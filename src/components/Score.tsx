import { UNAVAILABLE_COPY, isOk, type Maybe } from "@/lib/core/maybe";
import type { Rating, RatingDivergence } from "@/lib/core/types";
import { divergenceCopy } from "@/lib/rank/divergence";

/**
 * Rating rendering. Every component here takes a `Maybe` and has a real,
 * written-out unavailable state — there is no code path that renders a zero, a
 * dash-that-looks-like-a-score, or an empty star row. If we don't have the
 * number, we say which source didn't have it.
 */

function formatScore(value: number, scale: Rating["scale"]): string {
  switch (scale) {
    case "ten":
      return value.toFixed(1);
    case "percent":
      return `${Math.round(value)}%`;
    case "five":
      return value.toFixed(1);
  }
}

export function ScoreChip({ rating }: { readonly rating: Rating }) {
  const value = rating.value;
  const unavailable = !isOk(value);

  const body = (
    <>
      <span className="eyebrow text-muted">{rating.label}</span>
      {isOk(value) ? (
        <span className="display-tight text-base text-paper">
          {formatScore(value.value, rating.scale)}
          {rating.scale === "ten" ? (
            <span className="text-muted text-[11px] font-normal">/10</span>
          ) : null}
        </span>
      ) : (
        <span className="text-[11px] text-muted leading-tight">
          {UNAVAILABLE_COPY[value.reason]}
        </span>
      )}
    </>
  );

  const className = `flex min-w-[74px] flex-col gap-1 border-l-2 pl-2 ${
    unavailable ? "border-surface-hi" : "border-gold"
  }`;

  if (isOk(rating.sourceUrl) && !unavailable) {
    return (
      <a
        href={rating.sourceUrl.value}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} transition-opacity hover:opacity-75`}
      >
        {body}
      </a>
    );
  }

  return <div className={className}>{body}</div>;
}

export function ScoreRow({ ratings }: { readonly ratings: readonly Rating[] }) {
  if (ratings.length === 0) {
    return (
      <p className="text-[11px] text-muted">
        No critic scores on file for this title yet.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-3">
      {ratings.map((rating) => (
        <ScoreChip key={`${rating.source}-${rating.label}`} rating={rating} />
      ))}
    </div>
  );
}

/**
 * Rating divergence. Only rendered when both a critic and an audience number
 * genuinely exist and are far enough apart to be worth saying — see
 * lib/rank/divergence.ts. The bar is a literal picture of the two numbers, not
 * a decorative gradient.
 */
export function DivergenceBadge({
  divergence,
  compact = false,
}: {
  readonly divergence: Maybe<RatingDivergence>;
  readonly compact?: boolean;
}) {
  if (!isOk(divergence)) return null;
  const d = divergence.value;

  if (compact) {
    return (
      <span className="eyebrow inline-flex items-center gap-1 bg-surface-hi px-1.5 py-1 text-gold">
        <span aria-hidden="true">±</span>
        {Math.abs(d.gap)}
        <span className="sr-only">{divergenceCopy(d)}</span>
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2 border border-surface-hi bg-surface p-3">
      <p className="eyebrow text-gold">Split verdict</p>
      <p className="text-sm text-paper">{divergenceCopy(d)}</p>
      <div className="flex flex-col gap-1.5">
        <Bar label={d.criticLabel} percent={d.criticPercent} tone="flare" />
        <Bar label={d.audienceLabel} percent={d.audiencePercent} tone="cool" />
      </div>
    </div>
  );
}

function Bar({
  label,
  percent,
  tone,
}: {
  readonly label: string;
  readonly percent: number;
  readonly tone: "flare" | "cool";
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[104px] shrink-0 truncate text-[11px] text-muted">{label}</span>
      <span className="h-2 flex-1 bg-surface-hi">
        <span
          className={`block h-full ${tone === "flare" ? "bg-flare" : "bg-cool"}`}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-paper">
        {percent}
      </span>
    </div>
  );
}

/**
 * Our own community score. Deliberately styled differently from the critic
 * chips and always labelled as ours — it is never blended into the IMDb or
 * Rotten Tomatoes numbers.
 */
export function CommunityScore({
  score,
  count,
}: {
  readonly score: Maybe<number>;
  readonly count: Maybe<number>;
}) {
  return (
    <div className="flex min-w-[104px] flex-col gap-1 border-l-2 border-cool pl-2">
      <span className="eyebrow text-cool">Airtime readers</span>
      {isOk(score) && isOk(count) ? (
        <>
          <span className="display-tight text-base text-paper">
            {score.value.toFixed(1)}
            <span className="text-[11px] font-normal text-muted">/10</span>
          </span>
          <span className="text-[11px] text-muted">
            {count.value.toLocaleString()} {count.value === 1 ? "rating" : "ratings"}
          </span>
        </>
      ) : (
        <span className="text-[11px] leading-tight text-muted">
          No reader ratings yet — be first
        </span>
      )}
    </div>
  );
}

/**
 * Anticipation, for unreleased titles. An unreleased film has no ratings
 * anywhere, so we never render an empty or zero rating widget for one. This
 * replaces it, and says plainly that the number is ours.
 */
export function AnticipationMeter({ count }: { readonly count: Maybe<number> }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-gold pl-2">
      <span className="eyebrow text-gold">Airtime anticipation</span>
      {isOk(count) ? (
        <span className="text-sm text-paper">
          <span className="display-tight text-base">{count.value.toLocaleString()}</span>{" "}
          <span className="text-[11px] text-muted">
            {count.value === 1 ? "watchlist add" : "watchlist adds"}
          </span>
        </span>
      ) : (
        <span className="text-[11px] leading-tight text-muted">
          Not on anyone&rsquo;s watchlist yet
        </span>
      )}
      <span className="text-[10px] leading-tight text-muted/70">
        Our own signal. Unreleased films have no critic scores.
      </span>
    </div>
  );
}
