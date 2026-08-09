import "server-only";
import { neon } from "@neondatabase/serverless";
import { keys } from "@/lib/core/config";

/**
 * Postgres access. Everything that touches the database goes through `sql`.
 *
 * The database is OPTIONAL at runtime. Without DATABASE_URL the product still
 * works: charts, rails, leaderboards and title pages all render, and only the
 * features that genuinely need storage — reviews, watchlist, movement history —
 * report that they are unavailable. That is a deliberate choice for an
 * aggregator whose core value is read-only.
 */

let cached: ReturnType<typeof neon> | null = null;

export function getSql(): ReturnType<typeof neon> | null {
  if (!keys.databaseUrl) return null;
  cached ??= neon(keys.databaseUrl);
  return cached;
}

export const isDbConfigured = (): boolean => Boolean(keys.databaseUrl);

/**
 * Run a query, returning null instead of throwing when the database is absent
 * or unreachable. Callers render an explicit unavailable state on null — they
 * never substitute a default value, because a review count of "0" that actually
 * means "we could not reach the database" is exactly the kind of quiet lie this
 * product is built to avoid.
 */
export async function query<T>(
  run: (sql: NonNullable<ReturnType<typeof getSql>>) => Promise<T>,
): Promise<T | null> {
  const sql = getSql();
  if (!sql) return null;
  try {
    return await run(sql);
  } catch (error) {
    console.error("[db] query failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
