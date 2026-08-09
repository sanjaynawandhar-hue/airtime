import Link from "next/link";

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-[var(--board-gutter)]"
    >
      <div className="tick-strip mb-6 text-gold" aria-hidden="true" />
      <p className="eyebrow mb-2 text-gold">Nothing here</p>
      <h1 className="display mb-4 text-4xl text-paper">Off the board</h1>
      <p className="mb-6 max-w-prose text-[15px] leading-relaxed text-muted">
        That page doesn&rsquo;t exist. If you followed a link to a title, it may
        have been a TMDB id we don&rsquo;t have anything for — charts move and
        entries get merged.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/"
          className="border border-gold bg-gold px-4 py-2.5 text-[13px] font-semibold text-ink-deep transition-opacity hover:opacity-85"
        >
          Back to the board
        </Link>
        <Link
          href="/status"
          className="border border-surface-hi px-4 py-2.5 text-[13px] text-paper transition-colors hover:border-gold hover:text-gold"
        >
          Check source status
        </Link>
      </div>
    </main>
  );
}
