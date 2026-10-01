/**
 * @fileoverview Tests for the `artic_search_artworks` tool driven through a
 * real `AicService` over a fake `fetch`: input normalization and the request
 * it builds, the page and year-range guards, pagination and window caps,
 * zero-hit guidance, facets, row normalization, enrichment on the zero-result
 * and under-cap pages, upstream failure classes, and `format()` safety.
 * @module tests/tools/search-artworks.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchArtworks } from '@/mcp-server/tools/definitions/search-artworks.tool.js';
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
  fieldOf,
  HOSTILE_INLINE,
  HOSTILE_INLINE_RENDERED,
  hasNoUnsafeCharacters,
  installAicService,
  recoveryFor,
  structuredOf,
  textOf,
  UPSTREAM_FAILURES,
} from '../fixtures/aic-tool-kit.js';
import {
  API_INVALID_LIMIT_BODY,
  API_INVALID_RESULTS_BODY,
  ARTWORK_LICENSE,
  artworkRecord,
  IIIF_URL,
  IMAGE_ID,
  inCopyrightArtworkRecord,
  placeholderYearArtworkRecord,
  searchEnvelope,
  sparseArtworkRecord,
} from '../fixtures/aic-upstream.js';

interface SearchRun {
  artworks: Record<string, unknown>[];
  cap: number;
  facets?: Record<string, unknown[]>;
  has_more: boolean;
  license_text: string;
  next_page?: number;
  notice?: string;
  page: number;
  shown: number;
  sort_applied: string;
  totalCount: number;
  truncated: boolean;
}

type FetchFake = ReturnType<typeof scriptedFetch>;

const FIELDS =
  'id,title,artist_display,artist_id,artist_title,date_display,date_start,date_end,medium_display,artwork_type_title,department_title,place_of_origin,is_public_domain,is_on_view,gallery_title,image_id,thumbnail';

const PAGE_BOUND_RECOVERY =
  'Only the first 1,000 matches of a search are reachable. Narrow artic_search_artworks with filters such as department, artwork_type, or year_from, using values from artic_lookup_vocabulary.';
const YEAR_RANGE_RECOVERY =
  'Set year_from at or below year_to; use negative years for BCE, for example year_from -500.';

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

const rows = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => artworkRecord(from + index));

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

const search = (input: Record<string, unknown> = {}) =>
  runToolContract(searchArtworks, input as never);

// --- Request building ----------------------------------------------------------------

describe('artic_search_artworks request', () => {
  it('sends only paging and the field allowlist for an empty search', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<SearchRun>(await search());
    expect(bodyOf(fetchFake)).toEqual({ page: 1, limit: 10, fields: FIELDS });
    expect(out.sort_applied).toBe('popularity');
  });

  it('matches query text through a must clause and keeps q for ranking', async () => {
    const fetchFake = emptyResults();
    const out = structuredOf<SearchRun>(await search({ query: '  water lilies  ' }));
    expect(bodyOf(fetchFake)).toMatchObject({
      q: 'water lilies',
      query: {
        bool: {
          must: [{ simple_query_string: { query: 'water lilies', default_operator: 'and' } }],
        },
      },
    });
    expect(out.sort_applied).toBe('relevance');
  });

  it.each([
    ['date_asc', 'asc'],
    ['date_desc', 'desc'],
  ] as const)('sorts by start year for %s and drops q', async (sort, order) => {
    const fetchFake = emptyResults();
    const out = structuredOf<SearchRun>(await search({ query: 'water', sort }));
    const body = bodyOf(fetchFake);
    expect(body).not.toHaveProperty('q');
    expect(body.sort).toEqual([{ date_start: { order } }]);
    expect(filtersOf(fetchFake)).toContainEqual({
      range: { date_start: { gte: -8000, lte: 2100 } },
    });
    expect(out.sort_applied).toBe(sort);
  });

  it('builds the same request from blank optional inputs as from none', async () => {
    const fetchFake = emptyResults();
    await search();
    const blank = Object.fromEntries(
      [
        'query',
        'artist',
        'artist_id',
        'department',
        'artwork_type',
        'style',
        'subject',
        'classification',
        'place_of_origin',
        'gallery',
        'year_from',
        'year_to',
        'facets',
        'sort',
      ].map((name, index) => [name, index % 2 === 0 ? '' : '   ']),
    );
    const blankFetch = installAicService(scriptedFetch(jsonResponder(searchEnvelope([], 0))));
    const result = await search(blank);
    expect(result.isError).toBeUndefined();
    expect(bodyOf(blankFetch)).toEqual(bodyOf(fetchFake));
    expect(structuredOf<SearchRun>(result).sort_applied).toBe('popularity');
  });

  it.each([
    ['department', 'pc-10', { term: { department_id: 'PC-10' } }],
    ['department', '  Pc-10 ', { term: { department_id: 'PC-10' } }],
    ['style', 'tm-5', { term: { style_ids: 'TM-5' } }],
    ['subject', 'tm-7', { term: { subject_ids: 'TM-7' } }],
    ['classification', 'Tm-9', { term: { classification_ids: 'TM-9' } }],
    ['artwork_type', '12', { term: { artwork_type_id: 12 } }],
    [
      'department',
      'Prints and Drawings',
      {
        term: {
          'department_title.keyword': { value: 'Prints and Drawings', case_insensitive: true },
        },
      },
    ],
    [
      'artwork_type',
      ' Painting ',
      { term: { 'artwork_type_title.keyword': { value: 'Painting', case_insensitive: true } } },
    ],
    [
      'place_of_origin',
      'France',
      { term: { 'place_of_origin.keyword': { value: 'France', case_insensitive: true } } },
    ],
    [
      'gallery',
      '240',
      { term: { 'gallery_title.keyword': { value: 'Gallery 240', case_insensitive: true } } },
    ],
    [
      'gallery',
      ' 211a ',
      { term: { 'gallery_title.keyword': { value: 'Gallery 211a', case_insensitive: true } } },
    ],
    [
      'gallery',
      'Gallery 240',
      { term: { 'gallery_title.keyword': { value: 'Gallery 240', case_insensitive: true } } },
    ],
    [
      'department',
      'Ryerson and Burnham Libraries Special Collections',
      {
        term: {
          'department_title.keyword': {
            value: 'Ryerson and Burnham Libraries Special Collections',
            case_insensitive: true,
          },
        },
      },
    ],
  ])('routes %s %j through the schema to %j', async (name, value, clause) => {
    const fetchFake = emptyResults();
    await search({ [name]: value });
    expect(filtersOf(fetchFake)).toEqual([clause]);
  });

  it('reaches the id route for a lower-case pc- department input', async () => {
    const fetchFake = emptyResults();
    await search({ department: 'pc-10' });
    const [clause] = filtersOf(fetchFake) as { term: Record<string, unknown> }[];
    expect(clause?.term).toEqual({ department_id: 'PC-10' });
    expect(JSON.stringify(clause)).not.toContain('pc-10');
  });

  it('filters artist by name and by id', async () => {
    const fetchFake = emptyResults();
    await search({ artist: ' Test Artist ', artist_id: 900 });
    expect(filtersOf(fetchFake)).toEqual([
      { match: { artist_titles: { query: 'Test Artist', operator: 'and' } } },
      { term: { artist_ids: 900 } },
    ]);
  });

  it('adds overlap ranges plus the placeholder-year bounds for a year span', async () => {
    const fetchFake = emptyResults();
    await search({ year_from: -500, year_to: 1500 });
    expect(filtersOf(fetchFake)).toEqual([
      { range: { date_end: { gte: -500 } } },
      { range: { date_start: { lte: 1500 } } },
      { range: { date_start: { gte: -8000 } } },
      { range: { date_end: { lte: 2100 } } },
    ]);
  });

  it('accepts one open end and an equal from and to', async () => {
    const fetchFake = installAicService(
      scriptedFetch(jsonResponder(searchEnvelope([], 0)), jsonResponder(searchEnvelope([], 0))),
    );
    expect((await search({ year_to: 1500 })).isError).toBeUndefined();
    expect((await search({ year_from: 1900, year_to: 1900 })).isError).toBeUndefined();
    expect(filtersOf(fetchFake, 0)).toEqual([
      { range: { date_start: { lte: 1500 } } },
      { range: { date_start: { gte: -8000 } } },
      { range: { date_end: { lte: 2100 } } },
    ]);
    expect(filtersOf(fetchFake, 1)).toContainEqual({ range: { date_end: { gte: 1900 } } });
    expect(filtersOf(fetchFake, 1)).toContainEqual({ range: { date_start: { lte: 1900 } } });
  });

  it('adds one clause per scope flag', async () => {
    const fetchFake = emptyResults();
    await search({ public_domain_only: true, on_view_only: true, has_image: true });
    expect(filtersOf(fetchFake)).toEqual([
      { term: { is_public_domain: true } },
      { term: { is_on_view: true } },
      { exists: { field: 'image_id' } },
    ]);
  });

  it.each([
    ['an array', ['department', 'style']],
    ['a comma string', 'department,style'],
    ['a comma string with spaces, blanks, and duplicates', ' department , ,style,department '],
  ])('requests facet aggregations from %s', async (_name, facets) => {
    const fetchFake = emptyResults();
    await search({ facets });
    expect(bodyOf(fetchFake).aggs).toEqual({
      department: { terms: { field: 'department_title.keyword', size: 15 } },
      style: { terms: { field: 'style_titles.keyword', size: 15 } },
    });
  });

  it('keys the artist facet on the id and labels it with a one-hit top_hits', async () => {
    const fetchFake = emptyResults();
    await search({ facets: ['artist'] });
    expect(bodyOf(fetchFake).aggs).toEqual({
      artist: {
        terms: { field: 'artist_id', size: 15 },
        aggs: { label: { top_hits: { size: 1, _source: ['artist_title'] } } },
      },
    });
  });

  it('accepts all seven facets and omits aggs when none are requested', async () => {
    const fetchFake = installAicService(
      scriptedFetch(jsonResponder(searchEnvelope([], 0)), jsonResponder(searchEnvelope([], 0))),
    );
    await search({
      facets: 'department,artwork_type,style,subject,classification,place_of_origin,artist',
    });
    await search({ facets: [] });
    expect(Object.keys(bodyOf(fetchFake, 0).aggs as object)).toHaveLength(7);
    expect(bodyOf(fetchFake, 1)).not.toHaveProperty('aggs');
  });
});

// --- Validation -----------------------------------------------------------------------

describe('artic_search_artworks validation', () => {
  it.each([
    ['limit 101', { limit: 101 }, 'limit'],
    ['a negative limit', { limit: -1 }, 'limit'],
    ['page 0', { page: 0 }, 'page'],
    ['page 1001', { page: 1001 }, 'page'],
    ['an unknown sort', { sort: 'newest' }, 'sort'],
    ['an unknown facet', { facets: 'department,bogus' }, 'facets'],
    ['artist_id 0', { artist_id: 0 }, 'artist_id'],
    ['a fractional artist_id', { artist_id: 1.5 }, 'artist_id'],
    ['year_from past 2100', { year_from: 2101 }, 'year_from'],
    ['year_to before -8000', { year_to: -8001 }, 'year_to'],
    ['a 201-character query', { query: 'x'.repeat(201) }, 'query'],
    ['a 121-character artist', { artist: 'x'.repeat(121) }, 'artist'],
    ['a 121-character department', { department: 'x'.repeat(121) }, 'department'],
  ])('rejects %s without calling upstream', async (_name, input, field) => {
    const fetchFake = emptyResults();
    const error = errorOf(await search(input));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain(`"${field}"`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('cuts an over-long facet list before validation so it fails with a bounded issue count', async () => {
    emptyResults();
    const facets = [
      'department',
      'artwork_type',
      'style',
      'subject',
      'classification',
      'place_of_origin',
      'artist',
      ...Array.from({ length: 40 }, (_, index) => `bogus${index}`),
    ];
    const error = errorOf(await search({ facets }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((error.data.issues as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it('accepts the boundary values 0, 100, 1, and 1000', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(searchEnvelope([], 0)),
        jsonResponder(searchEnvelope([], 0)),
        jsonResponder(searchEnvelope([], 0)),
      ),
    );
    expect((await search({ limit: 0 })).isError).toBeUndefined();
    expect((await search({ limit: 100 })).isError).toBeUndefined();
    expect((await search({ page: 1000, limit: 1 })).isError).toBeUndefined();
  });
});

describe('artic_search_artworks window and range guards', () => {
  it.each([
    [11, 100],
    [1000, 2],
    [501, 2],
    [101, 10],
  ])(
    'fails page %i with limit %i as page_beyond_window before calling upstream',
    async (page, limit) => {
      const fetchFake = emptyResults();
      const result = await search({ page, limit });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('page_beyond_window');
      expect(error.data.recovery?.hint).toBe(PAGE_BOUND_RECOVERY);
      expect(error.message).toContain(`Page ${page} with limit ${limit}`);
      expect(textOf(result)).toContain(`Recovery: ${PAGE_BOUND_RECOVERY}`);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it.each([
    [10, 100],
    [1000, 1],
    [500, 2],
    [100, 10],
  ])('allows page %i with limit %i, exactly on the window edge', async (page, limit) => {
    const fetchFake = emptyResults();
    expect((await search({ page, limit })).isError).toBeUndefined();
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('fails year_from above year_to as invalid_year_range before calling upstream', async () => {
    const fetchFake = emptyResults();
    const result = await search({ year_from: 2000, year_to: 1900 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_year_range');
    expect(error.data.recovery?.hint).toBe(YEAR_RANGE_RECOVERY);
    expect(error.message).toContain('year_from 2000 is later than year_to 1900');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('reports the window before the year range when both are violated', async () => {
    emptyResults();
    const error = errorOf(await search({ page: 11, limit: 100, year_from: 2000, year_to: 1900 }));
    expect(error.data.reason).toBe('page_beyond_window');
  });

  it.each([
    ['Invalid limit', API_INVALID_LIMIT_BODY],
    ['Invalid number of results', API_INVALID_RESULTS_BODY],
  ])(
    'maps an upstream 403 "%s" to page_beyond_window with the declared recovery',
    async (_name, body) => {
      installAicService(scriptedFetch(jsonResponder(body, 403)));
      const result = await search({ query: 'water' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('page_beyond_window');
      expect(error.data.recovery?.hint).toBe(PAGE_BOUND_RECOVERY);
    },
  );
});

// --- Pagination and enrichment -----------------------------------------------------------

describe('artic_search_artworks paging', () => {
  it('returns the zero-result page with every required enrichment field', async () => {
    emptyResults();
    const out = structuredOf<SearchRun>(await search({ query: 'nonexistent' }));
    expect(out).toEqual({
      artworks: [],
      page: 1,
      has_more: false,
      sort_applied: 'relevance',
      license_text: ARTWORK_LICENSE,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 10,
      notice: 'No artworks matched. Check the spelling of the query text, or try a broader term.',
    });
  });

  it('falls back to the row count when the envelope reports no total', async () => {
    serve({ data: [], info: { license_text: 'x' } });
    const out = structuredOf<SearchRun>(await search());
    expect(out).toMatchObject({ totalCount: 0, shown: 0 });
  });

  it('returns the under-cap page with the total, no next page, and no notice', async () => {
    serve(searchEnvelope(rows(3), 3));
    const out = structuredOf<SearchRun>(await search());
    expect(out).toMatchObject({
      page: 1,
      has_more: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
    });
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1, 2, 3]);
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('points at the next page when matches remain inside the window', async () => {
    serve(searchEnvelope(rows(10), 25));
    const out = structuredOf<SearchRun>(await search());
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
    const out = structuredOf<SearchRun>(await search({ page: 3 }));
    expect(out).toMatchObject({ page: 3, has_more: false, truncated: false, shown: 5 });
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('has no more when the page ends exactly on the total', async () => {
    serve(searchEnvelope(rows(10, 11), 20));
    const out = structuredOf<SearchRun>(await search({ page: 2 }));
    expect(out.has_more).toBe(false);
    expect(out).not.toHaveProperty('next_page');
  });

  it('explains a page past the last match', async () => {
    serve(searchEnvelope([], 25));
    const out = structuredOf<SearchRun>(await search({ page: 4 }));
    expect(out).toMatchObject({ has_more: false, truncated: false, shown: 0, totalCount: 25 });
    expect(out.notice).toBe('Page 4 is past the last match (25 total); request a lower page.');
  });

  it('offers page 10 at limit 100 because it still ends inside the window', async () => {
    serve(searchEnvelope(rows(100, 801), 5000));
    const out = structuredOf<SearchRun>(await search({ page: 9, limit: 100 }));
    expect(out).toMatchObject({ has_more: true, next_page: 10 });
  });

  it('withholds next_page and names the window when the next page would cross 1,000', async () => {
    serve(searchEnvelope(rows(100, 901), 5000));
    const out = structuredOf<SearchRun>(await search({ page: 10, limit: 100 }));
    expect(out).toMatchObject({
      has_more: true,
      truncated: true,
      shown: 100,
      notice: WINDOW_NOTICE,
    });
    expect(out).not.toHaveProperty('next_page');
  });

  it('returns counts only for limit 0, reporting that rows exist', async () => {
    serve(searchEnvelope([], 7));
    const out = structuredOf<SearchRun>(await search({ limit: 0, facets: ['department'] }));
    expect(out).toMatchObject({
      artworks: [],
      has_more: true,
      totalCount: 7,
      truncated: true,
      shown: 0,
      cap: 0,
      notice: 'Counts only (limit 0); set limit between 1 and 100 to list the matching artworks.',
    });
    expect(out).not.toHaveProperty('next_page');
  });

  it('treats a limit 0 search with no matches as zero-hit', async () => {
    serve(searchEnvelope([], 0));
    const out = structuredOf<SearchRun>(await search({ limit: 0 }));
    expect(out).toMatchObject({ has_more: false, truncated: false, cap: 0 });
    expect(out.notice).toBe('No artworks matched.');
  });

  it('serves a limit 0 count-only page on page 1000', async () => {
    const fetchFake = serve(searchEnvelope([], 3));
    const out = structuredOf<SearchRun>(await search({ limit: 0, page: 1000 }));
    expect(out.totalCount).toBe(3);
    expect(bodyOf(fetchFake)).toMatchObject({ page: 1000, limit: 0 });
  });

  it('skips upstream rows with no integer id and counts only what it returns', async () => {
    serve(searchEnvelope([artworkRecord(1), { title: 'no id' }, null, { id: 'x' }], 4));
    const out = structuredOf<SearchRun>(await search());
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1]);
    expect(out.shown).toBe(1);
  });
});

describe('artic_search_artworks zero-hit guidance', () => {
  const zeroHit = async (input: Record<string, unknown>) => {
    emptyResults();
    return structuredOf<SearchRun>(await search(input)).notice;
  };

  it('is the bare sentence when nothing narrows the search', async () => {
    expect(await zeroHit({})).toBe('No artworks matched.');
  });

  it('sends vocabulary filters to artic_lookup_vocabulary by name', async () => {
    expect(await zeroHit({ department: 'Nope' })).toBe(
      'No artworks matched. Check filter values with artic_lookup_vocabulary (vocabulary "department") — values match exactly, ignoring case.',
    );
    expect(await zeroHit({ gallery: '240', department: 'Nope' })).toContain(
      '(vocabulary "department", "gallery")',
    );
  });

  it('sends an artist name to artic_search_artists', async () => {
    expect(await zeroHit({ artist: 'Nobody' })).toContain(
      'Resolve the name with artic_search_artists and pass artist_id instead.',
    );
  });

  it('asks to confirm an artist id', async () => {
    expect(await zeroHit({ artist_id: 5 })).toContain(
      'Confirm the id with artic_search_artists (ids mode); an agent with no artworks matches nothing.',
    );
  });

  it('warns about all-words matching only from three words on', async () => {
    expect(await zeroHit({ query: 'water lilies' })).not.toContain('All words must match');
    expect(await zeroHit({ query: 'water   lilies  monet' })).toContain(
      'All words must match; try fewer words or quote an exact phrase.',
    );
  });

  it('names the scope flags that are set, in a fixed order', async () => {
    expect(await zeroHit({ has_image: true, public_domain_only: true })).toContain(
      'Drop public_domain_only / has_image to widen the set.',
    );
    expect(
      await zeroHit({ has_image: true, on_view_only: true, public_domain_only: true }),
    ).toContain('Drop public_domain_only / on_view_only / has_image to widen the set.');
  });

  it.each([{ year_from: 1500 }, { year_to: 1500 }])(
    'asks to widen the span for %j',
    async (input) => {
      expect(await zeroHit(input)).toContain(
        'Widen year_from/year_to; a work matches when its date span overlaps the range.',
      );
    },
  );

  it('joins every applicable fragment in a stable order', async () => {
    expect(
      await zeroHit({
        query: 'one two three',
        artist: 'A',
        artist_id: 5,
        department: 'D',
        public_domain_only: true,
        year_from: 1900,
      }),
    ).toBe(
      'No artworks matched. Check filter values with artic_lookup_vocabulary (vocabulary "department") — values match exactly, ignoring case. Resolve the name with artic_search_artists and pass artist_id instead. Confirm the id with artic_search_artists (ids mode); an agent with no artworks matches nothing. All words must match; try fewer words or quote an exact phrase. Drop public_domain_only to widen the set. Widen year_from/year_to; a work matches when its date span overlaps the range.',
    );
  });

  it('gives no zero-hit fragments when matches exist', async () => {
    serve(searchEnvelope(rows(2), 2));
    const out = structuredOf<SearchRun>(await search({ department: 'D', has_image: true }));
    expect(out).not.toHaveProperty('notice');
  });
});

// --- Rows and facets ------------------------------------------------------------------------

describe('artic_search_artworks rows', () => {
  it('normalizes a full record with constructed URLs and no thumbnail data', async () => {
    serve(searchEnvelope([artworkRecord(7)], 1));
    const result = await search();
    const [row] = structuredOf<SearchRun>(result).artworks;
    expect(row).toEqual({
      id: 7,
      title: 'Synthetic Work 7',
      artist_display: 'Test Artist\nFrench, 1840-1900',
      artist_id: 900,
      date_display: '1890',
      date_start: 1890,
      date_end: 1890,
      medium: 'Oil on canvas',
      artwork_type: 'Painting',
      department: 'Painting and Sculpture of Europe',
      place_of_origin: 'France',
      is_public_domain: true,
      is_on_view: false,
      web_url: 'https://www.artic.edu/artworks/7',
      image: {
        url: `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
        url_large: `${IIIF_URL}/${IMAGE_ID}/full/1686,/0/default.jpg`,
        iiif_info_url: `${IIIF_URL}/${IMAGE_ID}/info.json`,
        alt_text: 'A synthetic landscape',
        width: 100,
        height: 80,
        rights: 'public_domain',
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/lqip|base64/);
  });

  it('withholds the large image from an in-copyright work and carries its gallery', async () => {
    serve(searchEnvelope([inCopyrightArtworkRecord(8)], 1));
    const [row] = structuredOf<SearchRun>(await search()).artworks;
    expect(row).toMatchObject({
      is_public_domain: false,
      is_on_view: true,
      gallery: 'Gallery 240',
      image: { rights: 'in_copyright' },
    });
    expect(row?.image).not.toHaveProperty('url_large');
  });

  it('carries only what a sparse record has, without inventing values', async () => {
    serve(searchEnvelope([sparseArtworkRecord(9)], 1));
    const result = await search();
    const [row] = structuredOf<SearchRun>(result).artworks;
    expect(row).toEqual({
      id: 9,
      title: '',
      is_public_domain: false,
      is_on_view: false,
      web_url: 'https://www.artic.edu/artworks/9',
    });
    const text = textOf(result);
    expect(text).toContain('## (untitled) (id 9)');
    expect(text).toContain('**Public domain:** no · **On view:** no');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('drops placeholder years and keeps the display date', async () => {
    serve(searchEnvelope([placeholderYearArtworkRecord(10)], 1));
    const result = await search();
    const [row] = structuredOf<SearchRun>(result).artworks;
    expect(row).toMatchObject({ date_display: 'Dates unknown' });
    expect(row).not.toHaveProperty('date_start');
    expect(row).not.toHaveProperty('date_end');
    expect(textOf(result)).toContain('- **Date:** Dates unknown');
    expect(textOf(result)).not.toContain('5000001');
  });

  it('reads the IIIF base from the envelope, and falls back when it is missing', async () => {
    serve(searchEnvelope([artworkRecord(1)], 1, { iiifUrl: 'https://iiif.example.test/v2' }));
    const [custom] = structuredOf<SearchRun>(await search()).artworks;
    expect(fieldOf<{ url: string }>(custom, 'image').url).toBe(
      `https://iiif.example.test/v2/${IMAGE_ID}/full/843,/0/default.jpg`,
    );
    serve(searchEnvelope([artworkRecord(1)], 1, { iiifUrl: null }));
    const [fallback] = structuredOf<SearchRun>(await search()).artworks;
    expect(fieldOf<{ url: string }>(fallback, 'image').url).toBe(
      `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
    );
  });

  it('returns an empty license text when the envelope carries none', async () => {
    serve(searchEnvelope([], 0, { license: null }));
    expect(structuredOf<SearchRun>(await search()).license_text).toBe('');
  });
});

describe('artic_search_artworks facets', () => {
  const facetAggregations = {
    department: {
      buckets: [
        { key: 'Prints and Drawings', doc_count: 40 },
        { key: 'Textiles', doc_count: 2 },
      ],
      sum_other_doc_count: 0,
    },
    artist: {
      buckets: [
        {
          key: 900,
          doc_count: 5,
          label: { hits: { hits: [{ _source: { artist_title: 'Test Artist' } }] } },
        },
        {
          key: 901,
          doc_count: 3,
          label: { hits: { hits: [{ _source: { artist_title: null } }] } },
        },
        { key: 902, doc_count: 1 },
      ],
      sum_other_doc_count: 0,
    },
  };

  it('returns only the requested facets, with numeric artist keys as ids and names when known', async () => {
    serve(searchEnvelope(rows(1), 50, { aggregations: facetAggregations }));
    const out = structuredOf<SearchRun>(await search({ facets: ['department', 'artist'] }));
    expect(out.facets).toEqual({
      department: [
        { value: 'Prints and Drawings', count: 40 },
        { value: 'Textiles', count: 2 },
      ],
      artist: [
        { artist_id: 900, count: 5, name: 'Test Artist' },
        { artist_id: 901, count: 3 },
        { artist_id: 902, count: 1 },
      ],
    });
  });

  it('omits facets entirely when none were requested', async () => {
    serve(searchEnvelope(rows(1), 1, { aggregations: facetAggregations }));
    expect(structuredOf<SearchRun>(await search())).not.toHaveProperty('facets');
  });

  it('returns an empty list for a requested facet the upstream did not aggregate', async () => {
    serve(searchEnvelope(rows(1), 1));
    const result = await search({ facets: ['style'] });
    expect(structuredOf<SearchRun>(result).facets).toEqual({ style: [] });
    expect(textOf(result)).toMatch(/### style\nNo values\./);
  });

  it('renders every facet value, count, and artist id that structuredContent carries', async () => {
    serve(searchEnvelope(rows(1), 50, { aggregations: facetAggregations }));
    const result = await search({ facets: ['department', 'artist'] });
    const text = textOf(result);
    expect(text).toContain('### department');
    expect(text).toContain('- Prints and Drawings (40)');
    expect(text).toContain('- Textiles (2)');
    expect(text).toContain('### artist');
    expect(text).toContain('- Test Artist · artist_id 900 (5)');
    expect(text).toContain('- (name not recorded) · artist_id 901 (3)');
    expect(text).toContain('- (name not recorded) · artist_id 902 (1)');
  });

  it('escapes hostile facet values and artist names in the rendering only', async () => {
    serve(
      searchEnvelope(rows(1), 5, {
        aggregations: {
          subject: { buckets: [{ key: HOSTILE_INLINE, doc_count: 2 }], sum_other_doc_count: 0 },
          artist: {
            buckets: [
              {
                key: 5,
                doc_count: 1,
                label: { hits: { hits: [{ _source: { artist_title: HOSTILE_INLINE } }] } },
              },
            ],
            sum_other_doc_count: 0,
          },
        },
      }),
    );
    const result = await search({ facets: ['subject', 'artist'] });
    const text = textOf(result);
    expect(text).toContain(`- ${HOSTILE_INLINE_RENDERED} (2)`);
    expect(text).toContain(`- ${HOSTILE_INLINE_RENDERED} · artist_id 5 (1)`);
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    const out = structuredOf<SearchRun>(result);
    expect(out.facets?.subject).toEqual([{ value: HOSTILE_INLINE, count: 2 }]);
  });
});

// --- format() --------------------------------------------------------------------------------

describe('artic_search_artworks format', () => {
  it('renders every row id, title, web URL, image URL, and the paging state from structuredContent', async () => {
    serve(searchEnvelope([artworkRecord(7), inCopyrightArtworkRecord(8)], 30));
    const result = await search({ limit: 2 });
    const out = structuredOf<SearchRun>(result);
    const text = textOf(result);
    expect(text).toContain('# Artworks (2 on this page)');
    expect(text).toContain(`**Page:** ${out.page}`);
    expect(text).toContain(`**Sort applied:** ${out.sort_applied}`);
    expect(text).toContain('**More matches:** yes');
    expect(text).toContain(`**Next page:** ${out.next_page}`);
    for (const artwork of out.artworks) {
      expect(text).toContain(`(id ${artwork.id})`);
      expect(text).toContain(String(artwork.title));
      expect(text).toContain(String(artwork.web_url));
      expect(text).toContain((artwork.image as { url: string }).url);
    }
    expect(text).toContain('**Gallery:** Gallery 240');
    expect(text).toContain('## License');
    expect(text).toContain(`> ${out.license_text}`);
    expect(text).toContain('Image (public_domain)');
    expect(text).toContain('Image (in_copyright)');
  });

  it('equals the format() of the structured output', async () => {
    serve(searchEnvelope(rows(2), 2));
    const result = await search();
    const { totalCount, truncated, shown, cap, notice, ...output } =
      structuredOf<SearchRun>(result);
    void [totalCount, truncated, shown, cap, notice];
    expect(searchArtworks.format?.(output as never)).toEqual([
      { type: 'text', text: textOf(result) },
    ]);
  });

  it('says there are no rows on an empty page', async () => {
    emptyResults();
    expect(textOf(await search())).toContain('No artwork rows on this page.');
  });

  it('percent-encodes brackets in printed URLs and leaves structuredContent untouched', async () => {
    serve(searchEnvelope([artworkRecord(1)], 1, { iiifUrl: 'https://iiif.example.test/a[1]' }));
    const result = await search();
    const text = textOf(result);
    expect(text).toContain(
      `https://iiif.example.test/a%5B1%5D/${IMAGE_ID}/full/843,/0/default.jpg`,
    );
    expect(text).not.toContain('a[1]');
    const [row] = structuredOf<SearchRun>(result).artworks;
    expect(fieldOf<{ url: string }>(row, 'image').url).toContain('a[1]');
  });

  it('keeps hostile upstream text out of inline markdown slots and structuredContent verbatim', async () => {
    serve(
      searchEnvelope(
        [
          artworkRecord(1, {
            title: 'Study&#13;&#10;# Injected title &lt;x&gt; [y]',
            artist_display: HOSTILE_INLINE,
            medium_display: HOSTILE_INLINE,
            artwork_type_title: HOSTILE_INLINE,
            department_title: HOSTILE_INLINE,
            place_of_origin: HOSTILE_INLINE,
            gallery_title: HOSTILE_INLINE,
            date_display: HOSTILE_INLINE,
            thumbnail: { width: 1, height: 1, alt_text: HOSTILE_INLINE },
          }),
        ],
        1,
        { license: 'License one\r\n# Fake heading\r\n\r\nLicense three' },
      ),
    );
    const result = await search();
    const text = textOf(result);
    const [row] = structuredOf<SearchRun>(result).artworks;

    expect(text).toContain('## Study # Injected title \\<x\\> \\[y\\] (id 1)');
    expect(text).toContain(`- **Artist:** ${HOSTILE_INLINE_RENDERED} · artist_id 900`);
    expect(text).toContain(`- **Date:** ${HOSTILE_INLINE_RENDERED} · start 1890 · end 1890`);
    expect(text).toContain(`- **Medium:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Type:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Department:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Place of origin:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`**Gallery:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Image alt text:** ${HOSTILE_INLINE_RENDERED}`);
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Artworks (1 on this page)',
    ]);

    const licenseLines = text.slice(text.indexOf('## License')).split('\n').slice(1);
    expect(licenseLines).toEqual(['> License one', '> # Fake heading', '>', '> License three']);

    expect(row?.title).toBe('Study\n# Injected title <x> [y]');
    expect(row?.artist_display).toBe(HOSTILE_INLINE);
    expect(row?.medium).toBe(HOSTILE_INLINE);
    expect(fieldOf<{ alt_text: string }>(row, 'image').alt_text).toBe(HOSTILE_INLINE);
    expect(structuredOf<SearchRun>(result).license_text).toBe(
      'License one\r\n# Fake heading\r\n\r\nLicense three',
    );
  });
});

// --- Upstream failures --------------------------------------------------------------------------

describe('artic_search_artworks upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name',
    async ({ responder, options, code, reason, forbidden }) => {
      installAicService(scriptedFetch(responder), options);
      const result = await search({ query: 'water' });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        const hint = recoveryFor(searchArtworks, reason);
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
      searchArtworks,
      { query: 'water' },
      {
        context: { signal: controller.signal },
      },
    );
    await vi.waitFor(() => expect(fetchFake).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('declares the five contract reasons with their codes', () => {
    expect(searchArtworks.errors?.map((entry) => [entry.reason, entry.code])).toEqual([
      ['page_beyond_window', JsonRpcErrorCode.ValidationError],
      ['invalid_year_range', JsonRpcErrorCode.ValidationError],
      ['rate_limited', JsonRpcErrorCode.RateLimited],
      ['request_blocked', JsonRpcErrorCode.Forbidden],
      ['upstream_rejected_query', JsonRpcErrorCode.InternalError],
    ]);
  });
});
