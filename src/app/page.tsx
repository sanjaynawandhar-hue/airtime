import { Suspense } from "react";
import Link from "next/link";
import { Footer, Header, ModeToggle, RailToggle, SectionHead } from "@/components/Shell";
import { FilmCard } from "@/components/FilmCard";
import { TrackCard } from "@/components/TrackCard";
import { EmptyRail, SkeletonRail, SourceBanner } from "@/components/States";
import { Attribution, LastChecked, relativeTime } from "@/components/Meta";
import { ConsentBar } from "@/components/ConsentBar";
import { readPrefs } from "@/lib/prefs/server";
import { theatricalBoard, ottBoard, overlappingIds, upcomingBoard } from "@/lib/boards/film";
import {
  GENRES,
  appleFeedBoard,
  artistBoard,
  fetchTopArtists,
  CURRENT_YEAR,
  musicBoard,
  releasedThisYearBoard,
  sourceAvailability,
  worldGenreBoard,
  worldwideBoard,
  type MusicSourceId,
} from "@/lib/boards/music";
import { appleMusicProvider } from "@/lib/providers/appleMusic";
import { youtubeProvider } from "@/lib/providers/youtube";
import { lastfmProvider } from "@/lib/providers/lastfm";
import { deezerProvider } from "@/lib/providers/deezer";
import { tmdbProvider } from "@/lib/providers/tmdb";
import { omdbProvider } from "@/lib/providers/omdb";
import { SOURCE_LABEL } from "@/lib/core/types";
import { EpisodeCard } from "@/components/EpisodeCard";
import { SearchBox } from "@/components/SearchBox";
import { TrailerCard } from "@/components/TrailerCard";
import {
  TRAILER_WINDOW_DAYS,
  fetchTrailers,
  missingTrailerSources,
  type TrailerScope,
} from "@/lib/providers/trailers";
import { fetchPodcastEpisodes, podcastsConfigured } from "@/lib/providers/podcasts";
import { PODCAST_SHOWS, WATCH_PROVIDERS } from "@/lib/core/config";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";
import { resolveCountry } from "@/lib/prefs/country";
import {
  CHART_FULL,
  CHART_PREVIEW,
  SOURCE_SLUG,
  chartHref,
} from "@/lib/boards/chart";

const countryName = (code: string) =>
  SUPPORTED_COUNTRIES.find((c) => c.code === code)?.name ?? code;

/**
 * The board. One page, two modes, and inside Film a structural split between
 * what is in cinemas and what is on streaming.
 *
 * Every rail is wrapped in its own Suspense boundary so a slow source never
 * holds up the rest of the page — for an aggregator, perceived speed is the
 * product, and a rail that arrives a second late is far better than a page that
 * arrives whole and late.
 */

interface SearchParams {
  readonly mode?: string;
  readonly rail?: string;
  readonly genre?: string;
  readonly country?: string;
  readonly show?: string;
  readonly scope?: string;
  readonly artist?: string;
  readonly platform?: string;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { prefs, consent } = await readPrefs();
  const country = resolveCountry(params.country, prefs.country);

  const mode =
    params.mode === "film"
      ? "film"
      : params.mode === "podcast"
        ? "podcast"
        : params.mode === "trailer"
          ? "trailer"
          : "music";
  const rail = params.rail === "ott" ? "ott" : "theatrical";
  const genre = params.genre;

  /**
   * Region rides on the URL, so it keeps working for a reader who declined
   * storage. Every in-page link carries it forward or the choice is lost on the
   * next click. See lib/prefs/country.ts.
   */
  const qs = params.country ? `&country=${country}` : "";

  return (
    <>
      <Header country={country} />
      <main id="main">
        <ModeToggle mode={mode} qs={qs} />
        <SourceBanner {...sourceStatus(mode)} />

        {mode === "music" ? (
          <>
            <div className="px-[var(--board-gutter)] pt-5">
              <SearchBox country={params.country ? country : undefined} />
            </div>
            {params.scope === "international" ? (
              <InternationalMode
                country={country}
                genre={genre}
                artist={params.artist}
                qs={qs}
              />
            ) : (
              <MusicMode country={country} genre={genre} qs={qs} />
            )}
          </>
        ) : mode === "podcast" ? (
          <PodcastMode showId={params.show} qs={qs} />
        ) : mode === "trailer" ? (
          <TrailerMode />
        ) : (
          <FilmMode
            country={country}
            rail={rail}
            platform={params.platform}
            services={prefs.services}
            qs={qs}
          />
        )}
      </main>
      <Footer />
      <ConsentBar consent={consent} />
    </>
  );
}

