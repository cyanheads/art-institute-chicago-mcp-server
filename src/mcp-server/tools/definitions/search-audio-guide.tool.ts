/**
 * @fileoverview `artic_search_audio_guide` — text search over the museum's
 * mobile audio-guide stops: title, MP3 URL, and transcript. The content is
 * licensed for noncommercial educational use, so every response carries the
 * upstream license text and a source citation.
 * @module mcp-server/tools/definitions/search-audio-guide.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  pageInfo,
  printableUrl,
  quoteBlock,
  SEARCH_WINDOW,
  WINDOW_NOTICE,
} from '@/services/aic/aic-text.js';
import { titleText, yesNo } from '../artwork-output.js';

const SOURCE_CITATION =
  'Audio guide content © Art Institute of Chicago and third parties, https://www.artic.edu/terms';

export const searchAudioGuide = tool('artic_search_audio_guide', {
  title: 'Search audio guide',
  description:
    "Search the Art Institute of Chicago's mobile audio-guide stops by text, matching stop titles and transcripts. Returns each stop's title, MP3 URL, and transcript text. Stops carry no artwork id, so match a stop to a work by its title; for a known artwork, artic_get_artworks related_media lists the recordings linked to it. Some stops are in Spanish, and titles are sometimes internal file names. This content is for noncommercial educational and personal use only: keep the copyright notice and cite the Art Institute of Chicago.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Text matched against stop titles and transcripts; every word must match. An artwork's title or the artist's surname works well.",
      ),
    page: blankAsUnset(z.number().int().min(1).max(200).default(1)).describe(
      'Page to return (1-based); page times limit may not exceed 1,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(20).default(5)).describe(
      'Stops per page (1-20).',
    ),
  }),
  output: z.object({
    stops: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe(
                'Audio-guide stop id; no tool fetches a stop by id, so each row carries the full stop.',
              ),
            title: z
              .string()
              .describe(
                'Stop title; sometimes an internal file name, and empty when the museum lists none.',
              ),
            audio_url: z
              .string()
              .optional()
              .describe(
                'MP3 URL of the recording, already percent-encoded; absent when none is recorded.',
              ),
            transcript: z
              .string()
              .optional()
              .describe(
                'Transcript of the recording, sometimes in Spanish; absent when the museum has none.',
              ),
          })
          .describe('One matching audio-guide stop.'),
      )
      .describe('Matching stops on this page, in relevance order.'),
    page: z.number().describe('Page returned (1-based).'),
    has_more: z.boolean().describe('True when more matches exist beyond this page.'),
    next_page: z
      .number()
      .optional()
      .describe(
        'Page to request next; absent when nothing remains or the next page would pass the first 1,000 matches.',
      ),
    license_text: z
      .string()
      .describe(
        'License statement from the API, verbatim: noncommercial educational and personal use, with notices retained and the source cited.',
      ),
    source_citation: z.string().describe('Citation to keep with any use of this content.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Matches for the query, before paging.'),
    truncated: z.boolean().describe('True when more matches exist beyond this page.'),
    shown: z.number().describe('Stops returned on this page.'),
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
        "Only the first 1,000 matches are reachable. Add words to the artic_search_audio_guide query, such as the artwork title or the artist's surname.",
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
        'Remove markup or script-like text, such as HTML tags, from query, then call artic_search_audio_guide again; if it holds none, wait about a minute first.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry artic_search_audio_guide with fewer query words, such as the artwork title alone; the server built a query the API rejected.',
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

    const result = await getAicService().searchMobileSounds(
      { query: input.query, page: input.page, limit: input.limit },
      ctx,
    );
    const paging = pageInfo(result.total, input.page, input.limit);
    const shown = result.stops.length;
    ctx.enrich.total(result.total);
    ctx.enrich({ shown });

    let notice = '';
    if (result.total === 0) {
      notice =
        "No audio-guide stops matched. Try the artwork's title or the artist's surname; for a known work, artic_get_artworks lists related_media.";
    } else if (shown === 0) {
      notice = `Page ${input.page} is past the last match (${result.total} total); request a lower page.`;
    } else if (paging.next_page !== undefined) {
      notice = `More matches: call again with page ${paging.next_page}.`;
    } else if (paging.windowExhausted) {
      notice = WINDOW_NOTICE;
    }
    if (paging.has_more) ctx.enrich.truncated({ shown, cap: input.limit, guidance: notice });
    else if (notice) ctx.enrich.notice(notice);

    return {
      stops: result.stops,
      page: input.page,
      has_more: paging.has_more,
      ...(paging.next_page !== undefined ? { next_page: paging.next_page } : {}),
      license_text: result.license_text,
      source_citation: SOURCE_CITATION,
    };
  },

  format: (result) => {
    const paging = [`**Page:** ${result.page}`, `**More matches:** ${yesNo(result.has_more)}`];
    if (result.next_page !== undefined) paging.push(`**Next page:** ${result.next_page}`);
    const lines = [`# Audio-guide stops (${result.stops.length} on this page)`, paging.join(' · ')];
    if (result.stops.length === 0) lines.push('', 'No stops on this page.');
    for (const stop of result.stops) {
      lines.push('', `## ${titleText(stop.title)} (id ${stop.id})`);
      lines.push(
        `- **Audio:** ${stop.audio_url ? printableUrl(stop.audio_url) : 'no recording URL'}`,
      );
      if (stop.transcript) lines.push('', '### Transcript', quoteBlock(stop.transcript));
    }
    lines.push(
      '',
      '## License',
      quoteBlock(result.license_text),
      '',
      `**Source citation:** ${result.source_citation}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
