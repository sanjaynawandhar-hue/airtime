import Link from "next/link";
import { APP } from "@/lib/core/config";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";
import { GENRES } from "@/lib/boards/music";
import { PODCAST_SHOWS } from "@/lib/core/config";
import { CommandPalette, type Command } from "./CommandPalette";

/**
 * The board's chrome. Two things live here that the design depends on: the
 * wordmark set in the wide display face, and the tick strip that separates
 * sections — see DESIGN.md.
 */

function buildCommands(country: string): readonly Command[] {
  const commands: Command[] = [
    { id: "home-music", label: "Trending music", group: "Go to", href: "/?mode=music" },
    { id: "home-cinema", label: "In cinemas now", group: "Go to", href: "/?mode=film&rail=theatrical" },
    { id: "home-ott", label: "On streaming", group: "Go to", href: "/?mode=film&rail=ott" },
    { id: "home-podcast", label: "Podcasts", group: "Go to", href: "/?mode=podcast" },
    { id: "coming", label: "Coming soon to cinemas", group: "Go to", href: "/coming-soon" },
    { id: "top-intl", label: "Top rated worldwide", group: "Go to", href: "/top-rated/international" },
    { id: "top-in", label: "Top rated Indian cinema", group: "Go to", href: "/top-rated/indian" },
    { id: "top-critics", label: "Best reviewed by critics", group: "Go to", href: "/top-rated/critics" },
    { id: "prefs", label: "Preferences and privacy", group: "Go to", href: "/preferences" },
    { id: "status", label: "Source status", group: "Go to", href: "/status" },
  ];

  for (const c of SUPPORTED_COUNTRIES) {
    commands.push({
      id: `country-${c.code}`,
      label: c.name,
      group: "Switch region",
      // A normal route, so the client router can actually follow it. The
      // previous target was an API redirect, which router.push cannot follow —
      // every region command silently did nothing.
      href: `/?country=${c.code}`,
      hint: c.code === country ? "current" : undefined,
    });
  }

  for (const show of PODCAST_SHOWS) {
    commands.push({
      id: `show-${show.id}`,
      label: show.name,
      group: "Podcast shows",
      href: `/?mode=podcast&show=${show.id}`,
    });
  }

  for (const g of GENRES) {
    commands.push({
      id: `genre-${g.slug}`,
      label: g.label,
      group: "Music by genre",
      href: `/?mode=music&genre=${encodeURIComponent(g.slug)}`,
    });
  }

  return commands;
}

export function Header({ country }: { readonly country: string }) {
  const countryName =
    SUPPORTED_COUNTRIES.find((c) => c.code === country)?.name ?? country;

  return (
    <header className="sticky top-0 z-40 border-b border-surface-hi bg-ink/95 backdrop-blur-none">
      <div className="flex items-center justify-between gap-4 px-[var(--board-gutter)] py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="display text-xl text-paper sm:text-2xl">Airtime</span>
          <span
            className="animate-live inline-block h-1.5 w-1.5 bg-flare"
            aria-hidden="true"
          />
          <span className="sr-only">— live charts</span>
        </Link>

        <div className="flex items-center gap-2">
          <CommandPalette commands={buildCommands(country)} />
          <Link
            href="/preferences"
            className="border border-surface-hi px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-gold hover:text-gold"
          >
            {countryName}
          </Link>
        </div>
      </div>
      <div className="tick-strip text-gold" aria-hidden="true" />
    </header>
  );
}

