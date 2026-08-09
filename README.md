# Airtime

*What the world is playing, right now.* — @professorSK

One page showing live music and film charts, split into what's in cinemas, what's
on streaming, what's coming, and an all-time Top Rated destination — with a link
out to the platform that can actually play it.

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Postgres (Neon) · Vercel.

---

## 1. Keys you need

Put these in `.env.local` (copy `.env.example`). Nothing is committed.

| Variable | Where to get it | Without it |
|---|---|---|
| `TMDB_READ_TOKEN` | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — the **v4 Read Access Token**, not the v3 key | Both film rails, Coming Soon and all three leaderboards are empty |
| `OMDB_API_KEY` | [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) — free tier is 1,000/day; the $1/mo tier gives 100,000/day | No IMDb or Rotten Tomatoes scores; the Critics board is empty |
| `YOUTUBE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com) → enable YouTube Data API v3 → Credentials | No YouTube music chart, no video review shelf |
| `LASTFM_API_KEY` | [last.fm/api/account/create](https://www.last.fm/api/account/create) | No genre or country music charts from Last.fm |
| `DATABASE_URL` | [console.neon.tech](https://console.neon.tech) — use the **pooled** string | No reviews, no watchlist, no week-over-week movement. Everything else works |

Apple Music RSS, the iTunes Search API and Deezer need no key.

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run db:push              # creates the tables (needs DATABASE_URL)
npm run dev
```

## 2. Check what's actually live

```bash
npm run verify
```

Calls every provider against its real endpoint and prints what came back —
including which ones returned nothing and why. Run it before and after adding
keys; it is the fastest way to see the true state of the system.

## 3. The rule that shapes the codebase

**No invented data.** Ratings, chart positions and availability are the entire
value proposition, so no value from an external source is ever typed as a bare
`number | null`. It is a [`Maybe<T>`](src/lib/core/maybe.ts), which forces every
call site — including every React component — to decide what to render when the
source had nothing. There is no code path that renders a guessed rating, a
zero-that-means-unknown, or an availability flag we didn't confirm.

Concretely:

- TMDB returns `vote_average: 0` for unrated titles. `fromNumeric` rejects 0.
- OMDb returns the string `"N/A"`. `fromText`/`fromNumeric` reject it.
- Last.fm serves a placeholder star image for missing art. The adapter maps it
  to `unavailable`.
- Deezer publishes no chart playlist for India, so `fetchTrending({country:"IN"})`
  returns an empty array. It does **not** fall back to "Top Worldwide".
- Gaana has no public API, so [its adapter](src/lib/providers/gaana.ts) ships
  disabled and returns zero records rather than faking a chart.

## 4. The two film rails never blend

This is structural, not cosmetic. `theatricalBoard()` and `ottBoard()` are
separate pipelines with separate TMDB calls, separate ranking and separate
availability contexts. A `FilmRecord` carries exactly one
`AvailabilityContext`, matching the rail that built it.

A title genuinely in cinemas *and* on streaming appears as **two records**, and
the title page shows both blocks side by side, each labelled. Neither ever
inherits the other's claim.

## 5. Our leaderboards are ours

The three Top Rated boards are Airtime's own rankings, computed with a Bayesian
weighted average (`WR = (v/(v+m))·R + (m/(v+m))·C`, parameters documented in
[`bayesian.ts`](src/lib/rank/bayesian.ts)) over TMDB's licensed vote data and
OMDb's licensed ratings. Every board prints a methodology line generated from
the same numbers the ranking used.

They are **not** IMDb's Top 250 or Rotten Tomatoes' Top 100. Those are
proprietary branded lists; reproducing either needs a licence. IMDb's genuine
list would require their commercial API via AWS Data Exchange.

## 6. Privacy

Anonymous-first. An opaque random ID in a first-party cookie, and nothing else —
no email, no name, no account, no third-party trackers. The consent step really
gates storage: decline and nothing is written server-side, and every surface
still works. "Reset everything" deletes both the cookies and the server row,
which cascades to reviews, watchlist and likes.

IP addresses are never stored raw — only a salted hash, for rate limiting, for
24 hours. Release reminders are a downloadable `.ics` file precisely so we never
hold contact details.

Set `RATE_LIMIT_SALT` in production.

## 7. Layout

```
src/lib/core/       Maybe, shared types, the Provider interface, config, fetcher
src/lib/providers/  One adapter per source, all implementing Provider<T>
src/lib/boards/     Composes providers into rails and leaderboards
src/lib/rank/       Bayesian ranking, critic/audience divergence, rank movement
src/lib/prefs/      Cookies, consent, subscription-aware link ordering
src/lib/reviews/    Anonymous reviews, rate limiting, community score
src/components/     Cards, the Movement Bar, command palette, forms
src/app/            Pages and route handlers
```

Design rationale is in [DESIGN.md](DESIGN.md).
