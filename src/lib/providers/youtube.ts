import "server-only";

import {
  keys,
  providerEnabled,
  REVALIDATE,
  REVIEW_CHANNELS,
} from "@/lib/core/config";
import { buildUrl, fetchJson, timedFetchJson } from "@/lib/core/fetcher";
import { fromNumeric, fromText, ok, unavailable, type Maybe } from "@/lib/core/maybe";
import type {
  DeepLink,
  DetailsQuery,
  HealthStatus,
  Provenance,
  Provider,
  TrackRecord,
  TrendingQuery,
  VideoReview,
} from "@/lib/core/types";

/**
 * YouTube Data API v3 — two unrelated jobs behind one key.
 *
 *  1. MUSIC CHARTS  (`fetchTrending`)   — videos.list, chart=mostPopular,
 *     videoCategoryId=10 (Music). The list order IS YouTube's ranking.
 *  2. REVIEW SHELF  (`fetchVideoReviews`) — search.list, restricted to the
 *     REVIEW_CHANNELS allowlist in config.ts.
 *
 * COPYRIGHT: nothing in this file fetches, stores or renders transcripts,
 * captions, descriptions or review text. A review card is a thumbnail, a title,
 * a channel and a link out to YouTube — that is the entire permitted surface,
 * and `VideoReview` has no field to put anything else in.
 *
 * Verified live 2026-08-02 (see FIELD NOTES at the bottom):
 *   keyless videos.list  -> HTTP 403  PERMISSION_DENIED
 *   bad-key videos.list  -> HTTP 400  API_KEY_INVALID
 *   bad-key search.list  -> HTTP 400  API_KEY_INVALID
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

/** Category 10 = Music. Confirmed against videoCategories.list documentation. */
const MUSIC_CATEGORY_ID = "10";

/** videos.list caps maxResults at 50. Documented: "Acceptable values are 1 to 50". */
const MAX_PAGE_SIZE = 50;

/**
 * QUOTA
 * -----
 * Default project quota is 10,000 units/day.
 *   videos.list  =   1 unit per call
 *   search.list  = 100 units per call
 *
 * The review shelf is the expensive one. search.list takes exactly ONE
 * `channelId`, so a shelf for one film costs 100 units x REVIEW_CHANNELS.length.
 * With the 10 channels currently in config that is 1,000 units per title —
 * ten titles and the day's entire quota is gone. Hence `REVALIDATE.videoReviews`
 * (weekly) on every shelf call, and REVIEW_SHELF_CONCURRENCY to keep the burst
 * small enough that a 403 rateLimitExceeded does not take out the whole shelf.
 */
const REVIEW_SHELF_CONCURRENCY = 4;

/* ------------------------------------------------------------------ *
 * Wire types
 * ------------------------------------------------------------------ */

