import Image from "next/image";
import { isOk } from "@/lib/core/maybe";
import type { PodcastEpisode } from "@/lib/core/types";
import { relativeTime } from "./Meta";

/**
 * A podcast episode.
 *
 * Wider than a track card and led by a 16:9 thumbnail, because these are long
 * videos rather than chart positions — and there is no rank numeral, because
 * there is no chart. The ordering is recency, and the visible date says so.
 */

/** "PT2H14M30S" -> "2h 14m". Returns null for anything unparseable. */
function formatDuration(iso: string): string | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const [, h, m, s] = match;
  const hours = Number(h ?? 0);
  const minutes = Number(m ?? 0);
  const seconds = Number(s ?? 0);
  if (hours === 0 && minutes === 0 && seconds === 0) return null;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function compactCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function EpisodeCard({ episode }: { readonly episode: PodcastEpisode }) {
  const thumb = episode.thumbnailUrl;
  const duration = isOk(episode.duration) ? formatDuration(episode.duration.value) : null;

  return (
    <article className="group w-[280px] sm:w-[320px]">
      <a
        href={episode.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block focus-visible:outline-3 focus-visible:outline-gold"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-surface">
          {isOk(thumb) ? (
            <Image
              src={thumb.value}
              alt=""
              fill
              className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              sizes="(max-width: 640px) 280px, 320px"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[11px] text-muted">
              No thumbnail
            </span>
          )}

          {duration ? (
            <span className="absolute bottom-1.5 right-1.5 bg-ink-deep/90 px-1.5 py-0.5 text-[11px] tabular-nums text-paper">
              {duration}
            </span>
          ) : null}
        </div>

        <h3 className="mt-2 clamp-2 text-[13px] font-semibold leading-snug text-paper">
          {episode.title}
          <span className="sr-only"> — opens on YouTube in a new tab</span>
        </h3>
      </a>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <a
          href={episode.showUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cool transition-colors hover:text-gold"
        >
          {episode.showName}
        </a>
        {isOk(episode.publishedAt) ? (
          <span>· {relativeTime(episode.publishedAt.value)}</span>
        ) : null}
        {isOk(episode.viewCount) ? (
          <span title={`${episode.viewCount.value.toLocaleString()} views`}>
            · {compactCount(episode.viewCount.value)} views
          </span>
        ) : null}
      </p>
    </article>
  );
}
