import { SOURCE_LABEL, type Provenance, type SourceId } from "@/lib/core/types";

/**
 * Attribution and freshness. TMDB's and Apple's terms both require visible
 * attribution, and showing where a number came from and when we fetched it is
 * also the cheapest way to make an aggregator trustworthy.
 */

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * "Last checked" line. Required on the Coming Soon rail specifically, because
 * release dates move constantly in India and a date with no timestamp reads as
 * a promise rather than an observation.
 */
export function LastChecked({
  fetchedAt,
  stale = false,
  className = "",
}: {
  readonly fetchedAt: string;
  readonly stale?: boolean;
  readonly className?: string;
}) {
  return (
    <p className={`text-[11px] text-muted ${className}`}>
      {stale ? (
        <span className="text-gold">Showing saved data · </span>
      ) : null}
      Last checked {relativeTime(fetchedAt)}
    </p>
  );
}

export function SourceTag({ source }: { readonly source: SourceId }) {
  return (
    <span className="eyebrow text-muted/80">via {SOURCE_LABEL[source]}</span>
  );
}

export function Attribution({
  sources,
  className = "",
}: {
  readonly sources: readonly SourceId[];
  readonly className?: string;
}) {
  const unique = [...new Set(sources)];
  if (unique.length === 0) return null;
  return (
    <p className={`text-[11px] leading-relaxed text-muted ${className}`}>
      Data from {unique.map((s) => SOURCE_LABEL[s]).join(", ")}.
      {unique.includes("tmdb") ? (
        <>
          {" "}
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </>
      ) : null}
      {unique.includes("apple-music") || unique.includes("itunes") ? (
        <> Chart data courtesy of Apple.</>
      ) : null}
    </p>
  );
}

export function ProvenanceLine({ provenance }: { readonly provenance: Provenance }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <SourceTag source={provenance.source} />
      <span aria-hidden="true">·</span>
      {relativeTime(provenance.fetchedAt)}
      {provenance.stale ? <span className="text-gold"> · saved copy</span> : null}
    </span>
  );
}
