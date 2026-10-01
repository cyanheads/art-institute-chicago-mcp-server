/**
 * @fileoverview Tests for the `artic_search_exhibitions` tool driven through a
 * real `AicService` over a fake `fetch`: input normalization and the request it
 * builds (`when`, date overlap, sort), the date-range guard, pagination and
 * window caps, zero-hit guidance, row normalization, enrichment on the
 * zero-result and under-cap pages, upstream failure classes, and `format()`
 * safety.
 * @module tests/tools/search-exhibitions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchExhibitions } from '@/mcp-server/tools/definitions/search-exhibitions.tool.js';
import { disposeAicService } from '@/services/aic/aic-service.js';
import { WINDOW_NOTICE } from '@/services/aic/aic-text.js';
import {
  hangingResponder,
  jsonResponder,
  scriptedFetch,
  searchBodyOf,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import {
  errorOf,
  HOSTILE_INLINE,
  HOSTILE_INLINE_RENDERED,
  hasNoUnsafeCharacters,
  installAicService,
  structuredOf,
  textOf,
  UPSTREAM_FAILURES,
} from '../fixtures/aic-tool-kit.js';
import {
  API_INVALID_LIMIT_BODY,
  API_INVALID_RESULTS_BODY,
  ARTWORK_LICENSE,
  exhibitionRecord,
  IIIF_URL,
  IMAGE_ID,
  searchEnvelope,
} from '../fixtures/aic-upstream.js';

interface ExhibitionsRun {
  cap: number;
  exhibitions: Record<string, unknown>[];
  has_more: boolean;
  license_text: string;
  next_page?: number;
  notice?: string;
  page: number;
  shown: number;
  sort_applied: string;
  totalCount: number;
  truncated: boolean;
  when_applied: string;
}

type FetchFake = ReturnType<typeof scriptedFetch>;

const FIELDS =
  'id,title,status,aic_start_at,aic_end_at,gallery_id,gallery_title,short_description,web_url,image_id,image_url,artwork_ids,artwork_titles,artist_ids,is_featured';

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

const rows = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => exhibitionRecord(from + index));

/** Installs a service whose every call answers `body`; returns the fetch fake. */
function serve(body: unknown): FetchFake {
  return installAicService(scriptedFetch(jsonResponder(body)));
}

const emptyResults = () => serve(searchEnvelope([], 0));

const bodyOf = (fetchFake: FetchFake, call = 0) => searchBodyOf(urlOfCall(fetchFake, call));

const filtersOf = (fetchFake: FetchFake, call = 0): unknown[] => {
  const query = bodyOf(fetchFake, call).query as { bool?: { filter?: unknown[] } } | undefined;
  return query?.bool?.filter ?? [];
};

const mustOf = (fetchFake: FetchFake, call = 0): unknown[] => {
  const query = bodyOf(fetchFake, call).query as { bool?: { must?: unknown[] } } | undefined;
  return query?.bool?.must ?? [];
};

const search = (input: Record<string, unknown> = {}) =>
  runToolContract(searchExhibitions, input as never);

// --- Request building -----------------------------------------------------------------------

