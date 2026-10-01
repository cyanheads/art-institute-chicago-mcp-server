/**
 * @fileoverview Tests for the `artic_search_artists` tool driven through a real
 * `AicService` over a fake `fetch`: the query-or-ids mode guards, input
 * normalization and the requests it builds, the page and birth-range guards,
 * pagination and window caps, ids-mode reordering and missing ids, the
 * degrading artwork-stats call, enrichment on the zero-result and under-cap
 * pages, upstream failure classes on the primary call, and `format()` safety.
 * @module tests/tools/search-artists.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchArtists } from '@/mcp-server/tools/definitions/search-artists.tool.js';
import { disposeAicService } from '@/services/aic/aic-service.js';
import { WINDOW_NOTICE } from '@/services/aic/aic-text.js';
import {
  hangingResponder,
  jsonResponder,
  queryParam,
  type Responder,
  routedFetch,
  searchBodyOf,
  textResponder,
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
  AGENT_LICENSE,
  API_INVALID_LIMIT_BODY,
  agentRecord,
  aggregationEnvelope,
  envelope,
  searchEnvelope,
} from '../fixtures/aic-upstream.js';

interface ArtistsRun {
  artists: Record<string, unknown>[];
  artists_only_applied: boolean;
  cap: number;
  has_more: boolean;
  license_text: string;
  missing_ids?: number[];
  next_page?: number;
  notice?: string;
  page: number;
  shown: number;
  totalCount: number;
  truncated: boolean;
}

type FetchFake = ReturnType<typeof routedFetch>;

const AGENTS_SEARCH = '/agents/search';
const AGENTS = '/agents';
const ARTWORKS_SEARCH = '/artworks/search';

const AGENT_FIELDS =
  'id,title,sort_title,alt_titles,is_artist,agent_type_title,birth_date,death_date,description';

const STATS_DEGRADED =
  "Artwork counts could not be loaded; pass an id as artist_id to artic_search_artworks to count and list that agent's works.";

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

const agents = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => agentRecord(from + index));

/** One `by_artist` bucket: the artwork count and up to three top hits. */
const bucket = (id: number, count: number, works: Record<string, unknown>[] = []) => ({
  key: id,
  doc_count: count,
  works: { hits: { hits: works.map((_source) => ({ _source })) } },
});

const statsFor = (...buckets: ReturnType<typeof bucket>[]) =>
  jsonResponder(aggregationEnvelope('by_artist', buckets));

interface Routes {
  /** `GET /agents?ids=` */
  byIds?: Responder;
  /** `GET /agents/search` */
  search?: Responder;
  /** The artwork-stats aggregation on `/artworks/search`. */
  stats?: Responder;
}

/** Routes the three paths the tool can reach; an unrouted path fails the fetch. */
function serve({ byIds, search, stats }: Routes): FetchFake {
  return installAicService(
    routedFetch({
      ...(search ? { [`/api/v1${AGENTS_SEARCH}`]: search } : {}),
      ...(byIds ? { [`/api/v1${AGENTS}`]: byIds } : {}),
      ...(stats ? { [`/api/v1${ARTWORKS_SEARCH}`]: stats } : {}),
    }),
  );
}

const serveSearch = (data: unknown[], total: number = data.length, stats?: Responder) =>
  serve({
    search: jsonResponder(searchEnvelope(data, total, { license: AGENT_LICENSE })),
    stats: stats ?? statsFor(),
  });

const serveIds = (data: unknown[], stats?: Responder) =>
  serve({
    byIds: jsonResponder(envelope(data, { license: AGENT_LICENSE })),
    stats: stats ?? statsFor(),
  });

const paths = (fetchFake: FetchFake) =>
  fetchFake.mock.calls.map(([url]) => new URL(url).pathname.replace('/api/v1', ''));

const callTo = (fetchFake: FetchFake, path: string): string => {
  const index = fetchFake.mock.calls.findIndex(
    ([url]) => new URL(url).pathname === `/api/v1${path}`,
  );
  if (index < 0) throw new Error(`No call to ${path}`);
  return urlOfCall(fetchFake as never, index);
};

const bodyTo = (fetchFake: FetchFake, path: string) => searchBodyOf(callTo(fetchFake, path));

const filtersTo = (fetchFake: FetchFake, path: string): unknown[] => {
  const query = bodyTo(fetchFake, path).query as { bool?: { filter?: unknown[] } } | undefined;
  return query?.bool?.filter ?? [];
};

const find = (input: Record<string, unknown> = {}) =>
  runToolContract(searchArtists, input as never);

// --- Mode guards -------------------------------------------------------------------------------

