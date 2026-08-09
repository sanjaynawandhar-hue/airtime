import "server-only";
import { cookies } from "next/headers";
import { query } from "@/lib/db/client";
import {
  CONSENT_COOKIE_NAME,
  EMPTY_SERVER_PREFS,
  PREF_COOKIE_NAME,
  isSupportedCountry,
  type ConsentState,
  type PrefCookie,
  type ServerPrefs,
} from "./types";
import { APP } from "@/lib/core/config";

/**
 * Reading and writing preferences. `cookies()` is async in Next 16.
 *
 * Nothing here is written unless consent is "granted". Reads always work — a
 * declining user gets defaults on every request, which is the correct
 * behaviour, not a degraded one.
 */

function parseCookie(raw: string | undefined): PrefCookie | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<PrefCookie>;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length < 8 ||
      typeof parsed.country !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      country: isSupportedCountry(parsed.country) ? parsed.country : APP.defaultCountry,
      consent: parsed.consent === "granted" || parsed.consent === "declined"
        ? parsed.consent
        : "unset",
      v: 1,
    };
  } catch {
    // A malformed cookie is user-supplied input at a real boundary. Treat it as
    // absent rather than throwing a 500 at someone with a stale cookie.
    return null;
  }
}

export async function readConsent(): Promise<ConsentState> {
  const store = await cookies();
  const value = store.get(CONSENT_COOKIE_NAME)?.value;
  if (value === "granted" || value === "declined") return value;
  const cookie = parseCookie(store.get(PREF_COOKIE_NAME)?.value);
  return cookie?.consent ?? "unset";
}

/** The current identity, or null when the user has no cookie yet. */
export async function readAnonId(): Promise<string | null> {
  const store = await cookies();
  return parseCookie(store.get(PREF_COOKIE_NAME)?.value)?.id ?? null;
}

export async function readCountry(): Promise<string> {
  const store = await cookies();
  return parseCookie(store.get(PREF_COOKIE_NAME)?.value)?.country ?? APP.defaultCountry;
}

/**
 * Full preferences. Cookie for country, database for the heavy lists. Returns
 * defaults for a user with no cookie or no database — never throws, never
 * blocks a page render.
 */
export async function readPrefs(): Promise<{
  readonly anonId: string | null;
  readonly consent: ConsentState;
  readonly prefs: ServerPrefs;
}> {
  const store = await cookies();
  const cookie = parseCookie(store.get(PREF_COOKIE_NAME)?.value);
  const consent = await readConsent();

  if (!cookie) {
    return { anonId: null, consent, prefs: EMPTY_SERVER_PREFS };
  }

  const rows = await query(async (sql) => {
    return (await sql`
      SELECT country, languages, genres, services
      FROM preference WHERE anon_id = ${cookie.id}
    `) as {
      country: string | null;
      languages: string[];
      genres: string[];
      services: string[];
    }[];
  });

  const row = rows?.[0];

  return {
    anonId: cookie.id,
    consent,
    prefs: {
      country: row?.country ?? cookie.country,
      languages: row?.languages ?? [],
      genres: row?.genres ?? [],
      services: row?.services ?? [],
    },
  };
}

/**
 * Ensure an identity row exists. Called only on a write path, and only with
 * consent — we do not mint an ID for someone who is just reading.
 */
export async function ensureIdentity(anonId: string): Promise<boolean> {
  const result = await query(async (sql) => {
    await sql`
      INSERT INTO identity (anon_id) VALUES (${anonId})
      ON CONFLICT (anon_id) DO UPDATE SET last_seen_at = now()
    `;
    return true;
  });
  return result === true;
}

export async function writePrefs(
  anonId: string,
  prefs: Partial<ServerPrefs>,
): Promise<boolean> {
  await ensureIdentity(anonId);
  const result = await query(async (sql) => {
    await sql`
      INSERT INTO preference (anon_id, country, languages, genres, services)
      VALUES (
        ${anonId},
        ${prefs.country ?? null},
        ${(prefs.languages ?? []) as string[]},
        ${(prefs.genres ?? []) as string[]},
        ${(prefs.services ?? []) as string[]}
      )
      ON CONFLICT (anon_id) DO UPDATE SET
        country    = COALESCE(EXCLUDED.country, preference.country),
        languages  = EXCLUDED.languages,
        genres     = EXCLUDED.genres,
        services   = EXCLUDED.services,
        updated_at = now()
    `;
    return true;
  });
  return result === true;
}

/**
 * "Reset my preferences" — must genuinely clear BOTH sides. The cookie delete
 * happens in the route handler that calls this; here we remove everything the
 * server holds. ON DELETE CASCADE takes reviews, watchlist and reactions with
 * it, which is what "reset everything" has to mean.
 */
export async function purgeIdentity(anonId: string): Promise<boolean> {
  const result = await query(async (sql) => {
    await sql`DELETE FROM identity WHERE anon_id = ${anonId}`;
    return true;
  });
  return result === true;
}
