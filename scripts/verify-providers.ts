/**
 * Live verification harness.
 *
 * Calls every provider against its REAL endpoint and prints what came back.
 * This is how we check that an adapter works rather than merely compiles — the
 * whole product is only as good as whether these calls actually return data.
 *
 * Run:  npm run verify
 *
 * Providers with no key configured report `not_configured` and are skipped
 * rather than failing the run, so this is useful before and after keys land.
 */

import { appleMusicProvider, fetchChartMeta } from "../src/lib/providers/appleMusic";
import { itunesProvider, enrichWithPreview } from "../src/lib/providers/itunes";
import { deezerProvider } from "../src/lib/providers/deezer";
import { lastfmProvider } from "../src/lib/providers/lastfm";
import { gaanaProvider } from "../src/lib/providers/gaana";
import { youtubeProvider } from "../src/lib/providers/youtube";
import { omdbProvider, fetchRatings } from "../src/lib/providers/omdb";
import tmdbProvider, {
  fetchTheatrical,
  fetchOtt,
  fetchUpcoming,
  fetchTitleDetails,
  fetchTopRatedPool,
  fetchIndianPool,
} from "../src/lib/providers/tmdb";
import { isOk, type Maybe } from "../src/lib/core/maybe";
import type { Provider } from "../src/lib/core/types";

const show = <T>(m: Maybe<T>): string =>
  isOk(m) ? String(m.value) : `[unavailable: ${m.reason}]`;

function head(title: string) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function checkHealth(provider: Provider<never>) {
  const h = await provider.healthCheck();
  console.log(
    `  health: ${h.ok ? "OK " : "FAIL"}  ${h.detail}  (${show(h.latencyMs)}ms)`,
  );
  return h.ok;
}

