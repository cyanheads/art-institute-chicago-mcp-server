/**
 * @fileoverview Attaches artwork counts and sample works to `artic_search_artists`
 * results from one artworks aggregation — the secondary call, whose failure
 * degrades to agents without counts rather than failing the search.
 * @module services/aic/artist-records
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getAicService } from './aic-service.js';
import type { Agent, SampleWork } from './types.js';

/** An agent with the museum's artwork count and a few of its works, when loaded. */
export interface ArtistRecord extends Agent {
  artwork_count?: number;
  sample_works?: SampleWork[];
}

export interface ArtistRecordsResult {
  artists: ArtistRecord[];
  /** True when the stats call failed and every agent was returned without counts. */
  degraded: boolean;
}

/**
 * Loads counts and sample works for `agents` in one call; skipped for an empty
 * page. A failed load degrades (logged at warning) to the agents as they are;
 * cancellation rethrows.
 */
export async function attachWorkStats(
  agents: readonly Agent[],
  ctx: Context,
): Promise<ArtistRecordsResult> {
  if (agents.length === 0) return { artists: [], degraded: false };
  try {
    const stats = await getAicService().artistWorkStats(
      agents.map((agent) => agent.id),
      ctx,
    );
    return {
      artists: agents.map((agent) => ({ ...agent, ...stats.get(agent.id) })),
      degraded: false,
    };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Artwork counts could not be loaded; returning agents without them', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { artists: [...agents], degraded: true };
  }
}
