/**
 * @fileoverview `artic_search_artworks` — collection search by text and
 * structured filters, with optional facet counts over the filtered set and
 * date sorting. Rows are compact; full records come from `artic_get_artworks`.
 * @module mcp-server/tools/definitions/search-artworks.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  galleryInput,
  inlineSafe,
  listInput,
  pageInfo,
  quoteBlock,
  SEARCH_WINDOW,
  VOCABULARY_FILTERS,
  vocabularyInput,
  WINDOW_NOTICE,
  YEAR_MAX,
  YEAR_MIN,
} from '@/services/aic/aic-text.js';
import { artworkSummaryShape, summaryLines, titleText, yesNo } from '../artwork-output.js';

const FACETS = [
  'department',
  'artwork_type',
  'style',
  'subject',
  'classification',
  'place_of_origin',
  'artist',
] as const;

const SCOPE_FLAGS = ['public_domain_only', 'on_view_only', 'has_image'] as const;

/** Most rows a page returns: a page of the heaviest catalog rows with every facet fits 100,000 wire bytes. */
const LIMIT_MAX = 12;

const facetValues = (filter: string) =>
  z
    .array(
      z
        .object({
          value: z
            .string()
            .describe(`Value as indexed; pass it back verbatim as the ${filter} filter.`),
          count: z.number().describe('Matching artworks carrying this value.'),
        })
        .describe('One facet value and its count.'),
    )
    .optional()
    .describe(`Top ${filter} values over the filtered set, most common first.`);

const SearchInput = z.object({
  query: blankAsUnset(z.string().trim().max(200).optional()).describe(
    'Text matched against titles, artists, descriptions, provenance, and other catalog fields; every word must match. Supports "exact phrase", -exclude, and a | b.',
  ),
  artist: blankAsUnset(z.string().trim().max(120).optional()).describe(
    'Artist or culture name matched against every credited artist (all words must match).',
  ),
  artist_id: blankAsUnset(z.number().int().positive().optional()).describe(
    'Agent id from artic_search_artists or an artist facet row; matches preferred and other credits.',
  ),
  department: vocabularyInput(120).describe(
    'Department title exactly as artic_lookup_vocabulary lists it (case ignored), such as Prints and Drawings.',
  ),
  artwork_type: vocabularyInput(120).describe(
    'Artwork type title as artic_lookup_vocabulary lists it (case ignored), such as Painting or Print.',
  ),
  style: vocabularyInput(120).describe(
    'Style title as artic_lookup_vocabulary lists it (case ignored), such as Impressionism; matches preferred or alternate styles.',
  ),
  subject: vocabularyInput(120).describe(
    'Subject title as artic_lookup_vocabulary lists it (case ignored).',
  ),
  classification: vocabularyInput(120).describe(
    'Classification title as artic_lookup_vocabulary lists it (case ignored), such as oil on canvas or etching.',
  ),
  place_of_origin: vocabularyInput(120).describe(
    'Place of origin as artic_lookup_vocabulary lists it (case ignored), such as france.',
  ),
  gallery: galleryInput(120).describe(
    'Gallery where the work is on view, such as Gallery 240 (a bare 240 is read as Gallery 240). Only on-view works carry a gallery.',
  ),
  year_from: blankAsUnset(z.number().int().min(YEAR_MIN).max(YEAR_MAX).optional()).describe(
    'Earliest year; a work matches when its date span overlaps year_from to year_to. Negative for BCE.',
  ),
  year_to: blankAsUnset(z.number().int().min(YEAR_MIN).max(YEAR_MAX).optional()).describe(
    'Latest year; a work matches when its date span overlaps year_from to year_to. Negative for BCE.',
  ),
  public_domain_only: blankAsUnset(z.boolean().default(false)).describe(
    'Only public-domain works, whose images are CC0.',
  ),
  on_view_only: blankAsUnset(z.boolean().default(false)).describe(
    'Only works on view at the museum now.',
  ),
  has_image: blankAsUnset(z.boolean().default(false)).describe('Only works with an image.'),
  facets: blankAsUnset(listInput(z.array(z.enum(FACETS)).max(7).optional(), 7)).describe(
    'Facet counts to compute over the filtered set (top 15 values each): department, artwork_type, style, subject, classification, place_of_origin, artist. An array or a comma-separated string.',
  ),
  sort: blankAsUnset(z.enum(['relevance', 'date_asc', 'date_desc']).default('relevance')).describe(
    'relevance ranks by query text, or by museum popularity without it; date_asc and date_desc sort by start year.',
  ),
  page: blankAsUnset(z.number().int().min(1).max(SEARCH_WINDOW).default(1)).describe(
    'Page to return (1-based); page times limit may not exceed 1,000.',
  ),
  limit: blankAsUnset(z.number().int().min(0).max(LIMIT_MAX).default(10)).describe(
    `Rows per page (0-${LIMIT_MAX}; capped so a page of long catalog records with every facet stays within common tool-output limits); 0 returns only totalCount and facets.`,
  ),
});