interface YtThumbnail {
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

interface YtSnippet {
  readonly publishedAt?: string;
  readonly channelId?: string;
  readonly channelTitle?: string;
  readonly title?: string;
  readonly thumbnails?: Record<string, YtThumbnail | undefined>;
  /** Present on videos.list snippets; the fallback filter below depends on it. */
  readonly categoryId?: string;
}

interface YtStatistics {
  /**
   * ABSENT — not zero — when the uploader hides the view count. Reading a
   * missing field as 0 would put "0 plays" on a video with millions, so this is
   * lifted with `fromNumeric` and renders as "No score on file" when missing.
   * It also arrives as a STRING ("184739201"), never a number.
   */
  readonly viewCount?: string;
  readonly likeCount?: string;
}

interface YtVideoItem {
  readonly id?: string;
  readonly snippet?: YtSnippet;
  readonly statistics?: YtStatistics;
}

interface YtVideoListResponse {
  readonly items?: readonly YtVideoItem[];
}

interface YtSearchItem {
  readonly id?: { readonly kind?: string; readonly videoId?: string };
  readonly snippet?: YtSnippet;
}

interface YtSearchListResponse {
  readonly items?: readonly YtSearchItem[];
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const watchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

const channelUrl = (channelId: string): string =>
  `https://www.youtube.com/channel/${channelId}`;

/** Highest-resolution thumbnail YouTube actually sent. Never synthesised. */
function bestThumbnail(snippet: YtSnippet | undefined): Maybe<string> {
  const map = snippet?.thumbnails;
  if (!map) return unavailable("not_in_source");
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    const url = map[key]?.url;
    if (typeof url === "string" && url.trim() !== "") return ok(url);
  }
  return unavailable("not_in_source");
}

function provenanceFor(sourceUrl: string, fetchedAt: string): Provenance {
  return { source: "youtube", fetchedAt, sourceUrl };
}

/** Turns a status code into copy the /status page can show verbatim. */
function describeHttpFailure(status: number | undefined, detail: string): string {
  switch (status) {
    case 400:
      return `${detail} — 400 API_KEY_INVALID: YOUTUBE_API_KEY is malformed or from the wrong project.`;
    case 403:
      return `${detail} — 403: key not registered, YouTube Data API v3 not enabled on the project, or the 10,000-unit daily quota is spent.`;
    case 404:
      return `${detail} — 404: the requested video or channel no longer exists.`;
    default:
      return detail;
  }
}

/**
 * Bounded-concurrency map. A fixed pool of `limit` workers pulls from a shared
 * cursor, so exactly `limit` requests are in flight at once.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Title parsing
 * ------------------------------------------------------------------ */

interface ParsedTitle {
  readonly title: string;
  readonly artist: string;
}

/**
 * Split "Artist - Track" into its two halves.
 *
 * YouTube has no artist field on a video — `snippet.title` is free text an
 * uploader typed, and across a real Music chart it looks like
 *   "Artist - Track (Official Video)"
 *   "Track | Movie Name | Singer"
 *   "FULL VIDEO: Track Song | Film | Cast"
 * Any clever splitter gets one of those wrong, and a wrong artist name is
 * indistinguishable from a right one on screen.
 *
 * So the rule is deliberately dumb: split on the FIRST " - " and only when both
 * halves are non-empty. Anything else keeps the whole uploader title in `title`
 * and puts `snippet.channelTitle` in `artist`.
 *
 * That fallback is a LABELLED FACT, not a guess at the performer: it is the name
 * of the channel that published the video (usually the label — T-Series, Sony
 * Music India — sometimes the artist). It is never inferred, and the UI should
 * treat an artist that equals the channel title as "published by", not "by".
 */
function parseTitle(rawTitle: string, channelTitle: string): ParsedTitle {
  const separator = rawTitle.indexOf(" - ");
  if (separator > 0) {
    const left = rawTitle.slice(0, separator).trim();
    const right = rawTitle.slice(separator + 3).trim();
    if (left !== "" && right !== "") {
      return { artist: left, title: right };
    }
  }
  return { title: rawTitle.trim(), artist: channelTitle.trim() };
}

/* ------------------------------------------------------------------ *
 * 1. MUSIC CHARTS
 * ------------------------------------------------------------------ */

/**
 * DOC CHECK, https://developers.google.com/youtube/v3/docs/videos/list
 * (read 2026-08-02). The combination is CURRENT and supported — verbatim:
 *
 *   chart:            "mostPopular – Return the most popular videos for the
 *                      specified content region and video category."
 *   videoCategoryId:  "identifies the video category for which the chart should
 *                      be retrieved. This parameter can only be used in
 *                      conjunction with the chart parameter."
 *   regionCode:       "instructs the API to select a video chart available in
 *                      the specified region. This parameter can only be used in
 *                      conjunction with the chart parameter."
 *
 * So there is no deprecation and no documented restriction on pairing the two.
 * What IS well attested in practice is that some region+category pairs return
 * `items: []` — a successful 200 with an empty chart. That is a data gap, not an
 * error, and it must not become an invented chart.
 *
 * The fallback below therefore does NOT substitute the general chart for the
 * music chart. It re-requests the same region's chart without a category and
 * keeps only items whose own `snippet.categoryId === "10"`. Every row is still a
 * genuine Music-category video that YouTube itself ranked for that region; the
 * only thing lost is that the ranking is now the region's overall popularity
 * order restricted to music, rather than YouTube's music-specific chart. Rows
 * are re-numbered 1..n over the filtered set and that is stated here so nobody
 * later mistakes those ranks for YouTube's own music positions.
 */
async function fetchMusicChart(
  country: string,
  limit: number,
): Promise<{ items: readonly YtVideoItem[]; fetchedAt: string } | null> {
  if (!keys.youtube) return null;

  const regionCode = country.toUpperCase();
  const maxResults = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));

  // `contentDetails` is deliberately not requested: nothing in TrackRecord
  // consumes duration or definition, and unused parts only inflate the payload.
  const primary = await fetchJson<YtVideoListResponse>({
    source: "youtube",
    url: buildUrl(`${API_BASE}/videos`, {
      part: "snippet,statistics",
      chart: "mostPopular",
      videoCategoryId: MUSIC_CATEGORY_ID,
      regionCode,
      maxResults,
      key: keys.youtube,
    }),
    revalidate: REVALIDATE.musicCharts,
    tags: ["youtube", `youtube:charts:${regionCode}`],
  });

  if (primary.ok && (primary.data.items?.length ?? 0) > 0) {
    return { items: primary.data.items ?? [], fetchedAt: primary.fetchedAt };
  }

  // 200 with an empty chart for this region+category. Fall back (see above).
  if (primary.ok) {
    const fallback = await fetchJson<YtVideoListResponse>({
      source: "youtube",
      url: buildUrl(`${API_BASE}/videos`, {
        part: "snippet,statistics",
        chart: "mostPopular",
        regionCode,
        maxResults: MAX_PAGE_SIZE,
        key: keys.youtube,
      }),
      revalidate: REVALIDATE.musicCharts,
      tags: ["youtube", `youtube:charts:${regionCode}`],
    });

    if (!fallback.ok) return null;

    const musicOnly = (fallback.data.items ?? []).filter(
      (item) => item.snippet?.categoryId === MUSIC_CATEGORY_ID,
    );
    return { items: musicOnly.slice(0, maxResults), fetchedAt: fallback.fetchedAt };
  }

  return null;
}

