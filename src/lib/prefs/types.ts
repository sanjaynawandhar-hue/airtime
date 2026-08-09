/**
 * Preferences, split deliberately across two stores.
 *
 * COOKIE (small, first-party, no third-party trackers):
 *   the opaque ID + the few display values needed to render the first paint
 *   without a database round-trip. Country and consent, essentially.
 *
 * SERVER (keyed to the same ID):
 *   the heavier lists — languages, genres, subscribed services, likes,
 *   watchlist. These do not need to be in the cookie and keeping them out of it
 *   keeps every request smaller.
 *
 * CONSENT actually gates storage. Both India's DPDP Act and GDPR apply given
 * the audience, and "consent" that does nothing is worse than no banner. If the
 * user declines, the only cookie we set is the essential one recording that
 * they declined; nothing is written server-side and preferences simply do not
 * persist. Every surface must work in that state.
 */

export type ConsentState = "granted" | "declined" | "unset";

/** The cookie payload. Keep this small — it rides on every request. */
export interface PrefCookie {
  /** Opaque random ID. Not derived from anything about the user. */
  readonly id: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly consent: ConsentState;
  /** Schema version, so a future shape change can be migrated not dropped. */
  readonly v: 1;
}

/** The server-side record. */
export interface ServerPrefs {
  readonly country: string;
  readonly languages: readonly string[];
  readonly genres: readonly string[];
  /** PlatformIds the user subscribes to. Drives deep-link ordering. */
  readonly services: readonly string[];
}

export const EMPTY_SERVER_PREFS: ServerPrefs = {
  country: "IN",
  languages: [],
  genres: [],
  services: [],
};

export const PREF_COOKIE_NAME = "at_prefs";
export const CONSENT_COOKIE_NAME = "at_consent";

/** Countries we ship region switching for. */
export const SUPPORTED_COUNTRIES = [
  { code: "IN", name: "India", storefront: "in" },
  { code: "US", name: "United States", storefront: "us" },
  { code: "GB", name: "United Kingdom", storefront: "gb" },
  { code: "AE", name: "United Arab Emirates", storefront: "ae" },
  { code: "AU", name: "Australia", storefront: "au" },
  { code: "CA", name: "Canada", storefront: "ca" },
  { code: "DE", name: "Germany", storefront: "de" },
  { code: "BR", name: "Brazil", storefront: "br" },
] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number]["code"];

export function isSupportedCountry(code: string): code is SupportedCountry {
  return SUPPORTED_COUNTRIES.some((c) => c.code === code);
}
