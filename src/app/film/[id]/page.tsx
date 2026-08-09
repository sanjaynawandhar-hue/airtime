import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { Footer, Header } from "@/components/Shell";
import { CommunityScore, DivergenceBadge, ScoreRow } from "@/components/Score";
import { Attribution, LastChecked, ProvenanceLine } from "@/components/Meta";
import { Reviews } from "@/components/Reviews";
import { CalendarButton, ShareCardButton, WatchlistButton } from "@/components/TitleActions";
import { isOk, type Maybe } from "@/lib/core/maybe";
import type { CastMember, CrewMember, DeepLink, FilmDetails } from "@/lib/core/types";
import { fetchTitleDetails } from "@/lib/providers/tmdb";
import { fetchRatings } from "@/lib/providers/omdb";
import { fetchVideoReviews } from "@/lib/providers/youtube";
import { computeDivergence } from "@/lib/rank/divergence";
import { readPrefs } from "@/lib/prefs/server";
import { communityScore, isOnWatchlist, listReviews, watchlistCount } from "@/lib/reviews/store";
import { OFFER_LABEL, isExtraCost, orderLinks } from "@/lib/prefs/ordering";
import { REVIEW_CHANNELS } from "@/lib/core/config";

/**
 * The title page — the most information-dense surface in the product, and the
 * page someone lands on when they are deciding whether a film is worth their
 * Friday.
 *
 * The availability section is the important part: a title that is genuinely in
 * cinemas AND on a streaming service shows BOTH contexts, each labelled, each
 * built from its own pipeline. Neither ever borrows the other's claim.
 */

interface Props {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isInteger(tmdbId)) return { title: "Title not found" };
  const details = await fetchTitleDetails(tmdbId, "IN");
  if (!details) return { title: "Title not found" };
  return {
    title: details.title,
    description: isOk(details.overview) ? details.overview.value.slice(0, 180) : undefined,
    openGraph: { images: [`/api/share?tmdbId=${tmdbId}`] },
  };
}

