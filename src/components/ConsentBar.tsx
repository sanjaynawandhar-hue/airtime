"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsentState } from "@/lib/prefs/types";

/**
 * The consent step, which actually gates storage rather than decorating it.
 *
 * Declining is a real, supported state: nothing is written server-side, no
 * identity is minted, and every surface on the site keeps working — preferences
 * simply do not persist between visits. Both India's DPDP Act and GDPR apply to
 * this audience, and a banner whose "reject" button still stores things is
 * worse than no banner at all.
 */
export function ConsentBar({ consent }: { readonly consent: ConsentState }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (consent !== "unset" || dismissed) return null;

  async function choose(decision: "granted" | "declined") {
    setBusy(true);
    try {
      await fetch("/api/prefs/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      setDismissed(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Storage preferences"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-gold bg-ink-deep px-[var(--board-gutter)] py-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-[13px] leading-relaxed text-paper">
          <span className="eyebrow mr-2 text-gold">Before you browse</span>
          We can remember your region, languages, favourite genres, the services you
          subscribe to and your watchlist. It is stored in a first-party cookie
          holding a random ID — no name, no email, no third-party trackers. Say no
          and everything still works; it just won&rsquo;t be remembered next time.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => choose("declined")}
            className="border border-surface-hi px-4 py-2 text-[13px] text-muted transition-colors hover:border-paper hover:text-paper disabled:opacity-50"
          >
            No thanks
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => choose("granted")}
            className="border border-gold bg-gold px-4 py-2 text-[13px] font-semibold text-ink-deep transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            Remember me
          </button>
        </div>
      </div>
    </div>
  );
}
