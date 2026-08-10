import "server-only";
import { isOk } from "@/lib/core/maybe";
import type { CountryCode, SourceId, TrackRecord } from "@/lib/core/types";
import {
  appleMusicProvider,
  fetchAppleFeed,
  fetchChartMeta,
} from "@/lib/providers/appleMusic";
import { enrichManyWithPreviews } from "@/lib/providers/itunes";
import { youtubeProvider } from "@/lib/providers/youtube";
import { DEEZER_CHART_COUNTRIES, deezerProvider } from "@/lib/providers/deezer";
import {
  fetchArtistTopTracks,
  fetchTopArtists,
  fetchWorldwideTracks,
  lastfmProvider,
  type LastfmArtist,
} from "@/lib/providers/lastfm";
import { gaanaProvider } from "@/lib/providers/gaana";
import {
  computeMovement,
  loadPreviousSnapshot,
  recordSnapshot,
} from "@/lib/rank/movement";

/**
 * Music charts, per source and per region/genre.
 *
 * The sources are NOT merged into one blended chart. Apple's most-played,
 * YouTube's most-popular and Last.fm's tag charts measure different things, and
 * averaging them would produce a ranking that is nobody's actual chart. Each
 * source gets its own rail with its own attribution, which is both more honest
 * and more useful.
 */

export type MusicSourceId = "apple-music" | "youtube" | "deezer" | "lastfm" | "gaana";

export interface MusicBoard {
  readonly source: MusicSourceId;
  readonly title: string;
  readonly tracks: readonly TrackRecord[];
  readonly fetchedAt: string;
  readonly stale: boolean;
  /** Set when the rail is empty for a reason worth telling the reader. */
  readonly note: string | null;
  /** Apple publishes its own chart timestamp; we show it when we have it. */
  readonly sourceUpdatedAt: string | null;
  readonly attribution: string;
}

const PROVIDERS = {
  "apple-music": appleMusicProvider,
  youtube: youtubeProvider,
  deezer: deezerProvider,
  lastfm: lastfmProvider,
  gaana: gaanaProvider,
} as const;

const TITLES: Record<MusicSourceId, string> = {
  "apple-music": "Most played on Apple Music",
  youtube: "Most popular music on YouTube",
  deezer: "Deezer chart",
  lastfm: "Most scrobbled on Last.fm",
  gaana: "Gaana",
};

/**
 * Which sources can actually answer a genre query, and how.
 *
 * This matters more than it looks. `youtubeProvider.fetchTrending` ignores the
 * `genre` argument entirely — YouTube's most-popular chart has no genre axis —
 * so asking it for "jazz" returns the general music chart. Rendering that under
 * a "Jazz" heading would present non-jazz data as jazz, which is precisely the
 * misrepresentation this product exists to avoid. So a source that cannot
 * filter is not queried at all under a genre, and the UI says why.
 *
 *   "native"  — the source has real genre/tag charts (Last.fm tags, Deezer
 *               editorial genres).
 *   "filter"  — no genre chart, but the source labels each row with its own
 *               genre names, so we can filter the real chart honestly. Ranks
 *               stay the source's original chart positions.
 *   "none"    — cannot answer a genre query at all.
 */
export const GENRE_SUPPORT: Record<MusicSourceId, "native" | "filter" | "none"> = {
  lastfm: "native",
  deezer: "native",
  "apple-music": "filter",
  youtube: "none",
  gaana: "none",
};

/**
 * Can this source answer for this country and genre at all?
 *
 * Distinguishes a *permanent structural* gap from a transient failure, because
 * they deserve different UI. A source that can never answer should not occupy a
 * rail-sized "Nothing to show here" panel on every visit — that reads as broken
 * when it is simply a fact about the source.
 *
 * Measured, not assumed:
 *   Deezer publishes 102 country chart playlists and NONE for India (checked
 *   against the live Deezer Charts account). Its "Indian Music" genre (id 81)
 *   exists but returns 0 chart playlists. So for IN, Deezer has nothing —
 *   though it answers fine for a genre like rock, which uses a different path.
 */
export type SourceAvailability = "ok" | "no_genre_axis" | "no_country_chart";

export function sourceAvailability(
  source: MusicSourceId,
  country: CountryCode,
  genre?: string,
): SourceAvailability {
  if (genre) {
    return GENRE_SUPPORT[source] === "none" ? "no_genre_axis" : "ok";
  }
  // Country charts only. Deezer is the one source with real country gaps.
  if (source === "deezer" && !DEEZER_CHART_COUNTRIES.includes(country.toUpperCase())) {
    return "no_country_chart";
  }
  return "ok";
}