describe('artic_search_exhibitions request', () => {
  it('sorts newest-first with no query, sending paging and the field allowlist only', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(bodyOf(fetchFake)).toEqual({
      sort: [{ aic_start_at: { order: 'desc' } }],
      page: 1,
      limit: 10,
      fields: FIELDS,
    });
    expect(out).toMatchObject({ when_applied: 'any', sort_applied: 'start_desc' });
  });

  it('ranks by relevance with a query, keeping q and a must clause and no explicit sort', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search({ query: '  impressionist  prints ' }));
    const body = bodyOf(fetchFake);
    expect(body.q).toBe('impressionist  prints');
    expect(body).not.toHaveProperty('sort');
    expect(mustOf(fetchFake)).toEqual([
      {
        simple_query_string: { query: 'impressionist  prints', default_operator: 'and' },
      },
    ]);
    expect(out.sort_applied).toBe('relevance');
  });

  it.each([
    ['start_asc', 'asc'],
    ['start_desc', 'desc'],
  ] as const)(
    'sorts %s by opening date, dropping q but keeping the text filter',
    async (sort, order) => {
      const fetchFake = emptyResults();
      const out = structuredOf<ExhibitionsRun>(await search({ query: 'prints', sort }));
      const body = bodyOf(fetchFake);
      expect(body.sort).toEqual([{ aic_start_at: { order } }]);
      expect(body).not.toHaveProperty('q');
      expect(mustOf(fetchFake)).toHaveLength(1);
      expect(out.sort_applied).toBe(sort);
    },
  );

  it('treats relevance without a query as start_desc', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search({ sort: 'relevance' }));
    expect(bodyOf(fetchFake).sort).toEqual([{ aic_start_at: { order: 'desc' } }]);
    expect(bodyOf(fetchFake)).not.toHaveProperty('q');
    expect(out.sort_applied).toBe('start_desc');
  });

  it.each([
    ['any', []],
    [
      'current',
      [{ range: { aic_start_at: { lte: 'now' } } }, { range: { aic_end_at: { gte: 'now' } } }],
    ],
    ['upcoming', [{ range: { aic_start_at: { gt: 'now' } } }]],
    ['past', [{ range: { aic_end_at: { lt: 'now' } } }]],
  ])('maps when=%s to Elasticsearch date math, never a server timestamp', async (when, filters) => {
    const fetchFake = emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search({ when }));
    expect(filtersOf(fetchFake)).toEqual(filters);
    expect(out.when_applied).toBe(when);
    expect(urlOfCall(fetchFake)).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it('maps a date window to an overlap of the run, not containment', async () => {
    const fetchFake = emptyResults();
    await search({ date_from: '2024-03-01', date_to: '2024-09-30' });
    expect(filtersOf(fetchFake)).toEqual([
      { range: { aic_end_at: { gte: '2024-03-01' } } },
      { range: { aic_start_at: { lte: '2024-09-30' } } },
    ]);
  });

  it.each([
    ['date_from', { date_from: '2024-03-01' }, { range: { aic_end_at: { gte: '2024-03-01' } } }],
    ['date_to', { date_to: '2024-09-30' }, { range: { aic_start_at: { lte: '2024-09-30' } } }],
  ])('accepts %s alone', async (_name, input, filter) => {
    const fetchFake = emptyResults();
    expect((await search(input)).isError).toBeUndefined();
    expect(filtersOf(fetchFake)).toEqual([filter]);
  });

  it('combines when with a date window', async () => {
    const fetchFake = emptyResults();
    await search({ when: 'past', date_from: '2000-01-01' });
    expect(filtersOf(fetchFake)).toEqual([
      { range: { aic_end_at: { lt: 'now' } } },
      { range: { aic_end_at: { gte: '2000-01-01' } } },
    ]);
  });

  it('passes page and limit upstream', async () => {
    const fetchFake = serve(searchEnvelope(rows(3, 21), 100));
    await search({ page: 3, limit: 20 });
    expect(bodyOf(fetchFake)).toMatchObject({ page: 3, limit: 20 });
  });

  it('builds the same request from blank optional inputs as from none', async () => {
    const fetchFake = emptyResults();
    await search();
    const blank = Object.fromEntries(
      ['query', 'when', 'date_from', 'date_to', 'sort'].map((name, index) => [
        name,
        index % 2 === 0 ? '' : '   ',
      ]),
    );
    const blankFetch = emptyResults();
    const result = await search(blank);
    expect(result.isError).toBeUndefined();
    expect(bodyOf(blankFetch)).toEqual(bodyOf(fetchFake));
    expect(structuredOf<ExhibitionsRun>(result)).toMatchObject({
      when_applied: 'any',
      sort_applied: 'start_desc',
    });
  });

  it('reads a blank query beside a sort as no query', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search({ query: '  ', sort: 'start_asc' }));
    expect(mustOf(fetchFake)).toEqual([]);
    expect(out.sort_applied).toBe('start_asc');
  });

  it.each([
    ['page', { page: '' }],
    ['limit', { limit: '   ' }],
  ])('reads a blank %s as unset, taking its default', async (_name, extra) => {
    const fetchFake = emptyResults();
    const result = await search(extra);
    expect(result.isError).toBeUndefined();
    expect(bodyOf(fetchFake)).toMatchObject({ page: 1, limit: 10 });
  });
});

// --- Input validation ----------------------------------------------------------------------------