export default async function FilmPage({ params }: Props) {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) notFound();

  const { prefs, consent, anonId } = await readPrefs();
  const details = await fetchTitleDetails(tmdbId, prefs.country);
  if (!details) notFound();

  const subjectKey = details.key;

  // OMDb ratings, the review shelf, and our own numbers — all in parallel.
  const [omdbRatings, videoReviews, community, watchCount, onWatchlist, storedReviews] =
    await Promise.all([
      isOk(details.imdbId) ? fetchRatings(details.imdbId.value) : Promise.resolve([]),
      fetchVideoReviews(details.title, releaseYear(details)),
      communityScore(subjectKey),
      watchlistCount(subjectKey),
      isOnWatchlist(anonId, subjectKey),
      listReviews(subjectKey, anonId),
    ]);

  const ratings = [...omdbRatings, ...details.ratings];
  const divergence = computeDivergence(ratings);

  /**
   * Unreleased titles have no ratings anywhere, so we never render a rating
   * widget for one — not even an empty one. The anticipation block replaces it.
   */
  const unreleased = isUnreleased(details);

  return (
    <>
      <Header country={prefs.country} />
      <main id="main" className="pb-8">
        <Hero details={details} />

        <div className="mx-auto max-w-6xl px-[var(--board-gutter)]">
          {/* ---------------- availability ---------------- */}
          <section aria-labelledby="watch" className="mt-8">
            <h2 id="watch" className="eyebrow mb-3 text-gold">
              Where to watch
            </h2>
            <div className="flex flex-col gap-3">
              {details.theatrical ? (
                <TheatricalBlock details={details} />
              ) : null}
              {details.ott ? (
                <OttBlock details={details} services={prefs.services} />
              ) : null}
              {!details.theatrical && !details.ott ? (
                <p className="max-w-prose text-sm text-muted">
                  We couldn&rsquo;t confirm anywhere to watch this in{" "}
                  {prefs.country} right now. That means our sources had no entry —
                  not that it is unavailable everywhere.
                </p>
              ) : null}
              {details.theatrical && details.ott ? (
                <p className="max-w-prose border-l-2 border-gold pl-3 text-[12px] leading-relaxed text-gold">
                  This title is in cinemas <em>and</em> on streaming at the same
                  time. Both are shown above with their own terms — one is not a
                  substitute for the other.
                </p>
              ) : null}
            </div>
          </section>

          {/* ---------------- scores ---------------- */}
          <section aria-labelledby="scores" className="mt-10">
            <h2 id="scores" className="eyebrow mb-3 text-gold">
              Scores
            </h2>

            {unreleased ? (
              <div className="flex flex-col gap-3">
                <Anticipation count={watchCount} />
                <p className="max-w-prose text-[12px] leading-relaxed text-muted">
                  This film hasn&rsquo;t released yet, so there are no critic or
                  audience scores to show. The number above is ours — how many
                  people here have added it to a watchlist.
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                  <ScoreRow ratings={ratings} />
                  <CommunityScore score={community.average} count={community.count} />
                </div>
                <div className="mt-4 max-w-md">
                  <DivergenceBadge divergence={divergence} />
                </div>
              </>
            )}
          </section>

          {/* ---------------- actions ---------------- */}
          <section aria-label="Actions" className="mt-8 flex flex-wrap gap-2">
            <WatchlistButton subjectKey={subjectKey} initialOn={onWatchlist} />
            {unreleased ? <CalendarButton tmdbId={details.tmdbId} /> : null}
            <ShareCardButton tmdbId={details.tmdbId} title={details.title} />
          </section>

          {/* ---------------- synopsis + facts ---------------- */}
          <div className="mt-10 grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-labelledby="synopsis">
              <h2 id="synopsis" className="eyebrow mb-3 text-gold">
                Synopsis
              </h2>
              {isOk(details.overview) ? (
                <p className="max-w-prose text-[15px] leading-relaxed text-paper">
                  {details.overview.value}
                </p>
              ) : (
                <p className="text-sm text-muted">
                  TMDB has no synopsis on file for this title.
                </p>
              )}
              {isOk(details.trailer) ? (
                <div className="mt-6">
                  <h3 className="eyebrow mb-2 text-gold">Trailer</h3>
                  <div className="relative aspect-video w-full max-w-2xl border border-surface-hi bg-ink-deep">
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${details.trailer.value.youtubeKey}`}
                      title={`Trailer for ${details.title}`}
                      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      loading="lazy"
                      className="absolute inset-0 h-full w-full"
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted">
                    {details.trailer.value.name} · via YouTube
                  </p>
                </div>
              ) : (
                <p className="mt-6 text-sm text-muted">
                  No trailer listed on TMDB for this title.
                </p>
              )}
            </section>

            <Facts details={details} />
          </div>

          {/* ---------------- cast ---------------- */}
          <Cast cast={details.cast} />

          {/* ---------------- crew ---------------- */}
          <Crew crew={details.crew} />

          {/* ---------------- video reviews ---------------- */}
          <VideoShelf reviews={videoReviews} />

          {/* ---------------- critic reviews ---------------- */}
          <CriticShelf details={details} />

          {/* ---------------- reader reviews ---------------- */}
          <Reviews
            subjectKey={subjectKey}
            subjectKind="film"
            subjectTitle={details.title}
            consentGranted={consent === "granted"}
            initialReviews={(storedReviews ?? []).map((r) => ({
              id: r.id,
              score: r.score,
              body: r.body,
              updatedAt: r.updatedAt,
              mine: r.mine,
            }))}
            averageScore={isOk(community.average) ? community.average.value : null}
            ratingCount={isOk(community.count) ? community.count.value : null}
            /* null means the store was unreachable, which is different from
               "nobody has reviewed this" and is said differently. */
            unavailableNote={
              storedReviews === null
                ? "Reader reviews aren't loading right now. Everything else on this page is unaffected."
                : null
            }
          />

          <div className="mt-10 flex flex-col gap-2">
            <LastChecked fetchedAt={details.provenance.fetchedAt} stale={details.provenance.stale} />
            <Attribution sources={["tmdb", "omdb", "youtube"]} />
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

/* ------------------------------------------------------------------ */

function releaseYear(details: FilmDetails): number | undefined {
  const date = isOk(details.localReleaseDate) ? details.localReleaseDate.value : null;
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : undefined;
}

function isUnreleased(details: FilmDetails): boolean {
  if (details.rail === "upcoming") return true;
  if (!isOk(details.localReleaseDate)) return false;
  return new Date(details.localReleaseDate.value).getTime() > Date.now();
}

function Hero({ details }: { readonly details: FilmDetails }) {
  const backdrop = details.backdropUrl;
  const poster = details.posterUrl;

  return (
    <div className="relative">
      {isOk(backdrop) ? (
        <div className="absolute inset-0 -z-10 h-[320px] overflow-hidden sm:h-[420px]">
          <Image
            src={backdrop.value}
            alt=""
            fill
            priority
            className="object-cover opacity-25"
            sizes="100vw"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-ink/40 to-ink" />
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl px-[var(--board-gutter)] pt-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          <div className="relative aspect-[2/3] w-[132px] shrink-0 overflow-hidden bg-surface sm:w-[176px]">
            {isOk(poster) ? (
              <Image
                src={poster.value}
                alt=""
                fill
                priority
                className="object-cover"
                sizes="176px"
              />
            ) : (
              <span className="flex h-full items-center justify-center px-2 text-center text-[11px] text-muted">
                No poster from TMDB
              </span>
            )}
          </div>

          <div className="min-w-0">
            <Link href="/?mode=film" className="eyebrow text-muted hover:text-gold">
              ← Back to the board
            </Link>
            <h1 className="display mt-2 text-3xl text-paper sm:text-5xl">
              {details.title}
            </h1>
            {isOk(details.originalTitle) &&
            details.originalTitle.value !== details.title ? (
              <p className="mt-1 text-sm text-muted">{details.originalTitle.value}</p>
            ) : null}
            {isOk(details.tagline) ? (
              <p className="mt-2 max-w-prose text-[15px] italic text-gold">
                {details.tagline.value}
              </p>
            ) : null}
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              {isOk(details.localReleaseDate) ? (
                <span>
                  {new Date(details.localReleaseDate.value).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              ) : (
                <span>Release date not listed</span>
              )}
              {isOk(details.runtimeMinutes) ? (
                <span>· {details.runtimeMinutes.value} min</span>
              ) : null}
              {isOk(details.certification) ? (
                <span className="border border-surface-hi px-1.5 py-0.5">
                  {details.certification.value}
                </span>
              ) : null}
            </p>
            {details.genres.length > 0 ? (
              <p className="mt-2 text-[13px] text-muted">{details.genres.join(" · ")}</p>
            ) : null}
            <div className="mt-3">
              <ProvenanceLine provenance={details.provenance} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TheatricalBlock({ details }: { readonly details: FilmDetails }) {
  const theatrical = details.theatrical!;

  /**
   * Having had a theatrical release and being in cinemas today are different
   * facts. The certification and local date are worth showing either way, so
   * the block stays — only the claim changes.
   */
  if (!theatrical.currentlyRunning) {
    return (
      <div className="border-l-4 border-surface-hi bg-surface/40 p-4">
        <p className="eyebrow mb-2 text-muted">Cinema release</p>
        <p className="text-sm text-paper">
          Released in cinemas in {theatrical.country}
          {isOk(theatrical.certification)
            ? ` · rated ${theatrical.certification.value}`
            : ""}
          {isOk(theatrical.releaseDate)
            ? ` on ${new Date(theatrical.releaseDate.value).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}`
            : ""}
        </p>
        <p className="mt-1.5 max-w-prose text-[12px] leading-relaxed text-muted">
          That run has almost certainly finished — we don&rsquo;t have licensed
          showtimes, so we won&rsquo;t claim it is playing now.
        </p>
      </div>
    );
  }

  return (
    <div className="border-l-4 border-flare bg-surface/40 p-4">
      <p className="eyebrow mb-2 text-flare">In cinemas</p>
      <p className="text-sm text-paper">
        Playing in {theatrical.country}
        {isOk(theatrical.releaseType) && theatrical.releaseType.value === "theatrical_limited"
          ? " (limited release)"
          : ""}
        {isOk(theatrical.certification) ? ` · rated ${theatrical.certification.value}` : ""}
      </p>
      {isOk(theatrical.releaseDate) ? (
        <p className="mt-1 text-[12px] text-muted">
          Released{" "}
          {new Date(theatrical.releaseDate.value).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </p>
      ) : null}
      {isOk(theatrical.booking) ? (
        <>
          <a
            href={theatrical.booking.value.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block border border-flare bg-flare px-4 py-2 text-[13px] font-semibold text-ink-deep transition-opacity hover:opacity-85"
          >
            Find tickets on {theatrical.booking.value.platformName}
          </a>
          <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
            This opens a search on their site. We don&rsquo;t have licensed
            showtimes or seat data, so we don&rsquo;t show any.
          </p>
        </>
      ) : null}
    </div>
  );
}

function OttBlock({
  details,
  services,
}: {
  readonly details: FilmDetails;
  readonly services: readonly string[];
}) {
  const ott = details.ott!;
  const ordered = orderLinks(ott.offers, services);

  return (
    <div className="border-l-4 border-cool bg-surface/40 p-4">
      <p className="eyebrow mb-2 text-cool">On streaming</p>
      {ordered.length === 0 ? (
        <p className="text-sm text-muted">
          No streaming offer confirmed in {ott.country}.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {ordered.map((offer) => (
            <li key={`${offer.platform}-${offer.offerType}`}>
              <OfferButton offer={offer} services={services} />
            </li>
          ))}
        </ul>
      )}
      {isOk(ott.justWatchUrl) ? (
        <p className="mt-3 text-[11px] text-muted">
          Availability data by JustWatch, via TMDB.{" "}
          <a
            href={ott.justWatchUrl.value}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gold"
          >
            See all offers
          </a>
        </p>
      ) : null}
    </div>
  );
}

function OfferButton({
  offer,
  services,
}: {
  readonly offer: DeepLink;
  readonly services: readonly string[];
}) {
  const extra = isExtraCost(offer, services);
  return (
    <a
      href={offer.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex flex-col border px-3 py-2 transition-colors ${
        extra
          ? "border-surface-hi text-muted hover:border-paper hover:text-paper"
          : "border-cool bg-cool text-ink-deep hover:opacity-85"
      }`}
    >
      <span className="text-[13px] font-semibold">{offer.platformName}</span>
      <span className="text-[11px]">
        {OFFER_LABEL[offer.offerType]}
        {isOk(offer.price) ? ` · ${offer.price.value}` : ""}
      </span>
    </a>
  );
}

