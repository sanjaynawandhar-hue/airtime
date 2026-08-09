import { APP } from "@/lib/core/public";
import { isSupportedCountry } from "./types";

/**
 * Region resolution.
 *
 * Region is a URL parameter first and a stored preference second, and that
 * ordering is deliberate for two reasons:
 *
 * 1. It works for a reader who declined storage. Consent gates *storage*, so a
 *    region held in a cookie is unavailable to them — but `?country=US` needs
 *    no storage at all, so switching region keeps working exactly as it does
 *    for everyone else. "Everything must work if you decline" has to mean this
 *    too, not just that pages still render.
 *
 * 2. It is navigable. The command palette pushes a normal route, which the
 *    client router can actually follow. The previous design pointed it at a
 *    route handler that returned a redirect; `router.push` cannot follow that,
 *    so every region command silently did nothing.
 *
 * The stored preference still wins over the default, so a reader who opted into
 * storage and picked a region on the Preferences page keeps it without a
 * parameter on every link.
 */
export function resolveCountry(
  param: string | undefined,
  storedCountry: string | undefined,
): string {
  if (param && isSupportedCountry(param)) return param;
  if (storedCountry && isSupportedCountry(storedCountry)) return storedCountry;
  return APP.defaultCountry;
}

/**
 * True when the active region came from the URL and differs from what we have
 * stored — the UI uses this to offer "keep this region" rather than silently
 * losing the choice on the next visit.
 */
export function isTransientCountry(
  param: string | undefined,
  storedCountry: string | undefined,
): boolean {
  return Boolean(param && isSupportedCountry(param) && param !== storedCountry);
}