function toTrackRecord(
  item: YtVideoItem,
  index: number,
  fetchedAt: string,
): TrackRecord | null {
  const videoId = item.id;
  const snippet = item.snippet;
  if (typeof videoId !== "string" || videoId === "") return null;
  if (typeof snippet?.title !== "string" || snippet.title.trim() === "") return null;

  const url = watchUrl(videoId);
  const provenance = provenanceFor(url, fetchedAt);
  const { title, artist } = parseTitle(snippet.title, snippet.channelTitle ?? "");

  const link: DeepLink = {
    platform: "youtube",
    platformName: "YouTube",
    url,
    offerType: "listen",
    price: unavailable<string>("not_in_source"),
    // The ID came straight from YouTube's own chart response, so the link is
    // resolved, not searched-for.
    verified: true,
    provenance,
  };

  return {
    key: `youtube:${videoId}`,
    sourceId: videoId,
    title,
    artist,
    // YouTube has no album concept on a video.
    album: unavailable<string>("not_in_source"),
    artworkUrl: bestThumbnail(snippet),
    // No 30s preview: YouTube exposes none, and extracting audio would breach
    // the ToS. Hover-to-play is simply off for this source.
    previewUrl: unavailable<string>("not_in_source"),
    // The chart's own order. This IS YouTube's ranking, not one we computed.
    rank: index + 1,
    // videos.list carries no previous position, and we do not diff snapshots
    // here — the ranking layer owns movement once it has two snapshots.
    movement: unavailable("not_in_source"),
    playCount: fromNumeric(item.statistics?.viewCount),
    // The API returns a numeric categoryId, not genres. Turning "10" into
    // ["Music"] would be us writing the genre, so the list stays empty.
    genres: [],
    // The video's publish date, which for a music video is its release. It is
    // NOT the track's original release date and must not be labelled as such.
    releaseDate: fromText(snippet.publishedAt),
    links: [link],
    provenance,
  };
}

/* ------------------------------------------------------------------ *
 * 2. REVIEW SHELF
 * ------------------------------------------------------------------ */

/** Allowlisted channel IDs. The shelf can contain nothing outside this set. */
const ALLOWED_CHANNEL_IDS: ReadonlySet<string> = new Set(
  REVIEW_CHANNELS.map((channel) => channel.id),
);

/**
 * Review videos for a title, from the REVIEW_CHANNELS allowlist ONLY.
 *
 * WHY THIS IS N CALLS AND NOT ONE: search.list accepts a single `channelId`.
 * There is no `channelIds`, no comma-separated form, and no filter that takes a
 * set of channels. The alternatives are worse — an unrestricted `q` search
 * returns the open sewer of reaction/AI-slop uploads, and `q="review site:..."`
 * style tricks do not exist in this API. So: one request per allowlisted
 * channel, `REVIEW_SHELF_CONCURRENCY` at a time, merged. At 100 units per
 * search.list call this is the single most quota-expensive thing we do, which is
 * why it is cached for REVALIDATE.videoReviews (a week).
 *
 * Returns `[]` when unconfigured or when every channel call failed.
 */