describe('artic_search_artists mode guards', () => {
  it('fails query_or_ids_required before any upstream call', async () => {
    const fetchFake = serve({});
    const result = await find();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('query_or_ids_required');
    expect(error.data.recovery?.hint).toBe(
      "Pass query with a name, or ids from an artwork's artist_id, to artic_search_artists.",
    );
    expect(textOf(result)).toContain('Recovery: Pass query with a name');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank query and blank ids', { query: '', ids: '' }],
    ['whitespace-only values', { query: '   ', ids: '  ' }],
    ['an empty ids array', { ids: [] }],
    ['ids that are only commas and blanks', { ids: ' , ,' }],
    ['only the filters', { born_from: 1800, artists_only: false, page: 2 }],
  ])('reads %s as neither query nor ids', async (_name, input) => {
    const fetchFake = serve({});
    const error = errorOf(await find(input));
    expect(error.data.reason).toBe('query_or_ids_required');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('fails query_and_ids_conflict when both are given', async () => {
    const fetchFake = serve({});
    const result = await find({ query: 'monet', ids: [5] });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('query_and_ids_conflict');
    expect(error.data.recovery?.hint).toBe(
      'Pass either query or ids to artic_search_artists, not both, then call again.',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('reads a blank query beside ids as ids mode', async () => {
    const fetchFake = serveIds([agentRecord(5)]);
    const out = structuredOf<ArtistsRun>(await find({ query: '   ', ids: [5] }));
    expect(out.artists.map((artist) => artist.id)).toEqual([5]);
    expect(paths(fetchFake)).toEqual(['/agents', '/artworks/search']);
  });

  it('reads blank ids beside a query as query mode', async () => {
    const fetchFake = serveSearch([agentRecord(5)]);
    const out = structuredOf<ArtistsRun>(await find({ query: 'seurat', ids: '' }));
    expect(out.artists.map((artist) => artist.id)).toEqual([5]);
    expect(paths(fetchFake)).toEqual(['/agents/search', '/artworks/search']);
  });

  it('checks the mode before the page window', async () => {
    serve({});
    const error = errorOf(await find({ page: 100, limit: 25 }));
    expect(error.data.reason).toBe('query_or_ids_required');
  });
});

// --- Input validation ----------------------------------------------------------------------------

describe('artic_search_artists input validation', () => {
  it.each([
    ['a query over 120 characters', { query: 'x'.repeat(121) }, 'query'],
    ['more than 25 ids', { ids: Array.from({ length: 26 }, (_, i) => i + 1) }, 'ids'],
    ['a zero id', { ids: [0] }, 'ids'],
    ['a negative id', { ids: [-3] }, 'ids'],
    ['a fractional id', { ids: [1.5] }, 'ids'],
    ['a non-numeric id string', { ids: 'abc' }, 'ids'],
    ['born_from below the year floor', { query: 'a', born_from: -8001 }, 'born_from'],
    ['born_from above the year ceiling', { query: 'a', born_from: 2101 }, 'born_from'],
    ['born_to below the year floor', { query: 'a', born_to: -8001 }, 'born_to'],
    ['a fractional born_to', { query: 'a', born_to: 1900.5 }, 'born_to'],
    ['page 0', { query: 'a', page: 0 }, 'page'],
    ['page 101', { query: 'a', page: 101 }, 'page'],
    ['limit 0', { query: 'a', limit: 0 }, 'limit'],
    ['limit 26', { query: 'a', limit: 26 }, 'limit'],
    ['a fractional limit', { query: 'a', limit: 2.5 }, 'limit'],
    ['a non-boolean artists_only', { query: 'a', artists_only: 'maybe' }, 'artists_only'],
  ])('rejects %s without calling upstream', async (_name, input, field) => {
    const fetchFake = serve({});
    const error = errorOf(await find(input));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain(`"${field}"`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('cuts an over-long ids list before validation, leaving one bounded issue', async () => {
    serve({});
    const error = errorOf(await find({ ids: Array.from({ length: 80 }, (_, i) => i + 1) }));
    const issues = error.data.issues as { code: string; path: unknown[] }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'too_big', path: ['ids'] });
  });

  it('accepts exactly 25 ids', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetchFake = serveIds([]);
    const result = await find({ ids });
    expect(result.isError).toBeUndefined();
    expect(queryParam(callTo(fetchFake, '/agents'), 'ids')).toBe(ids.join(','));
  });

  it.each([
    ['an array of numbers', [3, 1, 2], '3,1,2'],
    ['numeric strings in an array', ['3', 1, ' 2 '], '3,1,2'],
    ['a comma string with spaces', '3, 1,2', '3,1,2'],
    ['duplicates and blanks', '3,3, ,1,,2,1', '3,1,2'],
  ])('reads ids from %s', async (_name, ids, expected) => {
    const fetchFake = serveIds([]);
    await find({ ids });
    expect(queryParam(callTo(fetchFake, '/agents'), 'ids')).toBe(expected);
  });

  it('builds the same query request from blank optional inputs as from none', async () => {
    const plain = serveSearch([]);
    await find({ query: 'seurat' });
    const plainBody = bodyTo(plain, AGENTS_SEARCH);

    const blank = serveSearch([]);
    const result = await find({ query: 'seurat', ids: '', born_from: '', born_to: '  ' });
    expect(result.isError).toBeUndefined();
    expect(bodyTo(blank, AGENTS_SEARCH)).toEqual(plainBody);
  });

  it.each([
    ['page', { page: '' }],
    ['limit', { limit: '   ' }],
  ])('reads a blank %s as unset, taking its default', async (_name, extra) => {
    const fetchFake = serveSearch([]);
    const result = await find({ query: 'seurat', ...extra });
    expect(result.isError).toBeUndefined();
    expect(bodyTo(fetchFake, AGENTS_SEARCH)).toMatchObject({ page: 1, limit: 10 });
  });

  it('trims the query before building the request', async () => {
    const fetchFake = serveSearch([]);
    await find({ query: '  georges seurat  ' });
    expect(bodyTo(fetchFake, AGENTS_SEARCH)).toMatchObject({
      q: 'georges seurat',
      query: {
        bool: {
          must: [
            {
              simple_query_string: {
                query: 'georges seurat',
                fields: ['title', 'alt_titles', 'sort_title'],
                default_operator: 'and',
              },
            },
          ],
        },
      },
    });
  });
});

// --- Query request ---------------------------------------------------------------------------------

describe('artic_search_artists query request', () => {
  it('limits to artists by default and sends paging and the field allowlist', async () => {
    const fetchFake = serveSearch([]);
    const out = structuredOf<ArtistsRun>(await find({ query: 'seurat' }));
    const body = bodyTo(fetchFake, AGENTS_SEARCH);
    expect(body).toMatchObject({ page: 1, limit: 10, fields: AGENT_FIELDS });
    expect(filtersTo(fetchFake, AGENTS_SEARCH)).toEqual([{ term: { is_artist: true } }]);
    expect(out.artists_only_applied).toBe(true);
  });

  it('drops the artist filter when artists_only is false and echoes it', async () => {
    const fetchFake = serveSearch([]);
    const out = structuredOf<ArtistsRun>(await find({ query: 'fund', artists_only: false }));
    expect(filtersTo(fetchFake, AGENTS_SEARCH)).toEqual([]);
    expect(out.artists_only_applied).toBe(false);
  });

  it.each([
    ['both bounds', { born_from: 1800, born_to: 1850 }, { gte: 1800, lte: 1850 }],
    ['only a lower bound', { born_from: 1800 }, { gte: 1800 }],
    ['only an upper bound', { born_to: -300 }, { lte: -300 }],
    ['equal bounds', { born_from: 1840, born_to: 1840 }, { gte: 1840, lte: 1840 }],
    ['BCE bounds', { born_from: -8000, born_to: -400 }, { gte: -8000, lte: -400 }],
  ])('maps %s to a birth_date range', async (_name, input, range) => {
    const fetchFake = serveSearch([]);
    const result = await find({ query: 'a', ...input });
    expect(result.isError).toBeUndefined();
    expect(filtersTo(fetchFake, AGENTS_SEARCH)).toContainEqual({
      range: { birth_date: range },
    });
  });

  it('passes page and limit upstream', async () => {
    const fetchFake = serveSearch(agents(5, 41), 60);
    await find({ query: 'a', page: 3, limit: 20 });
    expect(bodyTo(fetchFake, AGENTS_SEARCH)).toMatchObject({ page: 3, limit: 20 });
  });

  it('asks the stats call about exactly the ids on the page', async () => {
    const fetchFake = serveSearch([agentRecord(7), agentRecord(3)], 2);
    await find({ query: 'a' });
    const body = bodyTo(fetchFake, ARTWORKS_SEARCH);
    expect(body).toMatchObject({
      limit: 0,
      query: { bool: { filter: [{ terms: { artist_ids: [7, 3] } }] } },
      aggs: {
        by_artist: {
          terms: { field: 'artist_ids', include: [7, 3], size: 2 },
          aggs: { works: { top_hits: { size: 3, sort: [{ is_boosted: { order: 'desc' } }] } } },
        },
      },
    });
  });
});

// --- Page and range guards ---------------------------------------------------------------------------

describe('artic_search_artists guards', () => {
  it('fails invalid_year_range when born_from is later than born_to', async () => {
    const fetchFake = serve({});
    const result = await find({ query: 'a', born_from: 1900, born_to: 1800 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_year_range');
    expect(error.data.recovery?.hint).toBe(
      'Set born_from at or below born_to and call artic_search_artists again; use negative years for BCE.',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('compares BCE years numerically', async () => {
    serve({});
    expect(errorOf(await find({ query: 'a', born_from: -100, born_to: -400 })).data.reason).toBe(
      'invalid_year_range',
    );
  });

  it.each([
    ['page 41 at limit 25', { page: 41, limit: 25 }],
    ['page 51 at limit 20', { page: 51, limit: 20 }],
  ])('fails page_beyond_window for %s', async (_name, paging) => {
    const fetchFake = serve({});
    const result = await find({ query: 'a', ...paging });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('page_beyond_window');
    expect(error.data.recovery?.hint).toBe(
      'Only the first 1,000 matches are reachable. Add more of the name, or set born_from and born_to, and call artic_search_artists again.',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('fails page_beyond_window at page 100 with limit 11 but serves it at limit 10', async () => {
    serve({});
    expect(errorOf(await find({ query: 'a', page: 100, limit: 11 })).data.reason).toBe(
      'page_beyond_window',
    );
    serveSearch(agents(10, 991), 5000);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 100 }));
    expect(out).toMatchObject({ page: 100, has_more: true, notice: WINDOW_NOTICE });
  });

  it('serves the last reachable page, where page times limit equals 1,000', async () => {
    const fetchFake = serveSearch(agents(25, 976), 5000);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 40, limit: 25 }));
    expect(out).toMatchObject({ page: 40, has_more: true, truncated: true, shown: 25 });
    expect(out).not.toHaveProperty('next_page');
    expect(out.notice).toBe(WINDOW_NOTICE);
    expect(bodyTo(fetchFake, AGENTS_SEARCH)).toMatchObject({ page: 40, limit: 25 });
  });

  it('checks the page window before the birth range', async () => {
    serve({});
    const error = errorOf(
      await find({ query: 'a', page: 100, limit: 11, born_from: 1900, born_to: 1800 }),
    );
    expect(error.data.reason).toBe('page_beyond_window');
  });

  it('maps an upstream window refusal on the search to page_beyond_window', async () => {
    serve({ search: jsonResponder(API_INVALID_LIMIT_BODY, 403) });
    const error = errorOf(await find({ query: 'a' }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('page_beyond_window');
  });
});

// --- Pagination and enrichment ------------------------------------------------------------------------

describe('artic_search_artists paging and enrichment', () => {
  it('returns the zero-result page with every required enrichment field', async () => {
    const fetchFake = serveSearch([], 0);
    const out = structuredOf<ArtistsRun>(await find({ query: 'nobody' }));
    expect(out).toEqual({
      artists: [],
      page: 1,
      has_more: false,
      artists_only_applied: true,
      license_text: AGENT_LICENSE,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 10,
      notice:
        'No agents matched. All name words must match; try the surname alone. Set artists_only false to include donors and organizations. Or match credited names in artwork records with artic_search_artworks artist.',
    });
    expect(paths(fetchFake)).toEqual(['/agents/search']);
  });

  it('adds the birth-range fragment and drops the artists_only fragment when it applies', async () => {
    serveSearch([], 0);
    const out = structuredOf<ArtistsRun>(
      await find({ query: 'nobody', artists_only: false, born_from: 1800 }),
    );
    expect(out.notice).toBe(
      'No agents matched. All name words must match; try the surname alone. Widen born_from/born_to. Or match credited names in artwork records with artic_search_artworks artist.',
    );
  });

  it('returns the under-cap page with the total, no next page, and no notice', async () => {
    serveSearch(agents(3), 3, statsFor(bucket(1, 4), bucket(2, 0), bucket(3, 1)));
    const out = structuredOf<ArtistsRun>(await find({ query: 'synthetic' }));
    expect(out).toMatchObject({
      page: 1,
      has_more: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
      artists_only_applied: true,
      license_text: AGENT_LICENSE,
    });
    expect(out.artists.map((artist) => artist.id)).toEqual([1, 2, 3]);
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
    expect(out).not.toHaveProperty('missing_ids');
  });

  it('points at the next page when matches remain inside the window', async () => {
    serveSearch(agents(10), 25);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
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
    serveSearch(agents(5, 21), 25);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 3 }));
    expect(out).toMatchObject({ page: 3, has_more: false, truncated: false, shown: 5 });
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('has no more when the page ends exactly on the total', async () => {
    serveSearch(agents(10, 11), 20);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 2 }));
    expect(out.has_more).toBe(false);
    expect(out).not.toHaveProperty('next_page');
  });

  it('explains a page past the last match and skips the stats call', async () => {
    const fetchFake = serveSearch([], 25);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 4 }));
    expect(out).toMatchObject({ has_more: false, truncated: false, shown: 0, totalCount: 25 });
    expect(out.notice).toBe('Page 4 is past the last match (25 total); request a lower page.');
    expect(paths(fetchFake)).toEqual(['/agents/search']);
  });

  it('withholds next_page and names the window when the next page would cross 1,000', async () => {
    serveSearch(agents(25, 976), 5000);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 40, limit: 25 }));
    expect(out).toMatchObject({ has_more: true, truncated: true, notice: WINDOW_NOTICE });
    expect(out).not.toHaveProperty('next_page');
  });

  it('offers page 40 at limit 25 because it still ends inside the window', async () => {
    serveSearch(agents(25, 951), 5000);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a', page: 39, limit: 25 }));
    expect(out).toMatchObject({ has_more: true, next_page: 40 });
  });

  it('skips upstream rows with no integer id and counts only what it returns', async () => {
    serveSearch([agentRecord(1), { title: 'no id' }, null, { id: 'x' }], 4);
    const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
    expect(out.artists.map((artist) => artist.id)).toEqual([1]);
    expect(out.shown).toBe(1);
  });

  it('falls back to the row count when the envelope reports no total', async () => {
    serve({
      search: jsonResponder({ data: [agentRecord(1)], info: { license_text: 'x' } }),
      stats: statsFor(),
    });
    const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
    expect(out).toMatchObject({ totalCount: 1, shown: 1, has_more: false });
  });

  it('defaults the license text to empty when the envelope omits it', async () => {
    serve({
      search: jsonResponder({ data: [], pagination: { total: 0 } }),
    });
    const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
    expect(out.license_text).toBe('');
  });
});

