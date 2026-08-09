import { NextResponse } from "next/server";
import { readAnonId, readConsent } from "@/lib/prefs/server";
import { clientIp, mintAnonId, setPrefCookie } from "@/lib/prefs/cookie";
import { validateReview } from "@/lib/reviews/sanitise";
import {
  checkRateLimit,
  communityScore,
  deleteReview,
  listReviews,
  upsertReview,
} from "@/lib/reviews/store";
import { isDbConfigured } from "@/lib/db/client";
import { readCountry } from "@/lib/prefs/server";

/**
 * Anonymous reviews. No account, no email, no personal data collected — the
 * only thing keying a review to a person is the opaque ID in their own cookie.
 *
 * Writing requires consent, because writing means storing. Reading never does.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const subjectKey = url.searchParams.get("subject");
  if (!subjectKey) {
    return NextResponse.json({ error: "subject is required." }, { status: 400 });
  }

  if (!isDbConfigured()) {
    return NextResponse.json(
      {
        reviews: [],
        score: { average: { status: "unavailable", reason: "not_configured" }, count: { status: "unavailable", reason: "not_configured" } },
        note: "Reader reviews need a database connection.",
      },
      { status: 200 },
    );
  }

  const anonId = await readAnonId();
  const [reviews, score] = await Promise.all([
    listReviews(subjectKey, anonId),
    communityScore(subjectKey),
  ]);

  if (reviews === null) {
    return NextResponse.json(
      { error: "We couldn't load reviews just now. The rest of the page is unaffected." },
      { status: 503 },
    );
  }

  return NextResponse.json({ reviews, score, note: null });
}

export async function POST(request: Request) {
  const consent = await readConsent();
  if (consent !== "granted") {
    return NextResponse.json(
      {
        error:
          "Posting a review means storing it against an ID in your browser. Turn that on in Preferences and your review will save.",
      },
      { status: 409 },
    );
  }

  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Reviews need a database connection, which isn't set up yet." },
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
  const subjectTitle = typeof body.subjectTitle === "string" ? body.subjectTitle : "";
  const subjectKind = body.subjectKind === "track" ? "track" : "film";

  if (!subjectKey || !subjectTitle) {
    return NextResponse.json(
      { error: "subjectKey and subjectTitle are required." },
      { status: 400 },
    );
  }

  const validated = validateReview({ body: body.body, score: body.score });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: 400 });
  }

  // A reader who granted consent but has no cookie yet (cleared it, new device)
  // gets an ID minted here so their first review is not lost.
  let anonId = await readAnonId();
  let mintedId: string | null = null;
  if (!anonId) {
    mintedId = mintAnonId();
    anonId = mintedId;
  }

  const ip = clientIp(request);
  const limit = await checkRateLimit(anonId, ip);
  if (!limit.allowed) {
    return NextResponse.json({ error: limit.message }, { status: 429 });
  }

  const result = await upsertReview({
    anonId,
    ip,
    subjectKind,
    subjectKey,
    subjectTitle,
    score: validated.score,
    body: validated.body,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true });
  if (mintedId) {
    const country = await readCountry();
    setPrefCookie(response, { id: mintedId, country, consent: "granted", v: 1 });
  }
  return response;
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const subjectKey = url.searchParams.get("subject");
  if (!subjectKey) {
    return NextResponse.json({ error: "subject is required." }, { status: 400 });
  }

  const anonId = await readAnonId();
  if (!anonId) {
    return NextResponse.json({ error: "Nothing to delete." }, { status: 404 });
  }

  const removed = await deleteReview(anonId, subjectKey);
  if (!removed) {
    return NextResponse.json(
      { error: "We couldn't delete that just now. Try again shortly." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
