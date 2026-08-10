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
 * here, so one edit updates the header, the footer and the page metadata.
 *
 * THE DISPLAY NAME AND THE ACCOUNT NAME ARE DIFFERENT ON PURPOSE.
 *
 *   brand           "@professorSK"        the nickname readers see
 *   instagramHandle "iam_sanjay_navandar" the actual Instagram account
 *
 * They are not a mismatch to be tidied up. `brand` is presentation; the handle
 * and URL are an identity claim that has to point at the real account, which is
 * why `instagram:creator` and `rel="me"` use the handle rather than the
 * nickname — crediting the wrong account is worse than crediting none.
 *
 * The URL is stored canonically, without the `igsh` and `utm_source=qr`
 * parameters Instagram's share sheet appends. Those identify a share session,
 * not the profile, and baking them into every page would send that token to
 * Instagram on every click.
 */
export const APP = {
  name: "Airtime",
  tagline: "What the world is playing, right now.",
  brand: "@professorSK",
  instagramHandle: "iam_sanjay_navandar",
  instagramUrl: "https://www.instagram.com/iam_sanjay_navandar",
  defaultCountry: "IN",
} as const;
