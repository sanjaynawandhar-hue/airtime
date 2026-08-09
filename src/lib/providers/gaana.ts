import "server-only";

import { providerEnabled } from "../core/config";
import { unavailable } from "../core/maybe";
import type {
  DeepLink,
  DetailsQuery,
  HealthStatus,
  Provider,
  TrackRecord,
  TrendingQuery,
} from "../core/types";

/**
 * ===========================================================================
 * GAANA — INTENTIONALLY DISABLED. THIS ADAPTER RETURNS ZERO RECORDS.
 * ===========================================================================
 *
 * Gaana publishes NO public API. There is no documented, key-issuing developer
 * programme, no public charts endpoint, and no partner feed we can sign up for.
 * The only way to obtain Gaana's charts today would be to scrape gaana.com or
 * call the private endpoints its web player uses — both of which violate
 * Gaana's terms of use. We will not do that, and there is no scraping code
 * anywhere in this file.
 *
 * The alternative to scraping would be worse: filling a Gaana-branded rail with
 * some other source's Indian charts. That would tell the user something false
 * about where the data came from, which is the one thing this codebase refuses
 * to do. So the rail ships empty and says so.
 *
 * This is a COMPLETE implementation of `Provider<TrackRecord>` — the same shape
 * as deezer.ts and lastfm.ts — precisely so that switching Gaana on is a config
 * change and a single function body, not a rewrite.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD NEED TO CHANGE TO ENABLE IT
 * ---------------------------------------------------------------------------
 * Exactly one thing: a LICENSED CHART ENDPOINT WITH CREDENTIALS, wired into
 * `fetchTrending` below. Concretely, once a Gaana (or Times Internet) content
 * licence provides a base URL plus an auth token:
 *
 *   1. Add the token to `keys` in src/lib/core/config.ts, reading a
 *      `GAANA_API_TOKEN` env var, exactly like the other keys.
 *   2. Implement `fetchTrending` with `fetchJson` from core/fetcher, using
 *      `REVALIDATE.musicCharts` and a `gaana:*` cache tag per query — the same
 *      call shape deezer.ts uses.
 *   3. Map the licensed payload into `TrackRecord` through `fromText` /
 *      `fromNumeric`, so any field the feed omits stays `unavailable`.
 *   4. Set `GAANA_ENABLED=true`. `providerEnabled.gaana` already reads it.
 *
 * Until then every method below returns empty or `unavailable`, and
 * `healthCheck` reports the real reason in plain language.
 */

export const gaanaProvider: Provider<TrackRecord> = {
  id: "gaana",
  kind: "music",
  displayName: "Gaana",
  attribution: "Gaana (not connected — no public API)",

  /** Gated on GAANA_ENABLED, which stays false until a licensed feed exists. */
  isEnabled(): boolean {
    return providerEnabled.gaana;
  },

  /**
   * Returns []. Even when `providerEnabled.gaana` is flipped on there is no
   * licensed endpoint to call yet, so this stays empty rather than pretending:
   * the flag alone must not be able to produce records out of nothing. Step 2
   * above replaces this body.
   */
  async fetchTrending(_query: TrendingQuery): Promise<readonly TrackRecord[]> {
    void _query;
    return [];
  },

  /** No catalogue to look a track up in. */
  async fetchTitleDetails(
    _id: string,
    _query: DetailsQuery,
  ): Promise<TrackRecord | null> {
    void _id;
    void _query;
    return null;
  },

  /**
   * No links. A gaana.com search URL built from a title string is a guess, not
   * a verified destination, so we emit nothing at all.
   */
  async resolveDeepLink(
    _record: TrackRecord,
    _query: DetailsQuery,
  ): Promise<readonly DeepLink[]> {
    void _record;
    void _query;
    return [];
  },

  async healthCheck(): Promise<HealthStatus> {
    return {
      source: "gaana",
      ok: false,
      detail: "Gaana has no public API; adapter is intentionally disabled.",
      latencyMs: unavailable<number>("not_licensed"),
      checkedAt: new Date().toISOString(),
    };
  },
};
