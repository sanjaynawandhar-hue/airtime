import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { readConsent, readPrefs, writePrefs, purgeIdentity } from "@/lib/prefs/server";
import { clearCookies, setPrefCookie } from "@/lib/prefs/cookie";
import { PREF_COOKIE_NAME, isSupportedCountry } from "@/lib/prefs/types";
import { WATCH_PROVIDERS } from "@/lib/core/config";

/**
 * Read and write the reader's preferences.
 *
 * Writes are refused without consent. That is the whole point of the consent
 * step: if it did not actually gate storage it would be theatre.
 */

export async function GET() {
  const { prefs, consent, anonId } = await readPrefs();
  return NextResponse.json({ prefs, consent, hasIdentity: anonId !== null });
}

const VALID_SERVICES = new Set(WATCH_PROVIDERS.map((p) => p.platform));

export async function PUT(request: Request) {
  const consent = await readConsent();
  if (consent !== "granted") {
    return NextResponse.json(
      {
        error:
          "Preferences aren't being saved because you haven't opted into storage. Everything still works — it just won't be remembered.",
      },
      { status: 409 },
    );
  }

  const { anonId } = await readPrefs();
  if (!anonId) {
    return NextResponse.json({ error: "No identity to save against." }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 40) : [];

  const country =
    typeof body.country === "string" && isSupportedCountry(body.country)
      ? body.country
      : undefined;

  // Services are constrained to platforms we actually resolve links for — an
  // arbitrary string here would silently never match and the reordering would
  // look broken rather than refuse.
  const services = asStrings(body.services).filter((s) => VALID_SERVICES.has(s));

  const saved = await writePrefs(anonId, {
    country,
    languages: asStrings(body.languages),
    genres: asStrings(body.genres),
    services,
  });

  if (!saved) {
    return NextResponse.json(
      { error: "We couldn't save that — the database didn't answer. Try again." },
      { status: 503 },
    );
  }

  const response = NextResponse.json({ ok: true });
  if (country) {
    setPrefCookie(response, { id: anonId, country, consent: "granted", v: 1 });
  }
  return response;
}

/**
 * "Reset my preferences" — clears BOTH sides for real. The identity row is
 * deleted, which cascades to preferences, reviews, watchlist and reactions, and
 * both cookies are removed.
 */
export async function DELETE() {
  const store = await cookies();
  const raw = store.get(PREF_COOKIE_NAME)?.value;
  let anonId: string | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as { id?: unknown };
      if (typeof parsed.id === "string") anonId = parsed.id;
    } catch {
      anonId = null;
    }
  }

  let serverCleared = true;
  if (anonId) serverCleared = await purgeIdentity(anonId);

  const response = NextResponse.json({
    ok: true,
    serverCleared,
    // Told plainly rather than claimed silently: if the database was
    // unreachable we say the server side is still pending.
    detail: serverCleared
      ? "Everything stored about you has been deleted."
      : "Your cookies are cleared, but we couldn't reach the database to delete the server-side copy. Try again shortly.",
  });
  clearCookies(response);
  return response;
}

/**
 * Region is a URL parameter, not an endpoint — see lib/prefs/country.ts. The
 * old GET /api/prefs/country redirect handler was removed because the command
 * palette's router.push could not follow it, which made every region command a
 * silent no-op. Persisting a region still happens through PUT above.
 */
export const dynamic = "force-dynamic";