export async function fetchVideoReviews(
  titleQuery: string,
  year?: number,
): Promise<readonly VideoReview[]> {
  if (!providerEnabled.youtube || !keys.youtube) return [];
  const trimmed = titleQuery.trim();
  if (trimmed === "") return [];

  // The year is a search hint that keeps remakes and same-named titles apart.
  // It narrows the query only; it is never written into a result.
  const query = year ? `${trimmed} ${year} review` : `${trimmed} review`;

  const perChannel = await mapWithConcurrency(
    REVIEW_CHANNELS,
    REVIEW_SHELF_CONCURRENCY,
    async (channel) => {
      const outcome = await fetchJson<YtSearchListResponse>({
        source: "youtube",
        url: buildUrl(`${API_BASE}/search`, {
          part: "snippet",
          type: "video",
          channelId: channel.id,
          q: query,
          maxResults: 2,
          order: "relevance",
          key: keys.youtube,
        }),
        revalidate: REVALIDATE.videoReviews,
        tags: ["youtube", "youtube:reviews", `youtube:reviews:${channel.id}`],
      });

      if (!outcome.ok) return [] as readonly VideoReview[];
      return toVideoReviews(outcome.data.items ?? [], outcome.fetchedAt);
    },
  );

  const merged: VideoReview[] = [];
  const seen = new Set<string>();
  for (const reviews of perChannel) {
    for (const review of reviews) {
      if (seen.has(review.videoId)) continue;
      seen.add(review.videoId);
      merged.push(review);
    }
  }

  /**
   * THE ALLOWLIST ASSERTION.
   *
   * Every result above already came from a per-channel query, so this filter
   * should never remove anything. It is here precisely because "should never"
   * is not a guarantee: YouTube can return a video whose snippet.channelId
   * differs from the queried channel (topic/auto-generated channels do this),
   * and a future edit could add a code path that forgets the restriction. This
   * is the last gate before the shelf reaches the page, and it drops rather
   * than throws, because a provider never throws for upstream weirdness.
   */
  const allowed = merged.filter((review) => ALLOWED_CHANNEL_IDS.has(review.channelId));
  if (allowed.length !== merged.length) {
    console.warn(
      `[youtube] review shelf dropped ${merged.length - allowed.length} result(s) from outside REVIEW_CHANNELS`,
    );
  }

  return allowed.sort((a, b) => comparePublishedDesc(a.publishedAt, b.publishedAt));
}

function toVideoReviews(
  items: readonly YtSearchItem[],
  fetchedAt: string,
): readonly VideoReview[] {
  const reviews: VideoReview[] = [];

  for (const item of items) {
    const videoId = item.id?.videoId;
    const snippet = item.snippet;
    const channelId = snippet?.channelId;

    if (typeof videoId !== "string" || videoId === "") continue;
    if (typeof channelId !== "string" || !ALLOWED_CHANNEL_IDS.has(channelId)) continue;
    if (typeof snippet?.title !== "string" || snippet.title.trim() === "") continue;

    // Prefer our own name for the channel — config.ts is the editorial label,
    // and it stays stable if the channel renames itself.
    const configured = REVIEW_CHANNELS.find((channel) => channel.id === channelId);

    reviews.push({
      videoId,
      title: snippet.title.trim(),
      channelId,
      channelTitle: configured?.name ?? snippet.channelTitle ?? "",
      channelUrl: channelUrl(channelId),
      thumbnailUrl: bestThumbnail(snippet),
      publishedAt: fromText(snippet.publishedAt),
      provenance: provenanceFor(watchUrl(videoId), fetchedAt),
      // No description, no transcript, no captions. See the copyright note at
      // the top of this file — VideoReview has nowhere to put them by design.
    });
  }

  return reviews;
}

function comparePublishedDesc(a: Maybe<string>, b: Maybe<string>): number {
  if (a.status !== "ok" && b.status !== "ok") return 0;
  if (a.status !== "ok") return 1; // undated sinks to the bottom
  if (b.status !== "ok") return -1;
  return b.value.localeCompare(a.value); // ISO 8601 sorts lexicographically
}

/* ------------------------------------------------------------------ *
 * Provider surface
 * ------------------------------------------------------------------ */

