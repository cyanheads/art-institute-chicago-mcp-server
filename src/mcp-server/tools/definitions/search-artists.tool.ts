/**
 * @fileoverview `artic_search_artists` — resolves artist, culture, and
 * organization names to agent ids, or fetches agents by id, with life dates,
 * alternate names, the museum's artwork count per agent, and a few sample works.
 * @module mcp-server/tools/definitions/search-artists.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  inlineSafe,
  listInput,
  numericIdItem,
  pageInfo,
  quoteBlock,
  SEARCH_WINDOW,
  WINDOW_NOTICE,
  YEAR_MAX,
  YEAR_MIN,
} from '@/services/aic/aic-text.js';
import { attachWorkStats } from '@/services/aic/artist-records.js';
import { titleText, yesNo } from '../artwork-output.js';

const STATS_DEGRADED =
  "Artwork counts could not be loaded; pass an id as artist_id to artic_search_artworks to count and list that agent's works.";

const ArtistSchema = z
  .object({
    id: z.number().describe('Agent id; pass as artist_id to artic_search_artworks.'),
    name: z
      .string()
      .describe('Name as the museum catalogues it; empty when the museum lists none.'),
    sort_name: z.string().optional().describe('Name in sort order, such as surname first.'),
    alt_names: z.array(z.string()).describe('Other names and spellings the museum records.'),
    agent_type: z
      .string()
      .optional()
      .describe('Kind of agent as the museum records it, such as a person or an organization.'),
    is_artist: z
      .boolean()
      .describe(
        'True when the museum records the agent as an artist; false for donors, funds, and organizations.',
      ),
    birth_year: z
      .number()
      .optional()
      .describe('Birth year, negative for BCE; omitted when unknown or implausible.'),
    death_year: z
      .number()
      .optional()
      .describe('Death year, negative for BCE; omitted when unknown or implausible.'),
    biography: z
      .string()
      .optional()
      .describe('Biography the museum wrote; present for about 1% of agents.'),
    artwork_count: z
      .number()
      .optional()
      .describe(
        'Artworks in the collection crediting this agent (0 when none); absent only when counts could not be loaded.',
      ),
    sample_works: z
      .array(
        z
          .object({
            id: z.number().describe('Artwork id; pass to artic_get_artworks.'),
            title: z.string().describe('Title as catalogued; empty when the museum lists none.'),
            date_display: z.string().optional().describe('Date as the museum displays it.'),
          })
          .describe("One of the agent's artworks."),
      )
      .optional()
      .describe(
        "Up to three of the agent's artworks, the museum's highlighted works first; absent only when counts could not be loaded.",
      ),
  })
  .describe('One matching agent.');

type Artist = z.infer<typeof ArtistSchema>;

function artistLines(artist: Artist): string[] {
  const name = artist.name === '' ? '(name not recorded)' : inlineSafe(artist.name);
  const lines = [`## ${name} (id ${artist.id})`];
  if (artist.sort_name) lines.push(`- **Sort name:** ${inlineSafe(artist.sort_name)}`);
  const kind = [`**Artist:** ${yesNo(artist.is_artist)}`];
  if (artist.agent_type) kind.push(`**Agent type:** ${inlineSafe(artist.agent_type)}`);
  lines.push(`- ${kind.join(' · ')}`);
  const life: string[] = [];
  if (artist.birth_year !== undefined) life.push(`born ${artist.birth_year}`);
  if (artist.death_year !== undefined) life.push(`died ${artist.death_year}`);
  if (life.length > 0) lines.push(`- **Life:** ${life.join(' · ')}`);
  if (artist.alt_names.length > 0) {
    lines.push(`- **Other names:** ${artist.alt_names.map(inlineSafe).join('; ')}`);
  }
  if (artist.artwork_count !== undefined) {
    lines.push(`- **Artworks in the collection:** ${artist.artwork_count}`);
  }
  if (artist.sample_works && artist.sample_works.length > 0) {
    lines.push('- **Sample works:**');
    for (const work of artist.sample_works) {
      const date = work.date_display ? `, ${inlineSafe(work.date_display)}` : '';
      lines.push(`  - ${titleText(work.title)}${date} (id ${work.id})`);
    }
  }
  if (artist.biography) lines.push('', '### Biography', quoteBlock(artist.biography));
  return lines;
}

export const searchArtists = tool('artic_search_artists', {
  title: 'Search artists',
  description:
    "Find artists, cultures, and organizations in the Art Institute of Chicago collection by name, or fetch them by id. Each result carries life dates, agent type, alternate names, how many of the museum's artworks credit them, and up to three of their works, the museum's highlighted works first. Pass an id to artic_search_artworks as artist_id to browse all of their works.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: blankAsUnset(z.string().trim().max(120).optional()).describe(
      'Name to find, matched against names and alternate names; every word must match. Pass query or ids, not both.',
    ),
    ids: blankAsUnset(
      listInput(z.array(z.number().int().positive()).max(25).optional(), 25, numericIdItem),
    ).describe(
      "Agent ids to fetch (up to 25), such as an artwork's artist_id, as an array or a comma-separated string. Pass query or ids, not both; the other filters and page apply to query only.",
    ),
    artists_only: blankAsUnset(z.boolean().default(true)).describe(
      'Query mode: only agents the museum records as artists. Set false to include donors, funds, and organizations.',
    ),
    born_from: blankAsUnset(z.number().int().min(YEAR_MIN).max(YEAR_MAX).optional()).describe(
      'Query mode: earliest birth year, negative for BCE.',
    ),
    born_to: blankAsUnset(z.number().int().min(YEAR_MIN).max(YEAR_MAX).optional()).describe(
      'Query mode: latest birth year, negative for BCE.',
    ),
    page: blankAsUnset(z.number().int().min(1).max(100).default(1)).describe(
      'Query mode: page to return (1-based); page times limit may not exceed 1,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(25).default(10)).describe(
      'Query mode: agents per page (1-25).',
    ),
  }),
  output: z.object({
    artists: z
      .array(ArtistSchema)
      .describe('Matching agents: in relevance order for a name search, in request order for ids.'),
    missing_ids: z
      .array(z.number())
      .optional()
      .describe('Requested ids with no agent, in request order; present when ids were passed.'),
    page: z.number().describe('Page returned (1-based); always 1 when ids were passed.'),
    has_more: z.boolean().describe('True when more matches exist beyond this page.'),
    next_page: z
      .number()
      .optional()
      .describe(
        'Page to request next; absent when nothing remains or the next page would pass the first 1,000 matches.',
      ),
    artists_only_applied: z
      .boolean()
      .describe(
        'Whether results were limited to artists; always false when ids were passed, since every requested agent is returned.',
      ),
    license_text: z.string().describe('License statement from the API for this data, verbatim.'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe('Matches for the query and filters before paging, or agents found for ids.'),
    truncated: z.boolean().describe('True when more matches exist beyond this page.'),
    shown: z.number().describe('Agents returned on this page.'),
    cap: z.number().describe('The limit applied to this page, or the number of ids requested.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, ids were missing, more pages exist, the reachable window is exhausted, or artwork counts could not be loaded.',
      ),
  },
  errors: [
    {
      reason: 'query_or_ids_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither query nor ids was given.',
      retryable: false,
      severity: 'notice',
      recovery:
        "Pass query with a name, or ids from an artwork's artist_id, to artic_search_artists.",
    },
    {
      reason: 'query_and_ids_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both query and ids were given.',
      retryable: false,
      severity: 'notice',
      recovery: 'Pass either query or ids to artic_search_artists, not both, then call again.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'born_from is later than born_to.',
      retryable: false,
      severity: 'notice',
      recovery:
        'Set born_from at or below born_to and call artic_search_artists again; use negative years for BCE.',
    },
    {
      reason: 'page_beyond_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page times limit exceeds 1,000, past the reachable search window.',
      retryable: false,
      severity: 'notice',
      recovery:
        'Only the first 1,000 matches are reachable. Add more of the name, or set born_from and born_to, and call artic_search_artists again.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Art Institute API throttled this server and retries ran out, or the shared request queue could not start the call in time.',
      retryable: true,
      recovery:
        'Wait about a minute and retry; the Art Institute API allows about 60 requests per minute from this server, so batch ids into one artic_get_artworks call.',
      thrownBy: 'service',
    },
    {
      reason: 'request_blocked',
      code: JsonRpcErrorCode.Forbidden,
      when: "The Art Institute API's firewall blocked the request, as it does for markup or script-like text and for bursts of traffic.",
      retryable: false,
      recovery:
        'Remove markup or script-like text, such as HTML tags, from query, then call artic_search_artists again; if it holds none, wait about a minute first.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry artic_search_artists with a shorter name or fewer ids and without born_from and born_to, or match the name with the artist filter of artic_search_artworks; the server built a query the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich.total(0);
    ctx.enrich({ truncated: false, shown: 0, cap: input.ids?.length || input.limit });

    const { query } = input;
    const ids = input.ids?.length ? input.ids : undefined;
    if (query && ids) {
      throw ctx.fail('query_and_ids_conflict', 'Both query and ids were given.');
    }

    if (ids) {
      const batch = await getAicService().getAgents(ids, ctx);
      const { artists, degraded } = await attachWorkStats(batch.agents, ctx);
      ctx.enrich.total(artists.length);
      ctx.enrich({ shown: artists.length });
      const fragments: string[] = [];
      if (artists.length === 0) {
        fragments.push(
          "None of these ids is an agent. Find ids with artic_search_artists query, or take an artwork's artist_id.",
        );
      } else if (batch.missing_ids.length > 0) {
        fragments.push(
          `No agent exists for id ${batch.missing_ids.join(', ')}; find ids with artic_search_artists query.`,
        );
      }
      if (degraded) fragments.push(STATS_DEGRADED);
      if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));
      return {
        artists,
        missing_ids: batch.missing_ids,
        page: 1,
        has_more: false,
        artists_only_applied: false,
        license_text: batch.license_text,
      };
    }

    if (!query) {
      throw ctx.fail('query_or_ids_required', 'Neither query nor ids was given.');
    }
    if (input.page * input.limit > SEARCH_WINDOW) {
      throw ctx.fail(
        'page_beyond_window',
        `Page ${input.page} with limit ${input.limit} reaches match ${input.page * input.limit}, past the first 1,000.`,
      );
    }
    if (
      input.born_from !== undefined &&
      input.born_to !== undefined &&
      input.born_from > input.born_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `born_from ${input.born_from} is later than born_to ${input.born_to}.`,
      );
    }

    const result = await getAicService().searchAgents(
      {
        query,
        artists_only: input.artists_only,
        born_from: input.born_from,
        born_to: input.born_to,
        page: input.page,
        limit: input.limit,
      },
      ctx,
    );
    const { artists, degraded } = await attachWorkStats(result.agents, ctx);
    const paging = pageInfo(result.total, input.page, input.limit);
    const shown = artists.length;
    ctx.enrich.total(result.total);
    ctx.enrich({ shown });

    const fragments: string[] = [];
    if (result.total === 0) {
      fragments.push('No agents matched.', 'All name words must match; try the surname alone.');
      if (input.artists_only) {
        fragments.push('Set artists_only false to include donors and organizations.');
      }
      if (input.born_from !== undefined || input.born_to !== undefined) {
        fragments.push('Widen born_from/born_to.');
      }
      fragments.push(
        'Or match credited names in artwork records with artic_search_artworks artist.',
      );
    } else if (shown === 0) {
      fragments.push(
        `Page ${input.page} is past the last match (${result.total} total); request a lower page.`,
      );
    } else if (paging.next_page !== undefined) {
      fragments.push(`More matches: call again with page ${paging.next_page}.`);
    } else if (paging.windowExhausted) {
      fragments.push(WINDOW_NOTICE);
    }
    if (degraded) fragments.push(STATS_DEGRADED);
    const notice = fragments.join(' ');
    if (paging.has_more) ctx.enrich.truncated({ shown, cap: input.limit, guidance: notice });
    else if (notice) ctx.enrich.notice(notice);

    return {
      artists,
      page: input.page,
      has_more: paging.has_more,
      ...(paging.next_page !== undefined ? { next_page: paging.next_page } : {}),
      artists_only_applied: input.artists_only,
      license_text: result.license_text,
    };
  },

  format: (result) => {
    const paging = [
      `**Page:** ${result.page}`,
      `**More matches:** ${yesNo(result.has_more)}`,
      `**Artists only:** ${yesNo(result.artists_only_applied)}`,
    ];
    if (result.next_page !== undefined) paging.push(`**Next page:** ${result.next_page}`);
    const lines = [`# Agents (${result.artists.length} on this page)`, paging.join(' · ')];
    if (result.artists.length === 0) lines.push('', 'No agent rows on this page.');
    for (const artist of result.artists) lines.push('', ...artistLines(artist));
    if (result.missing_ids) {
      lines.push(
        '',
        `**Missing ids:** ${result.missing_ids.length > 0 ? result.missing_ids.join(', ') : 'none'}`,
      );
    }
    lines.push('', '## License', quoteBlock(result.license_text));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
