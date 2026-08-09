import "server-only";
import { REVALIDATE, keys, providerEnabled, PODCAST_SHOWS, type PodcastShow } from "../core/config";
import { buildUrl, fetchJson } from "../core/fetcher";
import { fromNumeric, fromText, ok, unavailable } from "../core/maybe";
import type { PodcastEpisode, Provenance } from "../core/types";

/**
 * Podcast episodes, from an allowlist of shows.
 *
 * This reads each show's uploads playlist rather than searching, for two
 * reasons. Cost: playlistItems.list is 1 quota unit against search.list's 100,
 * so refreshing five shows costs 5 units instead of 500. Correctness: an
 * uploads playlist is definitionally that channel's own videos, so nothing
 * from outside the allowlist can appear — there is no relevance ranking to go
 * wrong.
 *
 * Episodes are ordered by publish date, newest first. That is a real property
 * of the data, not a popularity ranking we invented — which is why
 * `PodcastEpisode` has no `rank` field at all.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * An uploads playlist is everything a channel posts — full episodes, but also
 * Shorts and clip cutdowns. Without a length floor the section led with a
 * 2-minute Short, which is not what a reader opening "Podcast" wants.
 *
 * The floor is PER SHOW (see PodcastShow.minEpisodeMinutes), because a single
 * global 20-minute rule silently removed two of the five shows entirely — worse
 * than showing a shorter video, because the reader just sees a show they picked
 * produce nothing.
 */

/** ISO 8601 duration -> total seconds. Null when unparseable. */
function durationSeconds(iso: string): number | null {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(m ?? 0) * 60 +
    Number(s ?? 0)
  );
}

/**
 * True when we know the video is long enough. A video whose duration we could
 * NOT read is kept — dropping it would mean acting on an absence as though it
 * were a measurement.
 */
function isEpisodeLength(episode: PodcastEpisode, minMinutes: number): boolean {
  if (episode.duration.status !== "ok") return true;
  const seconds = durationSeconds(episode.duration.value);
  if (seconds === null) return true;
  return seconds >= minMinutes * 60;
}

interface PlaylistItemsResponse {
  readonly items?: readonly {
    readonly snippet?: {
      readonly title?: string;
      readonly publishedAt?: string;
      readonly channelId?: string;
      readonly thumbnails?: Record<string, { readonly url?: string } | undefined>;
      readonly resourceId?: { readonly videoId?: string };
    };
  }[];
}

interface VideosResponse {
  readonly items?: readonly {
    readonly id?: string;
    readonly statistics?: { readonly viewCount?: string };
    readonly contentDetails?: { readonly duration?: string };
  }[];
}

/** Largest first — take the best thumbnail YouTube actually returned. */
const THUMBNAIL_PREFERENCE = ["maxres", "standard", "high", "medium", "default"];

function pickThumbnail(
  thumbs: Record<string, { readonly url?: string } | undefined> | undefined,
) {
  if (!thumbs) return unavailable<string>("not_in_source");
  for (const size of THUMBNAIL_PREFERENCE) {
    const url = thumbs[size]?.url;
    if (url && url.trim() !== "") return ok(url);
  }
  return unavailable<string>("not_in_source");
}

const isConfigured = (): boolean =>
  providerEnabled.youtube && Boolean(keys.youtube);

