import { APP } from "@/lib/core/public";

/**
 * The @professorSK credit, as a real link.
 *
 * One component so the handle and its destination cannot drift apart across
 * the header, the footer and the title pages — both come from APP in
 * lib/core/public.ts.
 */

function InstagramGlyph({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function InstagramLink({
  className = "",
  showHandle = true,
  size = 14,
}: {
  readonly className?: string;
  readonly showHandle?: boolean;
  readonly size?: number;
}) {
  return (
    <a
      href={APP.instagramUrl}
      target="_blank"
      rel="me noopener noreferrer"
      className={`inline-flex items-center gap-1.5 transition-colors hover:text-flare ${className}`}
    >
      <InstagramGlyph size={size} />
      {showHandle ? <span>{APP.brand}</span> : null}
      <span className="sr-only">
        {APP.brand} on Instagram, @{APP.instagramHandle} (opens in a new tab)
      </span>
    </a>
  );
}

/**
 * "Made by" credit for the footer — the same link with a little more context,
 * so the product reads as belonging to someone rather than being anonymous.
 */
export function BrandCredit({ className = "" }: { readonly className?: string }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted ${className}`}>
      <span>Built by</span>
      <InstagramLink className="font-semibold text-paper" />
    </p>
  );
}
