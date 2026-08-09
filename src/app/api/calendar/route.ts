import { isOk } from "@/lib/core/maybe";
import { fetchTitleDetails } from "@/lib/providers/tmdb";
import { readCountry } from "@/lib/prefs/server";
import { APP } from "@/lib/core/config";

/**
 * Release-date calendar download (.ics).
 *
 * This is the reminder mechanism for Coming Soon, chosen precisely because it
 * collects nothing: the file is generated, downloaded, and lives in the
 * reader's own calendar. No email, no push token, no device registration —
 * nothing that would turn an anonymous product into one holding personal data.
 *
 * The date written is the country-specific theatrical date TMDB currently
 * lists. Because those dates move, the description carries the timestamp we
 * read it at, so a reader whose calendar entry is stale can see how old it is.
 */

/** RFC 5545 escaping: backslash, semicolon, comma, newline. */
function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 recommends folding lines at 75 octets. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

const stampUtc = (date: Date): string =>
  `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const idParam = url.searchParams.get("tmdbId");
  const tmdbId = Number(idParam);

  if (!idParam || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return new Response("A valid tmdbId is required.", { status: 400 });
  }

  const country = await readCountry();
  const details = await fetchTitleDetails(tmdbId, country);

  if (!details) {
    return new Response(
      "We couldn't load that title from TMDB, so there's no date to add.",
      { status: 404 },
    );
  }

  const release = details.localReleaseDate;
  if (!isOk(release)) {
    return new Response(
      `No release date is listed for "${details.title}" in your country yet, so there's nothing to add to a calendar.`,
      { status: 409 },
    );
  }

  // All-day event: DTSTART;VALUE=DATE with DTEND on the following day.
  const start = new Date(`${release.value}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    return new Response("The listed release date isn't a date we can parse.", {
      status: 409,
    });
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const dateOnly = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

  const checkedAt = new Date(details.provenance.fetchedAt);
  const description =
    `${details.title} releases in cinemas${isOk(details.certification) ? ` (${details.certification.value})` : ""}. ` +
    `Date as listed by TMDB for ${country}, checked ${checkedAt.toUTCString()}. ` +
    `Release dates change often — check before you book. Added from ${APP.name} (${APP.brand}).`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${APP.name}//Release dates//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:airtime-tmdb-${tmdbId}-${country}@airtime`,
    `DTSTAMP:${stampUtc(new Date())}`,
    `DTSTART;VALUE=DATE:${dateOnly(start)}`,
    `DTEND;VALUE=DATE:${dateOnly(end)}`,
    fold(`SUMMARY:${escapeIcs(`${details.title} — in cinemas`)}`),
    fold(`DESCRIPTION:${escapeIcs(description)}`),
    fold(`URL:${escapeIcs(details.provenance.sourceUrl)}`),
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const slug = details.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${slug || "release"}.ics"`,
      "cache-control": "no-store",
    },
  });
}
