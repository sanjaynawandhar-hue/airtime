import "server-only";

/**
 * Font loading for the share card.
 *
 * Satori needs raw font binaries, so the two display faces are fetched from
 * Google Fonts at request time and cached for a year — they never change. The
 * CSS endpoint is asked with a legacy user agent, which is what makes Google
 * serve a plain TTF rather than a WOFF2 that Satori cannot parse.
 */

const FONT_TTL = 60 * 60 * 24 * 365;

async function loadTtf(family: string, weight: number): Promise<ArrayBuffer | null> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  )}:wght@${weight}`;

  const cssResponse = await fetch(cssUrl, {
    headers: {
      // An old UA string makes Google serve TTF instead of WOFF2.
      "User-Agent": "Mozilla/5.0 (Windows NT 6.1)",
    },
    next: { revalidate: FONT_TTL },
  });
  if (!cssResponse.ok) return null;

  const css = await cssResponse.text();
  const match = /src:\s*url\((https:\/\/[^)]+\.ttf)\)/.exec(css);
  if (!match) return null;

  const fontResponse = await fetch(match[1], { next: { revalidate: FONT_TTL } });
  if (!fontResponse.ok) return null;

  return fontResponse.arrayBuffer();
}

export interface ShareFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 400 | 600 | 800;
  readonly style: "normal";
}

/**
 * Returns whatever loaded. If Google is unreachable the card still renders in
 * Satori's fallback face rather than failing — a plainer share card beats a
 * broken endpoint.
 */
export async function shareFonts(): Promise<ShareFont[]> {
  const [display, body] = await Promise.all([
    loadTtf("Archivo", 800),
    loadTtf("Instrument Sans", 600),
  ]);

  const fonts: ShareFont[] = [];
  if (display) fonts.push({ name: "Archivo", data: display, weight: 800, style: "normal" });
  if (body) fonts.push({ name: "Instrument Sans", data: body, weight: 600, style: "normal" });
  return fonts;
}
