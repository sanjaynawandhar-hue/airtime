/**
 * Raw TMDB v3 wire shapes.
 *
 * These describe what the API actually sends, not what our app wants — every
 * field that TMDB can omit or null is typed as optional/nullable so that the
 * adapter is forced to run it through `maybe.ts` rather than assuming it is
 * there. Nothing in this file is exported to the UI.
 *
 * Shapes confirmed against developer.themoviedb.org reference pages on
 * 2026-08-02 (movie-now-playing-list, movie-release-dates, movie-watch-providers,
 * movie-videos, movie-reviews, movie-details).
 */

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

export interface TmdbPaged<T> {
  readonly page?: number;
  readonly results?: readonly T[];
  readonly total_pages?: number;
  readonly total_results?: number;
}

/** now_playing / upcoming additionally carry a window. */
export interface TmdbDatedPaged<T> extends TmdbPaged<T> {
  readonly dates?: { readonly maximum?: string; readonly minimum?: string };
}

/** The list-item shape shared by now_playing, upcoming, trending and discover. */
export interface TmdbMovieListItem {
  readonly id: number;
  readonly title?: string;
  readonly original_title?: string;
  readonly original_language?: string;
  readonly overview?: string;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
  readonly genre_ids?: readonly number[];
  readonly release_date?: string;
  readonly popularity?: number;
  readonly vote_average?: number;
  readonly vote_count?: number;
  readonly adult?: boolean;
  readonly video?: boolean;
}

export interface TmdbGenre {
  readonly id: number;
  readonly name?: string;
}

export interface TmdbGenreList {
  readonly genres?: readonly TmdbGenre[];
}

/* ------------------------------------------------------------------ *
 * /movie/{id}/release_dates
 * ------------------------------------------------------------------ */

/**
 * TMDB release types. 2 (limited) and 3 (theatrical) are the only two that
 * mean "you can buy a cinema ticket".
 */
export const TMDB_RELEASE_TYPE = {
  premiere: 1,
  theatricalLimited: 2,
  theatrical: 3,
  digital: 4,
  physical: 5,
  tv: 6,
} as const;

export interface TmdbReleaseDateEntry {
  readonly certification?: string;
  readonly descriptors?: readonly string[];
  readonly iso_639_1?: string;
  readonly note?: string;
  readonly release_date?: string;
  readonly type?: number;
}

export interface TmdbReleaseDatesCountry {
  readonly iso_3166_1?: string;
  readonly release_dates?: readonly TmdbReleaseDateEntry[];
}

export interface TmdbReleaseDatesResponse {
  readonly id?: number;
  readonly results?: readonly TmdbReleaseDatesCountry[];
}

/* ------------------------------------------------------------------ *
 * /movie/{id}/watch/providers
 * ------------------------------------------------------------------ */

export interface TmdbWatchProvider {
  readonly provider_id?: number;
  readonly provider_name?: string;
  readonly logo_path?: string | null;
  readonly display_priority?: number;
}

/**
 * `link` is the JustWatch-backed TMDB watch page for that locale. TMDB does NOT
 * return a per-provider deep link and does NOT return prices — any price on a
 * DeepLink built from this response would be invented, so there isn't one.
 */
export interface TmdbWatchCountry {
  readonly link?: string;
  readonly flatrate?: readonly TmdbWatchProvider[];
  readonly rent?: readonly TmdbWatchProvider[];
  readonly buy?: readonly TmdbWatchProvider[];
  readonly free?: readonly TmdbWatchProvider[];
  readonly ads?: readonly TmdbWatchProvider[];
}

export interface TmdbWatchProvidersResponse {
  readonly id?: number;
  readonly results?: Readonly<Record<string, TmdbWatchCountry | undefined>>;
}

/* ------------------------------------------------------------------ *
 * /movie/{id}?append_to_response=...
 * ------------------------------------------------------------------ */

export interface TmdbCastMember {
  readonly id: number;
  readonly name?: string;
  readonly character?: string;
  readonly profile_path?: string | null;
  readonly order?: number;
}

export interface TmdbCrewMember {
  readonly id: number;
  readonly name?: string;
  readonly job?: string;
  readonly department?: string;
  readonly profile_path?: string | null;
}

export interface TmdbCredits {
  readonly cast?: readonly TmdbCastMember[];
  readonly crew?: readonly TmdbCrewMember[];
}

export interface TmdbVideo {
  readonly id?: string;
  readonly iso_639_1?: string;
  readonly iso_3166_1?: string;
  readonly name?: string;
  readonly key?: string;
  readonly site?: string;
  readonly size?: number;
  readonly type?: string;
  readonly official?: boolean;
  readonly published_at?: string;
}

export interface TmdbVideos {
  readonly results?: readonly TmdbVideo[];
}

export interface TmdbImage {
  readonly file_path?: string;
  readonly width?: number;
  readonly height?: number;
  readonly iso_639_1?: string | null;
}

export interface TmdbImages {
  readonly backdrops?: readonly TmdbImage[];
  readonly posters?: readonly TmdbImage[];
  readonly logos?: readonly TmdbImage[];
}

export interface TmdbExternalIds {
  readonly imdb_id?: string | null;
  readonly wikidata_id?: string | null;
  readonly facebook_id?: string | null;
  readonly instagram_id?: string | null;
  readonly twitter_id?: string | null;
}

export interface TmdbReviewAuthorDetails {
  readonly name?: string;
  readonly username?: string;
  readonly avatar_path?: string | null;
  /** 0-10, or null when the reviewer left no score. */
  readonly rating?: number | null;
}

export interface TmdbReview {
  readonly id?: string;
  readonly author?: string;
  readonly author_details?: TmdbReviewAuthorDetails;
  /** Deliberately never read: review text is copyrighted. See CriticReview. */
  readonly content?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly url?: string;
}

export interface TmdbReviews {
  readonly results?: readonly TmdbReview[];
}

export interface TmdbProductionCompany {
  readonly id?: number;
  readonly name?: string;
  readonly logo_path?: string | null;
  readonly origin_country?: string;
}

export interface TmdbMovieDetails {
  readonly id: number;
  readonly imdb_id?: string | null;
  readonly title?: string;
  readonly original_title?: string;
  readonly original_language?: string;
  readonly overview?: string | null;
  readonly tagline?: string | null;
  readonly status?: string;
  readonly homepage?: string | null;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
  readonly genres?: readonly TmdbGenre[];
  readonly runtime?: number | null;
  readonly release_date?: string;
  readonly popularity?: number;
  readonly vote_average?: number;
  readonly vote_count?: number;
  readonly production_companies?: readonly TmdbProductionCompany[];
  readonly origin_country?: readonly string[];
  // appended
  readonly credits?: TmdbCredits;
  readonly videos?: TmdbVideos;
  readonly images?: TmdbImages;
  readonly release_dates?: { readonly results?: readonly TmdbReleaseDatesCountry[] };
  readonly external_ids?: TmdbExternalIds;
  readonly reviews?: TmdbReviews;
}

/* ------------------------------------------------------------------ *
 * /configuration
 * ------------------------------------------------------------------ */

export interface TmdbConfiguration {
  readonly images?: {
    readonly secure_base_url?: string;
    readonly poster_sizes?: readonly string[];
    readonly backdrop_sizes?: readonly string[];
    readonly profile_sizes?: readonly string[];
  };
  readonly change_keys?: readonly string[];
}
