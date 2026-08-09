import { isOk, type Maybe } from "@/lib/core/maybe";
import type { Movement } from "@/lib/core/types";
import { movementCopy } from "@/lib/rank/movement";

/**
 * THE SIGNATURE ELEMENT. Every card in the product carries one. See DESIGN.md.
 *
 * Why it is drawn as a TWO-STEP and not a sparkline:
 * we have exactly two real observations of a title's position — where it was in
 * the last snapshot, and where it is now. A smooth seven-point sparkline would
 * require five points we do not have, so drawing one would be a small lie about
 * what we know. Two flat segments joined by one riser is the honest chart of
 * two data points, and it happens to read faster at 40px wide anyway.
 *
 * The stale state reuses the same component: when the data behind the card is
 * being served stale, the strip renders hatched instead of solid. Freshness is
 * therefore visible on every card, in the same place as movement, with no extra
 * badge to learn.
 */

interface Props {
  readonly movement: Maybe<Movement>;
  readonly stale?: boolean;
  readonly size?: "sm" | "md";
}

const W = 42;
const H = 18;
const STROKE = 2.5;

export function MovementBar({ movement, stale = false, size = "md" }: Props) {
  // No prior observation of this board at all. We do not know, so we say
  // nothing — an empty slot beats a fabricated "no change".
  if (!isOk(movement)) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-muted/70"
        aria-label="Movement not tracked yet"
      >
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <line
            x1="2"
            y1={H / 2}
            x2={W - 2}
            y2={H / 2}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity="0.5"
          />
        </svg>
        <span className="tabular-nums">—</span>
      </span>
    );
  }

  const m = movement.value;
  const label = movementCopy(m);

  const colour =
    m.direction === "up"
      ? "text-flare"
      : m.direction === "down"
        ? "text-cool"
        : m.direction === "new"
          ? "text-gold"
          : "text-muted";

  // A "new" entry has no previous position, so there is no step to draw.
  if (m.direction === "new") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${colour}`}
        title={label}
      >
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <rect
            x="2"
            y={H / 2 - STROKE / 2}
            width={W - 4}
            height={STROKE}
            fill="currentColor"
            className={stale ? "hatched" : undefined}
          />
        </svg>
        <span className="eyebrow">New</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  // Better rank = higher on the strip. `up` means the right segment sits high.
  const high = 4;
  const low = H - 4;
  const leftY = m.direction === "up" ? low : m.direction === "down" ? high : H / 2;
  const rightY = m.direction === "up" ? high : m.direction === "down" ? low : H / 2;

  const mid = W / 2;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${colour}`}
      title={label}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <g
          fill="currentColor"
          className={stale ? "hatched" : undefined}
          style={stale ? { color: "currentColor" } : undefined}
        >
          {/* where it was */}
          <rect x="2" y={leftY - STROKE / 2} width={mid - 2} height={STROKE} />
          {/* the move */}
          <rect
            x={mid - STROKE / 2}
            y={Math.min(leftY, rightY)}
            width={STROKE}
            height={Math.abs(rightY - leftY) || STROKE}
          />
          {/* where it is now */}
          <rect x={mid} y={rightY - STROKE / 2} width={W - mid - 2} height={STROKE} />
        </g>
      </svg>
      <span className="tabular-nums">
        {m.direction === "flat" ? "—" : `${m.direction === "up" ? "+" : "−"}${m.delta}`}
      </span>
      <span className="sr-only">{label}</span>
      {size === "md" && stale ? <span className="sr-only">(data may be out of date)</span> : null}
    </span>
  );
}
