import "server-only";
import type { SourceId } from "./types";

/**
 * Every third-party key is read here and nowhere else. This module is
 * `server-only`, so importing it from a client component is a build error —
 * which is the guarantee that no key reaches the client bundle.
 */

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
};

export const keys = {
  /** TMDB v4 Read Access Token, sent as `Authorization: Bearer`. */
  tmdb: env("TMDB_READ_TOKEN"),
  omdb: env("OMDB_API_KEY"),
  youtube: env("YOUTUBE_API_KEY"),
  lastfm: env("LASTFM_API_KEY"),
  databaseUrl: env("DATABASE_URL"),
} as const;

/**
 * Provider on/off. A provider with no key reports `not_configured` rather than
 * failing — the rest of the page still renders.
 */
export const providerEnabled: Record<SourceId, boolean> = {
  tmdb: Boolean(keys.tmdb),
  omdb: Boolean(keys.omdb),
  youtube: Boolean(keys.youtube),
  lastfm: Boolean(keys.lastfm),
  "apple-music": true, // public RSS marketing feeds, no key
  itunes: true, // public iTunes Search API, no key
  deezer: true, // public API, no key
  /**
   * Gaana has no public API. The adapter and its interface are written so the
   * source can be switched on the day a licensed feed exists, but it ships
   * disabled and returns zero records — we do not scrape it and we do not
   * substitute another source's data under Gaana's name.
   * Flip with GAANA_ENABLED=true only when a licensed endpoint is wired up.
   */
  gaana: env("GAANA_ENABLED") === "true",
  airtime: true,
};

/* ------------------------------------------------------------------ *
 * Cache revalidation windows (seconds)
 * ------------------------------------------------------------------ */

export const REVALIDATE = {
  /** Music charts refresh hourly. */
  musicCharts: 60 * 60,
  /** Theatrical rail: daily. Showtimes churn but the title list does not. */
  theatrical: 60 * 60 * 24,
  /** OTT rail: twice daily — catalogue adds land unpredictably. */
  ott: 60 * 60 * 12,
  /**
   * Upcoming: short. Indian release dates move constantly, so this rail is
   * cached for 3h and always rendered with a "last checked" timestamp.
   */
  upcoming: 60 * 60 * 3,
  /** Title metadata: weekly. Cast and crew do not change. */
  titleDetails: 60 * 60 * 24 * 7,
  /** Leaderboards: weekly. They are our own rankings over a slow-moving pool. */
  leaderboards: 60 * 60 * 24 * 7,
  /** Watch providers: daily, because that is what drives availability claims. */
  watchProviders: 60 * 60 * 24,
  /** YouTube review shelf: weekly. */
  videoReviews: 60 * 60 * 24 * 7,
} as const;

/* ------------------------------------------------------------------ *
 * YouTube review-channel allowlist
 * ------------------------------------------------------------------ */

/**
 * The review shelf searches ONLY within these channel IDs, so it cannot fill
 * with low-quality content. Edit freely — add a channel by pasting its UC… ID.
 * Find an ID from a channel URL of the form youtube.com/channel/UCxxxx, or via
 * the channels endpoint with forHandle=@name.
 */
export interface ReviewChannel {
  readonly id: string;
  readonly name: string;
  readonly market: "india" | "global";
}

export const REVIEW_CHANNELS: readonly ReviewChannel[] = [
  // India
  { id: "UCLmpGKb4v8Hzs2XKMFbdMLg", name: "Filmi Indian", market: "india" },
  { id: "UCq-Fj5jknLsUf-MWSy4_brA", name: "T-Series (trailers)", market: "india" },
  { id: "UCyoxCYs9Kh6a2XCFI6MWZtA", name: "Suchari (Cinema Express)", market: "india" },
  { id: "UChgHdWKGh0rlS-2LxDnCa1w", name: "Anupama Chopra / Film Companion", market: "india" },
  { id: "UCkdaKlEJ2ojlHDVKS4o6JXA", name: "Behindwoods TV", market: "india" },
  // Global
  { id: "UCJ0uqCI0Vqr2Rrt1HseGirg", name: "IGN", market: "global" },
  { id: "UCVSNOxehfALut52NbkfRBaA", name: "Chris Stuckmann", market: "global" },
  { id: "UCVHFbqXqoYvEWM1Ddxl0QDg", name: "Jeremy Jahns", market: "global" },
  { id: "UCz2s0Jz6qJ2wZk0K5V1TAoQ", name: "Screen Junkies", market: "global" },
  { id: "UCUyeluBRhGPCW4rPe_UvBZQ", name: "The Take", market: "global" },
];

