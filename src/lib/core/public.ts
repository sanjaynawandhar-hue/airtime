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

export const APP = {
  name: "Airtime",
  tagline: "What the world is playing, right now.",
  brand: "@professorSK",
  defaultCountry: "IN",
} as const;
