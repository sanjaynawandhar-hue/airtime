import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { APP } from "@/lib/core/config";
import { ensureIdentity } from "@/lib/prefs/server";
import { clearCookies, mintAnonId, setConsentCookie, setPrefCookie } from "@/lib/prefs/cookie";
import { CONSENT_COOKIE_NAME, PREF_COOKIE_NAME } from "@/lib/prefs/types";

/**
 * Record the consent decision.
 *
 * "granted" mints an opaque ID and creates the identity row. "declined" sets
 * ONLY the consent cookie — no ID is minted, nothing is written server-side,
 * and any existing cookie is cleared so a previous "yes" is genuinely undone.
 */
export async function POST(request: Request) {
  let decision: unknown;
  try {
    decision = ((await request.json()) as { decision?: unknown }).decision;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (decision !== "granted" && decision !== "declined") {
    return NextResponse.json(
      { error: "decision must be 'granted' or 'declined'." },
      { status: 400 },
    );
  }

  const response = NextResponse.json({ ok: true, consent: decision });

  if (decision === "declined") {
    clearCookies(response);
    setConsentCookie(response, "declined");
    return response;
  }

  const store = await cookies();
  const existingRaw = store.get(PREF_COOKIE_NAME)?.value;
  let id: string | null = null;
  if (existingRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(existingRaw)) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.length >= 8) id = parsed.id;
    } catch {
      id = null;
    }
  }
  id ??= mintAnonId();

  await ensureIdentity(id);

  setPrefCookie(response, { id, country: APP.defaultCountry, consent: "granted", v: 1 });
  setConsentCookie(response, "granted");
  return response;
}

/** The reader's current state, used by the preferences page. */
export async function GET() {
  const store = await cookies();
  const consent = store.get(CONSENT_COOKIE_NAME)?.value ?? "unset";
  return NextResponse.json({ consent });
}