// --- Records -----------------------------------------------------------------------------------------

describe('artic_search_artists records', () => {
  it('attaches the artwork count and sample works from the stats buckets', async () => {
    serveSearch(
      [agentRecord(10), agentRecord(11)],
      2,
      statsFor(
        bucket(11, 2, [{ id: 501, title: 'Synthetic Study', date_display: '1888' }]),
        bucket(10, 7, [
          { id: 601, title: 'First Work', date_display: 'c. 1900' },
          { id: 602, title: 'Second Work' },
          { id: 603, title: '<em>Third</em> Work', date_display: '' },
        ]),
      ),
    );
    const out = structuredOf<ArtistsRun>(await find({ query: 'synthetic' }));
    expect(out.artists.map((artist) => artist.id)).toEqual([10, 11]);
    expect(out.artists[0]).toMatchObject({
      artwork_count: 7,
      sample_works: [
        { id: 601, title: 'First Work', date_display: 'c. 1900' },
        { id: 602, title: 'Second Work' },
        { id: 603, title: 'Third Work' },
      ],
    });
    expect(out.artists[0]?.sample_works).toEqual([
      { id: 601, title: 'First Work', date_display: 'c. 1900' },
      { id: 602, title: 'Second Work' },
      { id: 603, title: 'Third Work' },
    ]);
    expect(out.artists[1]).toMatchObject({
      artwork_count: 2,
      sample_works: [{ id: 501, title: 'Synthetic Study', date_display: '1888' }],
    });
  });

  it('reports a count of 0 and no sample works for an agent without a bucket', async () => {
    serveSearch([agentRecord(10)], 1, statsFor());
    const [artist] = structuredOf<ArtistsRun>(await find({ query: 'a' })).artists;
    expect(artist).toMatchObject({ artwork_count: 0, sample_works: [] });
  });

  it('ignores buckets for ids that were not asked about and hits without an id', async () => {
    serveSearch(
      [agentRecord(10)],
      1,
      statsFor(bucket(99, 5, [{ id: 1, title: 'Stray' }]), bucket(10, 3, [{ title: 'No id' }])),
    );
    const [artist] = structuredOf<ArtistsRun>(await find({ query: 'a' })).artists;
    expect(artist).toMatchObject({ artwork_count: 3, sample_works: [] });
  });

  it('normalizes a full agent record', async () => {
    serveSearch(
      [
        agentRecord(10, {
          alt_titles: ['Alias One', '', 'Alias Two'],
          description: '<p>Born in a synthetic town.</p><p>Second &amp; last.</p>',
          agent_type_title: 'Individual',
        }),
      ],
      1,
    );
    const [artist] = structuredOf<ArtistsRun>(await find({ query: 'a' })).artists;
    expect(artist).toMatchObject({
      id: 10,
      name: 'Synthetic Agent 10',
      sort_name: 'Agent, Synthetic 10',
      alt_names: ['Alias One', 'Alias Two'],
      agent_type: 'Individual',
      is_artist: true,
      birth_year: 1840,
      death_year: 1900,
    });
    expect(artist?.biography).toMatch(/^Born in a synthetic town\.\s+Second & last\.$/);
  });

  it('survives a record that carries nothing but an id', async () => {
    serveSearch([{ id: 5 }], 1);
    const result = await find({ query: 'a' });
    const [artist] = structuredOf<ArtistsRun>(result).artists;
    expect(artist).toEqual({
      id: 5,
      name: '',
      alt_names: [],
      is_artist: false,
      artwork_count: 0,
      sample_works: [],
    });
    const text = textOf(result);
    expect(text).toContain('## (name not recorded) (id 5)');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('drops placeholder life years instead of reporting them', async () => {
    serveSearch([agentRecord(5, { birth_date: -1_824_528_578, death_date: 5_000_001 })], 1);
    const [artist] = structuredOf<ArtistsRun>(await find({ query: 'a' })).artists;
    expect(artist).not.toHaveProperty('birth_year');
    expect(artist).not.toHaveProperty('death_year');
  });

  it('keeps a BCE birth year', async () => {
    serveSearch([agentRecord(5, { birth_date: -450, death_date: -380 })], 1);
    const [artist] = structuredOf<ArtistsRun>(await find({ query: 'a' })).artists;
    expect(artist).toMatchObject({ birth_year: -450, death_year: -380 });
  });
});

// --- Ids mode --------------------------------------------------------------------------------------------

describe('artic_search_artists ids mode', () => {
  it('returns agents in request order whatever order upstream answers in', async () => {
    const fetchFake = serveIds([agentRecord(3), agentRecord(1), agentRecord(2)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [1, 2, 3] }));
    expect(out.artists.map((artist) => artist.id)).toEqual([1, 2, 3]);
    expect(queryParam(callTo(fetchFake, '/agents'), 'ids')).toBe('1,2,3');
    expect(queryParam(callTo(fetchFake, '/agents'), 'fields')).toBe(AGENT_FIELDS);
  });

  it('returns found agents with no notice and the ids-mode paging fields', async () => {
    serveIds([agentRecord(1), agentRecord(2)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [1, 2] }));
    expect(out).toMatchObject({
      page: 1,
      has_more: false,
      artists_only_applied: false,
      missing_ids: [],
      totalCount: 2,
      truncated: false,
      shown: 2,
      cap: 2,
      license_text: AGENT_LICENSE,
    });
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('echoes artists_only_applied false and ignores query-mode filters in ids mode', async () => {
    const fetchFake = serveIds([agentRecord(1, { is_artist: false })]);
    const out = structuredOf<ArtistsRun>(
      await find({ ids: [1], artists_only: true, born_from: 1900, born_to: 1800, page: 99 }),
    );
    expect(out.artists_only_applied).toBe(false);
    expect(out.page).toBe(1);
    expect(out.artists.map((artist) => artist.id)).toEqual([1]);
    expect(paths(fetchFake)).toEqual(['/agents', '/artworks/search']);
  });

  it('names a missing id in the notice and lists it in request order', async () => {
    serveIds([agentRecord(2), agentRecord(1)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [1, 9, 2] }));
    expect(out.artists.map((artist) => artist.id)).toEqual([1, 2]);
    expect(out.missing_ids).toEqual([9]);
    expect(out).toMatchObject({ totalCount: 2, shown: 2, cap: 3 });
    expect(out.notice).toBe('No agent exists for id 9; find ids with artic_search_artists query.');
  });

  it('names several missing ids together', async () => {
    serveIds([agentRecord(2)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [9, 2, 8] }));
    expect(out.missing_ids).toEqual([9, 8]);
    expect(out.notice).toBe(
      'No agent exists for id 9, 8; find ids with artic_search_artists query.',
    );
  });

  it('returns the all-missing zero-result page as a result and skips the stats call', async () => {
    const fetchFake = serveIds([]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [11, 12] }));
    expect(out).toEqual({
      artists: [],
      missing_ids: [11, 12],
      page: 1,
      has_more: false,
      artists_only_applied: false,
      license_text: AGENT_LICENSE,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 2,
      notice:
        "None of these ids is an agent. Find ids with artic_search_artists query, or take an artwork's artist_id.",
    });
    expect(paths(fetchFake)).toEqual(['/agents']);
  });

  it('ignores agents the caller did not ask for', async () => {
    serveIds([agentRecord(1), agentRecord(99)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [1] }));
    expect(out.artists.map((artist) => artist.id)).toEqual([1]);
    expect(out.missing_ids).toEqual([]);
  });

  it('counts an id once when it was given twice', async () => {
    const fetchFake = serveIds([agentRecord(1)]);
    const out = structuredOf<ArtistsRun>(await find({ ids: [1, '1', 1] }));
    expect(out.artists).toHaveLength(1);
    expect(out.cap).toBe(1);
    expect(queryParam(callTo(fetchFake, '/agents'), 'ids')).toBe('1');
  });
});