type SearchInputValues = z.infer<typeof SearchInput>;

/** Zero-hit guidance: one fragment per filter in play, each routing to a call. */
function zeroHitFragments(input: SearchInputValues): string[] {
  const fragments = ['No artworks matched.'];
  const vocabularies = VOCABULARY_FILTERS.filter((name) => input[name] !== undefined);
  if (vocabularies.length > 0) {
    fragments.push(
      `Check filter values with artic_lookup_vocabulary (vocabulary ${vocabularies.map((name) => `"${name}"`).join(', ')}) — values match exactly, ignoring case.`,
    );
  }
  if (input.artist) {
    fragments.push('Resolve the name with artic_search_artists and pass artist_id instead.');
  }
  if (input.artist_id !== undefined) {
    fragments.push(
      'Confirm the id with artic_search_artists (ids mode); an agent with no artworks matches nothing.',
    );
  }
  if (input.query) {
    fragments.push(
      input.query.split(/\s+/).length >= 3
        ? 'All words must match; try fewer words or quote an exact phrase.'
        : 'Check the spelling of the query text, or try a broader term.',
    );
  }
  const flags = SCOPE_FLAGS.filter((flag) => input[flag]);
  if (flags.length > 0) fragments.push(`Drop ${flags.join(' / ')} to widen the set.`);
  if (input.year_from !== undefined || input.year_to !== undefined) {
    fragments.push(
      'Widen year_from/year_to; a work matches when its date span overlaps the range.',
    );
  }
  return fragments;
}