/**
 * Which sources need enriching from the iTunes Search API, and why.
 *
 * This is not cosmetic. Measured live (2026-08-04), Last.fm serves its
 * deprecated placeholder star for EVERY track at EVERY size — small, medium,
 * large and extralarge all resolve to the same
 * `2a96cbd8b46e442fc41c2b86b821562f.png`. The adapter correctly refuses to
 * render that (it would be a fake-looking cover on a real track), but the
 * result was a rail of twenty "No art" boxes.
 *
 * The honest fix is not to invent artwork — it is to ask a source that has
 * some. iTunes Search resolves real cover art and a real 30-second preview by
 * matching artist and title, and the match is verified before anything is
 * attached, so a failed match yields "no art" rather than the wrong album's
 * cover. The artwork is Apple's and is attributed as such.
 *
 *   apple-music — has artwork, no preview URL in the RSS feed
 *   lastfm      — has neither: placeholder-only images, no preview
 *   deezer      — has both already
 *   youtube     — has real thumbnails; an audio preview does not apply
 */
const NEEDS_ITUNES_ENRICHMENT: Record<MusicSourceId, boolean> = {
  "apple-music": true,
  lastfm: true,
  deezer: false,
  youtube: false,
  gaana: false,
};

/**
 * Plain-language empty copy, written per source because the reasons genuinely
 * differ — "we have no key" and "Deezer publishes no chart for your country"
 * are different facts and a reader deserves to know which one they hit.
 */
function emptyNote(source: MusicSourceId, country: string, genre?: string): string {
  switch (source) {
    case "apple-music":
      // Apple publishes a chart for most storefronts, so "no chart here" is
      // almost never the real reason. Under a genre the honest answer is that
      // nothing in the current chart carries that genre tag.
      return genre
        ? `Apple's chart has no ${genre} entries right now. Apple publishes one most-played chart per country, not per genre, so this is the real chart filtered by the genres Apple itself tags — not a separate ${genre} chart.`
        : `Apple doesn't publish a most-played chart for this storefront.`;
    case "youtube":
      if (genre) {
        return `YouTube's most-popular chart has no genre axis, so we don't show it under a genre. Showing the general chart here labelled "${genre}" would be presenting other music as ${genre}.`;
      }
      return youtubeProvider.isEnabled()
        ? `YouTube returned no music chart for ${country} just now.`
        : `YouTube's music chart needs an API key. Add one and this rail fills in.`;
    case "deezer":
      return genre
        ? `Deezer has no editorial chart for ${genre} right now.`
        : `Deezer doesn't publish a chart for ${country}. We won't substitute a global chart and call it a local one.`;
    case "lastfm":
      return lastfmProvider.isEnabled()
        ? `Last.fm returned nothing for this ${genre ? "tag" : "country"}.`
        : `Last.fm's charts need an API key. Add one and this rail fills in.`;
    case "gaana":
      return `Gaana has no public API, so this source ships turned off. We'd rather show nothing than invent a chart.`;
  }
}

export async function musicBoard(params: {
  readonly source: MusicSourceId;
  readonly country: CountryCode;
  readonly genre?: string;
  readonly limit?: number;
}): Promise<MusicBoard> {
  const { source, country, genre, limit = 20 } = params;
  const provider = PROVIDERS[source];

  /**
   * Refuse to query a source that cannot filter by the requested genre. Without
   * this guard, YouTube would return its general music chart and the rail would
   * render it under the genre heading — real data, false label.
   */
  const raw =
    genre && GENRE_SUPPORT[source] === "none"
      ? []
      : await provider.fetchTrending({ country, genre, limit });

  if (raw.length === 0) {
    return {
      source,
      title: TITLES[source],
      tracks: [],
      fetchedAt: new Date().toISOString(),
      stale: false,
      note: emptyNote(source, country, genre),
      sourceUpdatedAt: null,
      attribution: provider.attribution,
    };
  }

  // See NEEDS_ITUNES_ENRICHMENT — sources that ship without artwork or without
  // a preview get both resolved from iTunes, verified by artist+title match.
  const tracks = NEEDS_ITUNES_ENRICHMENT[source]
    ? await enrichManyWithPreviews(raw, country)
    : raw;

  // Board key namespaces movement history by source, country and genre, so a
  // track's position on Apple's chart is never compared to its position on
  // YouTube's.
  const boardKey = `${source}:${country}:${genre ?? "all"}`;
  const snapshot = await loadPreviousSnapshot(boardKey);

  const withMovement = tracks.map((track) => ({
    ...track,
    movement: computeMovement(track.key, track.rank, snapshot),
  }));

  await recordSnapshot(
    boardKey,
    tracks.map((t) => ({ itemKey: t.key, rank: t.rank })),
  );

  let sourceUpdatedAt: string | null = null;
  if (source === "apple-music") {
    const meta = await fetchChartMeta(country, "songs");
    sourceUpdatedAt = isOk(meta.updatedIso) ? meta.updatedIso.value : null;
  }

  return {
    source,
    title: TITLES[source],
    tracks: withMovement,
    fetchedAt: raw[0].provenance.fetchedAt,
    stale: raw.some((t) => t.provenance.stale === true),
    note: null,
    sourceUpdatedAt,
    attribution: provider.attribution,
  };
}

