import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer, Header, SectionHead } from "@/components/Shell";
import { TrackCard } from "@/components/TrackCard";
import { EmptyRail } from "@/components/States";
import { Attribution, LastChecked, relativeTime } from "@/components/Meta";
import { readPrefs } from "@/lib/prefs/server";
import { resolveCountry } from "@/lib/prefs/country";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";
import { CHART_FULL, chartBoard, isChartSlug } from "@/lib/boards/chart";

/**
 * The full chart behind a rail.
 *
 * Built by the same `chartBoard` the home rail uses, so the twenty here and the
 * five there cannot disagree. Rendered as a plain vertical list at every size —
 * this page exists precisely because someone wants to read a chart top to
 * bottom, and a horizontal rail is the wrong shape for that on any screen.
 */

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{
    country?: string;
    genre?: string;
    artist?: string;
  }>;
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return { title: isChartSlug(slug) ? "Full chart" : "Chart not found" };
}

export default async function ChartPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!isChartSlug(slug)) notFound();

  const sp = await searchParams;
  const { prefs } = await readPrefs();
  const country = resolveCountry(sp.country, prefs.country);

  const board = await chartBoard(
    slug,
    { country, genre: sp.genre, artist: sp.artist },
    CHART_FULL,
  );

  const countryName =
    SUPPORTED_COUNTRIES.find((c) => c.code === country)?.name ?? country;

  /**
   * Back goes to the section this chart came from, reconstructed from the same
   * parameters — so it lands where the reader actually was rather than wherever
   * browser history happens to point.
   */
  const isInternational =
    slug === "worldwide" || slug === "world-genre" || slug === "artist";
  const backParams = new URLSearchParams({ mode: "music" });
  if (isInternational) backParams.set("scope", "international");
  if (sp.genre) backParams.set("genre", sp.genre);
  if (sp.country) backParams.set("country", country);
  const backHref = `/?${backParams.toString()}`;

  const context = sp.artist
    ? sp.artist
    : isInternational
      ? sp.genre
        ? `${sp.genre} · worldwide`
        : "Worldwide"
      : sp.genre
        ? `${sp.genre} · ${countryName}`
        : countryName;

  return (
    <>
      <Header country={country} />
      <main id="main">
        <div className="px-[var(--board-gutter)] pt-5">
          <Link
            href={backHref}
            className="eyebrow inline-flex items-center gap-1.5 border border-surface-hi px-3 py-2 text-muted transition-colors hover:border-gold hover:text-gold"
          >
            <span aria-hidden="true">←</span> Back
          </Link>
        </div>

        <SectionHead
          eyebrow={context}
          title={board.title}
          titleId="chart-title"
          meta={
            board.tracks.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2">
                <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
                {board.sourceUpdatedAt ? (
                  <span className="text-[11px] text-muted">
                    · chart updated {relativeTime(board.sourceUpdatedAt)}
                  </span>
                ) : null}
                <span className="text-[11px] text-muted">
                  · {board.tracks.length} tracks
                </span>
              </div>
            ) : null
          }
        />

        {board.tracks.length === 0 ? (
          <EmptyRail
            title="Nothing to show here"
            body={board.note ?? "This chart came back empty."}
            action={{ label: "Back to the board", href: backHref }}
          />
        ) : (
          <ol className="flex flex-col gap-1.5 px-[var(--board-gutter)] pb-2">
            {board.tracks.map((track) => (
              <li key={track.key}>
                <TrackCard track={track} stale={board.stale} />
              </li>
            ))}
          </ol>
        )}

        <div className="px-[var(--board-gutter)] pt-6">
          <p className="mb-2 max-w-prose text-[11px] leading-relaxed text-muted">
            {board.attribution}
          </p>
          <Attribution sources={["apple-music", "itunes", "youtube", "deezer", "lastfm"]} />
        </div>

        <div className="px-[var(--board-gutter)] pt-6">
          <Link
            href={backHref}
            className="eyebrow inline-flex items-center gap-1.5 border border-surface-hi px-3 py-2 text-muted transition-colors hover:border-gold hover:text-gold"
          >
            <span aria-hidden="true">←</span> Back
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
