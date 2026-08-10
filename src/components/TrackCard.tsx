import Image from "next/image";
import { isOk } from "@/lib/core/maybe";
import type { TrackRecord } from "@/lib/core/types";
import { MovementBar } from "./MovementBar";
import { AudioPreview } from "./AudioPreview";

/**
 * A row on the board. The rank numeral is set large and bled off the left edge
 * so the numbers form their own column down the rail — the card reads as a
 * position in a standing rather than a tile in a grid. See DESIGN.md.
 *
 * There is deliberately no per-card source tag: every rail is single-source and
 * says so in its heading, so repeating it on twenty cards would be noise in the
 * one place the card has no room to spare.
 */

/**
 * The source's own play/view count, where it reports one.
 *
 * The noun is derived from the source rather than genericised, because they
 * count different things: YouTube's number is video views, Last.fm's is
 * scrobbles. Calling both "plays" would quietly merge two different
 * measurements. Sources that report no count render nothing at all — there is
 * no zero here, because a hidden view count is not zero views.
 */
function PlayCount({ track }: { readonly track: TrackRecord }) {
  const count = track.playCount;
  if (!isOk(count)) return null;

  const noun =
    track.provenance.source === "youtube"
      ? "views"
      : track.provenance.source === "lastfm"
        ? "scrobbles"
        : "plays";

  const n = count.value;
  const compact =
    n >= 1_000_000_000
      ? `${(n / 1_000_000_000).toFixed(1)}B`
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(0)}K`
          : String(n);

  return (
    <span className="truncate text-[11px] text-muted" title={`${n.toLocaleString()} ${noun}`}>
      {compact} {noun}
    </span>
  );
}

export function TrackCard({
  track,
  stale = false,
  showRank = true,
}: {
  readonly track: TrackRecord;
  readonly stale?: boolean;
  /**
   * Off for search results. `rank` there is Apple's relevance ordering, and
   * rendering it in the chart numeral — the same numeral the boards use for a
   * real chart position — would present relevance as a ranking no source
   * published.
   */
  readonly showRank?: boolean;
}) {
  const artwork = track.artworkUrl;
  const preview = track.previewUrl;
  const primaryLink = track.links[0];

  return (
    <article className="group relative flex w-full items-center gap-3 border border-surface-hi/60 bg-surface py-2.5 pl-9 pr-2.5 transition-colors hover:border-gold/50 sm:w-[290px]">
      {/* Rank, bled off the left edge. Decorative duplication — the accessible
          name below carries the position. */}
      {showRank ? (
        <span
          aria-hidden="true"
          className="rank-numeral pointer-events-none absolute -left-1.5 top-1/2 -translate-y-1/2 select-none text-[44px] text-paper/15"
        >
          {track.rank}
        </span>
      ) : null}

      {isOk(artwork) ? (
        <Image
          src={artwork.value}
          alt=""
          width={52}
          height={52}
          className="h-[52px] w-[52px] shrink-0 bg-surface-hi object-cover"
          sizes="52px"
        />
      ) : (
        <span
          className="flex h-[52px] w-[52px] shrink-0 items-center justify-center bg-surface-hi text-[9px] leading-tight text-muted"
          aria-hidden="true"
        >
          No art
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-paper">
          {showRank ? <span className="sr-only">Number {track.rank}: </span> : null}
          {track.title}
        </p>
        <p className="truncate text-[12px] leading-tight text-muted">{track.artist}</p>
        <div className="mt-1 flex items-center gap-2">
          <MovementBar movement={track.movement} stale={stale} size="sm" />
          <PlayCount track={track} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {isOk(preview) ? (
          <AudioPreview
            previewUrl={preview.value}
            title={track.title}
            artist={track.artist}
          />
        ) : null}
        {primaryLink ? (
          <a
            href={primaryLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center border border-paper/25 text-muted transition-colors hover:border-gold hover:text-gold"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4.5 1.5h6v6M10.5 1.5L5 7M9 7.5v3h-7.5V3h3" />
            </svg>
            <span className="sr-only">
              Open {track.title} on {primaryLink.platformName} (new tab)
            </span>
          </a>
        ) : null}
      </div>
    </article>
  );
}
