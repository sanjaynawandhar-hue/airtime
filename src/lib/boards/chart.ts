import "server-only";
import type { CountryCode } from "@/lib/core/types";
import {
  appleFeedBoard,
  artistBoard,
  musicBoard,
  worldGenreBoard,
  worldwideBoard,
  type MusicBoard,
  type MusicSourceId,
} from "./music";

/**
 * Resolves a URL slug to the board behind it.
 *
 * This exists so the rail on the home page and the "see all" page are provably
 * the same chart — one function builds both, so the top five you see on the
 * board cannot drift from the twenty behind it.
 */

export const CHART_SLUGS = [
  "apple-music",
  "apple-albums",
  "apple-videos",
  "youtube",
  "lastfm",
  "deezer",
  "worldwide",
  "world-genre",
  "artist",
] as const;

export type ChartSlug = (typeof CHART_SLUGS)[number];

export function isChartSlug(value: string): value is ChartSlug {
  return (CHART_SLUGS as readonly string[]).includes(value);
}

/** The slug a music source uses in a URL. */
export const SOURCE_SLUG: Record<MusicSourceId, ChartSlug | null> = {
  "apple-music": "apple-music",
  youtube: "youtube",
  lastfm: "lastfm",
  deezer: "deezer",
  gaana: null,
};

export interface ChartQuery {
  readonly country: CountryCode;
  readonly genre?: string;
  readonly artist?: string;
}

/**
 * How many rows a chart page shows, and how many the home rail previews.
 *
 * The rail always FETCHES the full `full` count and slices for display rather
 * than requesting five. Two reasons: the rank-movement snapshot is written from
 * what we fetched, so requesting five would quietly shrink our movement history
 * to five rows; and the "see all" page then reads from the same warm cache
 * instead of issuing a second, different request.
 */
export const CHART_FULL = 20;
export const CHART_PREVIEW = 5;

export async function chartBoard(
  slug: ChartSlug,
  query: ChartQuery,
  limit: number = CHART_FULL,
): Promise<MusicBoard> {
  switch (slug) {
    case "apple-albums":
      return appleFeedBoard({ kind: "albums", country: query.country, limit });
    case "apple-videos":
      return appleFeedBoard({ kind: "music-videos", country: query.country, limit });
    case "worldwide":
      return worldwideBoard(query.country, limit);
    case "world-genre":
      return worldGenreBoard(query.genre ?? "pop", query.country, limit);
    case "artist":
      return artistBoard(query.artist ?? "", query.country, limit);
    default:
      return musicBoard({
        source: slug as MusicSourceId,
        country: query.country,
        genre: query.genre,
        limit,
      });
  }
}

/** Builds the "see all" href for a chart, carrying the context it needs. */
export function chartHref(slug: ChartSlug, query: ChartQuery): string {
  const params = new URLSearchParams({ country: query.country });
  if (query.genre) params.set("genre", query.genre);
  if (query.artist) params.set("artist", query.artist);
  return `/chart/${slug}?${params.toString()}`;
}
