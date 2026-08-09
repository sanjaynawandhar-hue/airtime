import "server-only";
import { createHash } from "node:crypto";
import { ok, unavailable, type Maybe } from "@/lib/core/maybe";
import { REVIEW_LIMITS } from "@/lib/core/config";
import { isDbConfigured, query } from "@/lib/db/client";
import { ensureIdentity } from "@/lib/prefs/server";

export interface StoredReview {
  readonly id: string;
  readonly score: number | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True when this row belongs to the reader, so the UI can offer an edit. */
  readonly mine: boolean;
}

export interface CommunityScore {
  readonly average: Maybe<number>;
  readonly count: Maybe<number>;
}

/**
 * IPs are never stored raw. This hash exists only to rate-limit, and the rows
 * are pruned after 24 hours. The salt comes from the environment so the hashes
 * are not reversible with a rainbow table of the IPv4 space.
 */
function hashIp(ip: string): string {
  const salt = process.env.RATE_LIMIT_SALT ?? "airtime-dev-salt";
  return createHash("sha256").update(`${ip}:${salt}`).digest("hex").slice(0, 32);
}

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string };

/**
 * Rate limit by BOTH the anonymous ID and the IP hash. The ID alone is trivial
 * to cycle by clearing a cookie; the IP alone punishes shared networks, which
 * matters a lot in the primary market. Requiring both keeps normal use free.
 *
 * When the database is unreachable we ALLOW the write rather than blocking it —
 * the review then fails at the insert anyway, and refusing writes because the
 * limiter is down would turn a storage outage into a total outage.
 */
export async function checkRateLimit(
  anonId: string,
  ip: string,
): Promise<RateLimitResult> {
  const ipHash = hashIp(ip);

  const counts = await query(async (sql) => {
    await sql`DELETE FROM write_log WHERE created_at < now() - interval '24 hours'`;
    const rows = (await sql`
      SELECT
        count(*) FILTER (WHERE anon_id = ${anonId} AND created_at > now() - interval '1 hour') AS by_id,
        count(*) FILTER (WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour') AS by_ip
      FROM write_log
    `) as { by_id: string; by_ip: string }[];
    return rows[0];
  });

  if (!counts) return { allowed: true };

  if (Number(counts.by_id) >= REVIEW_LIMITS.perIdPerHour) {
    return {
      allowed: false,
      message: "You've posted a lot in the last hour. Try again shortly.",
    };
  }
  if (Number(counts.by_ip) >= REVIEW_LIMITS.perIpPerHour) {
    return {
      allowed: false,
      message: "Too many reviews from this network in the last hour. Try again shortly.",
    };
  }
  return { allowed: true };
}

async function logWrite(anonId: string, ip: string): Promise<void> {
  await query(async (sql) => {
    await sql`INSERT INTO write_log (anon_id, ip_hash) VALUES (${anonId}, ${hashIp(ip)})`;
    return true;
  });
}

export async function upsertReview(params: {
  readonly anonId: string;
  readonly ip: string;
  readonly subjectKind: "film" | "track";
  readonly subjectKey: string;
  readonly subjectTitle: string;
  readonly score: number | null;
  readonly body: string;
}): Promise<{ readonly ok: boolean; readonly message?: string }> {
  await ensureIdentity(params.anonId);

  const result = await query(async (sql) => {
    await sql`
      INSERT INTO review (anon_id, subject_kind, subject_key, subject_title, score, body)
      VALUES (
        ${params.anonId}, ${params.subjectKind}, ${params.subjectKey},
        ${params.subjectTitle}, ${params.score}, ${params.body}
      )
      ON CONFLICT (anon_id, subject_key) DO UPDATE SET
        score = EXCLUDED.score,
        body = EXCLUDED.body,
        updated_at = now(),
        hidden = false
    `;
    return true;
  });

  if (result !== true) {
    return {
      ok: false,
      message: "We couldn't save that just now. Your text is still here — try again.",
    };
  }

  await logWrite(params.anonId, params.ip);
  return { ok: true };
}

