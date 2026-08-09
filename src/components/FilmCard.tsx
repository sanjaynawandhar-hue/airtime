import Image from "next/image";
import Link from "next/link";
import { isOk } from "@/lib/core/maybe";
import type { AvailabilityContext, FilmRecord } from "@/lib/core/types";
import { MovementBar } from "./MovementBar";
import { DivergenceBadge } from "./Score";
import { OFFER_LABEL, isExtraCost, orderLinks } from "@/lib/prefs/ordering";

/**
 * A film on the board.
 *
 * The availability line is the load-bearing part of this component. A card
 * built for the theatrical rail states it is in cinemas; a card built for the
 * OTT rail states which service and on what terms. A card NEVER infers one from
 * the other — `record.availability` is the context the pipeline that produced
 * this record attached, and if it is null the card says availability is
 * unconfirmed rather than guessing. Showing a film as streamable while it is
 * still theatrical-only is the error that breaks trust fastest.
 */

function AvailabilityLine({
  availability,
  services,
}: {
  readonly availability: AvailabilityContext | null;
  readonly services: readonly string[];
}) {
  if (!availability) {
    return (
      <p className="text-[11px] leading-tight text-muted">
        Where to watch: not confirmed
      </p>
    );
  }

  if (availability.kind === "theatrical") {
    const cert = availability.certification;

    // A past theatrical release is not a current one. Same data, honest claim.
    if (!availability.currentlyRunning) {
      return (
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-tight text-muted">
          Had a cinema release
          {isOk(cert) ? <span>· {cert.value}</span> : null}
        </p>
      );
    }

    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-tight text-flare">
        <span className="inline-block h-1.5 w-1.5 bg-flare" aria-hidden="true" />
        In cinemas
        {availability.releaseType.status === "ok" &&
        availability.releaseType.value === "theatrical_limited" ? (
          <span className="text-muted">· limited release</span>
        ) : null}
        {isOk(cert) ? <span className="text-muted">· {cert.value}</span> : null}
      </p>
    );
  }

  const ordered = orderLinks(availability.offers, services);
  const best = ordered[0];

  if (!best) {
    // Should not reach the OTT rail at all without an offer, but if a record
    // arrives with an empty offer list we say so rather than implying access.
    return (
      <p className="text-[11px] leading-tight text-muted">
        No streaming offer in your country
      </p>
    );
  }

  const extra = isExtraCost(best, services);

  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-tight text-cool">
      <span className="inline-block h-1.5 w-1.5 bg-cool" aria-hidden="true" />
      <span className={extra ? "text-muted" : "text-cool"}>
        {OFFER_LABEL[best.offerType]} on {best.platformName}
      </span>
      {isOk(best.price) ? (
        <span className="text-muted">· {best.price.value}</span>
      ) : null}
      {ordered.length > 1 ? (
        <span className="text-muted">+{ordered.length - 1} more</span>
      ) : null}
    </p>
  );
}

export function FilmCard({
  film,
  services = [],
  stale = false,
  showRank = true,
}: {
  readonly film: FilmRecord;
  readonly services?: readonly string[];
  readonly stale?: boolean;
  readonly showRank?: boolean;
}) {
  const poster = film.posterUrl;
  const rank = film.rank;

  // The rating we lead with on the card face: the highest-signal one available.
  const lead =
    film.ratings.find((r) => r.label === "IMDb" && isOk(r.value)) ??
    film.ratings.find((r) => r.label === "Rotten Tomatoes" && isOk(r.value)) ??
    film.ratings.find((r) => isOk(r.value));

  return (
    <article className="group relative w-[164px] sm:w-[184px]">
      <Link
        href={`/film/${film.tmdbId}`}
        className="block focus-visible:outline-3 focus-visible:outline-gold"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface">
          {isOk(poster) ? (
            <Image
              src={poster.value}
              alt=""
              fill
              className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
              sizes="(max-width: 640px) 164px, 184px"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] leading-tight text-muted">
              No poster from TMDB
            </span>
          )}

          {showRank && isOk(rank) ? (
            <span
              aria-hidden="true"
              className="rank-numeral pointer-events-none absolute -bottom-2 -left-1 select-none text-[62px] text-ink-deep/35"
            >
              {rank.value}
            </span>
          ) : null}

          <span className="absolute right-1.5 top-1.5">
            <DivergenceBadge divergence={film.divergence} compact />
          </span>
        </div>

        <h3 className="mt-2 clamp-2 text-[13px] font-semibold leading-snug text-paper">
          {showRank && isOk(rank) ? (
            <span className="sr-only">Number {rank.value}: </span>
          ) : null}
          {film.title}
        </h3>
      </Link>

      <div className="mt-1 flex flex-col gap-1">
        <AvailabilityLine availability={film.availability} services={services} />
        <div className="flex items-center justify-between gap-2">
          {lead && isOk(lead.value) ? (
            <span className="text-[11px] text-muted">
              <span className="text-paper">
                {lead.scale === "percent"
                  ? `${Math.round(lead.value.value)}%`
                  : lead.value.value.toFixed(1)}
              </span>{" "}
              {lead.label}
            </span>
          ) : (
            <span className="text-[11px] text-muted">No score yet</span>
          )}
          <MovementBar movement={film.movement} stale={stale} size="sm" />
        </div>
      </div>
    </article>
  );
}
