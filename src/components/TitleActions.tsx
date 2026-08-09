"use client";

import { useState } from "react";

/**
 * Watchlist toggle, calendar download and share-card export.
 *
 * All three are deliberately small: the watchlist is a single row in Postgres,
 * the calendar is a generated file that never leaves the device, and the share
 * card is a server-rendered PNG. None of them collects anything.
 */

export function WatchlistButton({
  subjectKey,
  subjectKind = "film",
  initialOn,
  label = "Watchlist",
}: {
  readonly subjectKey: string;
  readonly subjectKind?: "film" | "track";
  readonly initialOn: boolean;
  readonly label?: string;
}) {
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectKey, subjectKind }),
      });
      const data = (await response.json()) as { on?: boolean; error?: string };
      if (!response.ok) {
        setError(data.error ?? "That didn't save. Try again shortly.");
        return;
      }
      setOn(data.on === true);
    } catch {
      setError("You appear to be offline — that didn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={on}
        className={`flex items-center gap-2 border px-4 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-50 ${
          on
            ? "border-gold bg-gold text-ink"
            : "border-surface-hi text-paper hover:border-gold hover:text-gold"
        }`}
      >
        <span aria-hidden="true">{on ? "✓" : "+"}</span>
        {on ? `On your ${label.toLowerCase()}` : label}
      </button>
      {error ? (
        <p role="status" className="max-w-xs text-[11px] leading-tight text-flare">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CalendarButton({ tmdbId }: { readonly tmdbId: number }) {
  return (
    <a
      href={`/api/calendar?tmdbId=${tmdbId}`}
      download
      className="flex items-center gap-2 border border-surface-hi px-4 py-2.5 text-[13px] font-semibold text-paper transition-colors hover:border-gold hover:text-gold"
    >
      Add release date to calendar
    </a>
  );
}

export function ShareCardButton({
  tmdbId,
  title,
}: {
  readonly tmdbId: number;
  readonly title: string;
}) {
  return (
    <a
      href={`/api/share?tmdbId=${tmdbId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 border border-surface-hi px-4 py-2.5 text-[13px] font-semibold text-paper transition-colors hover:border-gold hover:text-gold"
    >
      Share card (9:16)
      <span className="sr-only">for {title}, opens in a new tab</span>
    </a>
  );
}
