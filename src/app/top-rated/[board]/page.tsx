import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer, Header, SectionHead } from "@/components/Shell";
import { FilmCard } from "@/components/FilmCard";
import { EmptyRail } from "@/components/States";
import { Attribution, LastChecked } from "@/components/Meta";
import { readPrefs } from "@/lib/prefs/server";
import { resolveCountry } from "@/lib/prefs/country";
import { BOARD_IDS, leaderboard, type BoardId } from "@/lib/boards/leaderboards";

/**
 * The all-time destination, kept deliberately separate from everything
 * trending. Three boards, each labelled with the methodology that produced it.
 *
 * These are Airtime's own rankings. They are not IMDb's Top 250 and not Rotten
 * Tomatoes' Top 100, and the copy on the page says so — reproducing either
 * branded list would need a licence we do not have.
 */

const LABELS: Record<BoardId, string> = {
  international: "Worldwide",
  indian: "Indian cinema",
  critics: "Critics' pick",
};

function isBoardId(value: string): value is BoardId {
  return (BOARD_IDS as readonly string[]).includes(value);
}

export function generateStaticParams() {
  return BOARD_IDS.map((board) => ({ board }));
}

export default async function TopRatedPage({
  params,
  searchParams,
}: {
  params: Promise<{ board: string }>;
  searchParams: Promise<{ country?: string }>;
}) {
  const { board } = await params;
  if (!isBoardId(board)) notFound();

  const { country: countryParam } = await searchParams;
  const { prefs } = await readPrefs();
  const country = resolveCountry(countryParam, prefs.country);
  const data = await leaderboard(board, 40);

  return (
    <>
      <Header country={country} />
      <main id="main">
        <div className="px-[var(--board-gutter)] pt-6">
          <p className="eyebrow mb-2 text-gold">Top rated · all time</p>
          <h1 className="display text-3xl text-paper sm:text-4xl">Airtime&rsquo;s boards</h1>
        </div>

        <nav aria-label="Leaderboard" className="px-[var(--board-gutter)] pt-4">
          <ul className="flex flex-wrap gap-2">
            {BOARD_IDS.map((id) => (
              <li key={id}>
                <Link
                  href={`/top-rated/${id}`}
                  aria-current={id === board ? "page" : undefined}
                  className={`display inline-block border px-4 py-2 text-[13px] transition-colors ${
                    id === board
                      ? "border-gold bg-gold text-ink"
                      : "border-surface-hi text-muted hover:text-paper"
                  }`}
                >
                  {LABELS[id]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <SectionHead
          eyebrow="Our ranking"
          title={data.title}
          meta={
            data.films.length > 0 ? (
              <LastChecked fetchedAt={data.fetchedAt} />
            ) : null
          }
        />

        {/* The methodology sentence is generated from the same numbers the
            ranking used, so the printed claim cannot drift from the maths. */}
        {data.methodology ? (
          <p className="mx-[var(--board-gutter)] mb-5 max-w-3xl border-l-2 border-gold pl-3 text-[12px] leading-relaxed text-muted">
            {data.methodology}
          </p>
        ) : null}

        {data.films.length === 0 ? (
          <EmptyRail
            title="This board is empty"
            body={data.note ?? "Nothing came back for this board."}
          />
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 px-[var(--board-gutter)] sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {data.films.map((film) => (
              <FilmCard key={film.key} film={film} services={prefs.services} />
            ))}
          </div>
        )}

        <div className="px-[var(--board-gutter)] pt-8">
          <Attribution sources={["tmdb", "omdb"]} />
          <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
            A licensed IMDb Top 250 would require IMDb&rsquo;s commercial API via
            AWS Data Exchange. We don&rsquo;t have that licence, so we don&rsquo;t
            claim to serve their list.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
