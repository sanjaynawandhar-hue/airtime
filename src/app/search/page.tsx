import Link from "next/link";
import { Footer, Header, SectionHead } from "@/components/Shell";
import { TrackCard } from "@/components/TrackCard";
import { EmptyRail } from "@/components/States";
import { SearchBox } from "@/components/SearchBox";
import { Attribution } from "@/components/Meta";
import { readPrefs } from "@/lib/prefs/server";
import { resolveCountry } from "@/lib/prefs/country";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";
import { searchTracks } from "@/lib/providers/itunes";

/**
 * Song search results.
 *
 * Ordered by Apple's relevance, and the page says so — these are search hits,
 * not a chart, and numbering them as though they were a ranking would invent a
 * chart nobody published.
 */

interface Props {
  readonly searchParams: Promise<{ q?: string; country?: string }>;
}

const MAX_QUERY_CHARS = 120;

export async function generateMetadata({ searchParams }: Props) {
  const { q } = await searchParams;
  const query = q?.trim();
  return {
    title: query ? `Search: ${query}` : "Search songs",
    // Search result pages are per-query and thin; keeping them out of the index
    // is standard practice and avoids competing with the boards themselves.
    robots: { index: false },
  };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { prefs } = await readPrefs();
  const country = resolveCountry(sp.country, prefs.country);
  const countryName =
    SUPPORTED_COUNTRIES.find((c) => c.code === country)?.name ?? country;

  // Bounded before it reaches the provider — an unbounded query string goes
  // straight into an outbound URL.
  const query = (sp.q ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const tracks = query === "" ? [] : await searchTracks(query, country, 25);

  return (
    <>
      <Header country={country} />
      <main id="main">
        <div className="px-[var(--board-gutter)] pt-6">
          <Link href="/?mode=music" className="text-[12px] text-cool hover:text-gold">
            ← Back to music
          </Link>
        </div>

        <div className="px-[var(--board-gutter)] pt-4">
          <SearchBox initialQuery={query} country={country} autoFocus={query === ""} />
        </div>

        {query === "" ? (
          <div className="px-[var(--board-gutter)] pt-8">
            <p className="max-w-prose text-sm text-muted">
              Search Apple&rsquo;s catalogue for any song — Hindi, Tamil, Telugu,
              Malayalam, Kannada, Punjabi or international. Results come from the{" "}
              {countryName} storefront, so you get the release and price for where
              you are.
            </p>
          </div>
        ) : (
          <section aria-labelledby="search-results">
            <SectionHead
              eyebrow={`Search · ${countryName}`}
              title={`Results for “${query}”`}
              titleId="search-results"
              meta={
                tracks.length > 0 ? (
                  <p className="text-[11px] text-muted">
                    {tracks.length} {tracks.length === 1 ? "song" : "songs"}, ordered
                    by Apple&rsquo;s relevance. This is a search result, not a chart
                    position.
                  </p>
                ) : null
              }
            />

            {tracks.length === 0 ? (
              <EmptyRail
                title={`Nothing found for “${query}”`}
                body={
                  "Apple's catalogue returned no songs for that query in the " +
                  `${countryName} storefront. Try the artist's name, or the film ` +
                  "the song is from."
                }
                action={{ label: "Back to music", href: "/?mode=music" }}
              />
            ) : (
              // Wrapping flex rather than a grid: TrackCard has a fixed 290px
              // width above the phone breakpoint, so grid columns wider than
              // that would leave ragged gaps inside each cell.
              <div className="flex flex-wrap gap-2 px-[var(--board-gutter)] pt-1">
                {tracks.map((track) => (
                  <TrackCard key={track.key} track={track} showRank={false} />
                ))}
              </div>
            )}
          </section>
        )}

        <div className="px-[var(--board-gutter)] pt-8">
          <Attribution sources={["itunes"]} />
        </div>
      </main>
      <Footer />
    </>
  );
}
