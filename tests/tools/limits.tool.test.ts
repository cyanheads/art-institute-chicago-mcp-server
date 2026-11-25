/**
 * @fileoverview Bounded requested limits and ordered ID continuation at the real fetch seam.
 * @module tests/tools/limits.tool.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getArtworks } from '@/mcp-server/tools/definitions/get-artworks.tool.js';
import { lookupVocabulary } from '@/mcp-server/tools/definitions/lookup-vocabulary.tool.js';
import { searchArtists } from '@/mcp-server/tools/definitions/search-artists.tool.js';
import { searchArtworks } from '@/mcp-server/tools/definitions/search-artworks.tool.js';
import { searchAudioGuide } from '@/mcp-server/tools/definitions/search-audio-guide.tool.js';
import { searchExhibitions } from '@/mcp-server/tools/definitions/search-exhibitions.tool.js';
import { disposeAicService } from '@/services/aic/aic-service.js';
import {
  jsonResponder,
  numberedSearch,
  scriptedFetch,
  searchBodyOf,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import { errorOf, installAicService, structuredOf, textOf } from '../fixtures/aic-tool-kit.js';
import {
  agentRecord,
  artworkRecord,
  exhibitionRecord,
  mobileSoundRecord,
  searchEnvelope,
} from '../fixtures/aic-upstream.js';
import audioHeaviest from '../fixtures/audio-heaviest.json' with { type: 'json' };

afterEach(disposeAicService);
const serveEmpty = () => installAicService(scriptedFetch(jsonResponder(searchEnvelope([], 0))));
type Output = {
  cap: number;
  shown?: number;
  page?: number;
  deferred_ids?: number[];
  missing_ids?: number[];
  notice?: string;
  has_more?: boolean;
  truncated?: boolean;
  totalCount?: number;
  next_page?: number;
  artworks?: { id: number }[];
  artists?: { id: number }[];
  exhibitions?: { id: number }[];
  stops?: { id: number; transcript?: string }[];
};
const run = (tool: typeof getArtworks, input: Record<string, unknown>) =>
  runToolContract(tool, input as never);
const surfaces = (result: Awaited<ReturnType<typeof run>>, snippet: string) => {
  expect(
    result.content.some((block) => block.type === 'text' && block.text.includes(snippet)),
  ).toBe(true);
};

describe('limits characterization', () => {
  it('normalizes equivalent artwork identifiers and retains counts-only mode', async () => {
    const fetch = serveEmpty();
    await run(getArtworks, { ids: ['7', '007', 'https://www.artic.edu/artworks/7/slug', '', 8] });
    expect(new URL(urlOfCall(fetch)).searchParams.get('ids')).toBe('7,8');
    serveEmpty();
    const result = await run(searchArtworks as never, { limit: 0 });
    expect(structuredOf<Output>(result).cap).toBe(0);
  });
});

describe('following next_page to the end of the window', () => {
  const PAGED = [
    ['artic_search_artworks', searchArtworks, 'artworks', artworkRecord, {}],
    ['artic_search_artists', searchArtists, 'artists', agentRecord, { query: 'a' }],
    ['artic_search_exhibitions', searchExhibitions, 'exhibitions', exhibitionRecord, {}],
    ['artic_search_audio_guide', searchAudioGuide, 'stops', mobileSoundRecord, { query: 'a' }],
  ] as const;

  /** The one request that starts inside the window and would end past it, per limit. */
  const CROSSING = [
    [7, { from: 994, limit: 6 }],
    [12, { from: 996, limit: 4 }],
    [30, { from: 990, limit: 10 }],
    [99, { from: 990, limit: 10 }],
    [100, undefined],
  ] as const;

  const CASES = PAGED.flatMap((tool) =>
    CROSSING.flatMap(([limit, crossing]) =>
      [998, 1000, 1337].map((total) => [...tool, limit, total, crossing] as const),
    ),
  );

  /** Serves `total` numbered rows on the tool's page search; the artists tool's artwork-count lookups get none. */
  const servePaged = (
    tool: unknown,
    total: number,
    row: (position: number) => Record<string, unknown>,
  ) => {
    const upstream = numberedSearch(total, (position) => row(position));
    const isPage = (url: string) =>
      tool !== searchArtists || new URL(url).pathname.endsWith('/agents/search');
    const fetch = installAicService(
      scriptedFetch((url, init) =>
        isPage(url) ? upstream(url, init) : Response.json(searchEnvelope([], 0)),
      ),
    );
    return { fetch, isPage };
  };

  it.each(CASES)(
    '%s reaches each match once: $5 at a time of $6',
    async (_name, tool, key, row, input, limit, total, crossing) => {
      const { fetch, isPage } = servePaged(tool, total, row);
      const seen: number[] = [];
      let last: Output | undefined;
      for (let page: number | undefined = 1; page !== undefined; page = last.next_page) {
        const result = await run(tool as never, { ...input, limit, page });
        last = structuredOf<Output>(result);
        const ids = last[key]!.map((record) => record.id);
        expect(last).toMatchObject({ page, cap: limit, shown: ids.length, totalCount: total });
        for (const id of ids) surfaces(result, `(id ${id})`);
        seen.push(...ids);
      }
      expect(seen).toEqual(Array.from({ length: Math.min(total, 1000) }, (_, i) => i + 1));
      expect(last).toMatchObject({ has_more: total > 1000, truncated: total > 1000 });

      const requests = fetch.mock.calls
        .filter(([url]) => isPage(url))
        .map(([url]) => searchBodyOf(url));
      const whole = Math.floor(1000 / limit);
      expect(requests.slice(0, whole).map(({ page, limit }) => ({ page, limit }))).toEqual(
        Array.from({ length: whole }, (_, index) => ({ page: index + 1, limit })),
      );
      expect(requests.slice(0, whole).some((request) => 'from' in request)).toBe(false);
      expect(requests.slice(whole).map(({ from, limit }) => ({ from, limit }))).toEqual(
        crossing ? [crossing] : [],
      );
      expect(requests.slice(whole).some((request) => 'page' in request)).toBe(false);
    },
  );

  const SHORTENED =
    'Page 34 starts at match 991 and holds only the rows that remain inside the first 1,000 matches, so it is shorter than the limit of 30.';
  const WINDOW =
    'Only the first 1,000 matches are reachable; narrow the search with filters to see the rest.';

  it.each(
    PAGED.flatMap((tool) =>
      (
        [
          [5000, 10, true, `${SHORTENED} ${WINDOW}`],
          [1000, 10, false, undefined],
          [993, 3, false, undefined],
          [990, 0, false, 'Page 34 is past the last match (990 total); request a lower page.'],
        ] as const
      ).map((expected) => [...tool, ...expected] as const),
    ),
  )(
    '%s explains the crossing page of $5 matches on both surfaces',
    async (_name, tool, key, row, input, total, shown, hasMore, notice) => {
      servePaged(tool, total, row);
      const result = await run(tool as never, { ...input, limit: 30, page: 34 });
      const out = structuredOf<Output>(result);
      expect(out).toMatchObject({
        page: 34,
        has_more: hasMore,
        truncated: hasMore,
        totalCount: total,
        shown,
        cap: 30,
      });
      expect(out.notice).toBe(notice);
      expect(out[key]?.map((record) => record.id)).toEqual(
        Array.from({ length: shown }, (_, index) => 991 + index),
      );
      expect(out).not.toHaveProperty('next_page');
      surfaces(
        result,
        `**${total} total**\n**truncated:** ${hasMore}\n**shown:** ${shown}\n**cap:** 30${notice === undefined ? '' : `\n> ${notice}`}`,
      );
      if (notice === undefined) {
        expect(textOf(result)).not.toContain('shorter than the limit');
      }
    },
  );

  it.each(PAGED)(
    '%s points page 33 at limit 30 to the crossing page',
    async (_name, tool, _key, row, input) => {
      servePaged(tool, 5000, row);
      const result = await run(tool as never, { ...input, limit: 30, page: 33 });
      expect(structuredOf<Output>(result)).toMatchObject({
        has_more: true,
        next_page: 34,
        shown: 30,
        notice: 'More matches: call again with page 34.',
      });
      surfaces(result, '**Next page:** 34');
    },
  );

  it.each(PAGED)('%s advertises where a page may start', (_name, tool) => {
    expect(z.toJSONSchema(tool.input, { io: 'input' })).toMatchObject({
      properties: {
        page: {
          description: expect.stringContaining(
            'A page must start within the first 1,000 matches; one that crosses match 1,000 holds only the rows up to it.',
          ),
        },
      },
    });
    expect(z.toJSONSchema(tool.output)).toMatchObject({
      properties: {
        next_page: {
          description: expect.stringContaining('the next page would start past match 1,000'),
        },
      },
    });
    expect(tool.errors?.find(({ reason }) => reason === 'page_beyond_window')).toMatchObject({
      when: 'The page starts past match 1,000, the last reachable one: (page - 1) times the applied limit is 1,000 or more.',
    });
  });

  it.each(PAGED)(
    '%s refuses the page after the crossing one before any request, naming its first match',
    async (_name, tool, _key, _row, input) => {
      const fetch = serveEmpty();
      for (const [page, limit, firstMatch] of [
        [85, 12, 1009],
        [35, 30, 1021],
        [144, 7, 1002],
        [12, 99, 1090],
        // Clamped to 100, as a page of 100 is counted.
        [11, 1000, 1001],
      ] as const) {
        const result = await run(tool as never, { ...input, page, limit });
        const error = errorOf(result);
        expect(error.data.reason).toBe('page_beyond_window');
        expect(error.message).toMatch(
          new RegExp(
            `^Page ${page} with (?:applied )?limit ${Math.min(limit, 100)} starts at match ${firstMatch}, past the first 1,000\\.`,
          ),
        );
        surfaces(result, `starts at match ${firstMatch}, past the first 1,000`);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('bounded oversized reads', () => {
  it.each([
    [searchArtworks, {}],
    [searchArtists, { query: 'a' }],
    [searchExhibitions, {}],
    [searchAudioGuide, { query: 'a' }],
    [lookupVocabulary, { vocabulary: 'material' }],
  ])('rejects invalid requested limits before upstream work for %s', async (tool, input) => {
    const fetch = serveEmpty();
    for (const limit of [1001, -1, 1.5, 'bad', {}]) {
      expect(errorOf(await run(tool as never, { ...input, limit })).data.reason).toBe(
        'invalid_arguments',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [searchArtworks, 100, 'artworks', artworkRecord, {}],
    [searchArtists, 100, 'artists', agentRecord, { query: 'a' }],
    [searchExhibitions, 100, 'exhibitions', exhibitionRecord, {}],
    [searchAudioGuide, 100, 'stops', mobileSoundRecord, { query: 'a' }],
  ] as const)(
    'keeps adjacent, final, and past-end pages exact for %s',
    async (tool, cap, key, row, input) => {
      const total = cap * 2 + 1;
      const fetch = installAicService(
        scriptedFetch((url) => {
          const uri = String(url);
          if (uri.includes('/artworks/search') && tool === searchArtists)
            return Response.json(searchEnvelope([], 0));
          const body = searchBodyOf(uri);
          const page = Number(body.page);
          const limit = Number(body.limit);
          const start = (page - 1) * limit;
          return Response.json(
            searchEnvelope(
              Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) =>
                row(start + i + 1),
              ),
              total,
            ),
          );
        }),
      );
      const seen: number[] = [];
      for (let page = 1; page <= 4; page++) {
        const result = await run(tool as never, { ...input, limit: 1000, page });
        const out = structuredOf<Output>(result);
        expect(out.cap).toBe(cap);
        expect(out.page).toBe(page);
        const expectedIds = Array.from(
          { length: Math.max(0, Math.min(cap, total - (page - 1) * cap)) },
          (_, index) => (page - 1) * cap + index + 1,
        );
        const ids = out[key]?.map((record) => record.id);
        expect(ids).toEqual(expectedIds);
        expect(out.shown).toBe(expectedIds.length);
        expect(out.truncated).toBe(page < 3);
        seen.push(...ids!);
        expect(out.totalCount).toBe(total);
        expect(out.has_more).toBe(page < 3);
        if (page < 3) expect(out.next_page).toBe(page + 1);
        else expect(out).not.toHaveProperty('next_page');
        if (page === 4) expect(out.notice).toContain('past the last match');
        for (const id of expectedIds) surfaces(result, `(id ${id})`);
      }
      expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      const pageCalls = fetch.mock.calls.filter(
        ([url]) =>
          tool !== searchArtists || new URL(String(url)).pathname.endsWith('/agents/search'),
      );
      expect(
        pageCalls.map(([url]) => {
          const { page, limit } = searchBodyOf(String(url));
          return { page, limit };
        }),
      ).toEqual([1, 2, 3, 4].map((page) => ({ page, limit: cap })));
    },
  );
  it.each([
    [searchArtworks, 100, {}],
    [searchArtists, 100, { query: 'a' }],
    [searchExhibitions, 100, {}],
    [searchAudioGuide, 100, { query: 'a' }],
  ])(
    'uses the applied size for last reachable pages and rejects beyond the window for %s',
    async (tool, cap, input) => {
      const last = Math.floor(1000 / cap);
      const fetch = serveEmpty();
      expect(
        (await run(tool as never, { ...input, limit: 1000, page: last })).isError,
      ).toBeUndefined();
      const result = await run(tool as never, { ...input, limit: 1000, page: last + 1 });
      expect(errorOf(result).data.reason).toBe('page_beyond_window');
      expect(errorOf(result).data.recovery?.hint).toContain('1,000');
      surfaces(result, 'Recovery:');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('returns a full page of 100 heaviest captured transcripts whole at the applied cap', async () => {
    const data = Array.from({ length: 100 }, (_, index) => ({
      ...audioHeaviest.data,
      id: 999_900 + index,
    }));
    const fetch = installAicService(
      scriptedFetch(jsonResponder({ ...audioHeaviest, data, pagination: { total: 1067 } })),
    );
    const result = await run(searchAudioGuide as never, { query: 'art', limit: 1000 });
    const out = structuredOf<Output>(result);
    expect(out).toMatchObject({ cap: 100, shown: 100, next_page: 2 });
    expect(out.notice).toContain('Applied limit 100 to requested limit 1000');
    surfaces(result, 'Applied limit 100 to requested limit 1000');
    // This captured fixture contains only paragraph/break tags and quote entities.
    const transcript = audioHeaviest.data.transcript
      .trim()
      .split('</p>')
      .filter((part) => part.trim() !== '')
      .map((part) =>
        part.trim().replace('<p>', '').replaceAll('<br>', '\n').replaceAll('&quot;', '"'),
      )
      .join('\n\n');
    expect(out.stops).toEqual(
      data.map((stop) => ({ id: stop.id, title: stop.title, audio_url: stop.web_url, transcript })),
    );
    const quotedTranscript = transcript
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n');
    expect(result.content[0]).toEqual({
      type: 'text',
      text: [
        '# Audio-guide stops (100 on this page)',
        '**Page:** 1 · **More matches:** yes · **Next page:** 2',
        ...data.flatMap((stop) => [
          '',
          `## ${stop.title} (id ${stop.id})`,
          `- **Audio:** [${stop.web_url}](<${stop.web_url}>)`,
          '',
          '### Transcript',
          quotedTranscript,
        ]),
        '',
        '## License',
        `> ${audioHeaviest.info.license_text}`,
        '',
        '**Source citation:** Audio guide content © Art Institute of Chicago and third parties, https://www.artic.edu/terms',
      ].join('\n'),
    });
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({ limit: 100 });
  });
  it.each([getArtworks, searchArtists])(
    'accepts raw entry and string ceilings, then continues the exact remainder',
    async (tool) => {
      const fetch = serveEmpty();
      const duplicates = ['1', ...Array(999).fill('')];
      expect(
        structuredOf<Output>(await run(tool as never, { ids: duplicates })).missing_ids,
      ).toEqual([1]);
      expect(
        structuredOf<Output>(await run(tool as never, { ids: `1${' '.repeat(99999)}` }))
          .missing_ids,
      ).toEqual([1]);
      const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
      let remaining = ids;
      const attempted: number[] = [];
      while (remaining.length > 0) {
        const result = await run(tool as never, { ids: remaining });
        const out = structuredOf<Output>(result);
        const cap = 100;
        expect(out.missing_ids).toEqual(remaining.slice(0, cap));
        expect(out.deferred_ids).toEqual(remaining.slice(cap));
        surfaces(result, `**Missing ids:** ${remaining.slice(0, cap).join(', ')}`);
        surfaces(
          result,
          `**Deferred ids:** ${remaining.length > cap ? remaining.slice(cap).join(', ') : 'none'}`,
        );
        attempted.push(...out.missing_ids!);
        remaining = out.deferred_ids!;
      }
      expect(attempted).toEqual(ids);
      expect(fetch).toHaveBeenCalled();
    },
  );
  it.each([
    [searchArtworks, 100, {}],
    [searchArtists, 100, { query: 'a' }],
    [searchExhibitions, 100, {}],
    [searchAudioGuide, 100, { query: 'a' }],
  ])('clamps %s for exact second-page requests and discloses the cap', async (tool, cap, input) => {
    const fetch = serveEmpty();
    const result = await run(tool as never, { ...input, limit: 1000, page: 2 });
    const out = structuredOf<Output>(result);
    expect(out.cap).toBe(cap);
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({ page: 2, limit: cap });
    expect(out.notice).toContain(`Applied limit ${cap}`);
    surfaces(result, `Applied limit ${cap}`);
  });
  it('serves the vocabulary input maximum unclamped, with useful guidance at its ceiling', async () => {
    const buckets = Array.from({ length: 1000 }, (_, index) => ({
      key: `subject ${index + 1}`,
      doc_count: 2000 - index,
    }));
    const fetch = installAicService(
      scriptedFetch(
        jsonResponder({ data: [], aggregations: { v: { buckets, sum_other_doc_count: 1 } } }),
      ),
    );
    const result = await run(lookupVocabulary as never, { vocabulary: 'subject', limit: 1000 });
    const out = structuredOf<Output & { values: unknown[] }>(result);
    expect(out).toMatchObject({ cap: 1000, shown: 1000, truncated: true });
    expect(out.values).toHaveLength(1000);
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({
      aggs: { v: { terms: { size: 1000 } } },
    });
    expect(out.notice).toBe('More values exist: narrow with contains.');
    surfaces(result, 'narrow with contains');
    surfaces(result, '- subject 1000 (1001 artworks)');
  });
  it.each([
    [getArtworks, 100],
    [searchArtists, 100],
  ])('defers valid IDs when the attempted head is entirely missing', async (tool, cap) => {
    const fetch = serveEmpty();
    const ids = Array.from({ length: cap + 2 }, (_, index) => index + 1);
    const result = await run(tool as never, { ids });
    const out = structuredOf<Output>(result);
    expect(out.missing_ids).toEqual(ids.slice(0, cap));
    expect(out.deferred_ids).toEqual(ids.slice(cap));
    expect(new URL(urlOfCall(fetch)).searchParams.get('ids')).toBe(ids.slice(0, cap).join(','));
    surfaces(result, `**Deferred ids:** ${ids.slice(cap).join(', ')}`);
    surfaces(result, 'call artic_');
    const missingNotice =
      tool === getArtworks
        ? 'None of the attempted ids exist.'
        : 'None of the attempted ids is an agent.';
    expect(out.notice).toContain(missingNotice);
    surfaces(result, missingNotice);
    if (tool === searchArtists) {
      expect(out).toMatchObject({ has_more: true, truncated: true, cap });
      expect(out).not.toHaveProperty('next_page');
    }
  });
  it.each([getArtworks, searchArtists])(
    'validates the entire accepted ID tail before fetch',
    async (tool) => {
      const fetch = serveEmpty();
      const result = await run(tool as never, {
        ids: [...Array.from({ length: 40 }, (_, i) => i + 1), 'bad'],
      });
      expect(errorOf(result).data.reason).toBe('invalid_arguments');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([getArtworks, searchArtists])(
    'counts raw duplicate and blank entries before normalization',
    async (tool) => {
      const fetch = serveEmpty();
      for (const ids of [
        Array(1001).fill('1'),
        ['1', ...Array(1000).fill('')],
        '1,'.repeat(1000),
        `1${' '.repeat(100000)}`,
      ]) {
        expect(errorOf(await run(tool as never, { ids })).data.reason).toBe('invalid_arguments');
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('returns every attempted artwork record whole and defers only unattempted IDs', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope(
            Array.from({ length: 100 }, (_, i) =>
              artworkRecord(i + 1, { description: 'x'.repeat(45000) }),
            ),
            100,
          ),
        ),
      ),
    );
    const result = await run(getArtworks, {
      ids: Array.from({ length: 102 }, (_, i) => i + 1),
      include_related_media: false,
    });
    const out = structuredOf<{ artworks: { description?: string }[]; deferred_ids: number[] }>(
      result,
    );
    expect(out.artworks).toHaveLength(100);
    expect(out.artworks.every((artwork) => artwork.description?.length === 45000)).toBe(true);
    expect(out.deferred_ids).toEqual([101, 102]);
    surfaces(result, '**Deferred ids:** 101, 102');
  });
  it('carries a maximum-size ID remainder whole on both surfaces', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => Number.MAX_SAFE_INTEGER - i);
    installAicService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope(
            ids.slice(0, 100).map((id) => artworkRecord(id, { description: 'x'.repeat(19000) })),
            100,
          ),
        ),
      ),
    );
    const result = await run(getArtworks, { ids, include_related_media: false });
    const out = structuredOf<Output>(result);
    expect(out.artworks).toHaveLength(100);
    expect(out.deferred_ids).toEqual(ids.slice(100));
    surfaces(result, `**Deferred ids:** ${ids.slice(100).join(', ')}`);
  });
});

/** The emitted input schemas of a tool, by field. */
const inputProperties = (tool: { input: z.ZodType }) =>
  z.toJSONSchema(tool.input, { io: 'input' }).properties as Record<
    string,
    { type?: string; maximum?: number }
  >;

interface ScalarInput {
  expected: 'number' | 'boolean';
  field: string;
  name: string;
  required: Record<string, unknown>;
  tool: { input: z.ZodType };
  value: number | boolean | undefined;
}

/** Every input the six tools advertise as a number or boolean, beside the arguments its tool requires. */
const SCALAR_INPUTS = [
  { tool: searchArtworks, required: {} },
  { tool: getArtworks, required: { ids: [1] } },
  { tool: searchArtists, required: { query: 'a' } },
  { tool: searchExhibitions, required: {} },
  { tool: searchAudioGuide, required: { query: 'a' } },
  { tool: lookupVocabulary, required: { vocabulary: 'material' } },
].flatMap(({ tool, required }) =>
  Object.entries(inputProperties(tool)).flatMap(([field, { type, maximum }]): ScalarInput[] => {
    const row = { name: `${tool.name}.${field}`, tool, required, field };
    if (type === 'integer' || type === 'number')
      return [{ ...row, expected: 'number', value: maximum }];
    if (type === 'boolean') return [{ ...row, expected: 'boolean', value: true }];
    return [];
  }),
);

describe('number and boolean inputs', () => {
  it('finds them on every tool', () => {
    expect(SCALAR_INPUTS.map(({ name }) => name)).toEqual([
      'artic_search_artworks.artist_id',
      'artic_search_artworks.year_from',
      'artic_search_artworks.year_to',
      'artic_search_artworks.acquired_from',
      'artic_search_artworks.acquired_to',
      'artic_search_artworks.public_domain_only',
      'artic_search_artworks.on_view_only',
      'artic_search_artworks.has_image',
      'artic_search_artworks.page',
      'artic_search_artworks.limit',
      'artic_get_artworks.include_related_media',
      'artic_search_artists.artists_only',
      'artic_search_artists.born_from',
      'artic_search_artists.born_to',
      'artic_search_artists.page',
      'artic_search_artists.limit',
      'artic_search_exhibitions.artwork_id',
      'artic_search_exhibitions.artist_id',
      'artic_search_exhibitions.page',
      'artic_search_exhibitions.limit',
      'artic_search_audio_guide.page',
      'artic_search_audio_guide.limit',
      'artic_lookup_vocabulary.public_domain_only',
      'artic_lookup_vocabulary.limit',
    ]);
  });

  it('advertises the inner schema, default included, and none as required', () => {
    const described = { description: expect.any(String) };
    const artworks = inputProperties(searchArtworks);
    expect(artworks.artist_id).toStrictEqual({
      ...described,
      type: 'integer',
      exclusiveMinimum: 0,
      maximum: 9007199254740991,
    });
    expect(artworks.year_from).toStrictEqual({
      ...described,
      type: 'integer',
      minimum: -8000,
      maximum: 2100,
    });
    expect(artworks.public_domain_only).toStrictEqual({
      ...described,
      type: 'boolean',
      default: false,
    });
    expect(inputProperties(lookupVocabulary).limit).toStrictEqual({
      ...described,
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      default: 25,
    });
    expect(inputProperties(getArtworks).include_related_media).toStrictEqual({
      ...described,
      type: 'boolean',
      default: true,
    });
    for (const { tool, field } of SCALAR_INPUTS) {
      expect(z.toJSONSchema(tool.input, { io: 'input' }).required ?? []).not.toContain(field);
    }
  });

  it.each(SCALAR_INPUTS)(
    'rejects a string that spells neither on $name with its type error, before upstream work',
    async ({ tool, required, field, expected }) => {
      const fetch = serveEmpty();
      const result = await run(tool as never, { ...required, [field]: 'abc' });
      const message = `${field}: Invalid input: expected ${expected}, received string`;
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toStrictEqual({
        issues: [
          {
            code: 'invalid_type',
            expected,
            path: [field],
            message: `Invalid input: expected ${expected}, received string`,
          },
        ],
        reason: 'invalid_arguments',
        recovery: { hint: message },
      });
      expect(textOf(result)).toContain(message);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(SCALAR_INPUTS)(
    'reads the string form of $name as the value itself',
    ({ tool, required, field, value }) => {
      const typed = tool.input.parse({ ...required, [field]: value }) as Record<string, unknown>;
      expect(typed[field]).toBe(value);
      expect(tool.input.parse({ ...required, [field]: String(value) })).toStrictEqual(typed);
    },
  );

  // A form client sends "" for a field its user left empty.
  it.each(SCALAR_INPUTS)('reads a blank $name as leaving it out', ({ tool, required, field }) => {
    const omitted = tool.input.parse(required) as Record<string, unknown>;
    const blank = tool.input.parse({ ...required, [field]: '' });
    // Parsing keeps the key of a field that was sent, holding undefined when nothing defaults it.
    expect(blank).toStrictEqual({ ...omitted, [field]: omitted[field] });
  });
});
