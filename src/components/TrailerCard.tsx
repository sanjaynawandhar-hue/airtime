import Image from "next/image";
import Link from "next/link";
import { isOk } from "@/lib/core/maybe";
import type { TrailerRecord } from "@/lib/providers/trailers";
import { relativeTime } from "./Meta";

/**
 * A trailer, led by its 16:9 YouTube thumbnail.
 *
 * The view count is the whole point of this rail — it is the ranking signal and
 * a real number from YouTube — so it is set in the display face and given the
 * most visual weight after the film title.
 */

/**
 * Compact form for display only. The exact figure goes in the `title`
 * attribute and in the screen-reader text, so rounding "61,795,434" to "61.8M"
 * never becomes the only number available.
 */
function compactViews(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Language names for the tags TMDB actually returns on Indian trailers.
 * Anything outside this map shows no badge rather than a raw ISO code.
 */
const LANGUAGE_NAME: Record<string, string> = {
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  kn: "Kannada",
  bn: "Bengali",
  mr: "Marathi",
  pa: "Punjabi",
  en: "English",
};

export function TrailerCard({
  trailer,
  rank,
}: {
  readonly trailer: TrailerRecord;
  readonly rank: number;
}) {
  const exact = trailer.viewCount.toLocaleString("en-IN");
  const language = trailer.language ? LANGUAGE_NAME[trailer.language] : undefined;

  return (
    <article className="group w-full sm:w-[320px]">
      <a
        href={trailer.watchUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block focus-visible:outline-3 focus-visible:outline-gold"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-surface">
          {isOk(trailer.thumbnailUrl) ? (
            <Image
              src={trailer.thumbnailUrl.value}
              alt=""
              fill
              className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              sizes="(max-width: 640px) 100vw, 320px"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[11px] text-muted">
              No thumbnail
            </span>
          )}

          <span className="display absolute left-0 top-0 bg-flare px-2 py-1 text-[13px] leading-none text-ink">
            {rank}
          </span>

          <span className="absolute bottom-1.5 right-1.5 bg-ink-deep/85 px-1.5 py-0.5 text-[11px] text-ink">
            {/* Which language this cut is in. A Hindi film's "official trailer"
                is often an English dub, and the two are different videos with
                different audiences — saying which one this is beats making the
                reader click to find out. */}
            {language ? `${language} ${trailer.kind.toLowerCase()}` : trailer.kind}
          </span>
        </div>

        <h3 className="mt-2 clamp-2 text-[13px] font-semibold leading-snug text-paper">
          {trailer.filmTitle}
          <span className="sr-only"> — trailer, opens on YouTube in a new tab</span>
        </h3>
      </a>

      <p
        className="display mt-1 text-[15px] leading-none text-paper"
        title={`${exact} views on YouTube`}
      >
        {compactViews(trailer.viewCount)}
        <span className="ml-1 text-[11px] font-normal text-muted">views</span>
        <span className="sr-only"> — {exact} views on YouTube</span>
      </p>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span>{relativeTime(trailer.publishedAt)}</span>
        {isOk(trailer.channelTitle) ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="clamp-1">{trailer.channelTitle.value}</span>
          </>
        ) : null}
      </p>

      <Link
        href={`/film/${trailer.tmdbId}`}
        className="mt-1 inline-block text-[11px] text-cool transition-colors hover:text-gold"
      >
        Film details
      </Link>
    </article>
  );
}