/**
 * Which sources can answer right now. Read from the providers themselves so the
 * banner cannot drift out of step with what actually happens on the page.
 */
function sourceStatus(mode: "music" | "film" | "podcast" | "trailer") {
  const providers =
    mode === "music"
      ? [appleMusicProvider, deezerProvider, youtubeProvider, lastfmProvider]
      : mode === "podcast"
        ? [youtubeProvider]
        : mode === "trailer"
          ? // Trailers genuinely need both: TMDB for which video is the
            // trailer, YouTube for the view count that orders the rail.
            [tmdbProvider, youtubeProvider]
          : [tmdbProvider, omdbProvider];
  const missing = providers.filter((p) => !p.isEnabled()).map((p) => p.displayName);
  return { connected: providers.length - missing.length, total: providers.length, missing };
}

/* ------------------------------------------------------------------ *
 * Music
 * ------------------------------------------------------------------ */

/**
 * Region charts vs worldwide.
 *
 * These are different data, not a filter: Apple and Deezer only publish
 * per-country charts, while Last.fm's chart.* and tag.* methods take no country
 * at all. So "international" is built on the methods that are genuinely global
 * rather than on a country chart with a different label.
 */
function ScopeToggle({
  scope,
  qs,
}: {
  readonly scope: "region" | "international";
  readonly qs: string;
}) {
  const options = [
    { value: "region", label: "Your region", href: `/?mode=music${qs}` },
    {
      value: "international",
      label: "International",
      href: `/?mode=music&scope=international${qs}`,
    },
  ] as const;

  return (
    <nav aria-label="Chart scope" className="px-[var(--board-gutter)] pt-4">
      <div className="inline-flex gap-2">
        {options.map((option) => (
          <Link
            key={option.value}
            href={option.href}
            aria-current={scope === option.value ? "page" : undefined}
            className={`display border px-4 py-2 text-[13px] transition-colors ${
              scope === option.value
                ? "border-cool bg-cool text-ink"
                : "border-surface-hi text-muted hover:text-paper"
            }`}
          >
            {option.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function GenreChips({
  active,
  qs,
}: {
  readonly active?: string;
  readonly qs: string;
}) {
  return (
    <nav aria-label="Music genre" className="pt-4">
      <ul className="chip-row">
        <li>
          <Link
            href={`/?mode=music${qs}`}
            aria-current={!active ? "page" : undefined}
            className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
              !active
                ? "border-gold bg-gold text-ink"
                : "border-surface-hi text-muted hover:text-paper"
            }`}
          >
            All
          </Link>
        </li>
        {GENRES.map((g) => (
          <li key={g.slug}>
            <Link
              href={`/?mode=music&genre=${encodeURIComponent(g.slug)}${qs}`}
              aria-current={active === g.slug ? "page" : undefined}
              className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
                active === g.slug
                  ? "border-gold bg-gold text-ink"
                  : "border-surface-hi text-muted hover:text-paper"
              }`}
            >
              {g.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function MusicMode({
  country,
  genre,
  qs,
}: {
  readonly country: string;
  readonly genre?: string;
  readonly qs: string;
}) {
  /**
   * Sources are shown as separate rails rather than blended into one chart.
   * Apple's most-played, YouTube's most-popular and Last.fm's scrobble counts
   * measure genuinely different things; averaging them would produce a ranking
   * that is nobody's actual chart. When a genre is selected the tag-based
   * sources lead, because Apple and YouTube have no clean genre axis.
   */
  const ordered: readonly MusicSourceId[] = genre
    ? ["lastfm", "deezer", "apple-music", "youtube"]
    : ["apple-music", "youtube", "lastfm", "deezer"];

  /**
   * Drop sources that structurally cannot answer this country/genre pair.
   *
   * A full-height "Nothing to show here" panel is right for a transient
   * failure and wrong for a permanent one — YouTube will never have a genre
   * axis, and Deezer publishes no chart for India (verified: 102 country
   * playlists, none Indian; its Indian Music genre returns 0 chart playlists).
   * Those facts are stated once, compactly, below the rails.
   */
  const checked = ordered.map((source) => ({
    source,
    status: sourceAvailability(source, country, genre),
  }));

  const sources = checked.filter((c) => c.status === "ok").map((c) => c.source);
  const excluded = checked.filter((c) => c.status !== "ok");

  return (
    <>
      <ScopeToggle scope="region" qs={qs} />
      <GenreChips active={genre} qs={qs} />

      {sources[0] ? (
        <Suspense fallback={<MusicRailSkeleton source={sources[0]} />}>
          <MusicRail source={sources[0]} country={country} genre={genre} />
        </Suspense>
      ) : null}

      {/* This year's releases. Skipped under a genre: the filter runs over a
          deep chart fetch, and the genre-capable sources are a different set. */}
      {genre ? null : (
        <>
          <Suspense fallback={<RailSkeleton label={`Fetching ${CURRENT_YEAR} releases on Apple Music`} />}>
            <ThisYearRail source="apple-music" country={country} />
          </Suspense>
          <Suspense fallback={<RailSkeleton label={`Fetching ${CURRENT_YEAR} releases on YouTube`} />}>
            <ThisYearRail source="youtube" country={country} />
          </Suspense>
        </>
      )}

      {/* Apple's albums and music-video charts are the same published data as
          the songs feed and need no key, so they sit high on the page and carry
          it when the key-gated sources below are empty. Skipped under a genre —
          these feeds have no genre axis. */}
      {genre ? null : (
        <>
          <Suspense fallback={<RailSkeleton label="Fetching Apple albums" />}>
            <AppleExtraRail kind="albums" country={country} />
          </Suspense>
          <Suspense fallback={<RailSkeleton label="Fetching Apple music videos" />}>
            <AppleExtraRail kind="music-videos" country={country} />
          </Suspense>
        </>
      )}

      {sources.slice(1).map((source) => (
        <Suspense key={source} fallback={<MusicRailSkeleton source={source} />}>
          <MusicRail source={source} country={country} genre={genre} />
        </Suspense>
      ))}
      {excluded.length > 0 ? (
        <div className="mx-[var(--board-gutter)] mt-6 max-w-prose border-l-2 border-surface-hi pl-3 text-[12px] leading-relaxed text-muted">
          {excluded.some((e) => e.status === "no_genre_axis") ? (
            <p>
              Not shown for a genre:{" "}
              {excluded
                .filter((e) => e.status === "no_genre_axis")
                .map((e) => SOURCE_LABEL[e.source])
                .join(" and ")}
              . Their charts have no genre axis, so filtering them would mean
              labelling other music as {genre}.
            </p>
          ) : null}
          {excluded.some((e) => e.status === "no_country_chart") ? (
            <p className="mt-1.5">
              Not shown for {countryName(country)}:{" "}
              {excluded
                .filter((e) => e.status === "no_country_chart")
                .map((e) => SOURCE_LABEL[e.source])
                .join(" and ")}
              . They publish no chart for this country, and we won&rsquo;t pass a
              global chart off as a local one. Pick a genre and they come back.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="px-[var(--board-gutter)] pt-6">
        <Attribution sources={["apple-music", "itunes", "youtube", "deezer", "lastfm"]} />
      </div>
    </>
  );
}

/**
 * The loading placeholder names its source. Three identical "Fetching the
 * chart" headings on one page is noise for anyone navigating by heading, and it
 * tells a sighted reader nothing about which rail is still coming.
 */
function MusicRailSkeleton({ source }: { readonly source?: MusicSourceId }) {
  return (
    <section aria-busy="true">
      <SectionHead
        eyebrow="Loading"
        title={source ? `Fetching ${SOURCE_LABEL[source]}` : "Fetching the chart"}
      />
      <SkeletonRail />
    </section>
  );
}

/**
 * Songs on the current chart that were released this year.
 *
 * The heading and the note both say exactly that. It is NOT "the most played
 * songs of 2026" — no source publishes a year-to-date play ranking, so that
 * list could only come from us inventing it.
 */
async function ThisYearRail({
  source,
  country,
}: {
  readonly source: "apple-music" | "youtube";
  readonly country: string;
}) {
  const board = await releasedThisYearBoard({ source, country, limit: CHART_PREVIEW });

  // A source with no current-year songs gets one quiet line, not a rail-sized
  // empty panel — this is a supplementary cut of a chart shown elsewhere.
  if (board.tracks.length === 0) {
    return (
      <p className="px-[var(--board-gutter)] pt-4 text-[11px] text-muted">
        {board.note}
      </p>
    );
  }

  return (
    <section aria-labelledby={`year-${source}`}>
      <SectionHead
        eyebrow={`${CURRENT_YEAR} releases · ${countryName(country)}`}
        title={board.title}
        titleId={`year-${source}`}
        meta={
          <>
            <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
            <p className="mt-1 max-w-prose text-[11px] text-muted">
              Songs on{" "}
              {source === "apple-music" ? "Apple Music's" : "YouTube's"} chart
              right now whose release date falls in {CURRENT_YEAR}, in chart
              order. Neither service publishes a year-to-date play ranking, so
              this is a cut of the live chart rather than a &ldquo;best of
              {" "}{CURRENT_YEAR}&rdquo; we made up.
            </p>
          </>
        }
      />
      <div className="rail-list">
        {board.tracks.map((track) => (
          <TrackCard key={track.key} track={track} stale={board.stale} />
        ))}
      </div>
    </section>
  );
}

async function MusicRail({
  source,
  country,
  genre,
}: {
  readonly source: MusicSourceId;
  readonly country: string;
  readonly genre?: string;
}) {
  /**
   * Fetch the whole chart, show the top few.
   *
   * Deliberately not requesting five: the rank-movement snapshot is written
   * from whatever we fetched, so a five-row request would quietly shrink our
   * movement history to five rows. It also means the "see all" page reads from
   * the same warm cache rather than issuing a second, different request.
   */
  const board = await musicBoard({ source, country, genre, limit: CHART_FULL });
  const slug = SOURCE_SLUG[source];

  return (
    <section aria-labelledby={`music-${source}`}>
      <SectionHead
        eyebrow={genre ? `${genre} · ${countryName(country)}` : countryName(country)}
        title={board.title}
        titleId={`music-${source}`}
        action={
          slug && board.tracks.length > CHART_PREVIEW
            ? {
                label: `See all ${board.tracks.length}`,
                href: chartHref(slug, { country, genre }),
              }
            : undefined
        }
        meta={
          board.tracks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-2">
              <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
              {board.sourceUpdatedAt ? (
                <span className="text-[11px] text-muted">
                  · chart updated {relativeTime(board.sourceUpdatedAt)}
                </span>
              ) : null}
            </div>
          ) : null
        }
      />
      {board.tracks.length === 0 ? (
        <EmptyRail
          title="Nothing to show here"
          body={board.note ?? "This chart came back empty."}
        />
      ) : (
        <div className="rail-list">
          {board.tracks.slice(0, CHART_PREVIEW).map((track) => (
            <TrackCard key={track.key} track={track} stale={board.stale} />
          ))}
        </div>
      )}
    </section>
  );
}

async function AppleExtraRail({
  kind,
  country,
}: {
  readonly kind: "albums" | "music-videos";
  readonly country: string;
}) {
  const board = await appleFeedBoard({ kind, country, limit: CHART_FULL });

  return (
    <section aria-labelledby={`apple-${kind}`}>
      <SectionHead
        eyebrow={countryName(country)}
        title={board.title}
        titleId={`apple-${kind}`}
        action={
          board.tracks.length > CHART_PREVIEW
            ? {
                label: `See all ${board.tracks.length}`,
                href: chartHref(kind === "albums" ? "apple-albums" : "apple-videos", {
                  country,
                }),
              }
            : undefined
        }
        meta={
          board.tracks.length > 0 ? (
            <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
          ) : null
        }
      />
      {board.tracks.length === 0 ? (
        <EmptyRail title="Nothing to show here" body={board.note ?? ""} />
      ) : (
        <div className="rail-list">
          {board.tracks.slice(0, CHART_PREVIEW).map((track) => (
            <TrackCard key={track.key} track={track} stale={board.stale} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * International music
 * ------------------------------------------------------------------ */

/**
 * Worldwide charts, browsable by singer and by genre.
 *
 * A note on what is NOT here: there is no "by actor" axis, because no music API
 * indexes tracks by the actor appearing in the video. Last.fm, Deezer, Apple
 * and iTunes all key on ARTIST. Building an actor axis would mean guessing which
 * films a song appeared in and who was on screen, which is exactly the invented
 * data this product refuses to ship. See the note rendered at the foot of this
 * section.
 */
async function InternationalMode({
  country,
  genre,
  artist,
  qs,
}: {
  readonly country: string;
  readonly genre?: string;
  readonly artist?: string;
  readonly qs: string;
}) {
  const artists = await fetchTopArtists(18);

  return (
    <>
      <ScopeToggle scope="international" qs={qs} />

      {/* by singer */}
      <nav aria-label="Artist" className="pt-4">
        <p className="eyebrow mb-2 px-[var(--board-gutter)] text-muted">By singer</p>
        <ul className="chip-row">
          {artists.length === 0 ? (
            <li className="text-[12px] text-muted">
              Last.fm&rsquo;s worldwide artist chart is unavailable right now.
            </li>
          ) : null}
          {artists.map((a) => (
            <li key={a.name}>
              <Link
                href={`/?mode=music&scope=international&artist=${encodeURIComponent(a.name)}${qs}`}
                aria-current={artist === a.name ? "page" : undefined}
                className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
                  artist === a.name
                    ? "border-gold bg-gold text-ink"
                    : "border-surface-hi text-muted hover:text-paper"
                }`}
              >
                {a.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* by genre — tag charts take no country, so these are worldwide */}
      <nav aria-label="Genre" className="pt-4">
        <p className="eyebrow mb-2 px-[var(--board-gutter)] text-muted">By genre</p>
        <ul className="chip-row">
          {GENRES.map((g) => (
            <li key={g.slug}>
              <Link
                href={`/?mode=music&scope=international&genre=${encodeURIComponent(g.slug)}${qs}`}
                aria-current={genre === g.slug ? "page" : undefined}
                className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
                  genre === g.slug
                    ? "border-gold bg-gold text-ink"
                    : "border-surface-hi text-muted hover:text-paper"
                }`}
              >
                {g.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Suspense fallback={<RailSkeleton label="Fetching worldwide chart" />}>
        <InternationalRail country={country} genre={genre} artist={artist} />
      </Suspense>

      <p className="mx-[var(--board-gutter)] mt-6 max-w-prose border-l-2 border-surface-hi pl-3 text-[12px] leading-relaxed text-muted">
        Worldwide charts come from Last.fm, whose chart and tag methods take no
        country at all — so this is genuinely global rather than one country&rsquo;s
        chart relabelled. Artwork and previews are matched from iTunes.
        <br />
        <br />
        There is no &ldquo;by actor&rdquo; axis: no music API indexes songs by the
        actor in the video — they all key on artist — so building one would mean
        inventing the data.
      </p>
    </>
  );
}

async function InternationalRail({
  country,
  genre,
  artist,
}: {
  readonly country: string;
  readonly genre?: string;
  readonly artist?: string;
}) {
  const board = artist
    ? await artistBoard(artist, country, CHART_FULL)
    : genre
      ? await worldGenreBoard(genre, country, CHART_FULL)
      : await worldwideBoard(country, CHART_FULL);

  const eyebrow = artist ? "By singer" : genre ? `${genre} · worldwide` : "Worldwide";

  return (
    <section aria-labelledby="intl-rail">
      <SectionHead
        eyebrow={eyebrow}
        title={board.title}
        titleId="intl-rail"
        action={
          board.tracks.length > CHART_PREVIEW
            ? {
                label: `See all ${board.tracks.length}`,
                href: chartHref(
                  artist ? "artist" : genre ? "world-genre" : "worldwide",
                  { country, genre, artist },
                ),
              }
            : undefined
        }
        meta={
          board.tracks.length > 0 ? (
            <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
          ) : null
        }
      />
      {board.tracks.length === 0 ? (
        <EmptyRail title="Nothing to show here" body={board.note ?? ""} />
      ) : (
        <div className="rail-list">
          {board.tracks.slice(0, CHART_PREVIEW).map((track) => (
            <TrackCard key={track.key} track={track} stale={board.stale} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Podcast
 * ------------------------------------------------------------------ */

function ShowChips({ active, qs }: { readonly active?: string; readonly qs: string }) {
  return (
    <nav aria-label="Podcast show" className="pt-4">
      <ul className="chip-row">
        <li>
          <Link
            href={`/?mode=podcast${qs}`}
            aria-current={!active ? "page" : undefined}
            className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
              !active
                ? "border-gold bg-gold text-ink"
                : "border-surface-hi text-muted hover:text-paper"
            }`}
          >
            All shows
          </Link>
        </li>
        {PODCAST_SHOWS.map((show) => (
          <li key={show.id}>
            <Link
              href={`/?mode=podcast&show=${show.id}${qs}`}
              aria-current={active === show.id ? "page" : undefined}
              className={`inline-block border px-3 py-1.5 text-[12px] transition-colors ${
                active === show.id
                  ? "border-gold bg-gold text-ink"
                  : "border-surface-hi text-muted hover:text-paper"
              }`}
            >
              {show.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PodcastMode({ showId, qs }: { readonly showId?: string; readonly qs: string }) {
  return (
    <>
      <ShowChips active={showId} qs={qs} />
      <Suspense fallback={<RailSkeleton label="Fetching episodes" />}>
        <PodcastRail showId={showId} />
      </Suspense>
    </>
  );
}

/**
 * Episodes from the allowlisted shows, newest first.
 *
 * There is no rank here and no numeral on the card, because there is no chart —
 * the ordering is publish date, which is a real property of the data rather
 * than a popularity ranking we would have had to invent.
 */
async function PodcastRail({ showId }: { readonly showId?: string }) {
  const episodes = await fetchPodcastEpisodes({ showId });
  const show = showId ? PODCAST_SHOWS.find((s) => s.id === showId) : undefined;

  return (
    <section aria-labelledby="podcast-rail">
      <SectionHead
        eyebrow={show ? show.name : `${PODCAST_SHOWS.length} shows`}
        title={show ? "Latest episodes" : "Latest across every show"}
        titleId="podcast-rail"
        meta={
          episodes.length > 0 ? (
            <LastChecked fetchedAt={episodes[0].provenance.fetchedAt} />
          ) : null
        }
      />

      {episodes.length === 0 ? (
        <EmptyRail
          title="No episodes to show"
          body={
            podcastsConfigured()
              ? "YouTube returned no uploads for these shows just now. We only ever read the shows in our config allowlist, so nothing else can appear here."
              : "Podcasts read each show's uploads from the YouTube Data API, which needs an API key. Add YOUTUBE_API_KEY and this section fills in."
          }
        />
      ) : (
        <div className="rail-list">
          {episodes.map((episode) => (
            <EpisodeCard key={episode.key} episode={episode} />
          ))}
        </div>
      )}

      <p className="mx-[var(--board-gutter)] mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        Shows are a fixed allowlist we curate, not a search — nothing outside it
        can appear. Episodes are each channel&rsquo;s own uploads, ordered by
        publish date, with Shorts and clips filtered out so full episodes
        don&rsquo;t get crowded off the rail. Via YouTube.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Film
 * ------------------------------------------------------------------ */

/**
 * Which service to narrow the streaming rail to.
 *
 * Only services that actually operate in the reader's country are offered —
 * WATCH_PROVIDERS carries a `regions` list per platform, so a reader in the UK
 * is never shown a JioHotstar chip that could only ever come back empty.
 */
function PlatformChips({
  country,
  active,
  qs,
}: {
  readonly country: string;
  readonly active?: string;
  readonly qs: string;
}) {
  const available = WATCH_PROVIDERS.filter((p) => p.regions.includes(country));
  if (available.length === 0) return null;

  const base = `/?mode=film&rail=ott${qs}`;
  const chip = (selected: boolean) =>
    `inline-block border px-3 py-1.5 text-[12px] transition-colors ${
      selected
        ? "border-cool bg-cool text-ink"
        : "border-surface-hi text-muted hover:text-paper"
    }`;

  return (
    <nav aria-label="Streaming service" className="pt-4">
      <ul className="chip-row">
        <li>
          <Link href={base} aria-current={!active ? "page" : undefined} className={chip(!active)}>
            All services
          </Link>
        </li>
        {available.map((p) => (
          <li key={p.platform}>
            <Link
              href={`${base}&platform=${p.platform}`}
              aria-current={active === p.platform ? "page" : undefined}
              className={chip(active === p.platform)}
            >
              {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FilmMode({
  country,
  rail,
  platform,
  services,
  qs,
}: {
  readonly country: string;
  readonly rail: "theatrical" | "ott";
  readonly platform?: string;
  readonly services: readonly string[];
  readonly qs: string;
}) {
  // A platform filter only means anything on the streaming rail. Carrying it
  // into the theatrical rail would be nonsense, so it is dropped there.
  const activePlatform = rail === "ott" ? platform : undefined;

  return (
    <>
      <div className="pt-4">
        <RailToggle rail={rail} qs={qs} />
      </div>

      {rail === "ott" ? (
        <PlatformChips country={country} active={activePlatform} qs={qs} />
      ) : null}

      <Suspense
        key={`${rail}:${activePlatform ?? "all"}`}
        fallback={
          <RailSkeleton
            label={rail === "theatrical" ? "Fetching cinema listings" : "Fetching streaming titles"}
          />
        }
      >
        <FilmRail
          country={country}
          rail={rail}
          platform={activePlatform}
          services={services}
        />
      </Suspense>

      {/* Coming Soon is a THEATRICAL rail — upcoming cinema releases. It was
          rendering under "On streaming" too, which put cinema dates in a
          streaming context and blurred the split the two rails exist to keep. */}
      {rail === "theatrical" ? (
        <Suspense fallback={<RailSkeleton label="Fetching upcoming releases" />}>
          <ComingSoonPreview country={country} qs={qs} />
        </Suspense>
      ) : null}

      <div className="px-[var(--board-gutter)] pt-6">
        <Attribution sources={["tmdb", "omdb"]} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Trailers
 * ------------------------------------------------------------------ */

function TrailerMode() {
  return (
    <>
      <Suspense fallback={<RailSkeleton label="Fetching India trailers" />}>
        <TrailerRail scope="india" />
      </Suspense>
      <Suspense fallback={<RailSkeleton label="Fetching international trailers" />}>
        <TrailerRail scope="international" />
      </Suspense>
      <div className="px-[var(--board-gutter)] pt-6">
        <Attribution sources={["tmdb", "youtube"]} />
      </div>
    </>
  );
}

async function TrailerRail({ scope }: { readonly scope: TrailerScope }) {
  const trailers = await fetchTrailers(scope, 10);
  const missing = missingTrailerSources();
  const label = scope === "india" ? "India" : "International";

  return (
    <section aria-labelledby={`trailers-${scope}`}>
      <SectionHead
        eyebrow={`Trailers · ${label}`}
        title={scope === "india" ? "Top Indian trailers" : "Top international trailers"}
        titleId={`trailers-${scope}`}
        meta={
          trailers.length > 0 ? (
            <>
              <LastChecked fetchedAt={trailers[0].fetchedAt} stale={false} />
              {/* State the rule the list obeys. "Top" means nothing on its own,
                  and the reader should not have to infer the window. */}
              <p className="mt-1 max-w-prose text-[11px] text-muted">
                {/* The number and its unit are one expression on purpose. Split
                    as `{DAYS} days`, a line wrap between them strips the space
                    and it renders "30days". */}
                Ranked by YouTube view count. Trailers and teasers published in
                the last {`${TRAILER_WINDOW_DAYS} days`}, one per film — a
                film&rsquo;s most-watched recent trailer represents it.
              </p>
            </>
          ) : null
        }
      />
      {trailers.length === 0 ? (
        <EmptyRail
          title={`No ${label.toLowerCase()} trailers in the last ${TRAILER_WINDOW_DAYS} days`}
          body={
            missing.length > 0
              ? `This rail needs both ${missing.join(" and ")}, which ${
                  missing.length > 1 ? "are" : "is"
                } not connected. Nothing was asked of ${
                  missing.length > 1 ? "them" : "it"
                } — this is not a source reporting an empty result.`
              : `TMDB lists no trailer published in the last ${TRAILER_WINDOW_DAYS} days for the films it is tracking here. Indian release schedules in particular publish trailers in bursts, so this rail can genuinely be thin.`
          }
        />
      ) : (
        <div className="rail">
          {trailers.map((trailer, index) => (
            <TrailerCard key={trailer.key} trailer={trailer} rank={index + 1} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Labelled loading placeholder. Every one on a page must say something
 *  different, or heading navigation becomes a list of identical entries. */
function RailSkeleton({ label }: { readonly label: string }) {
  return (
    <section aria-busy="true">
      <SectionHead eyebrow="Loading" title={label} />
      <SkeletonRail />
    </section>
  );
}

async function FilmRail({
  country,
  rail,
  platform,
  services,
}: {
  readonly country: string;
  readonly rail: "theatrical" | "ott";
  readonly platform?: string;
  readonly services: readonly string[];
}) {
  /**
   * BOTH pipelines run, even though only one rail is displayed. That is
   * deliberate: the cross-reference below ("also streaming" / "also in
   * cinemas") is only truthful if computed from the other pipeline's actual
   * output. The boards are never merged — each card keeps its own rail's
   * availability context, so a theatrical card can never claim a streaming
   * offer it did not earn.
   */
  const [theatrical, ott] = await Promise.all([
    theatricalBoard(country, 20),
    ottBoard(country, 20, platform),
  ]);

  const service = platform
    ? WATCH_PROVIDERS.find((p) => p.platform === platform)
    : undefined;

  const board = rail === "theatrical" ? theatrical : ott;
  const other = rail === "theatrical" ? ott : theatrical;
  const alsoIn = overlappingIds(board, other);

  const eyebrow =
    rail === "theatrical"
      ? `In cinemas · ${countryName(country)}`
      : `${service ? service.name : "Streaming"} · ${countryName(country)}`;
  const title =
    rail === "theatrical"
      ? "Playing now"
      : service
        ? `Top on ${service.name}`
        : "Trending on streaming";

  return (
    <section aria-labelledby="film-rail">
      <SectionHead
        eyebrow={eyebrow}
        title={title}
        titleId="film-rail"
        meta={
          board.films.length > 0 ? (
            <>
              <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
              {alsoIn.size > 0 ? (
                <p className="mt-1 max-w-prose text-[11px] text-gold">
                  {alsoIn.size} of these {alsoIn.size === 1 ? "is" : "are"} also{" "}
                  {rail === "theatrical" ? "on streaming" : "in cinemas"} right now.
                  Each rail shows only its own availability.
                </p>
              ) : null}
            </>
          ) : null
        }
      />
      {board.films.length === 0 ? (
        <EmptyRail
          title={
            rail === "theatrical"
              ? "No cinema listings for your region"
              : service
                ? `Nothing listed on ${service.name} here`
                : "No confirmed streaming titles for your region"
          }
          body={board.note ?? "Nothing came back from TMDB for this rail."}
          action={{ label: "Change region", href: "/preferences" }}
        />
      ) : (
        <div className="rail">
          {board.films.map((film) => (
            <div key={film.key} className="flex flex-col">
              <FilmCard
                film={film}
                services={services}
                stale={board.stale}
                leadPlatform={service?.platform}
              />
              {alsoIn.has(film.tmdbId) ? (
                <p className="mt-1 w-[164px] text-[10px] leading-tight text-gold sm:w-[184px]">
                  Also {rail === "theatrical" ? "streaming" : "in cinemas"}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function ComingSoonPreview({
  country,
  qs,
}: {
  readonly country: string;
  readonly qs: string;
}) {
  const board = await upcomingBoard(country, 12);

  return (
    <section aria-labelledby="coming-soon">
      <SectionHead
        eyebrow={`Coming soon · ${countryName(country)}`}
        title="Next in cinemas"
        titleId="coming-soon"
        meta={
          board.films.length > 0 ? (
            <>
              <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
              <p className="mt-1 max-w-prose text-[11px] text-muted">
                Dates are as currently listed and move often, especially in India. A
                changed date is an update, not an error.
              </p>
            </>
          ) : null
        }
        action={{ label: "See all", href: `/coming-soon${qs.replace("&", "?")}` }}
      />
      {board.films.length === 0 ? (
        <EmptyRail
          title="No dated releases yet"
          body={board.note ?? "Nothing dated for this region."}
        />
      ) : (
        <div className="rail">
          {board.films.map((film) => (
            <FilmCard key={film.key} film={film} stale={board.stale} showRank={false} />
          ))}
        </div>
      )}
    </section>
  );
}