export const youtubeProvider: Provider<TrackRecord> = {
  id: "youtube",
  kind: "music",
  displayName: "YouTube",
  attribution: "Charts and review videos via the YouTube Data API v3.",

  isEnabled(): boolean {
    return providerEnabled.youtube && Boolean(keys.youtube);
  },

  async fetchTrending(query: TrendingQuery): Promise<readonly TrackRecord[]> {
    if (!providerEnabled.youtube || !keys.youtube) return [];

    const limit = query.limit ?? 20;
    const chart = await fetchMusicChart(query.country, limit);
    if (!chart) return [];

    const records: TrackRecord[] = [];
    for (const item of chart.items) {
      const record = toTrackRecord(item, records.length, chart.fetchedAt);
      if (record) records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  },

  /**
   * Deliberately null, always.
   *
   * `TrackRecord.rank` is a required `number` — a chart position. A single
   * videos.list?id= lookup has no chart position, so building a record here
   * would mean writing 0 or 1 into `rank` and calling a one-off lookup the
   * number-one song. That is the exact class of invented value this codebase
   * forbids, so the method returns null until TrackRecord makes rank optional.
   * Nothing currently routes music detail pages through YouTube.
   */
  async fetchTitleDetails(_id: string, _query: DetailsQuery): Promise<TrackRecord | null> {
    void _id;
    void _query;
    return null;
  },

  /**
   * The watch URL is derived from an ID YouTube gave us, so it is a resolved
   * link rather than a search fallback.
   */
  async resolveDeepLink(
    record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _query;
    if (!record.sourceId) return [];
    const url = watchUrl(record.sourceId);
    return [
      {
        platform: "youtube",
        platformName: "YouTube",
        url,
        offerType: "listen",
        price: unavailable<string>("not_in_source"),
        verified: true,
        provenance: provenanceFor(url, new Date().toISOString()),
      },
    ];
  },

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();

    if (!keys.youtube) {
      return {
        source: "youtube",
        ok: false,
        detail:
          "not_configured — YOUTUBE_API_KEY is unset. Music charts and the review shelf are empty.",
        latencyMs: unavailable<number>("not_configured"),
        checkedAt,
      };
    }
    if (!providerEnabled.youtube) {
      return {
        source: "youtube",
        ok: false,
        detail: "provider_disabled — YouTube is switched off in config.",
        latencyMs: unavailable<number>("provider_disabled"),
        checkedAt,
      };
    }

    // Cheapest possible probe: videos.list is 1 quota unit. Never search.list
    // (100 units) — a health check must not be able to drain the day's quota.
    const { outcome, latencyMs } = await timedFetchJson<YtVideoListResponse>({
      source: "youtube",
      url: buildUrl(`${API_BASE}/videos`, {
        part: "id",
        chart: "mostPopular",
        videoCategoryId: MUSIC_CATEGORY_ID,
        regionCode: "IN",
        maxResults: 1,
        key: keys.youtube,
      }),
      revalidate: 0,
      timeoutMs: 5_000,
    });

    if (!outcome.ok) {
      return {
        source: "youtube",
        ok: false,
        detail: describeHttpFailure(outcome.status, outcome.detail),
        latencyMs: ok(latencyMs),
        checkedAt,
      };
    }

    const count = outcome.data.items?.length ?? 0;
    return {
      source: "youtube",
      ok: true,
      detail:
        count > 0
          ? "YouTube reachable; music chart responding."
          : "YouTube reachable, but the IN music chart returned no items — the category fallback will be used.",
      latencyMs: ok(latencyMs),
      checkedAt,
    };
  },
};

/* ------------------------------------------------------------------ *
 * FIELD NOTES — verified live 2026-08-02, no key available
 * ------------------------------------------------------------------ *
 *
 * $ curl -s -w '%{http_code}' \
 *   'https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails\
 *    &chart=mostPopular&videoCategoryId=10&regionCode=IN&maxResults=10'
 *   403  {"error":{"code":403,"message":"Method doesn't allow unregistered
 *        callers (callers without established identity). Please use API Key or
 *        other form of API consumer identity to call this API.",
 *        "status":"PERMISSION_DENIED"}}
 *   -> the route, the parameter names and the parameter combination are all
 *      accepted; only identity is missing. A 400 here would have meant the
 *      chart+category+region combination itself was rejected.
 *
 * $ same URL with &key=<syntactically-valid-but-fake>
 *   400  {"error":{"code":400,"message":"API key not valid. Please pass a valid
 *        API key.","status":"INVALID_ARGUMENT",
 *        "details":[{"reason":"API_KEY_INVALID"}]}}
 *
 * $ search.list?part=snippet&type=video&channelId=UCJ0uqCI0Vqr2Rrt1HseGirg
 *     &q=dune%20review&maxResults=2&key=<fake>
 *   400  same API_KEY_INVALID shape.
 *
 * Both shapes surface through `fetchJson` as `{ ok:false, reason:"http_error" }`
 * with the status preserved; `describeHttpFailure` turns them into status-page
 * copy. Note `fetchJson` does not read the error body, so the Google error
 * `reason` strings are documented here rather than parsed.
 *
 * STILL UNVERIFIED without a key: whether chart=mostPopular + videoCategoryId=10
 * + regionCode=IN actually returns a non-empty `items` array today. The docs
 * permit the combination; empty results for some region+category pairs are a
 * long-standing, widely reported behaviour. `fetchMusicChart` handles both.
 */