describe('artic_search_exhibitions input validation', () => {
  it.each([
    ['a query over 200 characters', { query: 'x'.repeat(201) }, 'query'],
    ['an unknown when', { when: 'soon' }, 'when'],
    ['an unknown sort', { sort: 'popularity' }, 'sort'],
    ['a slash-separated date_from', { date_from: '2024/03/01' }, 'date_from'],
    ['a compact date_from', { date_from: '20240301' }, 'date_from'],
    ['a date-time date_from', { date_from: '2024-03-01T00:00:00Z' }, 'date_from'],
    ['an impossible month in date_to', { date_to: '2024-13-01' }, 'date_to'],
    ['an impossible day in date_to', { date_to: '2024-02-31' }, 'date_to'],
    ['a text date_to', { date_to: 'tomorrow' }, 'date_to'],
    ['page 0', { page: 0 }, 'page'],
    ['page 41', { page: 41 }, 'page'],
    ['limit 0', { limit: 0 }, 'limit'],
    ['limit 26', { limit: 26 }, 'limit'],
    ['a fractional page', { page: 1.5 }, 'page'],
  ])('rejects %s without calling upstream', async (_name, input, field) => {
    const fetchFake = emptyResults();
    const error = errorOf(await search(input));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain(`"${field}"`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    ['page 40 at limit 25', { page: 40, limit: 25 }],
    ['limit 25', { limit: 25 }],
    ['a leap day', { date_from: '2024-02-29' }],
    ['a query of exactly 200 characters', { query: 'x'.repeat(200) }],
  ])('accepts %s', async (_name, input) => {
    emptyResults();
    expect((await search(input)).isError).toBeUndefined();
  });
});

// --- Date-range guard -----------------------------------------------------------------------------

describe('artic_search_exhibitions date-range guard', () => {
  it('fails invalid_date_range when date_from is later than date_to', async () => {
    const fetchFake = emptyResults();
    const result = await search({ date_from: '2024-10-01', date_to: '2024-09-30' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_date_range');
    expect(error.data.recovery?.hint).toBe(
      'Set date_from on or before date_to, both as YYYY-MM-DD, and call artic_search_exhibitions again.',
    );
    expect(textOf(result)).toContain('Recovery: Set date_from on or before date_to');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('accepts equal dates, a one-day window', async () => {
    const fetchFake = emptyResults();
    const result = await search({ date_from: '2024-05-05', date_to: '2024-05-05' });
    expect(result.isError).toBeUndefined();
    expect(filtersOf(fetchFake)).toEqual([
      { range: { aic_end_at: { gte: '2024-05-05' } } },
      { range: { aic_start_at: { lte: '2024-05-05' } } },
    ]);
  });

  it('compares dates across a year boundary', async () => {
    emptyResults();
    expect(
      errorOf(await search({ date_from: '2025-01-01', date_to: '2024-12-31' })).data.reason,
    ).toBe('invalid_date_range');
  });

  it('does not reject a reversed window when one date is blank', async () => {
    emptyResults();
    const result = await search({ date_from: '2025-01-01', date_to: '' });
    expect(result.isError).toBeUndefined();
  });

  it.each([
    ['Invalid limit', API_INVALID_LIMIT_BODY],
    ['Invalid number of results', API_INVALID_RESULTS_BODY],
  ])('maps an upstream "%s" refusal to page_beyond_window', async (_name, body) => {
    installAicService(scriptedFetch(jsonResponder(body, 403)));
    const result = await search({ query: 'prints' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('page_beyond_window');
    expect(error.data.recovery?.hint).toBe(
      'Only the first 1,000 matches are reachable. Narrow artic_search_exhibitions with query text, when, or date_from and date_to.',
    );
  });
});

// --- Pagination and enrichment -----------------------------------------------------------------------------

describe('artic_search_exhibitions paging and enrichment', () => {
  it('returns the zero-result page with every required enrichment field', async () => {
    emptyResults();
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(out).toEqual({
      exhibitions: [],
      when_applied: 'any',
      sort_applied: 'start_desc',
      page: 1,
      has_more: false,
      license_text: ARTWORK_LICENSE,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 10,
      notice: 'No exhibitions matched.',
    });
  });

  it('adds every zero-hit fragment that applies, in order', async () => {
    emptyResults();
    const out = structuredOf<ExhibitionsRun>(
      await search({ query: 'nothing', when: 'upcoming', date_from: '2030-01-01' }),
    );
    expect(out.notice).toBe(
      'No exhibitions matched. Set when to "any" to include all dates. Widen date_from/date_to. All words must match; try fewer words.',
    );
  });

  it.each([
    [
      'when alone',
      { when: 'current' },
      'No exhibitions matched. Set when to "any" to include all dates.',
    ],
    [
      'a date_to alone',
      { date_to: '1900-01-01' },
      'No exhibitions matched. Widen date_from/date_to.',
    ],
    [
      'a query alone',
      { query: 'zzz' },
      'No exhibitions matched. All words must match; try fewer words.',
    ],
  ])('gives the zero-hit fragment for %s', async (_name, input, notice) => {
    emptyResults();
    expect(structuredOf<ExhibitionsRun>(await search(input)).notice).toBe(notice);
  });

  it('returns the under-cap page with the total, no next page, and no notice', async () => {
    serve(searchEnvelope(rows(3), 3));
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(out).toMatchObject({
      page: 1,
      has_more: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
    });
    expect(out.exhibitions.map((exhibition) => exhibition.id)).toEqual([1, 2, 3]);
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('points at the next page when matches remain inside the window', async () => {
    serve(searchEnvelope(rows(10), 25));
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(out).toMatchObject({
      has_more: true,
      next_page: 2,
      totalCount: 25,
      truncated: true,
      shown: 10,
      cap: 10,
      notice: 'More matches: call again with page 2.',
    });
  });

  it('ends on the last partial page', async () => {
    serve(searchEnvelope(rows(5, 21), 25));
    const out = structuredOf<ExhibitionsRun>(await search({ page: 3 }));
    expect(out).toMatchObject({ page: 3, has_more: false, truncated: false, shown: 5 });
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('has no more when the page ends exactly on the total', async () => {
    serve(searchEnvelope(rows(10, 11), 20));
    const out = structuredOf<ExhibitionsRun>(await search({ page: 2 }));
    expect(out.has_more).toBe(false);
    expect(out).not.toHaveProperty('next_page');
  });

  it('explains a page past the last match', async () => {
    serve(searchEnvelope([], 25));
    const out = structuredOf<ExhibitionsRun>(await search({ page: 4 }));
    expect(out).toMatchObject({ has_more: false, truncated: false, shown: 0, totalCount: 25 });
    expect(out.notice).toBe('Page 4 is past the last match (25 total); request a lower page.');
  });

  it('offers page 40 at limit 25 because it still ends inside the window', async () => {
    serve(searchEnvelope(rows(25, 951), 5000));
    const out = structuredOf<ExhibitionsRun>(await search({ page: 39, limit: 25 }));
    expect(out).toMatchObject({ has_more: true, next_page: 40 });
  });

  it('withholds next_page and names the window on the last reachable page', async () => {
    serve(searchEnvelope(rows(25, 976), 5000));
    const out = structuredOf<ExhibitionsRun>(await search({ page: 40, limit: 25 }));
    expect(out).toMatchObject({
      has_more: true,
      truncated: true,
      shown: 25,
      notice: WINDOW_NOTICE,
    });
    expect(out).not.toHaveProperty('next_page');
  });

  it('skips upstream rows with no integer id and counts only what it returns', async () => {
    serve(searchEnvelope([exhibitionRecord(1), { title: 'no id' }, null, { id: 'x' }], 4));
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(out.exhibitions.map((exhibition) => exhibition.id)).toEqual([1]);
    expect(out.shown).toBe(1);
  });

  it('falls back to the row count when the envelope reports no total', async () => {
    serve({ data: [exhibitionRecord(1)], info: { license_text: 'x' } });
    const out = structuredOf<ExhibitionsRun>(await search());
    expect(out).toMatchObject({ totalCount: 1, shown: 1, has_more: false });
  });
});

// --- Records ---------------------------------------------------------------------------------------------------

describe('artic_search_exhibitions records', () => {
  it('normalizes a fully populated exhibition', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(7, {
            status: 'Confirmed',
            gallery_id: 4,
            gallery_title: 'Gallery 100',
            short_description: '<p>A synthetic <em>show</em>.</p><p>Second &amp; last.</p>',
            web_url: 'https://www.artic.edu/exhibitions/7/synthetic',
            image_id: '11111111-2222-3333-4444-555555555555',
            image_url: 'https://images.example.test/ignored.jpg',
            artwork_ids: [101, 102],
            artwork_titles: ['First Work', '<em>Second</em> Work'],
            artist_ids: [900, 901],
            is_featured: true,
          }),
        ],
        1,
      ),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition).toMatchObject({
      id: 7,
      title: 'Synthetic Exhibition 7',
      status: 'Confirmed',
      start: '2020-01-01T00:00:00-06:00',
      end: '2020-06-01T00:00:00-05:00',
      gallery: 'Gallery 100',
      web_url: 'https://www.artic.edu/exhibitions/7/synthetic',
      image_url: `${IIIF_URL}/11111111-2222-3333-4444-555555555555/full/843,/0/default.jpg`,
      is_featured: true,
      artwork_count: 2,
      artworks: [
        { id: 101, title: 'First Work' },
        { id: 102, title: 'Second Work' },
      ],
      artist_ids: [900, 901],
    });
    expect(exhibition?.summary).toMatch(/^A synthetic show\.\s+Second & last\.$/);
    expect(exhibition).not.toHaveProperty('gallery_id');
  });

  it('falls back to the museum image URL when no IIIF image id is linked', async () => {
    serve(
      searchEnvelope(
        [exhibitionRecord(1, { image_url: 'https://images.example.test/show.jpg' })],
        1,
      ),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.image_url).toBe('https://images.example.test/show.jpg');
  });

  it('builds the IIIF image URL on the base the envelope reports', async () => {
    serve(
      searchEnvelope([exhibitionRecord(1, { image_id: IMAGE_ID })], 1, {
        iiifUrl: 'https://www.artic.edu/iiif/3',
      }),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.image_url).toBe(
      `https://www.artic.edu/iiif/3/${IMAGE_ID}/full/843,/0/default.jpg`,
    );
  });

  it('prints no web or image line for a URL that is not http or https', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(1, {
            web_url: 'javascript:alert(1)',
            image_url: 'data:image/png;base64,AAAA',
          }),
        ],
        1,
      ),
    );
    const result = await search();
    const [exhibition] = structuredOf<ExhibitionsRun>(result).exhibitions;
    expect(exhibition).not.toHaveProperty('web_url');
    expect(exhibition).not.toHaveProperty('image_url');
    expect(textOf(result)).not.toContain('javascript:');
    expect(textOf(result)).not.toContain('data:image');
  });

  it('pairs artwork ids with titles by index when the lists are the same length', async () => {
    serve(
      searchEnvelope(
        [exhibitionRecord(1, { artwork_ids: [5, 6, 7], artwork_titles: ['A', 'B', 'C'] })],
        1,
      ),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.artworks).toEqual([
      { id: 5, title: 'A' },
      { id: 6, title: 'B' },
      { id: 7, title: 'C' },
    ]);
  });

  it.each([
    ['more ids than titles', [5, 6, 7], ['A', 'B']],
    ['more titles than ids', [5, 6], ['A', 'B', 'C']],
    ['no titles', [5, 6], []],
  ])(
    'gives each artwork its id alone, never a guessed title, with %s',
    async (_name, ids, titles) => {
      serve(searchEnvelope([exhibitionRecord(1, { artwork_ids: ids, artwork_titles: titles })], 1));
      const result = await search();
      const [exhibition] = structuredOf<ExhibitionsRun>(result).exhibitions;
      expect(exhibition?.artworks).toEqual(ids.map((id) => ({ id })));
      expect(exhibition?.artwork_count).toBe(ids.length);
      const text = textOf(result);
      for (const id of ids) expect(text).toContain(`  - id ${id}`);
    },
  );

  it('keeps an artwork id with a blank title as an id alone', async () => {
    serve(
      searchEnvelope([exhibitionRecord(1, { artwork_ids: [5, 6], artwork_titles: ['', 'B'] })], 1),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.artworks).toEqual([{ id: 5 }, { id: 6, title: 'B' }]);
  });

  it('ignores non-integer artwork and artist ids', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(1, {
            artwork_ids: [5, 'x', null, 6.5, 7],
            artwork_titles: ['A', 'B', 'C', 'D', 'E'],
            artist_ids: [9, 'y', null],
          }),
        ],
        1,
      ),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.artwork_count).toBe(2);
    expect(exhibition?.artist_ids).toEqual([9]);
  });

  it('survives a record that carries nothing but an id', async () => {
    serve(searchEnvelope([{ id: 5 }], 1));
    const result = await search();
    const [exhibition] = structuredOf<ExhibitionsRun>(result).exhibitions;
    expect(exhibition).toEqual({
      id: 5,
      title: '',
      artwork_count: 0,
      artworks: [],
      artist_ids: [],
    });
    const text = textOf(result);
    expect(text).toContain('## (untitled) (id 5)');
    expect(text).toContain('- **Artworks listed:** 0');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('omits null and empty-string fields instead of reporting them', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(1, {
            status: '',
            gallery_title: '',
            short_description: '',
            web_url: '',
            image_url: '',
            is_featured: null,
          }),
        ],
        1,
      ),
    );
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    for (const key of ['status', 'gallery', 'summary', 'web_url', 'image_url', 'is_featured']) {
      expect(exhibition).not.toHaveProperty(key);
    }
  });

  it('keeps is_featured false, which is a recorded value', async () => {
    serve(searchEnvelope([exhibitionRecord(1, { is_featured: false })], 1));
    const [exhibition] = structuredOf<ExhibitionsRun>(await search()).exhibitions;
    expect(exhibition?.is_featured).toBe(false);
  });
});

