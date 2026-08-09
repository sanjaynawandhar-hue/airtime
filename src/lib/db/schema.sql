-- ===========================================================================
-- Airtime schema — Postgres (Neon)
-- Apply with:  npm run db:push
--
-- Design notes that matter:
--
-- 1. ANONYMOUS-FIRST, CLAIMABLE LATER. Everything a user owns hangs off
--    `identity.anon_id`, an opaque random ID minted into a first-party cookie.
--    `identity.account_id` is nullable and unused today. When real auth is
--    added, claiming an anonymous history is a single UPDATE setting
--    account_id — no data migration, no re-keying of reviews.
--
-- 2. NO PERSONAL DATA. There is deliberately no email, name, phone or profile
--    column anywhere in this file, and none may be added at review time. IPs
--    are never stored raw — only as a salted hash, for rate limiting, with a
--    short retention window.
--
-- 3. RANK SNAPSHOTS ARE OBSERVATIONS, NOT DERIVATIONS. `chart_position` stores
--    what a source's chart actually said on a given day. Week-over-week
--    movement is computed by comparing two real observations. If we have no
--    prior observation for a title, movement is UNAVAILABLE — it is never
--    estimated, and a title we have never seen before is "new", not "up".
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Identity
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identity (
  anon_id      TEXT PRIMARY KEY,
  -- Reserved for a future auth layer. Anonymous rows are claimed by setting it.
  account_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_account_idx ON identity (account_id)
  WHERE account_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Preferences — the heavy lists live here, keyed to the anon_id.
-- The cookie itself carries only the ID plus lightweight display prefs.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS preference (
  anon_id      TEXT PRIMARY KEY REFERENCES identity(anon_id) ON DELETE CASCADE,
  country      TEXT,
  languages    TEXT[] NOT NULL DEFAULT '{}',
  genres       TEXT[] NOT NULL DEFAULT '{}',
  -- Platform ids the user says they subscribe to. Drives button ordering.
  services     TEXT[] NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Reviews
--
-- subject_kind: 'film' | 'track'
-- subject_key:  'tmdb:1234' | 'apple-music:6782573111'  (source-prefixed)
-- score:        1-10 integer, or NULL for a text-only review. NULL is a real
--               state — it is never coerced to 0 or to an average.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review (
  id           BIGSERIAL PRIMARY KEY,
  anon_id      TEXT NOT NULL REFERENCES identity(anon_id) ON DELETE CASCADE,
  account_id   TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('film', 'track')),
  subject_key  TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  score        SMALLINT CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  body         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete so a moderation action is reversible and does not renumber ids.
  hidden       BOOLEAN NOT NULL DEFAULT false,
  -- One review per person per title; editing updates the existing row.
  UNIQUE (anon_id, subject_key)
);

CREATE INDEX IF NOT EXISTS review_subject_idx
  ON review (subject_key, created_at DESC) WHERE hidden = false;

-- --------------------------------------------------------------------------
-- Likes and watchlist
--
-- Watchlist doubles as the anticipation signal for unreleased films: an
-- unreleased title has no ratings anywhere, so instead of rendering an empty
-- rating widget we count these rows and label the number as ours.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlist (
  anon_id      TEXT NOT NULL REFERENCES identity(anon_id) ON DELETE CASCADE,
  subject_key  TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('film', 'track')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, subject_key)
);

CREATE INDEX IF NOT EXISTS watchlist_subject_idx ON watchlist (subject_key);

CREATE TABLE IF NOT EXISTS reaction (
  anon_id      TEXT NOT NULL REFERENCES identity(anon_id) ON DELETE CASCADE,
  subject_key  TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('film', 'track')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, subject_key)
);

CREATE INDEX IF NOT EXISTS reaction_subject_idx ON reaction (subject_key);

-- --------------------------------------------------------------------------
-- Chart snapshots — the source of week-over-week movement
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chart_position (
  -- e.g. 'apple-music:IN:songs', 'tmdb:IN:theatrical', 'youtube:IN:music'
  board_key    TEXT NOT NULL,
  item_key     TEXT NOT NULL,
  rank         INTEGER NOT NULL CHECK (rank > 0),
  -- Date of observation, so a re-run on the same day overwrites rather than
  -- creating a second "previous week".
  captured_on  DATE NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_key, item_key, captured_on)
);

CREATE INDEX IF NOT EXISTS chart_position_lookup_idx
  ON chart_position (board_key, captured_on DESC);

-- --------------------------------------------------------------------------
-- Rate limiting
--
-- ip_hash is sha256(ip + RATE_LIMIT_SALT). The raw IP is never stored.
-- Rows older than 24h are pruned on write; nothing here is retained longer.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS write_log (
  id         BIGSERIAL PRIMARY KEY,
  anon_id    TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS write_log_anon_idx ON write_log (anon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS write_log_ip_idx   ON write_log (ip_hash, created_at DESC);
