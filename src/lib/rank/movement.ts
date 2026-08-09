import "server-only";
import { ok, unavailable, type Maybe } from "@/lib/core/maybe";
import type { Movement } from "@/lib/core/types";
import { query } from "@/lib/db/client";

/**
 * Week-over-week rank movement.
 *
 * This is computed from two REAL OBSERVATIONS of a chart, never derived and
 * never estimated. Concretely:
 *
 *  - Today's rank is what the source's chart says right now.
 *  - Last week's rank is a row we actually wrote to `chart_position` on an
 *    earlier date.
 *  - If there is no earlier row for this title on this board, movement is
 *    `"new"` if we have a prior snapshot of the board (so the title genuinely
 *    entered), and `unavailable` if we have no prior snapshot at all (so we
 *    simply do not know yet).
 *
 * That last distinction matters. On a brand-new deployment every title would
 * look like a "new entry" if we were careless, which would be a chart full of
 * fake excitement. Until a second snapshot exists, cards show no movement.
 */

/** The comparison window. Charts are snapshotted daily; we compare to ~7 days. */
const COMPARE_WINDOW_DAYS = 7;

export interface BoardSnapshot {
  readonly boardKey: string;
  /** item_key -> rank, from the most recent snapshot at least a week old. */
  readonly previous: ReadonlyMap<string, number>;
  /** The date those ranks were observed, or null if we have no prior snapshot. */
  readonly comparedTo: string | null;
}

/**
 * Load the newest snapshot that is at least COMPARE_WINDOW_DAYS old. Falls back
 * to the oldest snapshot we have if the board is younger than a week — showing
 * "since Tuesday" honestly beats showing nothing for the first week of life,
 * and `comparedTo` carries the real date so the UI can say which.
 */
export async function loadPreviousSnapshot(
  boardKey: string,
): Promise<BoardSnapshot> {
  const empty: BoardSnapshot = { boardKey, previous: new Map(), comparedTo: null };

  const rows = await query(async (sql) => {
    const dateRows = (await sql`
      SELECT captured_on::text AS captured_on
      FROM chart_position
      WHERE board_key = ${boardKey}
        AND captured_on <= CURRENT_DATE - ${COMPARE_WINDOW_DAYS}::int
      ORDER BY captured_on DESC
      LIMIT 1
    `) as { captured_on: string }[];

    const fallbackRows =
      dateRows.length > 0
        ? dateRows
        : ((await sql`
            SELECT captured_on::text AS captured_on
            FROM chart_position
            WHERE board_key = ${boardKey}
              AND captured_on < CURRENT_DATE
            ORDER BY captured_on ASC
            LIMIT 1
          `) as { captured_on: string }[]);

    if (fallbackRows.length === 0) return null;
    const capturedOn = fallbackRows[0].captured_on;

    const positions = (await sql`
      SELECT item_key, rank
      FROM chart_position
      WHERE board_key = ${boardKey} AND captured_on = ${capturedOn}
    `) as { item_key: string; rank: number }[];

    return { capturedOn, positions };
  });

  if (!rows) return empty;

  return {
    boardKey,
    previous: new Map(rows.positions.map((p) => [p.item_key, p.rank])),
    comparedTo: rows.capturedOn,
  };
}

export function computeMovement(
  itemKey: string,
  currentRank: number,
  snapshot: BoardSnapshot,
): Maybe<Movement> {
  // No prior observation of this board at all — we genuinely do not know.
  if (snapshot.comparedTo === null) return unavailable("not_in_source");

  const previousRank = snapshot.previous.get(itemKey);

  if (previousRank === undefined) {
    return ok({
      direction: "new",
      delta: 0,
      previousRank: unavailable("not_in_source"),
      comparedTo: ok(snapshot.comparedTo),
    });
  }

  // Rank 1 is best, so a SMALLER number is an improvement.
  const delta = previousRank - currentRank;

  return ok({
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    delta: Math.abs(delta),
    previousRank: ok(previousRank),
    comparedTo: ok(snapshot.comparedTo),
  });
}

/**
 * Record today's chart. Idempotent per day: a second run on the same date
 * overwrites, so re-deploying does not manufacture a second data point.
 */
export async function recordSnapshot(
  boardKey: string,
  entries: readonly { itemKey: string; rank: number }[],
): Promise<boolean> {
  if (entries.length === 0) return false;

  const result = await query(async (sql) => {
    const itemKeys = entries.map((e) => e.itemKey);
    const ranks = entries.map((e) => e.rank);
    await sql`
      INSERT INTO chart_position (board_key, item_key, rank, captured_on)
      SELECT ${boardKey}, k, r, CURRENT_DATE
      FROM unnest(${itemKeys}::text[], ${ranks}::int[]) AS t(k, r)
      ON CONFLICT (board_key, item_key, captured_on)
      DO UPDATE SET rank = EXCLUDED.rank, captured_at = now()
    `;
    return true;
  });

  return result === true;
}

/** Card copy: "up 4 since 26 Jul". Plain, no exclamation. */
export function movementCopy(movement: Movement): string {
  const since =
    movement.comparedTo.status === "ok"
      ? new Date(movement.comparedTo.value).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        })
      : null;
  const suffix = since ? ` since ${since}` : "";

  switch (movement.direction) {
    case "up":
      return `Up ${movement.delta}${suffix}`;
    case "down":
      return `Down ${movement.delta}${suffix}`;
    case "flat":
      return `No change${suffix}`;
    case "new":
      return `New entry${suffix}`;
  }
}
