import "server-only";
import { randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import {
  CONSENT_COOKIE_NAME,
  PREF_COOKIE_NAME,
  type ConsentState,
  type PrefCookie,
} from "./types";

/**
 * Cookie writing. Route handlers only — pages never set cookies.
 *
 * The ID is 128 bits of randomness and is not derived from anything about the
 * user: not the IP, not the user agent, not a hash of any of it. It exists to
 * key their own reviews and watchlist back to them, and nothing else.
 */

const ONE_YEAR = 60 * 60 * 24 * 365;

export function mintAnonId(): string {
  return randomBytes(16).toString("base64url");
}

const baseOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export function setPrefCookie(response: NextResponse, cookie: PrefCookie): void {
  response.cookies.set({
    ...baseOptions,
    name: PREF_COOKIE_NAME,
    value: encodeURIComponent(JSON.stringify(cookie)),
    maxAge: ONE_YEAR,
  });
}

/**
 * The consent cookie is the one thing we set for a user who declined, because
 * remembering "they said no" is what stops us asking on every page — and that
 * is the essential-storage exemption both regimes allow.
 */
export function setConsentCookie(response: NextResponse, consent: ConsentState): void {
  response.cookies.set({
    ...baseOptions,
    name: CONSENT_COOKIE_NAME,
    value: consent,
    maxAge: ONE_YEAR,
  });
}

/** Clear both cookies. Paired with purgeIdentity so "reset" clears both sides. */
export function clearCookies(response: NextResponse): void {
  response.cookies.set({ ...baseOptions, name: PREF_COOKIE_NAME, value: "", maxAge: 0 });
  response.cookies.set({ ...baseOptions, name: CONSENT_COOKIE_NAME, value: "", maxAge: 0 });
}

/**
 * The client IP, for rate limiting only. Never stored raw — see
 * lib/reviews/store.ts, which hashes it with a salt before it touches the
 * database.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