export function musicSources(): readonly SourceId[] {
  return ["apple-music", "itunes", "youtube", "deezer", "lastfm"];
}

/* ------------------------------------------------------------------ *
 * International
 * ------------------------------------------------------------------ */

/**
 * The international view, which is genuinely worldwide rather than a country
 * chart relabelled.
 *
 * Last.fm's `chart.getTopTracks`, `chart.getTopArtists` and `tag.getTopTracks`
 * take no country parameter at all — they are global by construction. That is
 * why this view is built on Last.fm rather than on Apple or Deezer, both of
 * which only publish per-storefront/per-country charts. Passing one of those
 * off as "international" would be the same lie as calling Deezer's Top
 * Worldwide an India chart.
 *
 * Every track here is enriched from iTunes, because Last.fm serves only its
 * deprecated placeholder image — see NEEDS_ITUNES_ENRICHMENT.
 */
async function internationalBoard(params: {
  readonly title: string;
  readonly fetcher: () => Promise<readonly TrackRecord[]>;
  readonly boardKey: string;
  readonly emptyNote: string;
  readonly country: CountryCode;
}): Promise<MusicBoard> {
  const raw = await params.fetcher();

  if (raw.length === 0) {
    return {
      source: "lastfm",
      title: params.title,
      tracks: [],
      fetchedAt: new Date().toISOString(),
      stale: false,
      note: lastfmProvider.isEnabled()
        ? params.emptyNote
        : "This view runs on Last.fm's worldwide charts, which need an API key.",
      sourceUpdatedAt: null,
      attribution: lastfmProvider.attribution,
    };
  }

  // Storefront only affects which iTunes catalogue resolves the artwork and
  // preview; the chart itself is worldwide either way.
  const enriched = await enrichManyWithPreviews(raw, params.country);

  const snapshot = await loadPreviousSnapshot(params.boardKey);
  const tracks = enriched.map((track) => ({
    ...track,
    movement: computeMovement(track.key, track.rank, snapshot),
  }));
  await recordSnapshot(
    params.boardKey,
    raw.map((t) => ({ itemKey: t.key, rank: t.rank })),
  );

  return {
    source: "lastfm",
    title: params.title,
    tracks,
    fetchedAt: raw[0].provenance.fetchedAt,
    stale: raw.some((t) => t.provenance.stale === true),
    note: null,
    sourceUpdatedAt: null,
    attribution: lastfmProvider.attribution,
  };
}

/** Worldwide most-played, no country filter anywhere in the chain. */
export function worldwideBoard(country: CountryCode, limit = 20) {
  return internationalBoard({
    title: "Most played worldwide",
    fetcher: () => fetchWorldwideTracks(limit),
    boardKey: `lastfm:worldwide:tracks`,
    emptyNote: "Last.fm's worldwide chart came back empty.",
    country,
  });
}

/** The "by singer" axis — one artist's most-played tracks. */
export function artistBoard(artist: string, country: CountryCode, limit = 20) {
  return internationalBoard({
    title: artist,
    fetcher: () => fetchArtistTopTracks(artist, limit),
    boardKey: `lastfm:artist:${artist.toLowerCase()}`,
    emptyNote: `Last.fm has no top tracks on file for ${artist}.`,
    country,
  });
}

/** The "by genre" axis, worldwide — tag charts take no country. */
export function worldGenreBoard(genre: string, country: CountryCode, limit = 20) {
  return internationalBoard({
    title: `${genre} worldwide`,
    fetcher: () => lastfmProvider.fetchTrending({ country, genre, limit }),
    boardKey: `lastfm:worldtag:${genre.toLowerCase()}`,
    emptyNote: `Last.fm has no worldwide chart for the ${genre} tag.`,
    country,
  });
}

export { fetchTopArtists };
export type { LastfmArtist };

/**
 * Apple's other most-played feeds — albums and music videos.
 *
 * These are the same published chart data as the songs feed and need no key, so
 * they are the cheapest way to put real content on the page. Verified live for
 * the `in` storefront: both return 50 entries.
 *
 * They are shown as their own rails rather than mixed into the songs chart,
 * because an album chart position and a song chart position are different
 * measurements and interleaving them would produce a ranking Apple never made.
 */
/* ------------------------------------------------------------------ *
 * Released this year
 * ------------------------------------------------------------------ */