/* ------------------------------------------------------------------ *
 * Podcast shows
 * ------------------------------------------------------------------ */

/**
 * The shows the Podcast section carries. Same allowlist pattern as
 * REVIEW_CHANNELS: nothing outside this list can ever appear.
 *
 * EVERY ID BELOW WAS RESOLVED AGAINST THE LIVE API, not guessed. A wrong UC…
 * id does not error — it quietly returns a different creator's uploads, which
 * is the worst possible failure for a section built on named people. Verified
 * 2026-08-04 via channels.list, with the subscriber count recorded as evidence
 * that the id maps to the channel we think it does.
 *
 * `uploadsPlaylistId` is a channel's auto-generated uploads playlist. It is
 * always the channel id with "UC" swapped for "UU", but it is stored explicitly
 * because it came back in the same verified response — deriving it by string
 * surgery would be an assumption.
 *
 * To add a show: resolve its id first (`channels?part=snippet&forHandle=@name`)
 * and paste what the API returned.
 */
export interface PodcastShow {
  readonly id: string;
  readonly name: string;
  readonly uploadsPlaylistId: string;
  readonly market: "india" | "global";
  /** Subscribers at verification time. Context only — never rendered as live. */
  readonly verifiedSubscribers: number;
  /**
   * Shortest upload that counts as an episode for THIS show, in minutes.
   *
   * Per-show because the shows genuinely publish different formats, measured
   * across 25 recent uploads each (2026-08-04):
   *   Joe Rogan / Huberman / Raj Shamani — full episodes run 1-3 hours
   *   Ranveer Allahbadia — 24 of 25 uploads are ~1-minute Shorts
   *   Technical Guruji  — 0 of 25 reach 20 minutes; his longest is 18
   *
   * A single global floor silently removed two of the five shows entirely,
   * which is worse than showing a shorter video: the reader just sees a show
   * they picked produce nothing, with no explanation.
   */
  readonly minEpisodeMinutes: number;
}

export const PODCAST_SHOWS: readonly PodcastShow[] = [
  {
    id: "UCzwCEE_PchiBULMnAJqhGVg",
    name: "Raj Shamani",
    uploadsPlaylistId: "UUzwCEE_PchiBULMnAJqhGVg",
    market: "india",
    verifiedSubscribers: 18_500_000,
    minEpisodeMinutes: 20,
  },
  {
    // The Ranveer Show (TRS). His BeerBiceps channel
    // (UCPxMZIFE856tbTfdkdjzTSQ) is the fitness/lifestyle one, not the podcast.
    id: "UCneyi-aYq4VIBYIAQgWmk_w",
    name: "Ranveer Allahbadia",
    uploadsPlaylistId: "UUneyi-aYq4VIBYIAQgWmk_w",
    market: "india",
    verifiedSubscribers: 11_300_000,
    // Posts mostly Shorts here; full TRS episodes are rarer but long.
    minEpisodeMinutes: 20,
  },
  {
    id: "UCOhHO2ICt0ti9KAh-QHvttQ",
    name: "Technical Guruji",
    uploadsPlaylistId: "UUOhHO2ICt0ti9KAh-QHvttQ",
    market: "india",
    verifiedSubscribers: 23_700_000,
    // Tech reviews rather than a podcast — his long-form runs 10-18 minutes,
    // so this floor keeps real videos while still excluding Shorts.
    minEpisodeMinutes: 8,
  },
  {
    // PowerfulJRE is the official Joe Rogan Experience channel.
    id: "UCzQUP1qoWDoEbmsQxvdjxgQ",
    name: "The Joe Rogan Experience",
    uploadsPlaylistId: "UUzQUP1qoWDoEbmsQxvdjxgQ",
    market: "global",
    verifiedSubscribers: 21_000_000,
    minEpisodeMinutes: 20,
  },
  {
    // Huberman Lab publishes under the host's own channel name.
    id: "UC2D2CMWXMOVWx7giW1n3LIg",
    name: "Huberman Lab",
    uploadsPlaylistId: "UU2D2CMWXMOVWx7giW1n3LIg",
    market: "global",
    verifiedSubscribers: 7_610_000,
    minEpisodeMinutes: 20,
  },
];

