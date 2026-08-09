"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Jump between region, genre, rail and platform without touching a menu.
 *
 * Everything the palette does is a navigation, so the commands are built from
 * the same route shapes the menus use — there is no second source of truth for
 * "what pages exist".
 */

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly href: string;
  readonly hint?: string;
}

export function CommandPalette({ commands }: { readonly commands: readonly Command[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  /**
   * Group headings are decided here rather than by mutating a variable while
   * mapping — the render pass has to stay pure for the React Compiler.
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? commands.filter(
          (c) =>
            c.label.toLowerCase().includes(q) ||
            c.group.toLowerCase().includes(q) ||
            (c.hint?.toLowerCase().includes(q) ?? false),
        )
      : commands;

    return matched
      .slice(0, 40)
      .map((command, index, list) => ({
        command,
        startsGroup: index === 0 || list[index - 1].group !== command.group,
      }));
  }, [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  /**
   * Navigate FIRST, then close.
   *
   * The other order looks harmless and silently loses the navigation: `close()`
   * unmounts the dialog, and the `router.push` queued behind that state update
   * never lands. Clicking a result worked, pressing Enter did not — the palette
   * closed and nothing happened, which is the worst kind of bug because it looks
   * like the app simply ignored you.
   */
  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      router.push(command.href);
      close();
    },
    [close, router],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // "/" opens it too, unless the user is already typing somewhere.
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 border border-surface-hi px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-gold hover:text-gold"
      >
        <span>Jump to…</span>
        <kbd className="hidden border border-surface-hi px-1 py-0.5 text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-deep/85 px-4 pt-[12vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-lg border border-surface-hi bg-ink shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // Reset the highlight here rather than in an effect on `query` —
            // the new query and the new selection are one user action.
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(results[active]?.command);
            }
          }}
          placeholder="Region, genre, platform, board…"
          aria-label="Search destinations"
          aria-activedescendant={results[active] ? `cmd-${results[active].command.id}` : undefined}
          className="w-full border-b border-surface-hi bg-transparent px-4 py-3.5 text-sm text-paper outline-none placeholder:text-muted"
        />

        {results.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            Nothing matches “{query}”. Try a country, a genre, or a platform name.
          </p>
        ) : (
          <ul ref={listRef} className="max-h-[52vh] overflow-y-auto py-1" role="listbox">
            {results.map(({ command, startsGroup }, index) => {
              return (
                <li key={command.id} id={`cmd-${command.id}`} role="option" aria-selected={index === active}>
                  {startsGroup ? (
                    <p className="eyebrow px-4 pb-1 pt-3 text-muted">{command.group}</p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(command)}
                    className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                      index === active ? "bg-surface text-gold" : "text-paper"
                    }`}
                  >
                    <span>{command.label}</span>
                    {command.hint ? (
                      <span className="text-[11px] text-muted">{command.hint}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="border-t border-surface-hi px-4 py-2 text-[11px] text-muted">
          ↑↓ to move · Enter to go · Esc to close
        </p>
      </div>
    </div>
  );
}