function provenanceFor(videoId: string, fetchedAt: string): Provenance {
  return {
    source: "youtube",
    fetchedAt,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/** Newest uploads for one show. Returns [] rather than throwing. */
async function fetchShowEpisodes(
  show: PodcastShow,
  perShow: number,
): Promise<readonly PodcastEpisode[]> {
  const outcome = await fetchJson<PlaylistItemsResponse>({
    source: "youtube",
    url: buildUrl(`${API_BASE}/playlistItems`, {
      part: "snippet",
      playlistId: show.uploadsPlaylistId,
      maxResults: Math.min(Math.max(perShow, 1), 50),
      key: keys.youtube,
    }),
    revalidate: REVALIDATE.musicCharts,
    tags: [`podcast:${show.id}`],
  });

  if (!outcome.ok) return [];

  const episodes: PodcastEpisode[] = [];
  for (const item of outcome.data.items ?? []) {
    const videoId = item.snippet?.resourceId?.videoId?.trim();
    const title = item.snippet?.title?.trim();
    if (!videoId || !title) continue;

    // YouTube leaves deleted/private uploads in the playlist as tombstones.
    // They carry no real title, so they are dropped rather than rendered.
    if (title === "Private video" || title === "Deleted video") continue;

    episodes.push({
      key: `youtube:${videoId}`,
      videoId,
      title,
      showId: show.id,
      showName: show.name,
      showUrl: `https://www.youtube.com/channel/${show.id}`,
      thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
      publishedAt: fromText(item.snippet?.publishedAt),
      // Filled in by the batch stats call below.
      viewCount: unavailable("not_in_source"),
      duration: unavailable("not_in_source"),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      provenance: provenanceFor(videoId, outcome.fetchedAt),
    });
  }
  return episodes;
}

/**
 * View counts and durations for up to 50 videos in ONE call (1 unit).
 * A video whose channel hides its count simply keeps `unavailable` — there is
 * no zero, because a hidden count is not zero views.
 */
async function attachStats(
  episodes: readonly PodcastEpisode[],
): Promise<readonly PodcastEpisode[]> {
  if (episodes.length === 0) return episodes;

  const stats = new Map<string, { views?: string; duration?: string }>();

  for (let i = 0; i < episodes.length; i += 50) {
    const batch = episodes.slice(i, i + 50);
    const outcome = await fetchJson<VideosResponse>({
      source: "youtube",
      url: buildUrl(`${API_BASE}/videos`, {
        part: "statistics,contentDetails",
        id: batch.map((e) => e.videoId).join(","),
        key: keys.youtube,
      }),
      revalidate: REVALIDATE.musicCharts,
      tags: ["podcast:stats"],
    });
    if (!outcome.ok) continue;
    for (const item of outcome.data.items ?? []) {
      if (item.id) {
        stats.set(item.id, {
          views: item.statistics?.viewCount,
          duration: item.contentDetails?.duration,
        });
      }
    }
  }

  return episodes.map((episode) => {
    const found = stats.get(episode.videoId);
    if (!found) return episode;
    return {
      ...episode,
      viewCount: fromNumeric(found.views),
      duration: fromText(found.duration),
    };
  });
}

export interface PodcastQuery {
  /** Limit to one show by channel id. Omit for every allowlisted show. */
  readonly showId?: string;
  readonly perShow?: number;
}

/**
 * Episodes across the allowlist, newest first.
 *
 * The allowlist is enforced twice — once by only ever requesting playlists we
 * hold, and once by filtering the result — so a config edit that introduces a
 * bad id cannot leak another channel's uploads into the section.
 */
export async function fetchPodcastEpisodes(
  query: PodcastQuery = {},
): Promise<readonly PodcastEpisode[]> {
  if (!isConfigured()) return [];

  const shows = query.showId
    ? PODCAST_SHOWS.filter((s) => s.id === query.showId)
    : PODCAST_SHOWS;
  if (shows.length === 0) return [];

  const wanted = query.perShow ?? (query.showId ? 20 : 6);

  /**
   * Over-fetch, because Shorts and clips are about to be filtered out and they
   * often dominate the most recent uploads. Costs nothing extra: playlistItems
   * is 1 unit per call regardless of maxResults.
   */
  // Always take the maximum page. Shorts-heavy channels bury their long
  // episodes, and playlistItems costs 1 unit whatever maxResults says.
  const perShow = 50;

  const batches = await Promise.all(
    shows.map((show) => fetchShowEpisodes(show, perShow)),
  );

  const allowed = new Set(PODCAST_SHOWS.map((s) => s.id));
  const merged = batches
    .flat()
    .filter((episode) => allowed.has(episode.showId))
    .sort((a, b) => {
      // Newest first. Episodes with no publish date sort last rather than
      // being assigned a date we do not have.
      const at = a.publishedAt.status === "ok" ? Date.parse(a.publishedAt.value) : NaN;
      const bt = b.publishedAt.status === "ok" ? Date.parse(b.publishedAt.value) : NaN;
      if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
      if (Number.isNaN(at)) return 1;
      if (Number.isNaN(bt)) return -1;
      return bt - at;
    });

  // Duration only arrives with the stats call, so the length filter has to run
  // after it — then trim each show back to what was actually asked for.
  const withStats = await attachStats(merged);
  const floors = new Map(PODCAST_SHOWS.map((s) => [s.id, s.minEpisodeMinutes]));
  const episodes = withStats.filter((episode) =>
    isEpisodeLength(episode, floors.get(episode.showId) ?? 20),
  );

  const perShowCount = new Map<string, number>();
  return episodes.filter((episode) => {
    const seen = perShowCount.get(episode.showId) ?? 0;
    if (seen >= wanted) return false;
    perShowCount.set(episode.showId, seen + 1);
    return true;
  });
}

export const podcastsConfigured = isConfigured;