export const searchArtworks = tool('artic_search_artworks', {
  title: 'Search artworks',
  description:
    'Search the Art Institute of Chicago collection by text and structured filters, ranked by relevance or sorted by date. Text matches all words across titles, artists, descriptions, provenance, and other catalog fields. Filters combine with AND. Results reach the first 1,000 matches; narrow with filters for more. Set limit to 0 with facets to get only counts. Use artic_lookup_vocabulary for filter values and artic_get_artworks for full records.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: SearchInput,
  output: z.object({
    artworks: z
      .array(z.object(artworkSummaryShape).describe('One matching artwork.'))
      .describe('Matching artworks on this page, in ranked or sorted order.'),
    facets: z
      .object({
        department: facetValues('department'),
        artwork_type: facetValues('artwork_type'),
        style: facetValues('style'),
        subject: facetValues('subject'),
        classification: facetValues('classification'),
        place_of_origin: facetValues('place_of_origin'),
        artist: z
          .array(
            z
              .object({
                artist_id: z.number().describe('Agent id; pass it back as the artist_id filter.'),
                name: z
                  .string()
                  .optional()
                  .describe('Artist name as written; absent when the museum record carries none.'),
                count: z.number().describe('Matching artworks crediting this artist.'),
              })
              .describe('One artist facet row.'),
          )
          .optional()
          .describe('Top artists over the filtered set, most common first.'),
      })
      .optional()
      .describe(
        'Counts over the filtered set for each requested facet; present only when facets were requested.',
      ),
    page: z.number().describe('Page returned (1-based).'),
    has_more: z.boolean().describe('True when more matches exist beyond this page.'),
    next_page: z
      .number()
      .optional()
      .describe(
        'Page to request next; absent when nothing remains or the next page would pass the first 1,000 matches.',
      ),
    sort_applied: z
      .enum(['relevance', 'popularity', 'date_asc', 'date_desc'])
      .describe(
        'Order applied; popularity when relevance was requested without query text (the museum popularity ranking).',
      ),
    license_text: z.string().describe('License statement from the API for this data, verbatim.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Matches for the query and filters, before paging.'),
    truncated: z.boolean().describe('True when more matches exist beyond this page.'),
    shown: z.number().describe('Rows returned on this page.'),
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
      reason: 'page_beyond_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page times limit exceeds 1,000, past the reachable search window.',
      retryable: false,
      severity: 'notice',
      recovery:
        'Only the first 1,000 matches of a search are reachable. Narrow artic_search_artworks with filters such as department, artwork_type, or year_from, using values from artic_lookup_vocabulary.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'year_from is later than year_to.',
      retryable: false,
      severity: 'notice',
      recovery:
        'Set year_from at or below year_to; use negative years for BCE, for example year_from -500.',
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
        'Remove markup or script-like text, such as HTML tags, from query and the other text filters, then call artic_search_artworks again; if they hold none, wait about a minute first.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry with fewer filters, or search with artic_search_artworks using query text alone; the server built a query the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich.total(0);
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });

    if (input.page * input.limit > SEARCH_WINDOW) {
      throw ctx.fail(
        'page_beyond_window',
        `Page ${input.page} with limit ${input.limit} reaches match ${input.page * input.limit}, past the first 1,000.`,
      );
    }
    if (
      input.year_from !== undefined &&
      input.year_to !== undefined &&
      input.year_from > input.year_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `year_from ${input.year_from} is later than year_to ${input.year_to}.`,
      );
    }

    const result = await getAicService().searchArtworks(input, ctx);
    const paging = pageInfo(result.total, input.page, input.limit);
    const shown = result.artworks.length;
    ctx.enrich.total(result.total);
    ctx.enrich({ shown });

    const fragments: string[] = [];
    if (result.total === 0) {
      fragments.push(...zeroHitFragments(input));
    } else if (input.limit === 0) {
      fragments.push(
        `Counts only (limit 0); set limit between 1 and ${LIMIT_MAX} to list the matching artworks.`,
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
    const notice = fragments.join(' ');
    if (paging.has_more) ctx.enrich.truncated({ shown, cap: input.limit, guidance: notice });
    else if (notice) ctx.enrich.notice(notice);

    return {
      artworks: result.artworks,
      ...(result.facets ? { facets: result.facets } : {}),
      page: input.page,
      has_more: paging.has_more,
      ...(paging.next_page !== undefined ? { next_page: paging.next_page } : {}),
      sort_applied: result.sort_applied,
      license_text: result.license_text,
    };
  },

  format: (result) => {
    const paging = [
      `**Page:** ${result.page}`,
      `**Sort applied:** ${result.sort_applied}`,
      `**More matches:** ${yesNo(result.has_more)}`,
    ];
    if (result.next_page !== undefined) paging.push(`**Next page:** ${result.next_page}`);
    const lines = [`# Artworks (${result.artworks.length} on this page)`, paging.join(' · ')];

    if (result.artworks.length === 0) lines.push('', 'No artwork rows on this page.');
    for (const artwork of result.artworks) {
      lines.push('', `## ${titleText(artwork.title)} (id ${artwork.id})`, ...summaryLines(artwork));
    }

    if (result.facets) {
      lines.push('', '## Facets');
      for (const name of FACETS) {
        if (name === 'artist') continue;
        const values = result.facets[name];
        if (!values) continue;
        lines.push('', `### ${name}`);
        if (values.length === 0) lines.push('No values.');
        for (const entry of values) lines.push(`- ${inlineSafe(entry.value)} (${entry.count})`);
      }
      if (result.facets.artist) {
        lines.push('', '### artist');
        if (result.facets.artist.length === 0) lines.push('No values.');
        for (const entry of result.facets.artist) {
          const name = entry.name ? inlineSafe(entry.name) : '(name not recorded)';
          lines.push(`- ${name} · artist_id ${entry.artist_id} (${entry.count})`);
        }
      }
    }

    lines.push('', '## License', quoteBlock(result.license_text));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