/** The top-level Music / Film switch. */
export function ModeToggle({
  mode,
  qs = "",
}: {
  readonly mode: "music" | "film" | "podcast";
  readonly qs?: string;
}) {
  return (
    <nav aria-label="Content type" className="px-[var(--board-gutter)] pt-5">
      <div className="inline-flex border border-surface-hi">
        {(["music", "film", "podcast"] as const).map((value) => (
          <Link
            key={value}
            href={`/?mode=${value}${qs}`}
            aria-current={mode === value ? "page" : undefined}
            className={`display px-5 py-2.5 text-sm transition-colors ${
              mode === value
                ? "bg-ink-deep text-ink"
                : "text-muted hover:text-paper"
            }`}
          >
            {value === "music" ? "Music" : value === "film" ? "Film" : "Podcast"}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/**
 * The theatrical / OTT switch. This is a structural split, not a filter: the
 * two rails are built by separate pipelines with separate ranking and separate
 * availability, and switching here swaps which pipeline's output you are
 * looking at.
 */
export function RailToggle({
  rail,
  qs = "",
}: {
  readonly rail: "theatrical" | "ott";
  readonly qs?: string;
}) {
  const options = [
    { value: "theatrical", label: "In cinemas", tone: "flare" },
    { value: "ott", label: "On streaming", tone: "cool" },
  ] as const;

  return (
    <nav aria-label="Where to watch" className="px-[var(--board-gutter)]">
      <div className="inline-flex gap-2">
        {options.map((option) => {
          const selected = rail === option.value;
          return (
            <Link
              key={option.value}
              href={`/?mode=film&rail=${option.value}${qs}`}
              aria-current={selected ? "page" : undefined}
              className={`display flex items-center gap-2 border px-4 py-2 text-[13px] transition-colors ${
                selected
                  ? option.tone === "flare"
                    ? "border-flare bg-flare text-ink"
                    : "border-cool bg-cool text-ink"
                  : "border-surface-hi text-muted hover:text-paper"
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-1.5 w-1.5 ${
                  selected
                    ? "bg-ink-deep"
                    : option.tone === "flare"
                      ? "bg-flare"
                      : "bg-cool"
                }`}
              />
              {option.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * `titleId` labels the enclosing section. The heading rendered here IS the
 * section's accessible name — sections must point `aria-labelledby` at this id
 * rather than adding their own visually-hidden copy, which was announcing every
 * rail title twice to screen readers.
 */
export function SectionHead({
  eyebrow,
  title,
  titleId,
  meta,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly titleId?: string;
  readonly meta?: React.ReactNode;
  readonly action?: { readonly label: string; readonly href: string };
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-[var(--board-gutter)] pb-2.5 pt-6 sm:pb-3 sm:pt-8">
      <div className="min-w-0">
        <p className="eyebrow mb-1.5 text-gold">{eyebrow}</p>
        <h2 id={titleId} className="display text-xl leading-[0.95] text-paper sm:text-2xl md:text-3xl">
          {title}
        </h2>
        {meta ? <div className="mt-1.5">{meta}</div> : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          className="eyebrow shrink-0 border border-surface-hi px-3 py-2 text-muted transition-colors hover:border-gold hover:text-gold"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function Footer() {
  return (
    // pb leaves room for the fixed consent bar so it never covers the footer links.
    <footer className="mt-16 border-t border-surface-hi px-[var(--board-gutter)] pb-32 pt-8">
      <div className="tick-strip-lg mb-6 text-surface-hi" aria-hidden="true" />
      <p className="display mb-2 text-lg text-paper">{APP.name}</p>
      <p className="mb-4 max-w-prose text-sm text-muted">{APP.tagline}</p>
      <p className="mb-4 max-w-prose text-[11px] leading-relaxed text-muted">
        Chart, rating and availability data comes from TMDB, OMDb, Apple, YouTube,
        Deezer and Last.fm. This product uses the TMDB API but is not endorsed or
        certified by TMDB. Ratings shown are the sources&rsquo; own; where a source
        has no value we say so rather than estimating one. Our leaderboards are
        Airtime&rsquo;s own rankings and are not IMDb&rsquo;s or Rotten
        Tomatoes&rsquo; lists.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12px]">
        <Link href="/preferences" className="text-muted hover:text-gold">
          Preferences &amp; privacy
        </Link>
        <Link href="/status" className="text-muted hover:text-gold">
          Source status
        </Link>
        <span className="text-muted">{APP.brand}</span>
      </div>
    </footer>
  );
}
