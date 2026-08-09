"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsentState, ServerPrefs } from "@/lib/prefs/types";

/**
 * Preferences, including the two controls that have to actually work: the
 * consent switch, which really gates storage, and "reset everything", which
 * really clears both the cookie and the server-side record.
 */

interface Option {
  readonly value: string;
  readonly label: string;
}

export function PreferencesForm({
  initial,
  consent,
  countries,
  languages,
  genres,
  services,
}: {
  readonly initial: ServerPrefs;
  readonly consent: ConsentState;
  readonly countries: readonly Option[];
  readonly languages: readonly Option[];
  readonly genres: readonly Option[];
  readonly services: readonly Option[];
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<ServerPrefs>(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const granted = consent === "granted";

  function toggle(key: "languages" | "genres" | "services", value: string) {
    setPrefs((current) => {
      const list = current[key];
      return {
        ...current,
        [key]: list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value],
      };
    });
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const response = await fetch("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prefs),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "That didn't save.");
        return;
      }
      setStatus("Saved.");
      router.refresh();
    } catch {
      setError("You appear to be offline — that didn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function setConsent(decision: "granted" | "declined") {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await fetch("/api/prefs/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const response = await fetch("/api/prefs", { method: "DELETE" });
      const data = (await response.json()) as { detail?: string; serverCleared?: boolean };
      setPrefs({ country: "IN", languages: [], genres: [], services: [] });
      if (data.serverCleared === false) {
        setError(data.detail ?? "Cookies cleared, but the server copy is still pending.");
      } else {
        setStatus(data.detail ?? "Everything cleared.");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      {/* ---------------- consent ---------------- */}
      <section aria-labelledby="storage">
        <h2 id="storage" className="display mb-2 text-xl text-paper">
          Storage
        </h2>
        <p className="mb-4 max-w-prose text-sm leading-relaxed text-muted">
          We store a random ID in a first-party cookie and hang your region,
          languages, genres, services, watchlist and reviews off it. No name, no
          email, no third-party trackers, no advertising identifiers. If you turn
          this off, everything on the site still works — it just isn&rsquo;t
          remembered.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`eyebrow border px-3 py-2 ${
              granted ? "border-cool text-cool" : "border-surface-hi text-muted"
            }`}
          >
            {granted ? "On" : consent === "declined" ? "Off" : "Not chosen yet"}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConsent(granted ? "declined" : "granted")}
            className="border border-surface-hi px-4 py-2 text-[13px] text-paper transition-colors hover:border-gold hover:text-gold disabled:opacity-50"
          >
            {granted ? "Turn storage off" : "Turn storage on"}
          </button>
        </div>
      </section>

      {/* ---------------- region ---------------- */}
      <section aria-labelledby="region">
        <h2 id="region" className="display mb-2 text-xl text-paper">
          Region
        </h2>
        <p className="mb-3 max-w-prose text-sm text-muted">
          Sets which country&rsquo;s cinema listings, streaming availability,
          release dates and certifications you see.
        </p>
        <select
          value={prefs.country}
          onChange={(event) => setPrefs({ ...prefs, country: event.target.value })}
          aria-label="Country"
          className="border border-surface-hi bg-ink px-3 py-2.5 text-sm text-paper"
        >
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </section>

      {/* ---------------- services ---------------- */}
      <section aria-labelledby="services">
        <h2 id="services" className="display mb-2 text-xl text-paper">
          Your streaming services
        </h2>
        <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted">
          Mark what you already pay for. Every card then puts the service you can
          actually watch on first, and anything you&rsquo;d have to rent or buy
          again is pushed down — never hidden, just demoted, so you can still see
          the real offer.
        </p>
        <ChipGroup
          options={services}
          selected={prefs.services}
          onToggle={(v) => toggle("services", v)}
          tone="cool"
        />
      </section>

      {/* ---------------- languages ---------------- */}
      <section aria-labelledby="languages">
        <h2 id="languages" className="display mb-2 text-xl text-paper">
          Languages
        </h2>
        <ChipGroup
          options={languages}
          selected={prefs.languages}
          onToggle={(v) => toggle("languages", v)}
          tone="gold"
        />
      </section>

      {/* ---------------- genres ---------------- */}
      <section aria-labelledby="genres">
        <h2 id="genres" className="display mb-2 text-xl text-paper">
          Favourite genres
        </h2>
        <ChipGroup
          options={genres}
          selected={prefs.genres}
          onToggle={(v) => toggle("genres", v)}
          tone="gold"
        />
      </section>

      {/* ---------------- save ---------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !granted}
          className="border border-gold bg-gold px-5 py-2.5 text-[13px] font-semibold text-ink transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          Save preferences
        </button>
        {!granted ? (
          <p className="max-w-prose text-[12px] text-muted">
            Saving is off because storage is off. Turn it on above and this button
            becomes available.
          </p>
        ) : null}
        {status ? (
          <p role="status" className="text-[13px] text-cool">
            {status}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-flare">
            {error}
          </p>
        ) : null}
      </div>

      {/* ---------------- reset ---------------- */}
      <section aria-labelledby="reset" className="border border-flare/40 p-4">
        <h2 id="reset" className="display mb-2 text-xl text-paper">
          Reset everything
        </h2>
        <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted">
          Deletes both sides for real: the cookies in this browser, and the
          server-side record keyed to your ID — which takes your preferences,
          watchlist, likes and reviews with it. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="border border-flare px-4 py-2.5 text-[13px] font-semibold text-flare transition-colors hover:bg-flare hover:text-ink disabled:opacity-50"
        >
          Delete everything stored about me
        </button>
      </section>
    </div>
  );
}

function ChipGroup({
  options,
  selected,
  onToggle,
  tone,
}: {
  readonly options: readonly Option[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly tone: "gold" | "cool";
}) {
  return (
    <ul className="flex flex-wrap gap-2">
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <li key={option.value}>
            <button
              type="button"
              onClick={() => onToggle(option.value)}
              aria-pressed={on}
              className={`border px-3 py-1.5 text-[13px] transition-colors ${
                on
                  ? tone === "cool"
                    ? "border-cool bg-cool text-ink"
                    : "border-gold bg-gold text-ink"
                  : "border-surface-hi text-muted hover:text-paper"
              }`}
            >
              {option.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
