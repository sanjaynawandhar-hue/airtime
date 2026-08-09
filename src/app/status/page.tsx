import { Footer, Header } from "@/components/Shell";
import { isOk } from "@/lib/core/maybe";
import type { HealthStatus, Provider } from "@/lib/core/types";
import { readPrefs } from "@/lib/prefs/server";
import { appleMusicProvider } from "@/lib/providers/appleMusic";
import { itunesProvider } from "@/lib/providers/itunes";
import { deezerProvider } from "@/lib/providers/deezer";
import { lastfmProvider } from "@/lib/providers/lastfm";
import { gaanaProvider } from "@/lib/providers/gaana";
import { youtubeProvider } from "@/lib/providers/youtube";
import { omdbProvider } from "@/lib/providers/omdb";
import { tmdbProvider } from "@/lib/providers/tmdb";
import { isDbConfigured } from "@/lib/db/client";

/**
 * Source status.
 *
 * This page exists because the honest answer to "why is that rail empty?"
 * should be one click away rather than a mystery. Every provider reports its
 * own health in its own words.
 */

export const metadata = { title: "Source status" };
export const dynamic = "force-dynamic";

const PROVIDERS = [
  tmdbProvider,
  omdbProvider,
  appleMusicProvider,
  itunesProvider,
  youtubeProvider,
  deezerProvider,
  lastfmProvider,
  gaanaProvider,
] as unknown as readonly Provider<never>[];

export default async function StatusPage() {
  const { prefs } = await readPrefs();
  const results = await Promise.all(
    PROVIDERS.map(async (provider): Promise<HealthStatus & { name: string }> => {
      const health = await provider.healthCheck();
      return { ...health, name: provider.displayName };
    }),
  );

  const live = results.filter((r) => r.ok).length;

  return (
    <>
      <Header country={prefs.country} />
      <main id="main" className="mx-auto max-w-3xl px-[var(--board-gutter)] pt-6">
        <p className="eyebrow mb-2 text-gold">Diagnostics</p>
        <h1 className="display text-3xl text-paper sm:text-4xl">Source status</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          {live} of {results.length} sources answered just now. A source being
          down never breaks the rest of the page — its rail shows an explicit
          empty state and everything else carries on.
        </p>

        <ul className="mt-6 flex flex-col">
          {results.map((result) => (
            <li
              key={result.source}
              className="flex items-start gap-3 border-t border-surface-hi/60 py-3.5"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 ${
                  result.ok ? "bg-cool" : "bg-flare"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[15px] font-semibold text-paper">
                  {result.name}
                  <span className="sr-only">{result.ok ? "— answering" : "— not answering"}</span>
                  {isOk(result.latencyMs) ? (
                    <span className="text-[11px] font-normal text-muted">
                      {result.latencyMs.value} ms
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted">
                  {result.detail}
                </p>
              </div>
            </li>
          ))}

          <li className="flex items-start gap-3 border-t border-surface-hi/60 py-3.5">
            <span
              aria-hidden="true"
              className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 ${
                isDbConfigured() ? "bg-cool" : "bg-flare"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-paper">Database</p>
              <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted">
                {isDbConfigured()
                  ? "Connected. Reviews, watchlists and week-over-week movement are stored."
                  : "Not connected — set DATABASE_URL. Charts, rails and title pages all still work; reviews, watchlists and rank movement don't."}
              </p>
            </div>
          </li>
        </ul>
      </main>
      <Footer />
    </>
  );
}
