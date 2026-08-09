/**
 * Constants that are safe in the client bundle.
 *
 * This file exists because `config.ts` is `server-only` — it holds the API
 * keys, and that guard is what makes it impossible to leak one into the
 * browser. A handful of plain constants (review length caps, the app name) are
 * genuinely needed by client components, so they live here instead of being
 * smuggled out of the module that holds secrets.
 *
 * Nothing secret may ever be added to this file.
 */

export const REVIEW_LIMITS = {
  maxBodyChars: 1500,
  minBodyChars: 3,
  /** Writes per anonymous ID per hour. */
  perIdPerHour: 10,
  /** Writes per IP per hour — catches one person cycling cookies. */
  perIpPerHour: 30,
} as const;

/**
 * Brand identity. Every place the handle or a social link appears reads from
 * here, so correcting one of these values updates the header, the footer, the
 * title pages and the page metadata at once.
 *
 * ⚠️ `instagramUrl` is DERIVED FROM THE HANDLE, not confirmed. Instagram
 * usernames are not guaranteed to match a display handle — `professorsk`,
 * `professor_sk` and `professorsk_` are all different accounts, and a public
 * product linking to the wrong one is worse than linking to none. Open the real
 * profile, copy the address bar, and paste it below.
 */
export const APP = {
  name: "Airtime",
  tagline: "What the world is playing, right now.",
  brand: "@professorSK",
  handle: "professorSK",
  instagramUrl: "https://www.instagram.com/professorsk/",
  defaultCountry: "IN",
} as const;
