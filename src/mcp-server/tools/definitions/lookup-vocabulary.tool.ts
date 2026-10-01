/**
 * @fileoverview `artic_lookup_vocabulary` — lists the values of an artwork
 * vocabulary (departments, types, styles, subjects, and more) with artwork
 * counts, the exact values the `artic_search_artworks` filters accept.
 * @module mcp-server/tools/definitions/lookup-vocabulary.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  containsPattern,
  inlineSafe,
  VOCABULARY_FIELDS,
  VOCABULARY_FILTERS,
  type VocabularyFilter,
} from '@/services/aic/aic-text.js';

const VOCABULARIES = [
  'department',
  'artwork_type',
  'style',
  'subject',
  'classification',
  'material',
  'technique',
  'theme',
  'place_of_origin',
  'gallery',
] as const;

const isFilterParam = (vocabulary: string): vocabulary is VocabularyFilter =>
  (VOCABULARY_FILTERS as readonly string[]).includes(vocabulary);

export const lookupVocabulary = tool('artic_lookup_vocabulary', {
  title: 'Look up collection vocabulary',
  description:
    'List the values of an Art Institute of Chicago collection vocabulary with how many artworks carry each, most common first, optionally narrowed by a substring. Department, artwork type, style, subject, classification, place of origin, and gallery values pass to the matching artic_search_artworks filter exactly as listed (case is ignored); material, technique, and theme values work as query text. Counts here span the whole collection; for counts within a filtered set of artworks, request facets from artic_search_artworks.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    vocabulary: z
      .enum(VOCABULARIES)
      .describe(
        'Vocabulary to list. department, artwork_type, style, subject, classification, place_of_origin, and gallery feed the artic_search_artworks filter of the same name; material, technique, and theme values work as query text.',
      ),
    contains: blankAsUnset(z.string().trim().max(60).optional()).describe(
      'Case-insensitive substring the values must contain, such as "impress" for Impressionism and Post-Impressionism. Omit to list the most common values.',
    ),
    public_domain_only: blankAsUnset(z.boolean().default(false)).describe(
      'Count only public-domain artworks.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(100).default(25)).describe(
      'Values to return, most common first (1-100).',
    ),
  }),
  output: z.object({
    vocabulary: z.enum(VOCABULARIES).describe('The vocabulary listed.'),
    filter_param: z
      .enum(VOCABULARY_FILTERS)
      .optional()
      .describe(
        'The artic_search_artworks parameter that accepts these values as listed; absent for material, technique, and theme, which are not search filters (use their values as query text).',
      ),
    values: z
      .array(
        z
          .object({
            value: z
              .string()
              .describe(
                'Value as the index stores it (place values are lower-case); pass it back verbatim.',
              ),
            artwork_count: z.number().describe('Artworks carrying this value.'),
          })
          .describe('One vocabulary value and its artwork count.'),
      )
      .describe('Values, most common first.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more values exist beyond the limit.'),
    shown: z.number().describe('Values returned.'),
    cap: z.number().describe('The limit applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no value matched or the list was capped.'),
  },
  errors: [
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
        'Remove markup or script-like text, such as HTML tags, from contains, then call artic_lookup_vocabulary again; if it holds none, wait about a minute first.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry artic_lookup_vocabulary without contains or public_domain_only; the server built a query the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });

    const result = await getAicService().aggregate(
      VOCABULARY_FIELDS[input.vocabulary],
      {
        size: input.limit,
        include: input.contains ? containsPattern(input.contains) : undefined,
        public_domain_only: input.public_domain_only,
      },
      ctx,
    );
    const values = result.buckets.map((bucket) => ({
      value: bucket.key,
      artwork_count: bucket.doc_count,
    }));

    ctx.enrich({ shown: values.length });
    if (result.sum_other_doc_count > 0) {
      ctx.enrich.truncated({
        shown: values.length,
        cap: input.limit,
        guidance: 'More values exist: raise limit or narrow with contains.',
      });
    }
    if (values.length === 0) {
      let notice = `No ${input.vocabulary} values were returned; retry artic_lookup_vocabulary, or search artic_search_artworks with query text instead.`;
      if (input.contains) {
        notice = `No ${input.vocabulary} value contains "${input.contains}". Call artic_lookup_vocabulary without contains to see the most common values.`;
      } else if (input.public_domain_only) {
        notice = `No ${input.vocabulary} values were returned for public-domain works; call artic_lookup_vocabulary again without public_domain_only to count every artwork.`;
      }
      ctx.enrich.notice(notice);
    }

    return {
      vocabulary: input.vocabulary,
      ...(isFilterParam(input.vocabulary) ? { filter_param: input.vocabulary } : {}),
      values,
    };
  },

  format: (result) => {
    const lines = [`# ${result.vocabulary} values (${result.values.length})`];
    lines.push(
      result.filter_param
        ? `Pass a value as \`${result.filter_param}\` to artic_search_artworks; case is ignored.`
        : 'Not an artic_search_artworks filter; use a value as query text.',
    );
    lines.push('');
    if (result.values.length === 0) lines.push('No values.');
    for (const entry of result.values) {
      const unit = entry.artwork_count === 1 ? 'artwork' : 'artworks';
      lines.push(`- ${inlineSafe(entry.value)} (${entry.artwork_count} ${unit})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
