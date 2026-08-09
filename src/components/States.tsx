import Link from "next/link";

/**
 * Empty and error states, written as sentences a person would say.
 *
 * There is no generic "Something went wrong." anywhere in this product. Every
 * state here says which source is involved and what the reader can do, because
 * for an aggregator the failure of one source is normal operation, not a crash.
 */

export function EmptyRail({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly href: string };
}) {
  return (
    <div className="mx-[var(--board-gutter)] border border-surface-hi bg-surface px-5 py-8">
      <p className="display-tight mb-2 text-lg text-paper">{title}</p>
      <p className="max-w-prose text-sm leading-relaxed text-muted">{body}</p>
      {action ? (
        <Link
          href={action.href}
          className="mt-4 inline-block border border-gold px-4 py-2 text-sm font-semibold text-gold transition-colors hover:bg-gold hover:text-ink"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * A source is unreachable. Named explicitly — "Apple Music didn't answer" is
 * information; "Something went wrong" is not.
 */
export function SourceDown({
  sourceName,
  what,
}: {
  readonly sourceName: string;
  readonly what: string;
}) {
  return (
    <div className="mx-[var(--board-gutter)] border border-flare/40 bg-surface px-5 py-6">
      <p className="eyebrow mb-2 text-flare">{sourceName} didn&rsquo;t answer</p>
      <p className="max-w-prose text-sm leading-relaxed text-muted">
        We couldn&rsquo;t reach {sourceName} just now, so {what} isn&rsquo;t showing.
        Everything else on this page is unaffected. We&rsquo;ll try again on the
        next refresh.
      </p>
    </div>
  );
}

/** A key is missing. Only ever seen by the operator, but written plainly anyway. */
export function NotConnected({
  sourceName,
  what,
}: {
  readonly sourceName: string;
  readonly what: string;
}) {
  return (
    <div className="mx-[var(--board-gutter)] border border-surface-hi bg-surface px-5 py-6">
      <p className="eyebrow mb-2 text-muted">{sourceName} not connected</p>
      <p className="max-w-prose text-sm leading-relaxed text-muted">
        {what} needs a {sourceName} API key. Add one to the environment and this
        section fills in on the next request. Nothing else on the page depends on
        it.
      </p>
    </div>
  );
}

/**
 * Says up front how much of the page is actually live.
 *
 * Without this, a reader with missing keys discovers the emptiness one rail at
 * a time and concludes the product is broken. Stating "2 of 6 sources
 * connected" at the top is both more honest and less alarming than four
 * separate empty boxes, and it points at the one place that explains why.
 */
export function SourceBanner({
  connected,
  total,
  missing,
}: {
  readonly connected: number;
  readonly total: number;
  readonly missing: readonly string[];
}) {
  if (missing.length === 0) return null;

  return (
    <div className="mx-[var(--board-gutter)] mt-4 border-l-2 border-gold bg-surface px-4 py-3">
      <p className="text-[13px] leading-relaxed text-paper">
        <span className="eyebrow mr-2 text-gold">
          {connected} of {total} sources connected
        </span>
        {missing.join(", ")} {missing.length === 1 ? "needs" : "need"} an API key,
        so those rails are empty. Everything below that has data is real and live.
      </p>
      <Link
        href="/status"
        className="mt-1.5 inline-block text-[12px] text-gold underline hover:no-underline"
      >
        See what&rsquo;s connected
      </Link>
    </div>
  );
}

export function SkeletonRail({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="rail" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="h-[248px] w-[164px] shrink-0 animate-pulse bg-surface"
        />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 5 }: { readonly count?: number }) {
  return (
    <div className="flex flex-col gap-2 px-[var(--board-gutter)]" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-[72px] animate-pulse bg-surface" />
      ))}
    </div>
  );
}
