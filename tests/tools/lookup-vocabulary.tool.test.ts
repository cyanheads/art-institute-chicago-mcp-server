/**
 * @fileoverview Tests for the `artic_lookup_vocabulary` tool driven through a
 * real `AicService` over a fake `fetch`: input normalization, the aggregation
 * request, enrichment on the zero-result and under-cap pages, truncation and
 * zero-value guidance, upstream failure classes, and `format()` safety.
 * @module tests/tools/lookup-vocabulary.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { lookupVocabulary } from '@/mcp-server/tools/definitions/lookup-vocabulary.tool.js';
import { disposeAicService } from '@/services/aic/aic-service.js';
import { containsPattern, VOCABULARY_FIELDS } from '@/services/aic/aic-text.js';
import {
  GET_QUERY_LIMIT,
  jsonResponder,
  POST_BODY_LIMIT,
  queryStringBytes,
  scriptedFetch,
  searchBodyOf,
  searchCallOf,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import {
  errorOf,
  HOSTILE_INLINE,
  HOSTILE_INLINE_RENDERED,
  hasNoUnsafeCharacters,
  installAicService,
  recoveryFor,
  structuredOf,
  textOf,
  UPSTREAM_FAILURES,
} from '../fixtures/aic-tool-kit.js';
import { aggregationEnvelope, envelope } from '../fixtures/aic-upstream.js';

type VocabularyRun = {
  cap: number;
  filter_param?: string;
  notice?: string;
  shown: number;
  truncated: boolean;
  values: { artwork_count: number; value: string }[];
  vocabulary: string;
};

afterEach(() => disposeAicService());

const bucketBody = (fetchFake: ReturnType<typeof scriptedFetch>, call = 0) =>
  searchBodyOf(urlOfCall(fetchFake, call)) as {
    aggs: { v: { terms: { field: string; include?: string; size: number } } };
    limit: number;
    query?: unknown;
  };

describe('artic_lookup_vocabulary input', () => {
  it.each(Object.entries(VOCABULARY_FIELDS))('aggregates %s over %s', async (vocabulary, field) => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, { vocabulary } as never);
    expect(bucketBody(fetchFake).aggs.v.terms.field).toBe(field);
  });

  it('sends the default limit as the aggregation size, with no include and no query', async () => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, { vocabulary: 'department' });
    const body = bucketBody(fetchFake);
    expect(body.limit).toBe(0);
    expect(body.aggs.v.terms.size).toBe(25);
    expect(body.aggs.v.terms).not.toHaveProperty('include');
    expect(body).not.toHaveProperty('query');
  });

  it('compiles contains into a case- and accent-insensitive include regex, trimmed', async () => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, { vocabulary: 'style', contains: '  Impress  ' });
    expect(bucketBody(fetchFake).aggs.v.terms.include).toBe(containsPattern('Impress'));
  });

  it('escapes regex metacharacters in contains so they match literally', async () => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, { vocabulary: 'style', contains: 'a.b(c)*' });
    const include = bucketBody(fetchFake).aggs.v.terms.include ?? '';
    expect(include).toBe(containsPattern('a.b(c)*'));
    expect(new RegExp(`^${include}$`).test('A.B(C)*')).toBe(true);
    expect(new RegExp(`^${include}$`).test('axbcc')).toBe(false);
  });

  it('sends one request for an accented and an unaccented contains, the second from cache', async () => {
    const fetchFake = installAicService(
      scriptedFetch(
        jsonResponder(aggregationEnvelope('v', [{ key: "cote d'ivoire", doc_count: 53 }])),
      ),
    );
    const accented = await runToolContract(lookupVocabulary, {
      vocabulary: 'place_of_origin',
      contains: 'côte',
    });
    const plain = await runToolContract(lookupVocabulary, {
      vocabulary: 'place_of_origin',
      contains: 'cote',
    });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(bucketBody(fetchFake).aggs.v.terms.include).toBe(containsPattern('cote'));
    for (const result of [accented, plain]) {
      expect(structuredOf<VocabularyRun>(result).values).toEqual([
        { value: "cote d'ivoire", artwork_count: 53 },
      ]);
      expect(textOf(result)).toContain("- cote d'ivoire (53 artworks)");
    }
  });

  /** `o` has the longest letter class; a short contains stays a GET, a long one posts. */
  it.each([
    ['a short word', 'applique', 'GET'],
    ['the longest letter class', 'o'.repeat(60), 'POST'],
    ['realistic text', 'black-and-white photography with gelatin silver and ink wash', 'POST'],
    ['title-case letters', 'ǅ'.repeat(60), 'GET'],
    ['fullwidth letters', 'Ａ'.repeat(60), 'GET'],
  ])('sends a contains of %s inside the firewall limits', async (_name, contains, method) => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, {
      vocabulary: 'classification',
      contains,
      public_domain_only: true,
      limit: 100,
    });
    const call = searchCallOf(fetchFake);
    expect(call.method).toBe(method);
    expect((call.body.aggs as typeof call.body).v).toMatchObject({
      terms: { include: containsPattern(contains) },
    });
    if (call.method === 'GET')
      expect(queryStringBytes(call.url)).toBeLessThanOrEqual(GET_QUERY_LIMIT);
    else expect(Buffer.byteLength(String(call.init.body))).toBeLessThan(POST_BODY_LIMIT);
  });

  it.each(['', '   ', '\t\n'])('reads blank contains %j as unset', async (contains) => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'theme', contains });
    expect(result.isError).toBeUndefined();
    expect(bucketBody(fetchFake).aggs.v.terms).not.toHaveProperty('include');
  });

  it('restricts the count to public-domain works only when asked', async () => {
    const fetchFake = installAicService(
      scriptedFetch(
        jsonResponder(aggregationEnvelope('v', [])),
        jsonResponder(aggregationEnvelope('v', [])),
      ),
    );
    await runToolContract(lookupVocabulary, { vocabulary: 'department', public_domain_only: true });
    await runToolContract(lookupVocabulary, {
      vocabulary: 'department',
      public_domain_only: false,
    });
    expect(bucketBody(fetchFake, 0).query).toEqual({
      bool: { filter: [{ term: { is_public_domain: true } }] },
    });
    expect(bucketBody(fetchFake, 1)).not.toHaveProperty('query');
  });

  it('passes limit through as the aggregation size', async () => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    await runToolContract(lookupVocabulary, { vocabulary: 'subject', limit: 100 });
    expect(bucketBody(fetchFake).aggs.v.terms.size).toBe(100);
  });

  it.each([
    ['an unknown vocabulary', { vocabulary: 'nationality' }, 'vocabulary'],
    ['a missing vocabulary', {}, 'vocabulary'],
    ['contains over 60 characters', { vocabulary: 'style', contains: 'x'.repeat(61) }, 'contains'],
    ['limit 0', { vocabulary: 'style', limit: 0 }, 'limit'],
    ['limit 101', { vocabulary: 'style', limit: 101 }, 'limit'],
    ['a fractional limit', { vocabulary: 'style', limit: 2.5 }, 'limit'],
  ])('rejects %s as invalid arguments without calling upstream', async (_name, input, field) => {
    const fetchFake = installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const result = await runToolContract(lookupVocabulary, input as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain(`"${field}"`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('accepts contains at exactly 60 characters', async () => {
    installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'style',
      contains: 'x'.repeat(60),
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('artic_lookup_vocabulary output and enrichment', () => {
  it('returns the zero-result page with every required enrichment field', async () => {
    installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'department' });
    expect(structuredOf<VocabularyRun>(result)).toEqual({
      vocabulary: 'department',
      filter_param: 'department',
      values: [],
      truncated: false,
      shown: 0,
      cap: 25,
      notice:
        'No department values were returned; retry artic_lookup_vocabulary, or search artic_search_artworks with query text instead.',
    });
  });

  it('returns the under-cap page with truncated false and no notice', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(
          aggregationEnvelope('v', [
            { key: 'Prints and Drawings', doc_count: 3 },
            { key: 'Textiles', doc_count: 1 },
          ]),
        ),
      ),
    );
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'department', limit: 10 });
    const out = structuredOf<VocabularyRun>(result);
    expect(out).toEqual({
      vocabulary: 'department',
      filter_param: 'department',
      values: [
        { value: 'Prints and Drawings', artwork_count: 3 },
        { value: 'Textiles', artwork_count: 1 },
      ],
      truncated: false,
      shown: 2,
      cap: 10,
    });
    expect(out).not.toHaveProperty('notice');
  });

  it('reports truncation and how to see the rest when values exist beyond the limit', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(aggregationEnvelope('v', [{ key: 'Painting', doc_count: 9 }], 41)),
      ),
    );
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'artwork_type', limit: 1 }),
    );
    expect(out).toMatchObject({
      truncated: true,
      shown: 1,
      cap: 1,
      notice: 'More values exist: raise limit or narrow with contains.',
    });
  });

  it('stays untruncated when the aggregation reports nothing beyond the buckets', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(aggregationEnvelope('v', [{ key: 'Painting', doc_count: 9 }], 0)),
      ),
    );
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'artwork_type', limit: 1 }),
    );
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty('notice');
  });

  it('names the contains text and the unfiltered call when nothing matches', async () => {
    installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'style', contains: 'zzz' }),
    );
    expect(out.values).toEqual([]);
    expect(out.notice).toBe(
      'No style value contains "zzz". Call artic_lookup_vocabulary without contains to see the most common values.',
    );
  });

  it('points at the public-domain restriction when it is the likely cause of an empty list', async () => {
    installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'theme', public_domain_only: true }),
    );
    expect(out.notice).toContain('without public_domain_only');
  });

  it('tolerates an envelope with no aggregations at all', async () => {
    installAicService(scriptedFetch(jsonResponder(envelope([], { total: 0 }))));
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'gallery' }),
    );
    expect(out).toMatchObject({ values: [], truncated: false, shown: 0, cap: 25 });
  });

  it('stringifies numeric bucket keys', async () => {
    installAicService(
      scriptedFetch(jsonResponder(aggregationEnvelope('v', [{ key: 240, doc_count: 4 }]))),
    );
    const out = structuredOf<VocabularyRun>(
      await runToolContract(lookupVocabulary, { vocabulary: 'gallery' }),
    );
    expect(out.values).toEqual([{ value: '240', artwork_count: 4 }]);
  });

  it.each(Object.keys(VOCABULARY_FIELDS))(
    'names %s as the search filter its values feed, on both surfaces',
    async (vocabulary) => {
      installAicService(
        scriptedFetch(
          jsonResponder(aggregationEnvelope('v', [{ key: 'gold leaf', doc_count: 78 }])),
        ),
      );
      const result = await runToolContract(lookupVocabulary, { vocabulary } as never);
      expect(structuredOf<VocabularyRun>(result).filter_param).toBe(vocabulary);
      expect(textOf(result)).toContain(
        `Pass a value as \`${vocabulary}\` to artic_search_artworks; case is ignored.`,
      );
      expect(textOf(result)).not.toContain('query text');
    },
  );

  it('declares filter_param required in the output contract', () => {
    expect(lookupVocabulary.output.safeParse({ vocabulary: 'material', values: [] }).success).toBe(
      false,
    );
    expect(
      lookupVocabulary.output.safeParse({
        vocabulary: 'material',
        filter_param: 'material',
        values: [],
      }).success,
    ).toBe(true);
  });

  it('leaves the cap on the accumulator when the call fails before any result', async () => {
    installAicService(scriptedFetch(jsonResponder({}, 429)));
    const ctx = createMockContext({ errors: lookupVocabulary.errors });
    await expect(
      lookupVocabulary.handler(
        lookupVocabulary.input.parse({ vocabulary: 'style', limit: 7 }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(getEnrichment(ctx)).toEqual({ truncated: false, shown: 0, cap: 7 });
  });
});

describe('artic_lookup_vocabulary format', () => {
  it('renders the same values and counts as structuredContent, singular for one artwork', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(
          aggregationEnvelope('v', [
            { key: 'Painting', doc_count: 12 },
            { key: 'Mask', doc_count: 1 },
          ]),
        ),
      ),
    );
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'artwork_type' });
    const out = structuredOf<VocabularyRun>(result);
    const text = textOf(result);
    expect(text).toContain('# artwork_type values (2)');
    expect(text).toContain('Pass a value as `artwork_type` to artic_search_artworks');
    for (const entry of out.values) {
      expect(text).toContain(entry.value);
    }
    expect(text).toContain('- Painting (12 artworks)');
    expect(text).toContain('- Mask (1 artwork)');
    const { values, vocabulary, filter_param } = out;
    expect(lookupVocabulary.format?.({ values, vocabulary, filter_param } as never)).toEqual([
      { type: 'text', text },
    ]);
  });

  it('states there are no values on an empty list', async () => {
    installAicService(scriptedFetch(jsonResponder(aggregationEnvelope('v', []))));
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'style' });
    expect(textOf(result)).toContain('No values.');
  });

  it('escapes brackets and angle brackets, flattens CR/LF, and strips control characters', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(aggregationEnvelope('v', [{ key: HOSTILE_INLINE, doc_count: 2 }])),
      ),
    );
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'subject' });
    const text = textOf(result);
    expect(text).toContain(`- ${HOSTILE_INLINE_RENDERED} (2 artworks)`);
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    expect(text.split('\n').some((line) => line.startsWith('# Injected'))).toBe(false);
    expect(structuredOf<VocabularyRun>(result).values[0]?.value).toBe(HOSTILE_INLINE);
  });
});

describe('artic_lookup_vocabulary upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name',
    async ({ responder, options, code, reason, forbidden }) => {
      installAicService(scriptedFetch(responder), options);
      const result = await runToolContract(lookupVocabulary, { vocabulary: 'department' });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        expect(error.data.reason).toBe(reason);
        expect(error.data.recovery?.hint).toBe(recoveryFor(lookupVocabulary, reason));
        expect(textOf(result)).toContain(`Recovery: ${recoveryFor(lookupVocabulary, reason)}`);
      }
      for (const leak of forbidden ?? []) {
        expect(JSON.stringify(result)).not.toContain(leak);
      }
    },
  );

  it('declares the three shared reasons in the contract', () => {
    expect(lookupVocabulary.errors?.map((e) => e.reason)).toEqual([
      'rate_limited',
      'request_blocked',
      'upstream_rejected_query',
    ]);
  });
});
