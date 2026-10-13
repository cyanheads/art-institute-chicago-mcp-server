/**
 * @fileoverview Bounded requested limits and ordered ID continuation at the real fetch seam.
 * @module tests/tools/limits.tool.test
 */
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
  scriptedFetch,
  searchBodyOf,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import { errorOf, installAicService, structuredOf } from '../fixtures/aic-tool-kit.js';
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
    [searchArtworks, 12, 'artworks', artworkRecord, {}],
    [searchArtists, 25, 'artists', agentRecord, { query: 'a' }],
    [searchExhibitions, 25, 'exhibitions', exhibitionRecord, {}],
    [searchAudioGuide, 2, 'stops', mobileSoundRecord, { query: 'a' }],
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
    [searchArtworks, 12, {}],
    [searchArtists, 25, { query: 'a' }],
    [searchExhibitions, 25, {}],
    [searchAudioGuide, 2, { query: 'a' }],
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
  it('returns two complete heaviest captured transcripts within the full MCP wire budget', async () => {
    const data = [audioHeaviest.data, { ...audioHeaviest.data, id: 999990 }];
    const fetch = installAicService(
      scriptedFetch(jsonResponder({ ...audioHeaviest, data, pagination: { total: 1067 } })),
    );
    const result = await run(searchAudioGuide as never, { query: 'art', limit: 1000 });
    const out = structuredOf<Output>(result);
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
        '# Audio-guide stops (2 on this page)',
        '**Page:** 1 · **More matches:** yes · **Next page:** 2',
        ...data.flatMap((stop) => [
          '',
          `## ${stop.title} (id ${stop.id})`,
          `- **Audio:** ${stop.web_url}`,
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
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100000);
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({ limit: 2 });
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
        const cap = tool === getArtworks ? 10 : 25;
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
    [searchArtworks, 12, {}],
    [searchArtists, 25, { query: 'a' }],
    [searchExhibitions, 25, {}],
    [searchAudioGuide, 2, { query: 'a' }],
  ])('clamps %s for exact second-page requests and discloses the cap', async (tool, cap, input) => {
    const fetch = serveEmpty();
    const result = await run(tool as never, { ...input, limit: 1000, page: 2 });
    const out = structuredOf<Output>(result);
    expect(out.cap).toBe(cap);
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({ page: 2, limit: cap });
    expect(out.notice).toContain(`Applied limit ${cap}`);
    surfaces(result, `Applied limit ${cap}`);
  });
  it('uses the vocabulary cap and useful guidance at its ceiling', async () => {
    const fetch = installAicService(
      scriptedFetch(
        jsonResponder({
          data: [],
          aggregations: { v: { buckets: [{ key: 'ink', doc_count: 2 }], sum_other_doc_count: 1 } },
        }),
      ),
    );
    const result = await run(lookupVocabulary as never, { vocabulary: 'material', limit: 1000 });
    const out = structuredOf<Output>(result);
    expect(out.cap).toBe(100);
    expect(searchBodyOf(urlOfCall(fetch))).toMatchObject({ aggs: { v: { terms: { size: 100 } } } });
    expect(out.notice).toContain('narrow with contains');
    expect(out.notice).not.toContain('raise limit');
    surfaces(result, 'narrow with contains');
  });
  it.each([
    [getArtworks, 10],
    [searchArtists, 25],
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
  it('places response-budget deferrals before unattempted artwork IDs', async () => {
    installAicService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope(
            Array.from({ length: 10 }, (_, i) =>
              artworkRecord(i + 1, { description: 'x'.repeat(45000) }),
            ),
            10,
          ),
        ),
      ),
    );
    const result = await run(getArtworks, {
      ids: Array.from({ length: 12 }, (_, i) => i + 1),
      include_related_media: false,
    });
    expect(structuredOf<Output>(result).deferred_ids).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 2),
    );
  });
  it('keeps a maximum-size ID remainder within the complete response budget', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => Number.MAX_SAFE_INTEGER - i);
    installAicService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope(
            ids.slice(0, 10).map((id) => artworkRecord(id, { description: 'x'.repeat(19000) })),
            10,
          ),
        ),
      ),
    );
    const result = await run(getArtworks, { ids, include_related_media: false });
    expect(structuredOf<Output>(result).deferred_ids).toHaveLength(999);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100000);
  });
});
