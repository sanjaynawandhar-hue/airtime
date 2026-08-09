import { ImageResponse } from "next/og";
import { isOk } from "@/lib/core/maybe";
import { fetchTitleDetails } from "@/lib/providers/tmdb";
import { fetchRatings } from "@/lib/providers/omdb";
import { readCountry } from "@/lib/prefs/server";
import { shareFonts } from "@/lib/share/fonts";
import { APP } from "@/lib/core/config";
import { computeDivergence, divergenceCopy } from "@/lib/rank/divergence";

/**
 * 9:16 share card, 1080x1920, for Reels and Stories.
 *
 * Satori supports flexbox and a subset of CSS — no grid, no CSS variables — so
 * the tokens from DESIGN.md are inlined here as literals. The tick strip is
 * rebuilt as a row of divs for the same reason.
 *
 * Nothing on this card is invented: a title with no Rotten Tomatoes score shows
 * no Rotten Tomatoes block rather than a placeholder, exactly as the site does.
 */

export const runtime = "nodejs";

const INK = "#120c0f";
const SURFACE = "#2e1f26";
const FLARE = "#ff6b35";
const COOL = "#4cc9f0";
const GOLD = "#ffd166";
const PAPER = "#f7f0ea";
const MUTED = "#b9a49a";

function TickStrip({ colour, count = 46 }: { colour: string; count?: number }) {
  return (
    <div style={{ display: "flex", gap: 14, height: 14, opacity: 0.55 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ width: 5, height: 14, backgroundColor: colour }} />
      ))}
    </div>
  );
}

function ScoreBlock({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: `6px solid ${accent}`, paddingLeft: 18 }}>
      <div
        style={{
          display: "flex",
          fontSize: 22,
          letterSpacing: 3,
          color: MUTED,
          textTransform: "uppercase",
          fontFamily: "Archivo",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", fontSize: 62, color: PAPER, fontFamily: "Archivo" }}>
        {value}
      </div>
    </div>
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tmdbId = Number(url.searchParams.get("tmdbId"));

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return new Response("A valid tmdbId is required.", { status: 400 });
  }

  const country = await readCountry();
  const details = await fetchTitleDetails(tmdbId, country);

  if (!details) {
    return new Response("We couldn't load that title, so there's no card to make.", {
      status: 404,
    });
  }

  // Ratings for the card come from the same place the page uses.
  const ratings = isOk(details.imdbId)
    ? await fetchRatings(details.imdbId.value)
    : details.ratings;

  const imdb = ratings.find((r) => r.label === "IMDb" && isOk(r.value));
  const rt = ratings.find((r) => r.label === "Rotten Tomatoes" && isOk(r.value));

  const fonts = await shareFonts();
  const poster = isOk(details.posterUrl) ? details.posterUrl.value : null;

  const year = isOk(details.localReleaseDate)
    ? details.localReleaseDate.value.slice(0, 4)
    : null;

  /**
   * Only claim "in cinemas now" when the run is actually current. A film that
   * merely HAD a theatrical release still carries a theatrical context (it is
   * where the certification and local date come from), so this reads the
   * `currentlyRunning` flag rather than the mere presence of the context.
   */
  const inCinemas = details.theatrical?.currentlyRunning === true;
  const context = inCinemas
    ? "In cinemas now"
    : details.ott !== null && details.ott.offers.length > 0
      ? `Streaming on ${details.ott.offers[0].platformName}`
      : null;

  /**
   * Divergence recomputed from the OMDb-enriched ratings above. `details`
   * carries only TMDB's own vote, so its precomputed divergence is almost
   * always unavailable — the card was silently dropping the split-verdict line
   * that the title page was showing for the same film.
   */
  const divergence = computeDivergence(ratings);

  return new ImageResponse(
    (
      <div
        style={{
          width: 1080,
          height: 1920,
          display: "flex",
          flexDirection: "column",
          backgroundColor: INK,
          padding: 72,
          fontFamily: "Instrument Sans",
        }}
      >
        {/* masthead */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div
            style={{
              display: "flex",
              fontFamily: "Archivo",
              fontSize: 52,
              color: PAPER,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Airtime
          </div>
          <div style={{ display: "flex", width: 18, height: 18, backgroundColor: FLARE }} />
        </div>

        <div style={{ display: "flex", marginTop: 22, marginBottom: 54 }}>
          <TickStrip colour={GOLD} />
        </div>

        {/* poster */}
        {poster ? (
          <div style={{ display: "flex", justifyContent: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={poster}
              alt=""
              width={620}
              height={930}
              style={{ objectFit: "cover", backgroundColor: SURFACE }}
            />
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              width: 620,
              height: 930,
              backgroundColor: SURFACE,
              alignSelf: "center",
              alignItems: "center",
              justifyContent: "center",
              color: MUTED,
              fontSize: 28,
            }}
          >
            No poster available
          </div>
        )}

        {/* title */}
        <div
          style={{
            display: "flex",
            marginTop: 54,
            fontFamily: "Archivo",
            fontSize: details.title.length > 26 ? 74 : 96,
            lineHeight: 1,
            color: PAPER,
            textTransform: "uppercase",
          }}
        >
          {details.title}
        </div>

        <div style={{ display: "flex", gap: 20, marginTop: 20, fontSize: 30, color: MUTED }}>
          {year ? <div style={{ display: "flex" }}>{year}</div> : null}
          {isOk(details.runtimeMinutes) ? (
            <div style={{ display: "flex" }}>{details.runtimeMinutes.value} min</div>
          ) : null}
          {isOk(details.certification) ? (
            <div style={{ display: "flex" }}>{details.certification.value}</div>
          ) : null}
        </div>

        {context ? (
          <div
            style={{
              display: "flex",
              marginTop: 24,
              alignSelf: "flex-start",
              backgroundColor: inCinemas ? FLARE : COOL,
              color: INK,
              fontFamily: "Archivo",
              fontSize: 28,
              letterSpacing: 2,
              textTransform: "uppercase",
              padding: "12px 22px",
            }}
          >
            {context}
          </div>
        ) : null}

        {/* scores — only what we actually have */}
        <div style={{ display: "flex", gap: 56, marginTop: 44 }}>
          {imdb && isOk(imdb.value) ? (
            <ScoreBlock label="IMDb" value={imdb.value.value.toFixed(1)} accent={GOLD} />
          ) : null}
          {rt && isOk(rt.value) ? (
            <ScoreBlock
              label="Rotten Tomatoes"
              value={`${Math.round(rt.value.value)}%`}
              accent={FLARE}
            />
          ) : null}
        </div>

        {isOk(divergence) ? (
          <div style={{ display: "flex", marginTop: 30, fontSize: 30, color: GOLD }}>
            {divergenceCopy(divergence.value)}
          </div>
        ) : null}

        <div style={{ display: "flex", flex: 1 }} />

        {/* footer */}
        <div style={{ display: "flex", marginBottom: 22 }}>
          <TickStrip colour={SURFACE} />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 30, color: MUTED }}>
            {APP.tagline}
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: "Archivo",
              fontSize: 34,
              color: GOLD,
              letterSpacing: 1,
            }}
          >
            {APP.brand}
          </div>
        </div>
      </div>
    ),
    {
      width: 1080,
      height: 1920,
      fonts: fonts.length > 0 ? fonts : undefined,
      headers: {
        // Share cards are stable for a title; cache them hard at the edge.
        "cache-control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