// --- Upstream failures -----------------------------------------------------------------------------------------

describe('artic_search_exhibitions upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name',
    async ({ responder, options, code, reason, forbidden }) => {
      installAicService(scriptedFetch(responder), options);
      const result = await search({ query: 'prints' });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        const hint = searchExhibitions.errors?.find((entry) => entry.reason === reason)?.recovery;
        expect(hint).toBeTruthy();
        expect(error.data.reason).toBe(reason);
        expect(error.data.recovery?.hint).toBe(hint);
        expect(textOf(result)).toContain(`Recovery: ${hint}`);
      }
      for (const leak of forbidden ?? []) {
        expect(JSON.stringify(result)).not.toContain(leak);
      }
    },
  );

  it('surfaces cancellation as RequestCancelled rather than a service failure', async () => {
    const controller = new AbortController();
    const fetchFake = installAicService(scriptedFetch(hangingResponder));
    const pending = runToolContract(
      searchExhibitions,
      { query: 'prints' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(fetchFake).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('declares the five contract reasons with their codes', () => {
    expect(searchExhibitions.errors?.map((entry) => [entry.reason, entry.code])).toEqual([
      ['invalid_date_range', JsonRpcErrorCode.ValidationError],
      ['page_beyond_window', JsonRpcErrorCode.ValidationError],
      ['rate_limited', JsonRpcErrorCode.RateLimited],
      ['request_blocked', JsonRpcErrorCode.Forbidden],
      ['upstream_rejected_query', JsonRpcErrorCode.InternalError],
    ]);
  });
});

// --- format() ----------------------------------------------------------------------------------------------------

describe('artic_search_exhibitions format', () => {
  it('carries the same data as structuredContent', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(7, {
            status: 'Confirmed',
            gallery_title: 'Gallery 100',
            short_description: '<p>A synthetic show.</p>',
            web_url: 'https://www.artic.edu/exhibitions/7/synthetic',
            image_url: 'https://images.example.test/show.jpg',
            artwork_ids: [101, 102],
            artwork_titles: ['First Work', 'Second Work'],
            artist_ids: [900, 901],
            is_featured: true,
          }),
          exhibitionRecord(8),
        ],
        25,
      ),
    );
    const result = await search({ query: 'synthetic' });
    const out = structuredOf<ExhibitionsRun>(result);
    const text = textOf(result);

    expect(text).toContain('# Exhibitions (2 on this page)');
    expect(text).toContain(`**Page:** ${out.page}`);
    expect(text).toContain(`**When applied:** ${out.when_applied}`);
    expect(text).toContain(`**Sort applied:** ${out.sort_applied}`);
    expect(text).toContain('**More matches:** yes');
    expect(text).toContain(`**Next page:** ${out.next_page}`);
    for (const exhibition of out.exhibitions) {
      expect(text).toContain(`## ${exhibition.title} (id ${exhibition.id})`);
      expect(text).toContain(String(exhibition.start));
      expect(text).toContain(String(exhibition.end));
    }
    expect(text).toContain('**Status:** Confirmed · **Gallery:** Gallery 100 · **Featured:** yes');
    expect(text).toContain('- **Web:** https://www.artic.edu/exhibitions/7/synthetic');
    expect(text).toContain('- **Image:** https://images.example.test/show.jpg');
    expect(text).toContain('- **Artist ids:** 900, 901');
    expect(text).toContain('- **Artworks listed:** 2');
    expect(text).toContain('  - First Work (id 101)');
    expect(text).toContain('  - Second Work (id 102)');
    expect(text).toContain('### Summary\n> A synthetic show.');
    expect(text).toContain('## License');
    expect(text).toContain(`> ${out.license_text}`);
  });

  it('equals the format() of the structured output', async () => {
    serve(searchEnvelope(rows(2), 2));
    const result = await search();
    const { totalCount, truncated, shown, cap, notice, ...output } =
      structuredOf<ExhibitionsRun>(result);
    void [totalCount, truncated, shown, cap, notice];
    expect(searchExhibitions.format?.(output as never)).toEqual([
      { type: 'text', text: textOf(result) },
    ]);
  });

  it('says there are no rows on an empty page', async () => {
    emptyResults();
    expect(textOf(await search())).toContain('No exhibition rows on this page.');
  });

  it('percent-encodes brackets in printed URLs and leaves structuredContent untouched', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(1, {
            web_url: 'https://www.artic.edu/exhibitions/a[1]',
            image_url: 'https://images.example.test/b[2].jpg',
          }),
        ],
        1,
      ),
    );
    const result = await search();
    const text = textOf(result);
    expect(text).toContain('https://www.artic.edu/exhibitions/a%5B1%5D');
    expect(text).toContain('https://images.example.test/b%5B2%5D.jpg');
    expect(text).not.toContain('a[1]');
    const [exhibition] = structuredOf<ExhibitionsRun>(result).exhibitions;
    expect(exhibition?.web_url).toBe('https://www.artic.edu/exhibitions/a[1]');
  });

  it('keeps hostile upstream text out of inline markdown slots and structuredContent verbatim', async () => {
    serve(
      searchEnvelope(
        [
          exhibitionRecord(1, {
            title: 'Show&#13;&#10;# Injected title &lt;x&gt; [y]',
            status: HOSTILE_INLINE,
            gallery_title: HOSTILE_INLINE,
            aic_start_at: HOSTILE_INLINE,
            aic_end_at: HOSTILE_INLINE,
            short_description: 'Line one<br># Fake heading<br><br>Line three\u0007',
            artwork_ids: [5],
            artwork_titles: ['Work&#13;&#10;# Injected work [z]'],
          }),
        ],
        1,
        { license: 'License one\r\n# Fake heading\r\n\r\nLicense three' },
      ),
    );
    const result = await search();
    const text = textOf(result);
    const [exhibition] = structuredOf<ExhibitionsRun>(result).exhibitions;

    expect(text).toContain('## Show # Injected title \\<x\\> \\[y\\] (id 1)');
    expect(text).toContain(
      `- **Dates:** opens ${HOSTILE_INLINE_RENDERED} · closes ${HOSTILE_INLINE_RENDERED}`,
    );
    expect(text).toContain(
      `**Status:** ${HOSTILE_INLINE_RENDERED} · **Gallery:** ${HOSTILE_INLINE_RENDERED}`,
    );
    expect(text).toContain('  - Work # Injected work \\[z\\] (id 5)');
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Exhibitions (1 on this page)',
    ]);
    const summary = text.slice(text.indexOf('### Summary')).split('\n').slice(1, 5);
    expect(summary).toEqual(['> Line one', '> # Fake heading', '>', '> Line three']);
    const licenseLines = text.slice(text.indexOf('## License')).split('\n').slice(1);
    expect(licenseLines).toEqual(['> License one', '> # Fake heading', '>', '> License three']);

    expect(exhibition?.title).toBe('Show\n# Injected title <x> [y]');
    expect(exhibition?.status).toBe(HOSTILE_INLINE);
    expect(exhibition?.gallery).toBe(HOSTILE_INLINE);
    expect(exhibition?.artworks).toEqual([{ id: 5, title: 'Work\n# Injected work [z]' }]);
    expect(structuredOf<ExhibitionsRun>(result).license_text).toBe(
      'License one\r\n# Fake heading\r\n\r\nLicense three',
    );
  });
});