function Anticipation({ count }: { readonly count: Maybe<number> }) {
  return (
    <div className="flex flex-col gap-1 border-l-4 border-gold bg-surface/40 p-4">
      <p className="eyebrow text-gold">Airtime anticipation</p>
      {isOk(count) ? (
        <p className="text-paper">
          <span className="display text-3xl">{count.value.toLocaleString()}</span>{" "}
          <span className="text-sm text-muted">
            {count.value === 1 ? "person has" : "people have"} added this to a watchlist
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted">Nobody has added this to a watchlist yet.</p>
      )}
    </div>
  );
}

function Facts({ details }: { readonly details: FilmDetails }) {
  const rows: readonly { readonly label: string; readonly value: string | null }[] = [
    {
      label: "Language",
      value: isOk(details.originalLanguage) ? details.originalLanguage.value.toUpperCase() : null,
    },
    {
      label: "Runtime",
      value: isOk(details.runtimeMinutes) ? `${details.runtimeMinutes.value} minutes` : null,
    },
    {
      label: "Certification",
      value: isOk(details.certification) ? details.certification.value : null,
    },
    { label: "Studio", value: details.studios.length > 0 ? details.studios.join(", ") : null },
    { label: "Genre", value: details.genres.length > 0 ? details.genres.join(", ") : null },
    { label: "Status", value: isOk(details.status) ? details.status.value : null },
  ];

  return (
    <section aria-labelledby="facts">
      <h2 id="facts" className="eyebrow mb-3 text-gold">
        Details
      </h2>
      <dl className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 border-b border-surface-hi/60 pb-2.5">
            <dt className="w-[104px] shrink-0 text-[12px] text-muted">{row.label}</dt>
            <dd className="text-[13px] text-paper">
              {row.value ?? <span className="text-muted">Not listed</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Cast({ cast }: { readonly cast: readonly CastMember[] }) {
  if (cast.length === 0) {
    return (
      <section className="mt-10">
        <h2 className="eyebrow mb-3 text-gold">Cast</h2>
        <p className="text-sm text-muted">TMDB has no cast listed for this title.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="cast" className="mt-10">
      <h2 id="cast" className="eyebrow mb-3 text-gold">
        Cast
      </h2>
      <ul className="flex gap-3 overflow-x-auto pb-3" style={{ scrollbarWidth: "none" }}>
        {cast.map((member) => (
          <li key={member.personId} className="w-[112px] shrink-0">
            <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface">
              {isOk(member.profileUrl) ? (
                <Image
                  src={member.profileUrl.value}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="112px"
                />
              ) : (
                <span className="flex h-full items-center justify-center text-[10px] text-muted">
                  No photo
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[12px] font-semibold leading-tight text-paper">
              {member.name}
            </p>
            <p className="text-[11px] leading-tight text-muted">
              {isOk(member.character) ? member.character.value : "Role not listed"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Key crew, selected by matching the `job` field from TMDB's credits — never by
 * position in the array, which is not stable and would silently mislabel people.
 */
const CREW_ROLES: readonly { readonly label: string; readonly jobs: readonly string[] }[] = [
  { label: "Director", jobs: ["Director"] },
  { label: "Writers", jobs: ["Screenplay", "Writer", "Story", "Screenstory"] },
  { label: "Composer", jobs: ["Original Music Composer", "Music"] },
  { label: "Cinematographer", jobs: ["Director of Photography"] },
  { label: "Producers", jobs: ["Producer"] },
];

function Crew({ crew }: { readonly crew: readonly CrewMember[] }) {
  const rows = CREW_ROLES.map((role) => ({
    label: role.label,
    people: crew.filter((member) => role.jobs.includes(member.job)),
  })).filter((row) => row.people.length > 0);

  if (rows.length === 0) {
    return (
      <section className="mt-10">
        <h2 className="eyebrow mb-3 text-gold">Crew</h2>
        <p className="text-sm text-muted">TMDB has no crew credits for this title.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="crew" className="mt-10">
      <h2 id="crew" className="eyebrow mb-3 text-gold">
        Crew
      </h2>
      <dl className="grid gap-2.5 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 border-b border-surface-hi/60 pb-2.5">
            <dt className="w-[128px] shrink-0 text-[12px] text-muted">{row.label}</dt>
            <dd className="text-[13px] text-paper">
              {row.people.slice(0, 4).map((p) => p.name).join(", ")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function VideoShelf({ reviews }: { readonly reviews: readonly import("@/lib/core/types").VideoReview[] }) {
  return (
    <section aria-labelledby="video-reviews" className="mt-12">
      <h2 id="video-reviews" className="eyebrow mb-1.5 text-gold">
        Video reviews
      </h2>
      <p className="mb-3 max-w-prose text-[12px] leading-relaxed text-muted">
        Searched only within {REVIEW_CHANNELS.length} film-review channels we keep
        in a config allowlist, so this shelf can&rsquo;t fill with anything else.
      </p>

      {reviews.length === 0 ? (
        <p className="text-sm text-muted">
          No review from an allowlisted channel found for this title.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {reviews.slice(0, 4).map((review) => (
            <li key={review.videoId}>
              <div className="relative aspect-video w-full border border-surface-hi bg-ink-deep">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${review.videoId}`}
                  title={review.title}
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  loading="lazy"
                  className="absolute inset-0 h-full w-full"
                />
              </div>
              <p className="mt-2 clamp-2 text-[13px] font-semibold leading-snug text-paper">
                {review.title}
              </p>
              <a
                href={review.channelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-muted hover:text-gold"
              >
                {review.channelTitle}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Critic reviews are a headline, an attribution and a link — nothing more.
 * Review text, critic quote-cards and transcripts are copyrighted, so the
 * CriticReview type deliberately carries no body field to reproduce.
 */
function CriticShelf({ details }: { readonly details: FilmDetails }) {
  return (
    <section aria-labelledby="critic-reviews" className="mt-12">
      <h2 id="critic-reviews" className="eyebrow mb-1.5 text-gold">
        Published critic reviews
      </h2>
      <p className="mb-3 max-w-prose text-[12px] leading-relaxed text-muted">
        We link out rather than reprint. The review belongs to whoever wrote it.
      </p>

      {details.criticReviews.length === 0 ? (
        <p className="text-sm text-muted">TMDB has no critic reviews on file for this title.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {details.criticReviews.slice(0, 8).map((review) => (
            <li
              key={review.id}
              className="flex items-center justify-between gap-3 border border-surface-hi bg-surface/30 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-paper">
                  {review.author}
                </p>
                <p className="text-[11px] text-muted">
                  {isOk(review.publication) ? review.publication.value : "Publication not listed"}
                  {isOk(review.score) ? ` · ${review.score.value}/10` : ""}
                </p>
              </div>
              {isOk(review.url) ? (
                <a
                  href={review.url.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="eyebrow shrink-0 border border-surface-hi px-3 py-2 text-muted transition-colors hover:border-gold hover:text-gold"
                >
                  Read
                </a>
              ) : (
                <span className="eyebrow shrink-0 text-muted">No link</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
