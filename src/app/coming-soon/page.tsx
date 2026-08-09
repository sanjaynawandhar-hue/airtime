import Image from "next/image";
import Link from "next/link";
import { Footer, Header } from "@/components/Shell";
import { EmptyRail } from "@/components/States";
import { Attribution, LastChecked } from "@/components/Meta";
import { isOk } from "@/lib/core/maybe";
import { readPrefs } from "@/lib/prefs/server";
import { resolveCountry } from "@/lib/prefs/country";
import { upcomingBoard } from "@/lib/boards/film";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";

/**
 * Coming soon to cinemas, ordered by the reader's own country release date.
 *
 * Two rules govern this page. There are NO rating widgets — unreleased films
 * have no scores anywhere, and an empty or zero one would be a lie of omission.
 * And every date carries a "last checked" stamp, because Indian release dates
 * move constantly and a bare date reads as a promise rather than an observation.
 */

export const metadata = { title: "Coming soon to cinemas" };

export default async function ComingSoonPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string }>;
}) {
  const params = await searchParams;
  const { prefs } = await readPrefs();
  const country = resolveCountry(params.country, prefs.country);
  const board = await upcomingBoard(country, 40);
  const countryName =
    SUPPORTED_COUNTRIES.find((c) => c.code === country)?.name ?? country;

  return (
    <>
      <Header country={country} />
      <main id="main">
        <div className="px-[var(--board-gutter)] pt-6">
          <p className="eyebrow mb-2 text-gold">Coming soon · {countryName}</p>
          <h1 className="display text-3xl text-paper sm:text-4xl">Next in cinemas</h1>
          <div className="mt-2 flex flex-col gap-1">
            <LastChecked fetchedAt={board.fetchedAt} stale={board.stale} />
            <p className="max-w-prose text-[12px] leading-relaxed text-muted">
              Dates are as currently listed by TMDB for {countryName}, with the
              local certification where one has been issued. Release dates change
              often — when one moves, this page simply shows the new date.
            </p>
          </div>
        </div>

        {board.films.length === 0 ? (
          <div className="pt-8">
            <EmptyRail
              title="No dated releases yet"
              body={board.note ?? "Nothing dated for this region."}
              action={{ label: "Change region", href: "/preferences" }}
            />
          </div>
        ) : (
          <ol className="mt-6 flex flex-col">
            {board.films.map((film) => {
              const theatrical =
                film.availability?.kind === "theatrical" ? film.availability : null;
              const date = theatrical?.releaseDate;

              return (
                <li
                  key={film.key}
                  className="border-t border-surface-hi/60 px-[var(--board-gutter)] py-4 transition-colors hover:bg-surface"
                >
                  <Link href={`/film/${film.tmdbId}`} className="flex items-center gap-4">
                    <div className="relative aspect-[2/3] w-[64px] shrink-0 overflow-hidden bg-surface">
                      {isOk(film.posterUrl) ? (
                        <Image
                          src={film.posterUrl.value}
                          alt=""
                          fill
                          className="object-cover"
                          sizes="64px"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center text-[9px] text-muted">
                          No art
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-paper">
                        {film.title}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                        {date && isOk(date) ? (
                          <span className="text-gold">
                            {new Date(date.value).toLocaleDateString("en-GB", {
                              weekday: "short",
                              day: "numeric",
                              month: "long",
                              year: "numeric",
                            })}
                          </span>
                        ) : (
                          <span>Date not listed for {countryName}</span>
                        )}
                        {theatrical && isOk(theatrical.certification) ? (
                          <span className="border border-surface-hi px-1.5 py-0.5">
                            {theatrical.certification.value}
                          </span>
                        ) : null}
                        {film.genres.length > 0 ? (
                          <span>· {film.genres.slice(0, 3).join(", ")}</span>
                        ) : null}
                      </p>
                      {/* Deliberately no rating widget here — see the file comment. */}
                    </div>

                    <span className="eyebrow shrink-0 text-muted">Details →</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}

        <div className="px-[var(--board-gutter)] pt-8">
          <Attribution sources={["tmdb"]} />
        </div>
      </main>
      <Footer />
    </>
  );
}
