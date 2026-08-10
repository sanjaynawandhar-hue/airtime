"use client";

import { useRef, useState } from "react";

/**
 * Song search.
 *
 * A plain GET form, not a fetch-on-keystroke box. Two reasons, both deliberate:
 * the result is a real URL people can share and go back to, and it works before
 * (or without) JavaScript. The only client state here is the value, so the
 * clear button can reach it.
 */
export function SearchBox({
  initialQuery = "",
  country,
  autoFocus = false,
}: {
  readonly initialQuery?: string;
  readonly country?: string;
  readonly autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form action="/search" method="get" role="search" className="w-full max-w-xl">
      {/* Region rides along so a search made while browsing India keeps the
          Indian storefront, which is what decides whether the query returns
          the Hindi release or the US one. */}
      {country ? <input type="hidden" name="country" value={country} /> : null}

      <label htmlFor="song-search" className="eyebrow mb-1.5 block text-muted">
        Search any song — India or international
      </label>

      <div className="flex">
        <input
          ref={inputRef}
          id="song-search"
          type="search"
          name="q"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only on the
          // results page, where searching is the entire purpose of the screen.
          autoFocus={autoFocus}
          placeholder="Song, artist, or film soundtrack…"
          autoComplete="off"
          className="min-w-0 flex-1 border-2 border-ink-deep bg-surface px-3 py-2 text-sm text-paper outline-none placeholder:text-muted focus-visible:border-gold"
        />
        <button
          type="submit"
          className="raised ml-2 shrink-0 border-2 border-ink-deep bg-gold px-4 py-2 text-[13px] font-semibold text-ink"
        >
          Search
        </button>
      </div>
    </form>
  );
}
