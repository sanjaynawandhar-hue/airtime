import "server-only";
import { fetchJson } from "@/lib/core/fetcher";
import { keys, providerEnabled, REVALIDATE } from "@/lib/core/config";
import { fromNumeric, ok, unavailable, type Maybe } from "@/lib/core/maybe";
import { posterUrl } from "./tmdb";

/**
 * Trailers, ranked by how many people actually watched them.
 *
 * This section needs two sources and neither can do it alone:
 *
 *   TMDB knows WHICH YouTube video is a given film's trailer. YouTube's own
 *   search cannot tell you that reliably — searching "<title> trailer" returns
 *   reaction videos, fan edits and concatenated "ALL TRAILERS" compilations,
 *   and there is no field that says "this is the official trailer for film X".
 *
 *   YouTube knows the VIEW COUNT. TMDB does not carry one at all.
 *
 * So: TMDB supplies the film -> video mapping, YouTube supplies the ranking
 * signal, and a trailer only appears here if BOTH answered. A film whose
 * trailer YouTube has no statistics for is dropped rather than shown with a
 * blank or assumed count — the whole rail is ordered by views, so a record
 * without one has no defensible position in it.
 */

const TMDB_API = "https://api.themoviedb.org/3";
const YT_API = "https://www.googleapis.com/youtube/v3";

/** videos.list caps `id` at 50 per call. Documented limit, not a guess. */
const YT_ID_BATCH = 50;

/** Discover pages to sweep per scope. 3 pages = up to 60 candidate films. */
const DISCOVER_PAGES = 3;

/**
 * The window, in days. The section is defined as "trailers from the last
 * month", so this is the section's meaning rather than a tuning knob — it is
 * surfaced in the UI so the reader knows exactly what they are looking at.
 */
export const TRAILER_WINDOW_DAYS = 30;

/**
 * How far around today to look for films. Trailers land months before release
 * and keep accruing views for a while after, so the film pool is deliberately
 * much wider than the trailer window.
 */
const RELEASE_LOOKBACK_DAYS = 150;
const RELEASE_LOOKAHEAD_DAYS = 180;

/**
 * Indian-language originals. A trailer rail for India that ranked purely on
 * `region=IN` would fill with Hollywood releases playing in India, which is not
 * what "Top India" means to a reader here.
 */
const INDIAN_ORIGINAL_LANGUAGES = ["hi", "ta", "te", "ml", "kn", "bn", "mr", "pa"];

/**
 * Video languages to ask TMDB for.
 *
 * THIS IS NOT OPTIONAL. `/movie/{id}/videos` defaults to `language=en-US` and
 * returns ONLY English-tagged videos. Measured on Ramayana (tmdb 656908) on
 * 2026-08-10: the default call returned two English dubs and nothing else,
 * while the actual Hindi trailer — published 2026-07-29, the one people in
 * India watched — was invisible. An Indian trailer rail built on the default
 * call is an English-dub rail wearing an Indian label.
 *
 * `null` is included because TMDB uses it for videos carrying no language tag,
 * and dropping those loses legitimate trailers.
 *
 * The two scopes ask for DIFFERENT languages, and that is the point. Asking the
 * international rail for Indian languages too put "Hindi trailer — Avengers:
 * Doomsday" at its number one: a real video, but a Hindi dub is not what
 * "international" means to a reader, and because the rail ranks on views the
 * dub outranked the English original. Each rail asks only for the languages it
 * is about.
 */
const VIDEO_LANGUAGES: Record<TrailerScope, string> = {
  india: `${INDIAN_ORIGINAL_LANGUAGES.join(",")},en,null`,
  international: "en,null",
};

export type TrailerScope = "india" | "international";

export interface TrailerRecord {
  readonly key: string;
  readonly videoId: string;
  readonly tmdbId: number;
  readonly filmTitle: string;
  readonly trailerTitle: string;
  readonly posterUrl: Maybe<string>;
  readonly thumbnailUrl: Maybe<string>;
  /** Real YouTube view count. Never estimated — a record without one is dropped. */
  readonly viewCount: number;
  readonly likeCount: Maybe<number>;
  readonly publishedAt: string;
  readonly channelTitle: Maybe<string>;
  /** "Trailer" or "Teaser", as TMDB classified it. */
  readonly kind: string;
  /** The trailer's own language, as TMDB tagged it. Null when untagged. */
  readonly language: string | null;
  readonly watchUrl: string;
  readonly fetchedAt: string;
}

