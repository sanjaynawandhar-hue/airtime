import type { Maybe } from "./maybe";

/* ------------------------------------------------------------------ *
 * Source identity + provenance
 * ------------------------------------------------------------------ */

export const SOURCE_IDS = [
  "tmdb",
  "omdb",
  "youtube",
  "apple-music",
  "itunes",
  "deezer",
  "lastfm",
  "gaana",
  "airtime", // our own derived data (community score, anticipation, our rankings)
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABEL: Record<SourceId, string> = {
  tmdb: "TMDB",
  omdb: "OMDb",
  youtube: "YouTube",
  "apple-music": "Apple Music",
  itunes: "iTunes",
  deezer: "Deezer",
  lastfm: "Last.fm",
  gaana: "Gaana",
  airtime: "Airtime",
};

/**
 * Attribution + freshness carried by every normalised record. TMDB's and
 * Apple's terms both require visible attribution; it also lets the UI show
 * honestly how old a number is.
 */
export interface Provenance {
  readonly source: SourceId;
  /** ISO 8601. When we actually called the source for this record. */
  readonly fetchedAt: string;
  /** Canonical public URL for this record on the source. */
  readonly sourceUrl: string;
  /** True when served from cache after a failed revalidation. */
  readonly stale?: boolean;
}

/* ------------------------------------------------------------------ *
 * Region / language
 * ------------------------------------------------------------------ */

/** ISO 3166-1 alpha-2, uppercase. */
export type CountryCode = string;
/** ISO 639-1, lowercase. */
export type LanguageCode = string;

/* ------------------------------------------------------------------ *
 * Movement — the signature data point of this product
 * ------------------------------------------------------------------ */

export type MovementDirection = "up" | "down" | "flat" | "new";

export interface Movement {
  readonly direction: MovementDirection;
  /** Absolute number of positions moved. 0 for flat, absent-safe for new. */
  readonly delta: number;
  /** Rank in the previous snapshot, if we have one. */
  readonly previousRank: Maybe<number>;
  /** ISO date of the snapshot we are comparing against. */
  readonly comparedTo: Maybe<string>;
}

/* ------------------------------------------------------------------ *
 * Ratings
 * ------------------------------------------------------------------ */

export type RatingScale = "ten" | "percent" | "five";

export interface Rating {
  readonly source: SourceId;
  /** Display name of the rating body, e.g. "Rotten Tomatoes". */
  readonly label: string;
  readonly value: Maybe<number>;
  readonly scale: RatingScale;
  /** Number of votes behind the score, where the source exposes it. */
  readonly voteCount: Maybe<number>;
  readonly sourceUrl: Maybe<string>;
}

/**
 * Critics-vs-audience gap. Only produced when BOTH sides are `ok` — we never
 * infer divergence from a single score.
 */
export interface RatingDivergence {
  /** Normalised 0-100 critic score. */
  readonly criticPercent: number;
  /** Normalised 0-100 audience score. */
  readonly audiencePercent: number;
  /** criticPercent - audiencePercent. Negative = audience liked it more. */
  readonly gap: number;
  readonly verdict: "critics_favour" | "audience_favour";
  /** Which two ratings produced the gap, for the tooltip. */
  readonly criticLabel: string;
  readonly audienceLabel: string;
}

/* ------------------------------------------------------------------ *
 * Deep links out
 * ------------------------------------------------------------------ */

export type PlatformId =
  | "netflix"
  | "prime"
  | "jiohotstar"
  | "sonyliv"
  | "zee5"
  | "appletv"
  | "youtube"
  | "apple-music"
  | "spotify"
  | "deezer"
  | "gaana"
  | "bookmyshow"
  | "tmdb"
  | "imdb";

/** How the user gets access to the title on this platform. */
export type OfferType = "subscription" | "rent" | "buy" | "free" | "ads" | "ticket" | "listen";

export interface DeepLink {
  readonly platform: PlatformId;
  readonly platformName: string;
  readonly url: string;
  readonly offerType: OfferType;
  /** Price as the source reported it, e.g. "₹149". Never invented. */
  readonly price: Maybe<string>;
  /** True when we resolved this link from a licensed availability source
   *  (TMDB watch/providers). False for search-URL fallbacks like BookMyShow. */
  readonly verified: boolean;
  readonly provenance: Provenance;
}

/* ------------------------------------------------------------------ *
 * Music
 * ------------------------------------------------------------------ */

export interface TrackRecord {
  /** Stable within a source: `${source}:${sourceId}`. */
  readonly key: string;
  readonly sourceId: string;
  readonly title: string;
  readonly artist: string;
  readonly album: Maybe<string>;
  readonly artworkUrl: Maybe<string>;
  /** 30-second preview, for hover-to-play. */
  readonly previewUrl: Maybe<string>;
  readonly rank: number;
  readonly movement: Maybe<Movement>;
  /** Only where the source actually reports it (YouTube view counts). */
  readonly playCount: Maybe<number>;
  readonly genres: readonly string[];
  readonly releaseDate: Maybe<string>;
  readonly links: readonly DeepLink[];
  readonly provenance: Provenance;
}

/* ------------------------------------------------------------------ *
 * Film — one title record, two availability contexts
 * ------------------------------------------------------------------ */

/**
 * The structural split. A title may legitimately carry BOTH a theatrical and an
 * OTT context at once (theatrical run overlapping an early digital release, or
 * a re-release). The rails are built from separate pipelines and each card
 * states which context it is showing. A rail never reads the other's context.
 */
export type Rail = "theatrical" | "ott" | "upcoming" | "top-rated";

export interface TheatricalContext {
  readonly kind: "theatrical";
  readonly country: CountryCode;
  /**
   * True only when the theatrical release is recent enough to plausibly still
   * be running — see THEATRICAL_RUN_DAYS in providers/tmdb.ts.
   *
   * Without this, a title page built from a release-dates lookup claims "in
   * cinemas" for ANY film that ever had a theatrical run in that country.
   * Dilwale Dulhania Le Jayenge (1995) was rendering "IN CINEMAS NOW" on its
   * share card. Having a theatrical release and being in cinemas today are
   * different facts, and the certification and release date are still worth
   * showing for an old film — so the context is kept and this flag carries the
   * distinction rather than the context being dropped.
   */
  readonly currentlyRunning: boolean;
  /** Country-specific theatrical release date from TMDB release_dates. */
  readonly releaseDate: Maybe<string>;
  /** TMDB release type 2 (limited) or 3 (theatrical). */
  readonly releaseType: Maybe<"theatrical" | "theatrical_limited">;
  /** Country certification, e.g. "UA" (CBFC) or "PG-13" (MPAA). */
  readonly certification: Maybe<string>;
  readonly booking: Maybe<DeepLink>;
}

export interface OttContext {
  readonly kind: "ott";
  readonly country: CountryCode;
  /** Every offer TMDB watch/providers returned for this country. */
  readonly offers: readonly DeepLink[];
  /** TMDB's JustWatch attribution link — required by their terms. */
  readonly justWatchUrl: Maybe<string>;
}

export type AvailabilityContext = TheatricalContext | OttContext;

export interface FilmRecord {
  /** `tmdb:${id}` — the catalogue is keyed on TMDB IDs. */
  readonly key: string;
  readonly tmdbId: number;
  readonly imdbId: Maybe<string>;
  readonly title: string;
  readonly originalTitle: Maybe<string>;
  readonly originalLanguage: Maybe<LanguageCode>;
  readonly overview: Maybe<string>;
  readonly posterUrl: Maybe<string>;
  readonly backdropUrl: Maybe<string>;
  readonly genres: readonly string[];
  readonly runtimeMinutes: Maybe<number>;
  readonly ratings: readonly Rating[];
  readonly divergence: Maybe<RatingDivergence>;
  readonly rank: Maybe<number>;
  readonly movement: Maybe<Movement>;
  /**
   * Exactly one context, matching the rail this record was built for. A title
   * that is in both rails appears as two records with two contexts — never one
   * record whose availability is ambiguous.
   */
  readonly availability: AvailabilityContext | null;
  readonly rail: Rail;
  readonly provenance: Provenance;
}

/* ------------------------------------------------------------------ *
 * Title detail page
 * ------------------------------------------------------------------ */

export interface CastMember {
  readonly personId: number;
  readonly name: string;
  readonly character: Maybe<string>;
  readonly profileUrl: Maybe<string>;
  readonly order: number;
}

export interface CrewMember {
  readonly personId: number;
  readonly name: string;
  readonly job: string;
  readonly department: string;
  readonly profileUrl: Maybe<string>;
}

export interface Trailer {
  readonly youtubeKey: string;
  readonly name: string;
  readonly language: Maybe<LanguageCode>;
  readonly official: boolean;
  readonly publishedAt: Maybe<string>;
}

export interface CriticReview {
  readonly id: string;
  readonly author: string;
  readonly publication: Maybe<string>;
  readonly score: Maybe<number>;
  readonly scale: RatingScale;
  readonly url: Maybe<string>;
  readonly provenance: Provenance;
  /**
   * NOTE: deliberately no `body`/`excerpt` field. Review text, critic
   * quote-cards and transcripts are copyrighted. A headline, an attribution and
   * a link is the whole card.
   */
}

export interface VideoReview {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly channelUrl: string;
  readonly thumbnailUrl: Maybe<string>;
  readonly publishedAt: Maybe<string>;
  readonly provenance: Provenance;
}

/* ------------------------------------------------------------------ *
 * Podcasts
 * ------------------------------------------------------------------ */

/**
 * One episode from an allowlisted show.
 *
 * Deliberately NOT a `TrackRecord`. A track carries a chart `rank`, and these
 * have no chart — they are the newest uploads from a fixed set of shows,
 * ordered by publish date. Forcing them into TrackRecord would mean writing a
 * rank we did not measure, which is the failure mode this codebase is built to
 * prevent.
 */
export interface PodcastEpisode {
  /** `youtube:${videoId}` */
  readonly key: string;
  readonly videoId: string;
  readonly title: string;
  readonly showId: string;
  readonly showName: string;
  readonly showUrl: string;
  readonly thumbnailUrl: Maybe<string>;
  readonly publishedAt: Maybe<string>;
  /** From videos.list statistics; absent when the channel hides counts. */
  readonly viewCount: Maybe<number>;
  /** ISO 8601 duration from contentDetails, e.g. "PT2H14M". */
  readonly duration: Maybe<string>;
  readonly url: string;
  readonly provenance: Provenance;
}

export interface FilmDetails extends FilmRecord {
  readonly tagline: Maybe<string>;
  readonly status: Maybe<string>;
  readonly studios: readonly string[];
  readonly cast: readonly CastMember[];
  readonly crew: readonly CrewMember[];
  readonly trailer: Maybe<Trailer>;
  readonly certification: Maybe<string>;
  /** Country-specific release date, chosen from the user's country entry. */
  readonly localReleaseDate: Maybe<string>;
  readonly criticReviews: readonly CriticReview[];
  readonly videoReviews: readonly VideoReview[];
  /** Present on both contexts when the title genuinely sits in both rails. */
  readonly theatrical: TheatricalContext | null;
  readonly ott: OttContext | null;
}

/* ------------------------------------------------------------------ *
 * Provider interface — every source implements exactly this
 * ------------------------------------------------------------------ */

export interface TrendingQuery {
  readonly country: CountryCode;
  readonly language?: LanguageCode;
  readonly genre?: string;
  readonly limit?: number;
  /** Which film rail is asking. Music providers ignore it. */
  readonly rail?: Rail;
}

export interface DetailsQuery {
  readonly country: CountryCode;
  readonly language?: LanguageCode;
}

export type ProviderKind = "music" | "film" | "ratings" | "reviews";

export interface HealthStatus {
  readonly source: SourceId;
  readonly ok: boolean;
  /** Plain language, shown on the /status page. */
  readonly detail: string;
  readonly latencyMs: Maybe<number>;
  readonly checkedAt: string;
}

/**
 * `T` is the record shape this provider yields — TrackRecord for music
 * providers, FilmRecord for film providers.
 *
 * A provider never throws for an expected upstream failure. It returns an empty
 * list plus a health signal, and the UI renders an explicit empty state.
 */
export interface Provider<T = TrackRecord | FilmRecord> {
  readonly id: SourceId;
  readonly kind: ProviderKind;
  readonly displayName: string;
  /** Attribution line the UI must render when this provider contributed. */
  readonly attribution: string;
  /** False when unconfigured or turned off in config. */
  isEnabled(): boolean;

  fetchTrending(query: TrendingQuery): Promise<readonly T[]>;
  fetchTitleDetails(id: string, query: DetailsQuery): Promise<T | null>;
  resolveDeepLink(record: T, query: DetailsQuery): Promise<readonly DeepLink[]>;
  healthCheck(): Promise<HealthStatus>;
}