export async function deleteReview(
  anonId: string,
  subjectKey: string,
): Promise<boolean> {
  const result = await query(async (sql) => {
    await sql`DELETE FROM review WHERE anon_id = ${anonId} AND subject_key = ${subjectKey}`;
    return true;
  });
  return result === true;
}

export async function listReviews(
  subjectKey: string,
  viewerAnonId: string | null,
  limit = 30,
): Promise<readonly StoredReview[] | null> {
  const rows = await query(async (sql) => {
    return (await sql`
      SELECT id::text, anon_id, score, body,
             created_at::text AS created_at, updated_at::text AS updated_at
      FROM review
      WHERE subject_key = ${subjectKey} AND hidden = false
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `) as {
      id: string;
      anon_id: string;
      score: number | null;
      body: string;
      created_at: string;
      updated_at: string;
    }[];
  });

  if (!rows) return null;

  return rows.map((r) => ({
    id: r.id,
    score: r.score,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mine: viewerAnonId !== null && r.anon_id === viewerAnonId,
  }));
}

/**
 * Our community score. Returned separately from the critic ratings and labelled
 * as ours everywhere it is shown — it is never averaged into IMDb's or Rotten
 * Tomatoes' numbers, which would misrepresent both.
 *
 * A count of zero is a real answer ("nobody has rated this"), and is distinct
 * from a database we could not reach, which is `unavailable`.
 */
export async function communityScore(subjectKey: string): Promise<CommunityScore> {
  const rows = await query(async (sql) => {
    return (await sql`
      SELECT avg(score)::float AS average, count(score)::int AS count
      FROM review
      WHERE subject_key = ${subjectKey} AND hidden = false AND score IS NOT NULL
    `) as { average: number | null; count: number }[];
  });

  if (!rows) {
    // "We never set up a database" and "the database didn't answer" are
    // different facts and the UI says them differently.
    const reason = isDbConfigured() ? "source_error" : "not_configured";
    return { average: unavailable(reason), count: unavailable(reason) };
  }

  const row = rows[0];
  if (!row || row.count === 0) {
    return { average: unavailable("not_in_source"), count: ok(0) };
  }

  return { average: ok(row.average ?? 0), count: ok(row.count) };
}

/** Watchlist count — the anticipation signal for unreleased titles. */
export async function watchlistCount(subjectKey: string): Promise<Maybe<number>> {
  const rows = await query(async (sql) => {
    return (await sql`
      SELECT count(*)::int AS count FROM watchlist WHERE subject_key = ${subjectKey}
    `) as { count: number }[];
  });
  if (!rows) return unavailable(isDbConfigured() ? "source_error" : "not_configured");
  const count = rows[0]?.count ?? 0;
  return count === 0 ? unavailable("not_in_source") : ok(count);
}

export async function toggleWatchlist(params: {
  readonly anonId: string;
  readonly subjectKey: string;
  readonly subjectKind: "film" | "track";
}): Promise<{ readonly ok: boolean; readonly added: boolean }> {
  await ensureIdentity(params.anonId);

  const result = await query(async (sql) => {
    const existing = (await sql`
      SELECT 1 FROM watchlist
      WHERE anon_id = ${params.anonId} AND subject_key = ${params.subjectKey}
    `) as unknown[];

    if (existing.length > 0) {
      await sql`
        DELETE FROM watchlist
        WHERE anon_id = ${params.anonId} AND subject_key = ${params.subjectKey}
      `;
      return false;
    }

    await sql`
      INSERT INTO watchlist (anon_id, subject_key, subject_kind)
      VALUES (${params.anonId}, ${params.subjectKey}, ${params.subjectKind})
      ON CONFLICT DO NOTHING
    `;
    return true;
  });

  if (result === null) return { ok: false, added: false };
  return { ok: true, added: result };
}

export async function isOnWatchlist(
  anonId: string | null,
  subjectKey: string,
): Promise<boolean> {
  if (!anonId) return false;
  const rows = await query(async (sql) => {
    return (await sql`
      SELECT 1 FROM watchlist WHERE anon_id = ${anonId} AND subject_key = ${subjectKey}
    `) as unknown[];
  });
  return (rows?.length ?? 0) > 0;
}
