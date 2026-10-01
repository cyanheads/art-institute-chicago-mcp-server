/**
 * @fileoverview `artic_search_exhibitions` — searches past, current, and
 * upcoming exhibitions by text and an overlapping date window, with the
 * artworks shown when the museum lists them.
 * @module mcp-server/tools/definitions/search-exhibitions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  inlineSafe,
  pageInfo,
  printableUrl,
  quoteBlock,
  WINDOW_NOTICE,
} from '@/services/aic/aic-text.js';
import { titleText, yesNo } from '../artwork-output.js';

const WHEN = ['any', 'current', 'upcoming', 'past'] as const;
const SORTS = ['relevance', 'start_desc', 'start_asc'] as const;

const ExhibitionSchema = z
  .object({
    id: z
      .number()
      .describe(
        'Exhibition id; no tool fetches an exhibition by id, so each row carries the full record.',
      ),
    title: z.string().describe('Exhibition title; empty when the museum lists none.'),
    status: z
      .string()
      .optional()
      .describe(
        'Museum status label (Closed, Confirmed, Traveling). It does not say whether the show is on now; the when filter does.',
      ),
    start: z.string().optional().describe('Opening date and time, ISO 8601 with offset.'),
    end: z.string().optional().describe('Closing date and time, ISO 8601 with offset.'),
    gallery: z.string().optional().describe('Gallery where the exhibition is held.'),
    summary: z.string().optional().describe('Short description the museum wrote.'),
    web_url: z.string().optional().describe('Exhibition page on artic.edu.'),
    image_url: z
      .string()
      .optional()
      .describe(
        "Exhibition image: an 843 px IIIF URL when the museum links an image id, else the museum's own image URL.",
      ),
    is_featured: z
      .boolean()
      .optional()
      .describe('True when the museum features the exhibition; absent when not recorded.'),
    artwork_count: z.number().describe('Artworks the museum lists for the show; 0 when none.'),
    artworks: z
      .array(
        z
          .object({
            id: z.number().describe('Artwork id; pass to artic_get_artworks.'),
            title: z
              .string()
              .optional()
              .describe(
                "Artwork title; absent when the museum's id and title lists do not pair up.",
              ),
          })
          .describe('One artwork shown.'),
      )
      .describe('Artworks shown, when the museum lists them; pass ids to artic_get_artworks.'),
    artist_ids: z
      .array(z.number())
      .describe(
        'Ids of artists in the show; pass as ids to artic_search_artists or one as artist_id to artic_search_artworks.',
      ),
  })
  .describe('One matching exhibition.');

type Exhibition = z.infer<typeof ExhibitionSchema>;

function exhibitionLines(exhibition: Exhibition): string[] {
  const lines = [`## ${titleText(exhibition.title)} (id ${exhibition.id})`];
  const dates: string[] = [];
  if (exhibition.start) dates.push(`opens ${inlineSafe(exhibition.start)}`);
  if (exhibition.end) dates.push(`closes ${inlineSafe(exhibition.end)}`);
  if (dates.length > 0) lines.push(`- **Dates:** ${dates.join(' · ')}`);
  const facts: string[] = [];
  if (exhibition.status) facts.push(`**Status:** ${inlineSafe(exhibition.status)}`);
  if (exhibition.gallery) facts.push(`**Gallery:** ${inlineSafe(exhibition.gallery)}`);
  if (exhibition.is_featured !== undefined) {
    facts.push(`**Featured:** ${yesNo(exhibition.is_featured)}`);
  }
  if (facts.length > 0) lines.push(`- ${facts.join(' · ')}`);
  if (exhibition.web_url) lines.push(`- **Web:** ${printableUrl(exhibition.web_url)}`);
  if (exhibition.image_url) lines.push(`- **Image:** ${printableUrl(exhibition.image_url)}`);
  if (exhibition.artist_ids.length > 0) {
    lines.push(`- **Artist ids:** ${exhibition.artist_ids.join(', ')}`);
  }
  lines.push(`- **Artworks listed:** ${exhibition.artwork_count}`);
  for (const artwork of exhibition.artworks) {
    lines.push(
      artwork.title === undefined
        ? `  - id ${artwork.id}`
        : `  - ${titleText(artwork.title)} (id ${artwork.id})`,
    );
  }
  if (exhibition.summary) lines.push('', '### Summary', quoteBlock(exhibition.summary));
  return lines;
}

export const searchExhibitions = tool('artic_search_exhibitions', {
  title: 'Search exhibitions',
  description:
    'Search Art Institute of Chicago exhibitions by text and date: what is on now, what is coming, or past shows on a topic. Results carry dates, gallery, summary, web page, and the artworks shown when the museum lists them. Pass artwork ids to artic_get_artworks for full records.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: blankAsUnset(z.string().trim().max(200).optional()).describe(
      'Text matched against exhibition titles, descriptions, and other fields; every word must match.',
    ),
    when: blankAsUnset(z.enum(WHEN).default('any')).describe(
      'current: open today; upcoming: opens after today; past: closed before today; any: no date condition.',
    ),
    date_from: blankAsUnset(z.iso.date().optional()).describe(
      'Earliest date, YYYY-MM-DD; an exhibition matches when its run overlaps date_from to date_to.',
    ),
    date_to: blankAsUnset(z.iso.date().optional()).describe(
      'Latest date, YYYY-MM-DD; an exhibition matches when its run overlaps date_from to date_to.',
    ),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'relevance ranks by query text; start_desc and start_asc sort by opening date. Defaults to relevance with a query, else start_desc; relevance without a query sorts as start_desc.',
    ),
    page: blankAsUnset(z.number().int().min(1).max(40).default(1)).describe(
      'Page to return (1-based, 1-40); page times limit may not exceed 1,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(25).default(10)).describe(
      'Exhibitions per page (1-25).',
    ),
  }),
  output: z.object({
    exhibitions: z
      .array(ExhibitionSchema)
      .describe('Matching exhibitions on this page, in ranked or sorted order.'),
    when_applied: z.enum(WHEN).describe('The when condition applied.'),
    sort_applied: z.enum(SORTS).describe('Order applied.'),
    page: z.number().describe('Page returned (1-based).'),
    has_more: z.boolean().describe('True when more matches exist beyond this page.'),
    next_page: z
      .number()
      .optional()
      .describe(
        'Page to request next; absent when nothing remains or the next page would pass the first 1,000 matches.',
      ),
    license_text: z.string().describe('License statement from the API for this data, verbatim.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Matches for the query and filters, before paging.'),
    truncated: z.boolean().describe('True when more matches exist beyond this page.'),
    shown: z.number().describe('Exhibitions returned on this page.'),
    cap: z.number().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, more pages exist, or the reachable window is exhausted.',
      ),
  },
  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_from is later than date_to.',
      retryable: false,
      severity: 'notice',
      recovery:
        'Set date_from on or before date_to, both as YYYY-MM-DD, and call artic_search_exhibitions again.',
    },
    {
      reason: 'page_beyond_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The API refused the page as past the first 1,000 matches (the page and limit bounds keep calls inside it).',
      retryable: false,
      severity: 'notice',
      recovery:
        'Only the first 1,000 matches are reachable. Narrow artic_search_exhibitions with query text, when, or date_from and date_to.',
      thrownBy: 'service',
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
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry artic_search_exhibitions with fewer query words and without date_from and date_to; the server built a query the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich.total(0);
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });

    if (input.date_from && input.date_to && input.date_from > input.date_to) {
      throw ctx.fail(
        'invalid_date_range',
        `date_from ${input.date_from} is later than date_to ${input.date_to}.`,
      );
    }

    const result = await getAicService().searchExhibitions(
      {
        query: input.query,
        when: input.when,
        date_from: input.date_from,
        date_to: input.date_to,
        sort: input.sort ?? (input.query ? 'relevance' : 'start_desc'),
        page: input.page,
        limit: input.limit,
      },
      ctx,
    );
    const paging = pageInfo(result.total, input.page, input.limit);
    const shown = result.exhibitions.length;
    ctx.enrich.total(result.total);
    ctx.enrich({ shown });

    const fragments: string[] = [];
    if (result.total === 0) {
      fragments.push('No exhibitions matched.');
      if (input.when !== 'any') fragments.push('Set when to "any" to include all dates.');
      if (input.date_from || input.date_to) fragments.push('Widen date_from/date_to.');
      if (input.query) fragments.push('All words must match; try fewer words.');
    } else if (shown === 0) {
      fragments.push(
        `Page ${input.page} is past the last match (${result.total} total); request a lower page.`,
      );
    } else if (paging.next_page !== undefined) {
      fragments.push(`More matches: call again with page ${paging.next_page}.`);
    } else if (paging.windowExhausted) {
      fragments.push(WINDOW_NOTICE);
    }
    const notice = fragments.join(' ');
    if (paging.has_more) ctx.enrich.truncated({ shown, cap: input.limit, guidance: notice });
    else if (notice) ctx.enrich.notice(notice);

    return {
      exhibitions: result.exhibitions,
      when_applied: input.when,
      sort_applied: result.sort_applied,
      page: input.page,
      has_more: paging.has_more,
      ...(paging.next_page !== undefined ? { next_page: paging.next_page } : {}),
      license_text: result.license_text,
    };
  },

  format: (result) => {
    const paging = [
      `**Page:** ${result.page}`,
      `**When applied:** ${result.when_applied}`,
      `**Sort applied:** ${result.sort_applied}`,
      `**More matches:** ${yesNo(result.has_more)}`,
    ];
    if (result.next_page !== undefined) paging.push(`**Next page:** ${result.next_page}`);
    const lines = [`# Exhibitions (${result.exhibitions.length} on this page)`, paging.join(' · ')];
    if (result.exhibitions.length === 0) lines.push('', 'No exhibition rows on this page.');
    for (const exhibition of result.exhibitions) lines.push('', ...exhibitionLines(exhibition));
    lines.push('', '## License', quoteBlock(result.license_text));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