async function main() {
  const country = process.env.VERIFY_COUNTRY ?? "IN";
  console.log(`Verifying providers against country=${country}`);
  console.log(`Node ${process.version}  ${new Date().toISOString()}`);

  /* ---------------------------------------------------------------- */
  head("APPLE MUSIC (public RSS — no key)");
  await checkHealth(appleMusicProvider as unknown as Provider<never>);
  const meta = await fetchChartMeta(country, "songs");
  console.log(`  chart meta: ${JSON.stringify(meta)}`);
  const appleTracks = await appleMusicProvider.fetchTrending({ country, limit: 5 });
  console.log(`  tracks returned: ${appleTracks.length}`);
  for (const t of appleTracks.slice(0, 3)) {
    console.log(
      `   #${t.rank} ${t.title} — ${t.artist}\n` +
        `      art=${show(t.artworkUrl)}\n` +
        `      preview=${show(t.previewUrl)}\n` +
        `      url=${t.provenance.sourceUrl}\n` +
        `      genres=[${t.genres.join(", ")}]`,
    );
  }

  /* ---------------------------------------------------------------- */
  head("ITUNES (public search/lookup — no key)");
  await checkHealth(itunesProvider as unknown as Provider<never>);
  if (appleTracks[0]) {
    const enriched = await enrichWithPreview(appleTracks[0], country);
    console.log(`  enriched "${enriched.title}"`);
    console.log(`    preview=${show(enriched.previewUrl)}`);
    console.log(`    artwork=${show(enriched.artworkUrl)}`);
  }

  /* ---------------------------------------------------------------- */
  head("DEEZER (public — no key)");
  await checkHealth(deezerProvider as unknown as Provider<never>);
  const deezerAll = await deezerProvider.fetchTrending({ country, limit: 5 });
  console.log(`  tracks (no genre): ${deezerAll.length}`);
  for (const t of deezerAll.slice(0, 3)) {
    console.log(`   #${t.rank} ${t.title} — ${t.artist}  preview=${show(t.previewUrl)}`);
  }
  const deezerPop = await deezerProvider.fetchTrending({ country, genre: "Pop", limit: 5 });
  console.log(`  tracks (genre=Pop): ${deezerPop.length}`);
  for (const t of deezerPop.slice(0, 3)) {
    console.log(`   #${t.rank} ${t.title} — ${t.artist}`);
  }

  /* ---------------------------------------------------------------- */
  head("LAST.FM (needs LASTFM_API_KEY)");
  await checkHealth(lastfmProvider as unknown as Provider<never>);
  const lastfmGeo = await lastfmProvider.fetchTrending({ country, limit: 5 });
  console.log(`  geo tracks: ${lastfmGeo.length}`);
  for (const t of lastfmGeo.slice(0, 3)) {
    console.log(`   #${t.rank} ${t.title} — ${t.artist}  plays=${show(t.playCount)}`);
  }
  const lastfmTag = await lastfmProvider.fetchTrending({ country, genre: "rock", limit: 5 });
  console.log(`  tag=rock tracks: ${lastfmTag.length}`);

  /* ---------------------------------------------------------------- */
  head("GAANA (intentionally disabled — no public API)");
  await checkHealth(gaanaProvider as unknown as Provider<never>);
  const gaana = await gaanaProvider.fetchTrending({ country, limit: 5 });
  console.log(`  tracks returned: ${gaana.length}  (expected 0)`);

  /* ---------------------------------------------------------------- */
  head("YOUTUBE (needs YOUTUBE_API_KEY)");
  await checkHealth(youtubeProvider as unknown as Provider<never>);
  const yt = await youtubeProvider.fetchTrending({ country, limit: 5 });
  console.log(`  music chart tracks: ${yt.length}`);
  for (const t of yt.slice(0, 3)) {
    console.log(`   #${t.rank} ${t.title} — ${t.artist}  views=${show(t.playCount)}`);
  }

  /* ---------------------------------------------------------------- */
  head("TMDB (needs TMDB_READ_TOKEN)");
  await checkHealth(tmdbProvider as unknown as Provider<never>);

  const theatrical = await fetchTheatrical(country, 8);
  console.log(`\n  THEATRICAL rail: ${theatrical.length} titles`);
  for (const f of theatrical.slice(0, 4)) {
    const a = f.availability;
    console.log(
      `   #${show(f.rank)} ${f.title} (tmdb:${f.tmdbId})\n` +
        `      rail=${f.rail} context=${a?.kind ?? "none"}\n` +
        `      cert=${a && a.kind === "theatrical" ? show(a.certification) : "n/a"}` +
        ` release=${a && a.kind === "theatrical" ? show(a.releaseDate) : "n/a"}\n` +
        `      booking=${a && a.kind === "theatrical" && isOk(a.booking) ? a.booking.value.url : "none"}`,
    );
  }

  const ott = await fetchOtt(country, 8);
  console.log(`\n  OTT rail: ${ott.length} titles`);
  for (const f of ott.slice(0, 4)) {
    const a = f.availability;
    const offers = a && a.kind === "ott" ? a.offers : [];
    console.log(
      `   #${show(f.rank)} ${f.title} (tmdb:${f.tmdbId})  rail=${f.rail} context=${a?.kind ?? "none"}\n` +
        `      offers: ${offers.map((o) => `${o.platformName}/${o.offerType}${isOk(o.price) ? ` @${o.price.value}` : ""}`).join(", ") || "none"}`,
    );
  }

  // The overlap case the brief calls out explicitly.
  const theatricalIds = new Set(theatrical.map((f) => f.tmdbId));
  const overlap = ott.filter((f) => theatricalIds.has(f.tmdbId));
  console.log(
    `\n  BOTH-RAIL OVERLAP: ${overlap.length} title(s) appear in both rails` +
      (overlap.length ? ` — ${overlap.map((f) => f.title).join(", ")}` : ""),
  );
  for (const f of overlap) {
    const t = theatrical.find((x) => x.tmdbId === f.tmdbId)!;
    console.log(
      `    ${f.title}: theatrical record context=${t.availability?.kind}, ` +
        `ott record context=${f.availability?.kind} (must differ, must not be shared)`,
    );
  }

  const upcoming = await fetchUpcoming(country, 6);
  console.log(`\n  UPCOMING rail: ${upcoming.length} titles`);
  for (const f of upcoming.slice(0, 4)) {
    const a = f.availability;
    console.log(
      `   ${f.title} — release=${a && a.kind === "theatrical" ? show(a.releaseDate) : "n/a"}` +
        `  ratings=${f.ratings.length} (must be 0)  fetchedAt=${f.provenance.fetchedAt}`,
    );
  }

  if (theatrical[0]) {
    const details = await fetchTitleDetails(theatrical[0].tmdbId, country);
    if (details) {
      console.log(`\n  TITLE DETAILS for "${details.title}"`);
      console.log(`    imdbId=${show(details.imdbId)} runtime=${show(details.runtimeMinutes)}`);
      console.log(`    cert=${show(details.certification)} localRelease=${show(details.localReleaseDate)}`);
      console.log(`    genres=[${details.genres.join(", ")}] studios=[${details.studios.join(", ")}]`);
      console.log(`    cast: ${details.cast.slice(0, 4).map((c) => `${c.name} as ${show(c.character)}`).join("; ")}`);
      const role = (job: string) =>
        details.crew.filter((c) => c.job === job).map((c) => c.name).join(", ") || "—";
      console.log(`    director=${role("Director")}`);
      console.log(`    dop=${role("Director of Photography")}`);
      console.log(`    composer=${role("Original Music Composer")}`);
      console.log(`    trailer=${isOk(details.trailer) ? details.trailer.value.youtubeKey : "[none]"}`);
      console.log(`    critic reviews: ${details.criticReviews.length}`);
      console.log(`    theatrical ctx=${details.theatrical ? "yes" : "no"}  ott ctx=${details.ott ? "yes" : "no"}`);

      /* -------------------------------------------------------- */
      head("OMDb (needs OMDB_API_KEY) — ratings for the title above");
      await checkHealth(omdbProvider as unknown as Provider<never>);
      if (isOk(details.imdbId)) {
        const ratings = await fetchRatings(details.imdbId.value);
        console.log(`  ratings returned: ${ratings.length}`);
        for (const r of ratings) {
          console.log(`   ${r.label}: ${show(r.value)} (${r.scale})  votes=${show(r.voteCount)}`);
        }
      } else {
        console.log("  no IMDb id on this title — cannot look up");
      }
    } else {
      console.log("\n  TITLE DETAILS: null");
    }
  }

  const pool = await fetchTopRatedPool(2000, 3);
  console.log(`\n  TOP-RATED POOL: ${pool.length} candidates`);
  if (pool.length) {
    const clearing = pool.filter((c) => c.voteCount >= 2000).length;
    console.log(`    clearing the 2000-vote floor: ${clearing}`);
  }

  const indian = await fetchIndianPool(["hi", "ta", "te", "ml", "kn", "bn", "mr"], 100);
  console.log(`  INDIAN POOL: ${indian.length} candidates`);
  if (indian.length) {
    for (const floor of [50, 100, 200, 500, 2000]) {
      console.log(`    clearing ${floor} votes: ${indian.filter((c) => c.voteCount >= floor).length}`);
    }
  }

  console.log("\nDone.\n");
}

main().catch((error) => {
  console.error("verify failed:", error);
  process.exit(1);
});