// --- Degraded stats ------------------------------------------------------------------------------------------

describe('artic_search_artists degraded artwork counts', () => {
  const failures: [string, Responder][] = [
    ['a 429 rate limit', jsonResponder({}, 429, { 'retry-after': '0' })],
    ['a 500 server error', textResponder('upstream exploded', 500)],
    ['an unreadable 200 body', textResponder('<html>maintenance</html>', 200)],
    ['a 400 from the search backend', textResponder('400 Bad Request: {"error":"x"}', 400)],
    ['a 403 API refusal', jsonResponder({ status: 403, error: 'Forbidden', detail: 'x' }, 403)],
  ];

  it.each(failures)(
    'keeps the agents and drops the counts when the stats call fails with %s (query mode)',
    async (_name, stats) => {
      serveSearch(agents(2), 2, stats);
      const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
      expect(out.artists.map((artist) => artist.id)).toEqual([1, 2]);
      for (const artist of out.artists) {
        expect(artist).not.toHaveProperty('artwork_count');
        expect(artist).not.toHaveProperty('sample_works');
      }
      expect(out).toMatchObject({ totalCount: 2, shown: 2, has_more: false });
      expect(out.notice).toBe(STATS_DEGRADED);
    },
  );

  it('keeps the agents and drops the counts when the stats call fails in ids mode', async () => {
    serveIds([agentRecord(1)], textResponder('boom', 500));
    const out = structuredOf<ArtistsRun>(await find({ ids: [1] }));
    expect(out.artists).toHaveLength(1);
    expect(out.artists[0]).not.toHaveProperty('artwork_count');
    expect(out.notice).toBe(STATS_DEGRADED);
  });

  it('joins the degradation fragment after the continuation notice', async () => {
    serveSearch(agents(10), 25, textResponder('boom', 500));
    const out = structuredOf<ArtistsRun>(await find({ query: 'a' }));
    expect(out).toMatchObject({
      has_more: true,
      next_page: 2,
      truncated: true,
      notice: `More matches: call again with page 2. ${STATS_DEGRADED}`,
    });
  });

  it('joins the degradation fragment after the missing-id notice in ids mode', async () => {
    serveIds([agentRecord(1)], textResponder('boom', 500));
    const out = structuredOf<ArtistsRun>(await find({ ids: [1, 9] }));
    expect(out.notice).toBe(
      `No agent exists for id 9; find ids with artic_search_artists query. ${STATS_DEGRADED}`,
    );
  });

  it('renders the degraded page without count lines', async () => {
    serveSearch(agents(1), 1, textResponder('boom', 500));
    const text = textOf(await find({ query: 'a' }));
    expect(text).not.toContain('Artworks in the collection');
    expect(text).not.toContain('Sample works');
  });

  it('does not degrade a primary failure: a failed agent search fails the call', async () => {
    serve({ search: textResponder('boom', 500), stats: statsFor() });
    expect(errorOf(await find({ query: 'a' })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('does not degrade a failed ids fetch: it fails the call', async () => {
    serve({ byIds: textResponder('boom', 500), stats: statsFor() });
    expect(errorOf(await find({ ids: [1] })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('surfaces cancellation during the stats call as RequestCancelled, not a degraded page', async () => {
    const controller = new AbortController();
    const fetchFake = serve({
      search: jsonResponder(searchEnvelope(agents(1), 1)),
      stats: hangingResponder,
    });
    const pending = runToolContract(
      searchArtists,
      { query: 'a' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(paths(fetchFake)).toContain('/artworks/search'));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

// --- Upstream failures ------------------------------------------------------------------------------------------

describe('artic_search_artists upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name on the agent search',
    async ({ responder, options, code, reason, forbidden }) => {
      installAicService(
        routedFetch({
          [`/api/v1${AGENTS_SEARCH}`]: responder,
          [`/api/v1${ARTWORKS_SEARCH}`]: statsFor(),
        }),
        options,
      );
      const result = await find({ query: 'a' });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        const hint = searchArtists.errors?.find((entry) => entry.reason === reason)?.recovery;
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

  it.each([
    [
      '429 rate limit',
      jsonResponder({}, 429, { 'retry-after': '0' }),
      'rate_limited',
      JsonRpcErrorCode.RateLimited,
    ],
    [
      '500 server error',
      textResponder('boom', 500),
      undefined,
      JsonRpcErrorCode.ServiceUnavailable,
    ],
    [
      'non-JSON 200',
      textResponder('<html>x</html>', 200),
      undefined,
      JsonRpcErrorCode.ServiceUnavailable,
    ],
  ])('maps a %s on the ids fetch', async (_name, byIds, reason, code) => {
    serve({ byIds, stats: statsFor() });
    const error = errorOf(await find({ ids: [1] }));
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
  });

  it('surfaces cancellation as RequestCancelled rather than a service failure', async () => {
    const controller = new AbortController();
    const fetchFake = serve({ search: hangingResponder });
    const pending = runToolContract(
      searchArtists,
      { query: 'a' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(fetchFake).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('declares the seven contract reasons with their codes', () => {
    expect(searchArtists.errors?.map((entry) => [entry.reason, entry.code])).toEqual([
      ['query_or_ids_required', JsonRpcErrorCode.ValidationError],
      ['query_and_ids_conflict', JsonRpcErrorCode.ValidationError],
      ['invalid_year_range', JsonRpcErrorCode.ValidationError],
      ['page_beyond_window', JsonRpcErrorCode.ValidationError],
      ['rate_limited', JsonRpcErrorCode.RateLimited],
      ['request_blocked', JsonRpcErrorCode.Forbidden],
      ['upstream_rejected_query', JsonRpcErrorCode.InternalError],
    ]);
  });
});

// --- format() ---------------------------------------------------------------------------------------------------

describe('artic_search_artists format', () => {
  const unenriched = (result: Awaited<ReturnType<typeof find>>) => {
    const { totalCount, truncated, shown, cap, notice, ...output } =
      structuredOf<ArtistsRun>(result);
    void [totalCount, truncated, shown, cap, notice];
    return output;
  };

  it('carries the same data as structuredContent', async () => {
    serveSearch(
      [
        agentRecord(10, {
          alt_titles: ['Alias One', 'Alias Two'],
          agent_type_title: 'Individual',
          description: '<p>A synthetic life.</p>',
        }),
        agentRecord(11, { is_artist: false, birth_date: null, death_date: null }),
      ],
      25,
      statsFor(bucket(10, 4, [{ id: 601, title: 'First Work', date_display: '1890' }])),
    );
    const result = await find({ query: 'synthetic' });
    const out = structuredOf<ArtistsRun>(result);
    const text = textOf(result);

    expect(text).toContain('# Agents (2 on this page)');
    expect(text).toContain(`**Page:** ${out.page}`);
    expect(text).toContain('**More matches:** yes');
    expect(text).toContain('**Artists only:** yes');
    expect(text).toContain(`**Next page:** ${out.next_page}`);
    for (const artist of out.artists) {
      expect(text).toContain(`(id ${artist.id})`);
      expect(text).toContain(String(artist.name));
    }
    expect(text).toContain('- **Sort name:** Agent, Synthetic 10');
    expect(text).toContain('**Artist:** yes · **Agent type:** Individual');
    expect(text).toContain('**Artist:** no');
    expect(text).toContain('- **Life:** born 1840 · died 1900');
    expect(text).toContain('- **Other names:** Alias One; Alias Two');
    expect(text).toContain('- **Artworks in the collection:** 4');
    expect(text).toContain('  - First Work, 1890 (id 601)');
    expect(text).toContain('### Biography\n> A synthetic life.');
    expect(text).toContain('## License');
    expect(text).toContain(`> ${out.license_text}`);
  });

  it('equals the format() of the structured output', async () => {
    serveSearch(agents(2), 2, statsFor(bucket(1, 1)));
    const result = await find({ query: 'a' });
    expect(searchArtists.format?.(unenriched(result) as never)).toEqual([
      { type: 'text', text: textOf(result) },
    ]);
  });

  it('names missing ids in ids mode, or none', async () => {
    serveIds([agentRecord(1)]);
    expect(textOf(await find({ ids: [1, 9] }))).toContain('**Missing ids:** 9');
    serveIds([agentRecord(1)]);
    const found = await find({ ids: [1] });
    expect(textOf(found)).toContain('**Missing ids:** none');
    expect(textOf(found)).toContain('**Artists only:** no');
  });

  it('says there are no rows on an empty page', async () => {
    serveSearch([], 0);
    expect(textOf(await find({ query: 'a' }))).toContain('No agent rows on this page.');
  });

  it('keeps hostile upstream text out of inline markdown slots and structuredContent verbatim', async () => {
    serveSearch(
      [
        agentRecord(1, {
          title: 'Name&#13;&#10;# Injected name &lt;x&gt; [y]',
          sort_title: HOSTILE_INLINE,
          agent_type_title: HOSTILE_INLINE,
          alt_titles: [HOSTILE_INLINE, 'Plain Alias'],
          description: 'Line one<br># Fake heading<br><br>Line three\u0007',
        }),
      ],
      1,
      statsFor(
        bucket(1, 1, [
          { id: 7, title: 'Work&#13;&#10;# Injected work [z]', date_display: HOSTILE_INLINE },
        ]),
      ),
    );
    const result = await find({ query: 'a' });
    const text = textOf(result);
    const [artist] = structuredOf<ArtistsRun>(result).artists;

    expect(text).toContain('## Name # Injected name \\<x\\> \\[y\\] (id 1)');
    expect(text).toContain(`- **Sort name:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`**Agent type:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Other names:** ${HOSTILE_INLINE_RENDERED}; Plain Alias`);
    expect(text).toContain(`  - Work # Injected work \\[z\\], ${HOSTILE_INLINE_RENDERED} (id 7)`);
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Agents (1 on this page)',
    ]);
    const biography = text.slice(text.indexOf('### Biography')).split('\n').slice(1, 5);
    expect(biography).toEqual(['> Line one', '> # Fake heading', '>', '> Line three']);

    expect(artist?.name).toBe('Name\n# Injected name <x> [y]');
    expect(artist?.sort_name).toBe(HOSTILE_INLINE);
    expect(artist?.alt_names).toEqual([HOSTILE_INLINE, 'Plain Alias']);
  });

  it('keeps a hostile license out of the heading structure', async () => {
    serve({
      search: jsonResponder(
        searchEnvelope([], 0, { license: 'License one\r\n# Fake heading\r\n\r\nLicense three' }),
      ),
    });
    const result = await find({ query: 'a' });
    const text = textOf(result);
    const licenseLines = text.slice(text.indexOf('## License')).split('\n').slice(1);
    expect(licenseLines).toEqual(['> License one', '> # Fake heading', '>', '> License three']);
    expect(structuredOf<ArtistsRun>(result).license_text).toBe(
      'License one\r\n# Fake heading\r\n\r\nLicense three',
    );
  });
});