/* ------------------------------------------------------------------ *
 * Ranking parameters
 * ------------------------------------------------------------------ */

/**
 * Bayesian weighted rating — the shape IMDb publishes for its own weighted
 * average:
 *
 *     WR = (v / (v + m)) * R  +  (m / (v + m)) * C
 *
 *   R = this title's mean vote (TMDB vote_average, 0-10)
 *   v = this title's vote count (TMDB vote_count)
 *   m = minimum votes required to enter the pool (below, defaults per board)
 *   C = mean vote across the whole candidate pool, computed at request time
 *       from the pool we actually fetched — NOT a hard-coded constant.
 *
 * The effect: a film with 9 votes and a perfect 10 is pulled hard toward the
 * pool mean and cannot top the board, while a film with 20,000 votes keeps
 * almost all of its own average.
 */
export const BAYESIAN = {
  /**
   * International board. TMDB's own /movie/top_rated uses a 300-vote floor;
   * we set ours higher so the board is genuinely "all-time great" rather than
   * "recently popular". Tuned against live response counts, not guessed.
   */
  internationalMinVotes: 2000,
  /**
   * Indian board. Indian-language titles collect far fewer TMDB votes than
   * Hollywood ones, so the international floor would empty this board.
   *
   * MEASURED against a live /discover response across the seven languages
   * below (2026-08-04, 77-title pool). Titles clearing each candidate floor:
   *
   *     200 votes ->  32 titles
   *     500 votes ->  12 titles
   *    2000 votes ->   2 titles   <- the international floor
   *
   * Two titles is not a leaderboard. 100 is the only floor that fills a
   * 30-40 slot board, and at m=100 a title with exactly 100 votes still keeps
   * half its own average, which is a defensible amount of confidence.
   * Re-measure with `npm run verify` if TMDB's Indian coverage grows.
   */
  indianMinVotes: 100,
  /**
   * Critics board. The RT score comes from OMDb per title, so the candidate
   * pool is bounded by how many OMDb lookups we are willing to make. This is
   * the pool size stated in the UI.
   */
  criticsPoolSize: 200,
  criticsMinVotes: 500,
} as const;

/** Languages that make up the Indian leaderboard. */
export const INDIAN_LANGUAGES: readonly string[] = [
  "hi", // Hindi
  "ta", // Tamil
  "te", // Telugu
  "ml", // Malayalam
  "kn", // Kannada
  "bn", // Bengali
  "mr", // Marathi
];

/* ------------------------------------------------------------------ *
 * Streaming platforms we surface (TMDB watch-provider IDs)
 * ------------------------------------------------------------------ */

/**
 * TMDB provider IDs, confirmed against /watch/providers/movie?watch_region=IN.
 * `platform` maps to our PlatformId so the UI can reorder by the user's
 * declared subscriptions.
 */
export interface WatchProviderConfig {
  readonly tmdbProviderId: number;
  readonly platform: string;
  readonly name: string;
  readonly regions: readonly string[];
}

export const WATCH_PROVIDERS: readonly WatchProviderConfig[] = [
  { tmdbProviderId: 8, platform: "netflix", name: "Netflix", regions: ["IN", "US", "GB"] },
  { tmdbProviderId: 119, platform: "prime", name: "Prime Video", regions: ["IN", "US", "GB"] },
  { tmdbProviderId: 2336, platform: "jiohotstar", name: "JioHotstar", regions: ["IN"] },
  { tmdbProviderId: 237, platform: "sonyliv", name: "SonyLIV", regions: ["IN"] },
  { tmdbProviderId: 232, platform: "zee5", name: "ZEE5", regions: ["IN"] },
  { tmdbProviderId: 350, platform: "appletv", name: "Apple TV+", regions: ["IN", "US", "GB"] },
];

/* ------------------------------------------------------------------ *
 * Re-exported from ./public so server code has one import site, while
 * client components import them from ./public directly — this module is
 * server-only because it holds the API keys.
 * ------------------------------------------------------------------ */

export { REVIEW_LIMITS, APP } from "./public";
