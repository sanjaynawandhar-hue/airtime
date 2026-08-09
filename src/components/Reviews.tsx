"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { REVIEW_LIMITS } from "@/lib/core/public";

/**
 * Reader reviews. Written and read without an account.
 *
 * The initial list and score are RENDERED ON THE SERVER and passed in as props,
 * so reviews are in the HTML on first paint rather than arriving after a
 * client-side fetch. After a write we call `router.refresh()`, which re-runs the
 * server component and streams the updated list back — no effect, no loading
 * flash, no second source of truth.
 *
 * The community score here is always labelled as ours and never blended into
 * the critic numbers above it — averaging a handful of reader votes into IMDb's
 * would misrepresent both.
 */

export interface ReviewView {
  readonly id: string;
  readonly score: number | null;
  readonly body: string;
  readonly updatedAt: string;
  readonly mine: boolean;
}

export function Reviews({
  subjectKey,
  subjectKind,
  subjectTitle,
  consentGranted,
  initialReviews,
  averageScore,
  ratingCount,
  unavailableNote,
}: {
  readonly subjectKey: string;
  readonly subjectKind: "film" | "track";
  readonly subjectTitle: string;
  readonly consentGranted: boolean;
  readonly initialReviews: readonly ReviewView[];
  readonly averageScore: number | null;
  readonly ratingCount: number | null;
  /** Set when the store itself was unreachable, as opposed to simply empty. */
  readonly unavailableNote: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const mine = initialReviews.find((r) => r.mine);
  const others = initialReviews.filter((r) => !r.mine);

  const [score, setScore] = useState<number | null>(mine?.score ?? null);
  const [body, setBody] = useState(mine?.body ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const busy = submitting || pending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectKey, subjectKind, subjectTitle, score, body }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setFormError(data.error ?? "That didn't save.");
        return;
      }
      setSaved(true);
      startTransition(() => router.refresh());
    } catch {
      setFormError("You appear to be offline — that didn't save.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(
        `/api/reviews?subject=${encodeURIComponent(subjectKey)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setFormError(data.error ?? "That didn't delete.");
        return;
      }
      setScore(null);
      setBody("");
      setSaved(false);
      startTransition(() => router.refresh());
    } catch {
      setFormError("You appear to be offline — that didn't delete.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="reader-reviews" className="mt-12">
      <p className="eyebrow mb-1.5 text-cool">Airtime readers</p>
      <h2 id="reader-reviews" className="display mb-1 text-2xl text-paper">
        Reader reviews
      </h2>

      <p className="mb-5 max-w-prose text-[12px] leading-relaxed text-muted">
        This score is ours alone — an average of ratings left by people on this
        site. It is never mixed into the IMDb or Rotten Tomatoes numbers above.
      </p>

      {/* our score */}
      <div className="mb-6 flex items-baseline gap-3">
        {averageScore !== null && ratingCount !== null && ratingCount > 0 ? (
          <>
            <span className="display text-4xl text-cool">{averageScore.toFixed(1)}</span>
            <span className="text-sm text-muted">
              /10 from {ratingCount} {ratingCount === 1 ? "reader" : "readers"}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted">
            {unavailableNote ?? "No reader ratings yet. Yours would be the first."}
          </span>
        )}
      </div>

      {/* write */}
      {consentGranted ? (
        <form onSubmit={submit} className="mb-8 border border-surface-hi bg-surface p-4">
          <fieldset className="mb-3">
            <legend className="eyebrow mb-2 text-muted">Your rating (optional)</legend>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScore(score === n ? null : n)}
                  aria-pressed={score === n}
                  className={`h-9 w-9 border text-[13px] transition-colors ${
                    score === n
                      ? "border-cool bg-cool text-ink"
                      : "border-surface-hi text-muted hover:border-cool hover:text-cool"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="review-body" className="eyebrow mb-2 block text-muted">
            Your review (optional)
          </label>
          <textarea
            id="review-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={REVIEW_LIMITS.maxBodyChars}
            rows={4}
            placeholder="What did you make of it?"
            className="w-full resize-y border border-surface-hi bg-ink px-3 py-2 text-sm text-paper outline-none placeholder:text-muted focus-visible:border-cool"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[11px] text-muted">
              {body.length}/{REVIEW_LIMITS.maxBodyChars} · no account, no email
            </span>
            <div className="flex gap-2">
              {mine ? (
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="border border-surface-hi px-3 py-2 text-[13px] text-muted transition-colors hover:border-flare hover:text-flare disabled:opacity-50"
                >
                  Delete mine
                </button>
              ) : null}
              <button
                type="submit"
                disabled={busy}
                className="border border-cool bg-cool px-4 py-2 text-[13px] font-semibold text-ink transition-opacity hover:opacity-85 disabled:opacity-50"
              >
                {mine ? "Update" : "Post"}
              </button>
            </div>
          </div>
          {formError ? (
            <p role="alert" className="mt-2 text-[12px] text-flare">
              {formError}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="mt-2 text-[12px] text-cool">
              Saved. You can edit or delete it any time from this device.
            </p>
          ) : null}
        </form>
      ) : (
        <div className="mb-8 border border-surface-hi bg-surface p-4">
          <p className="max-w-prose text-sm leading-relaxed text-muted">
            Posting a review means storing it against a random ID in your browser.
            You haven&rsquo;t opted into storage, so the form is off — reading
            reviews works either way.{" "}
            <a href="/preferences" className="text-gold underline">
              Change that in Preferences
            </a>
            .
          </p>
        </div>
      )}

      {/* read */}
      {initialReviews.length === 0 ? (
        <p className="text-sm text-muted">
          {unavailableNote ?? "Nobody has written about this yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {[...(mine ? [mine] : []), ...others].map((review) => (
            <li
              key={review.id}
              className={`border p-4 ${
                review.mine ? "border-cool/50 bg-surface" : "border-surface-hi bg-surface"
              }`}
            >
              <div className="mb-2 flex items-center gap-3">
                {review.score !== null ? (
                  <span className="display-tight text-lg text-cool">{review.score}/10</span>
                ) : (
                  <span className="text-[11px] text-muted">No rating given</span>
                )}
                {review.mine ? <span className="eyebrow text-gold">Yours</span> : null}
                <span className="text-[11px] text-muted">
                  {new Date(review.updatedAt).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
              {review.body ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-paper">
                  {review.body}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
