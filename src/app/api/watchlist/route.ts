import { NextResponse } from "next/server";
import { readAnonId, readConsent, readCountry } from "@/lib/prefs/server";
import { mintAnonId, setPrefCookie } from "@/lib/prefs/cookie";
import { isOnWatchlist, toggleWatchlist, watchlistCount } from "@/lib/reviews/store";
import { isDbConfigured } from "@/lib/db/client";

/**
 * The watchlist. It does double duty: it is the reader's own list, and its
 * per-title count is the anticipation signal shown on unreleased films in place
 * of a rating widget they cannot honestly have.
 *
 * There are deliberately no reminders here — email or push would mean
 * collecting personal data, which this product avoids. The calendar download at
 * /api/calendar is the reminder mechanism, and it never leaves the device.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const subjectKey = url.searchParams.get("subject");
  if (!subjectKey) {
    return NextResponse.json({ error: "subject is required." }, { status: 400 });
  }

  const anonId = await readAnonId();
  const [on, count] = await Promise.all([
    isOnWatchlist(anonId, subjectKey),
    watchlistCount(subjectKey),
  ]);

  return NextResponse.json({ on, count });
}

export async function POST(request: Request) {
  const consent = await readConsent();
  if (consent !== "granted") {
    return NextResponse.json(
      {
        error:
          "A watchlist has to be stored somewhere. Turn on storage in Preferences and this will start saving.",
      },
      { status: 409 },
    );
  }

  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "The watchlist needs a database connection, which isn't set up yet." },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const subjectKey = typeof body.subjectKey === "string" ? body.subjectKey : "";
  if (!subjectKey) {
    return NextResponse.json({ error: "subjectKey is required." }, { status: 400 });
  }
  const subjectKind = body.subjectKind === "track" ? "track" : "film";

  let anonId = await readAnonId();
  let mintedId: string | null = null;
  if (!anonId) {
    mintedId = mintAnonId();
    anonId = mintedId;
  }

  const result = await toggleWatchlist({ anonId, subjectKey, subjectKind });
  if (!result.ok) {
    return NextResponse.json(
      { error: "We couldn't update your watchlist just now. Try again shortly." },
      { status: 503 },
    );
  }

  const count = await watchlistCount(subjectKey);
  const response = NextResponse.json({ ok: true, on: result.added, count });
  if (mintedId) {
    const country = await readCountry();
    setPrefCookie(response, { id: mintedId, country, consent: "granted", v: 1 });
  }
  return response;
}