export const CURRENT_YEAR = new Date().getFullYear();

/**
 * The current chart, narrowed to songs actually RELEASED this year.
 *
 * Read the title carefully, because the distinction matters and the UI repeats
 * it: this is not "the most played songs of 2026". Neither Apple nor YouTube
 * publishes a year-to-date play ranking, so such a list could only be
 * fabricated by us. What both DO publish is a live chart, and every entry
 * carries a real release date — so "what is on the chart right now, released
 * this year" is a fact we can stand behind, computed entirely from source data.
 *
 * The chart is fetched deep (100 for Apple, YouTube's 50 ceiling) and then
 * filtered, because taking the top 20 first would leave only a handful of
 * current-year songs. Positions are renumbered 1..N over the filtered set and
 * the UI states that the ranking is within this year's releases.
 */
export async function releasedThisYearBoard(params: {
  readonly source: Extract<MusicSourceId, "apple-music" | "youtube">;
  readonly country: CountryCode;
  readonly limit?: number;
  readonly year?: number;
}): Promise<MusicBoard> {
  const { source, country, limit = 10, year = CURRENT_YEAR } = params;

  // Apple's feed serves 100; YouTube's videos.list caps maxResults at 50.
  const depth = source === "apple-music" ? 100 : 50;
  const board = await musicBoard({ source, country, limit: depth });

  const prefix = String(year);
  const thisYear = board.tracks.filter(
    (track) => isOk(track.releaseDate) && track.releaseDate.value.startsWith(prefix),
  );

  const renumbered = thisYear
    .slice(0, limit)
    // Chart order is preserved; only the visible numbering is recomputed, so
    // rank 1 means "highest-charting {year} release", not "biggest song of {year}".
    .map((track, index) => ({ ...track, rank: index + 1 }));

  return {
    ...board,
    title:
      source === "apple-music"
        ? `Apple Music chart · ${year} releases`
        : `YouTube chart · ${year} releases`,
    tracks: renumbered,
    note:
      renumbered.length === 0
        ? board.note ??
          `Nothing on this chart right now was released in ${year}. That is the ` +
            `chart's own release dates, not a failed request.`
        : null,
  };
}

export async function appleFeedBoard(params: {
  readonly kind: "albums" | "music-videos";
  readonly country: CountryCode;
  readonly limit?: number;
}): Promise<MusicBoard> {
  const { kind, country, limit = 20 } = params;
  const raw = await fetchAppleFeed(country, kind, limit);

  const title =
    kind === "albums" ? "Top albums on Apple Music" : "Top music videos on Apple Music";

  if (raw.length === 0) {
    return {
      source: "apple-music",
      title,
      tracks: [],
      fetchedAt: new Date().toISOString(),
      stale: false,
      note: `Apple doesn't publish a most-played ${kind === "albums" ? "albums" : "music videos"} chart for this storefront.`,
      sourceUpdatedAt: null,
      attribution: appleMusicProvider.attribution,
    };
  }

  const boardKey = `apple-music:${country}:${kind}`;
  const snapshot = await loadPreviousSnapshot(boardKey);

  const tracks = raw.map((track) => ({
    ...track,
    movement: computeMovement(track.key, track.rank, snapshot),
  }));

  await recordSnapshot(
    boardKey,
    raw.map((t) => ({ itemKey: t.key, rank: t.rank })),
  );

  const meta = await fetchChartMeta(country, kind);

  return {
    source: "apple-music",
    title,
    tracks,
    fetchedAt: raw[0].provenance.fetchedAt,
    stale: raw.some((t) => t.provenance.stale === true),
    note: null,
    sourceUpdatedAt: isOk(meta.updatedIso) ? meta.updatedIso.value : null,
    attribution: appleMusicProvider.attribution,
  };
}

/**
 * The genre axis. Apple and YouTube don't expose genre charts cleanly, so genre
 * browsing runs on Last.fm tags and Deezer's editorial genres. These are the
 * tags we offer; each maps to a Last.fm tag and, where one exists, a Deezer
 * genre name.
 */
export const GENRES: readonly { readonly slug: string; readonly label: string }[] = [
  // Bollywood leads: India is the primary market, so it sits directly beside
  // "All" rather than fifth behind four Western genres.
  { slug: "bollywood", label: "Bollywood" },
  { slug: "punjabi", label: "Punjabi" },
  { slug: "pop", label: "Pop" },
  { slug: "hip-hop", label: "Hip-hop" },
  { slug: "rock", label: "Rock" },
  { slug: "electronic", label: "Electronic" },
  { slug: "tamil", label: "Tamil" },
  { slug: "indie", label: "Indie" },
  { slug: "r&b", label: "R&B" },
  { slug: "jazz", label: "Jazz" },
];