export function trailersConfigured(): boolean {
  return (
    providerEnabled.tmdb &&
    Boolean(keys.tmdb) &&
    providerEnabled.youtube &&
    Boolean(keys.youtube)
  );
}

/** Which of the two required sources is missing, for an honest empty state. */
export function missingTrailerSources(): readonly string[] {
  const missing: string[] = [];
  if (!providerEnabled.tmdb || !keys.tmdb) missing.push("TMDB");
  if (!providerEnabled.youtube || !keys.youtube) missing.push("YouTube");
  return missing;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded concurrency — TMDB is queried once per candidate film. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * TMDB: candidate films, then their trailer videos
 * ------------------------------------------------------------------ */

interface TmdbDiscoverItem {
  readonly id?: number;
  readonly title?: string;
  readonly poster_path?: string | null;
}

interface TmdbVideo {
  readonly key?: string;
  readonly name?: string;
  readonly site?: string;
  readonly type?: string;
  readonly official?: boolean;
  readonly published_at?: string;
  /** ISO-639-1 of the video itself, e.g. "hi" for a Hindi trailer. */
  readonly iso_639_1?: string;
}

interface TmdbFilm {
  readonly id: number;
  readonly title: string;
  readonly posterPath: string | null;
}

async function discoverFilms(scope: TrailerScope): Promise<readonly TmdbFilm[]> {
  const region = scope === "india" ? "IN" : "US";
  const films = new Map<number, TmdbFilm>();

  for (let page = 1; page <= DISCOVER_PAGES; page += 1) {
    const url = buildUrl(`${TMDB_API}/discover/movie`, {
      region,
      page,
      sort_by: "popularity.desc",
      "primary_release_date.gte": isoDay(-RELEASE_LOOKBACK_DAYS),
      "primary_release_date.lte": isoDay(RELEASE_LOOKAHEAD_DAYS),
      with_original_language:
        scope === "india" ? INDIAN_ORIGINAL_LANGUAGES.join("|") : undefined,
    });

    const outcome = await fetchJson<{ results?: readonly TmdbDiscoverItem[] }>({
      source: "tmdb",
      url,
      headers: { Authorization: `Bearer ${keys.tmdb ?? ""}` },
      revalidate: REVALIDATE.trailers,
      tags: ["tmdb", `tmdb:trailers:pool:${scope}`],
    });

    // A failed page is not fatal — rank what the other pages returned.
    if (!outcome.ok) break;

    for (const item of outcome.data.results ?? []) {
      const title = item.title?.trim();
      if (typeof item.id !== "number" || !title) continue;
      if (!films.has(item.id)) {
        films.set(item.id, { id: item.id, title, posterPath: item.poster_path ?? null });
      }
    }
  }

  return [...films.values()];
}

interface Candidate {
  readonly film: TmdbFilm;
  readonly videoId: string;
  readonly trailerTitle: string;
  readonly kind: string;
  readonly publishedAt: string;
  readonly language: string | null;
}

/**
 * Every trailer/teaser this film published inside the window — not just one.
 *
 * All of them are kept at this stage because the rail ranks on views, and TMDB
 * cannot tell us which of a film's five teasers people actually watched. The
 * reduction to one video per film happens AFTER YouTube supplies the counts,
 * so the film is represented by its genuinely most-watched trailer.
 */
async function trailerCandidates(
  film: TmdbFilm,
  cutoff: number,
  scope: TrailerScope,
): Promise<Candidate[]> {
  const outcome = await fetchJson<{ results?: readonly TmdbVideo[] }>({
    source: "tmdb",
    url: buildUrl(`${TMDB_API}/movie/${film.id}/videos`, {
      include_video_language: VIDEO_LANGUAGES[scope],
    }),
    headers: { Authorization: `Bearer ${keys.tmdb ?? ""}` },
    revalidate: REVALIDATE.trailers,
    tags: ["tmdb", `tmdb:trailers:videos:${scope}:${film.id}`],
  });

  if (!outcome.ok) return [];

  const out: Candidate[] = [];
  for (const video of outcome.data.results ?? []) {
    if (video.site !== "YouTube") continue;

    const kind = video.type?.trim();
    if (kind !== "Trailer" && kind !== "Teaser") continue;

    const videoId = video.key?.trim();
    if (!videoId) continue;

    const published = Date.parse(video.published_at ?? "");
    if (!Number.isFinite(published) || published < cutoff) continue;

    out.push({
      film,
      videoId,
      trailerTitle: video.name?.trim() || `${film.title} — ${kind}`,
      kind,
      publishedAt: new Date(published).toISOString(),
      language: video.iso_639_1?.trim().toLowerCase() || null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * YouTube: the ranking signal
 * ------------------------------------------------------------------ */

interface YtItem {
  readonly id?: string;
  readonly snippet?: {
    readonly channelTitle?: string;
    readonly thumbnails?: Record<string, { readonly url?: string } | undefined>;
  };
  readonly statistics?: { readonly viewCount?: string; readonly likeCount?: string };
}

function bestThumbnail(item: YtItem | undefined): Maybe<string> {
  const t = item?.snippet?.thumbnails;
  const url =
    t?.maxres?.url ?? t?.standard?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url;
  return url ? ok(url) : unavailable("not_in_source");
}

async function fetchStats(videoIds: readonly string[]): Promise<Map<string, YtItem>> {
  const stats = new Map<string, YtItem>();

  for (const batch of chunk(videoIds, YT_ID_BATCH)) {
    const outcome = await fetchJson<{ items?: readonly YtItem[] }>({
      source: "youtube",
      url: buildUrl(`${YT_API}/videos`, {
        part: "snippet,statistics",
        id: batch.join(","),
        key: keys.youtube,
      }),
      revalidate: REVALIDATE.trailers,
      tags: ["youtube", "youtube:trailers"],
    });

    // A failed batch drops those videos rather than the whole rail.
    if (!outcome.ok) continue;

    for (const item of outcome.data.items ?? []) {
      if (item.id) stats.set(item.id, item);
    }
  }

  return stats;
}

/* ------------------------------------------------------------------ *
 * Composed
 * ------------------------------------------------------------------ */

export async function fetchTrailers(
  scope: TrailerScope,
  limit = 10,
): Promise<readonly TrailerRecord[]> {
  if (!trailersConfigured()) return [];

  const cutoff = Date.now() - TRAILER_WINDOW_DAYS * 86_400_000;
  const films = await discoverFilms(scope);
  if (films.length === 0) return [];

  const candidates = (
    await mapLimit(films, 6, (f) => trailerCandidates(f, cutoff, scope))
  ).flat();
  if (candidates.length === 0) return [];

  const stats = await fetchStats([...new Set(candidates.map((c) => c.videoId))]);
  const fetchedAt = new Date().toISOString();

  /**
   * One record per FILM, and it must be the film's most-viewed recent trailer.
   *
   * Without this the rail is not a trailer chart at all — a single tentpole
   * release that published seven teasers in a fortnight takes every visible
   * slot. Measured on 2026-08-10: Spider-Man: Brand New Day occupied 8 of the
   * top 8 international rows before this reduction.
   */
  const bestPerFilm = new Map<number, TrailerRecord>();

  for (const c of candidates) {
    const item = stats.get(c.videoId);
    const views = fromNumeric(item?.statistics?.viewCount);
    // No view count means no place in a view-ranked list. Dropped, not zeroed.
    if (views.status !== "ok") continue;

    const record: TrailerRecord = {
      key: `trailer:${c.videoId}`,
      videoId: c.videoId,
      tmdbId: c.film.id,
      filmTitle: c.film.title,
      trailerTitle: c.trailerTitle,
      posterUrl: posterUrl(c.film.posterPath),
      thumbnailUrl: bestThumbnail(item),
      viewCount: views.value,
      likeCount: fromNumeric(item?.statistics?.likeCount),
      publishedAt: c.publishedAt,
      channelTitle: item?.snippet?.channelTitle
        ? ok(item.snippet.channelTitle)
        : unavailable<string>("not_in_source"),
      kind: c.kind,
      language: c.language,
      watchUrl: `https://www.youtube.com/watch?v=${c.videoId}`,
      fetchedAt,
    };

    const held = bestPerFilm.get(c.film.id);
    if (!held || record.viewCount > held.viewCount) bestPerFilm.set(c.film.id, record);
  }

  return [...bestPerFilm.values()]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, Math.max(0, limit));
}
