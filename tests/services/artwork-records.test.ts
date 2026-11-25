/**
 * @fileoverview Tests for `loadArtworkRecords`: request-order records, missing
 * ids, the 100-id cap and deferred ids, the linked sound recordings,
 * publication sections, and text documents (concurrent loads, the 100-id cap
 * and degradation per kind, cancellation), and the description and publication
 * attributions.
 * @module tests/services/artwork-records.test.ts
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAicService, initAicService } from '@/services/aic/aic-service.js';
import {
  DEFAULT_SECTIONS,
  DESCRIPTION_ATTRIBUTION,
  loadArtworkRecords,
  PUBLICATION_CITATION,
} from '@/services/aic/artwork-records.js';
import {
  barrier,
  behindFirewall,
  hangingResponder,
  idSearchesOf,
  jsonResponder,
  networkErrorResponder,
  queryParam,
  type Responder,
  rejection,
  rejectionOf,
  routedFetch,
  SECTIONS,
  SOUNDS,
  searchCallOf,
  soundSearchesOf,
  TEST_VERSION,
  TEXTS,
  textResponder,
} from '../fixtures/aic-service-kit.js';
import {
  ARTWORK_LICENSE,
  artworkRecord,
  ES_BAD_REQUEST_TEXT,
  envelope,
  inCopyrightArtworkRecord,
  SECTION_LICENSE,
  searchEnvelope,
  sectionRecord,
  soundRecord,
  soundUuid,
  sparseArtworkRecord,
  TEXT_LICENSE,
  textRecord,
  textUuid,
} from '../fixtures/aic-upstream.js';

const ARTWORKS = '/api/v1/artworks';

const UNATTEMPTED_NOTICE =
  'The first 100 ids were attempted; call artic_get_artworks again with deferred_ids for the rest.';

const degradedNotice =
  'The linked sound recordings could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry.';

function setup(routes: Record<string, Responder>) {
  const fetch = routedFetch(routes);
  initAicService({
    contact: 'https://example.test/contact',
    version: TEST_VERSION,
    fetch,
    pacer: createPacer({ name: 'aic-records-test' }),
    retry: { baseDelayMs: 0 },
  });
  return fetch;
}

const request = (
  ids: number[],
  overrides: Partial<Parameters<typeof loadArtworkRecords>[0]> = {},
) => ({
  ids,
  include_related_media: true,
  sections: DEFAULT_SECTIONS,
  ...overrides,
});

/** `/artworks` calls recorded, as parsed `ids` lists. */
const artworkIdsRequested = (fetch: ReturnType<typeof routedFetch>): number[][] =>
  fetch.mock.calls
    .filter(([url]) => new URL(url).pathname === ARTWORKS)
    .map(([url]) => (queryParam(url, 'ids') ?? '').split(',').map(Number));

/** `/sounds` searches recorded, as the uuid lists of their `id` terms filter. */
const soundIdsRequested = (fetch: ReturnType<typeof routedFetch>): string[][] =>
  soundSearchesOf(fetch).map(({ ids }) => ids);

/** `/sections` searches recorded, as the id lists of their `id` terms filter. */
const sectionIdsRequested = (fetch: ReturnType<typeof routedFetch>): number[][] =>
  idSearchesOf<number>(fetch, SECTIONS).map(({ ids }) => ids);

/** `/texts` searches recorded, as the uuid lists of their `id` terms filter. */
const textIdsRequested = (fetch: ReturnType<typeof routedFetch>): string[][] =>
  idSearchesOf(fetch, TEXTS).map(({ ids }) => ids);

/** Paths requested, in call order. */
const pathsRequested = (fetch: ReturnType<typeof routedFetch>): string[] =>
  fetch.mock.calls.map(([url]) => new URL(url).pathname);

const warningsOf = (ctx: ReturnType<typeof createMockContext>): string[] =>
  (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning').map((c) => c.msg);

/** An artwork linking one item of each kind, all numbered `id`. */
const linkedArtwork = (id: number) =>
  artworkRecord(id, { sound_ids: [soundUuid(id)], section_ids: [id], text_ids: [textUuid(id)] });

const soundsResponder = (ns: number[]) =>
  jsonResponder(searchEnvelope(ns.map((n) => soundRecord(soundUuid(n)))));
const sectionsResponder = (ns: number[], license: string | null = SECTION_LICENSE) =>
  jsonResponder(
    searchEnvelope(
      ns.map((n) => sectionRecord(n)),
      ns.length,
      { license },
    ),
  );
const textsResponder = (ns: number[]) =>
  jsonResponder(
    searchEnvelope(
      ns.map((n) => textRecord(textUuid(n))),
      ns.length,
      { license: TEXT_LICENSE },
    ),
  );

/** Routes `artworks` plus each kind's search; a kind left out fails if it is requested. */
const setupLinked = (
  artworks: unknown[],
  kinds: { sections?: Responder; sounds?: Responder; texts?: Responder },
) =>
  setup({
    [ARTWORKS]: jsonResponder(envelope(artworks)),
    ...(kinds.sounds ? { [SOUNDS]: kinds.sounds } : {}),
    ...(kinds.sections ? { [SECTIONS]: kinds.sections } : {}),
    ...(kinds.texts ? { [TEXTS]: kinds.texts } : {}),
  });

const range = (count: number, from = 1) => Array.from({ length: count }, (_, i) => from + i);

afterEach(() => {
  disposeAicService();
});

describe('loadArtworkRecords', () => {
  describe('records and missing ids', () => {
    it('returns records in request order with the license and no notices', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope([artworkRecord(2), artworkRecord(1)])) });
      const result = await loadArtworkRecords(
        request([1, 2], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.artworks.map((a) => a.id)).toEqual([1, 2]);
      expect(result.missing_ids).toEqual([]);
      expect(result.deferred_ids).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(result.license_text).toBe(ARTWORK_LICENSE);
    });

    it('names the missing ids in a notice when some exist', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope([artworkRecord(1)])) });
      const result = await loadArtworkRecords(request([1, 7, 9]), createMockContext());
      expect(result.artworks.map((a) => a.id)).toEqual([1]);
      expect(result.missing_ids).toEqual([7, 9]);
      expect(result.notices).toEqual([
        'No artwork exists for id 7, 9; find ids with artic_search_artworks.',
      ]);
    });

    it('treats all ids missing as a result, not an error', async () => {
      const fetch = setup({ [ARTWORKS]: jsonResponder(envelope([])) });
      const result = await loadArtworkRecords(request([5, 6]), createMockContext());
      expect(result.artworks).toEqual([]);
      expect(result.missing_ids).toEqual([5, 6]);
      expect(result.notices).toEqual([
        'None of the attempted ids exist. Find ids with artic_search_artworks.',
      ]);
      expect(result).not.toHaveProperty('description_attribution');
      expect(soundIdsRequested(fetch)).toEqual([]);
    });

    it('passes the requested ids and sections to the upstream call', async () => {
      const fetch = setup({ [ARTWORKS]: jsonResponder(envelope([])) });
      await loadArtworkRecords(
        request([3, 1], {
          sections: ['publication_history', 'provenance'],
          include_related_media: false,
        }),
        createMockContext(),
      );
      const [url] = fetch.mock.calls[0] ?? [];
      expect(queryParam(url ?? '', 'ids')).toBe('3,1');
      const fields = (queryParam(url ?? '', 'fields') ?? '').split(',');
      expect(fields).toContain('provenance_text');
      expect(fields).toContain('publication_history');
      expect(fields).not.toContain('description');
    });

    it('fails the call when the primary fetch fails', async () => {
      setup({ [ARTWORKS]: jsonResponder({}, 503) });
      const error = await rejection(loadArtworkRecords(request([1]), createMockContext()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails the call on a rejected primary query, with its reason', async () => {
      setup({ [ARTWORKS]: textResponder(ES_BAD_REQUEST_TEXT, 400) });
      const error = await rejection(loadArtworkRecords(request([1]), createMockContext()));
      expect(error.data).toMatchObject({ reason: 'upstream_rejected_query' });
    });

    it('lets a throttled primary fetch surface as rate_limited', async () => {
      setup({ [ARTWORKS]: jsonResponder({}, 429, { 'retry-after': '30' }) });
      const error = await rejection(loadArtworkRecords(request([1]), createMockContext()));
      expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30 });
    });
  });

  describe('description attribution', () => {
    it('is present when a record carries a description', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { description: '<p>Text.</p>' })])),
      });
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
      expect(DESCRIPTION_ATTRIBUTION).toBe(
        "Description text © Art Institute of Chicago, CC BY 4.0 — cite the record's web_url.",
      );
    });

    it('is present when only a short description exists', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { short_description: 'Short.' })])),
      });
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
    });

    it('is absent when no record has description text', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope([artworkRecord(1), sparseArtworkRecord(2)])) });
      const result = await loadArtworkRecords(
        request([1, 2], { include_related_media: false }),
        createMockContext(),
      );
      expect(result).not.toHaveProperty('description_attribution');
    });

    it('is present when a description-bearing record follows a very large one', async () => {
      setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            artworkRecord(1, { provenance_text: 'p'.repeat(250_000) }),
            artworkRecord(2, { description: '<p>Text.</p>' }),
          ]),
        ),
      });
      const result = await loadArtworkRecords(
        request([1, 2], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.deferred_ids).toEqual([]);
      expect(result.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
    });

    it('is absent when the only description-bearing id falls past the 100th', async () => {
      const head = Array.from({ length: 100 }, (_, i) => i + 1);
      setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            ...head.map((id) => sparseArtworkRecord(id)),
            artworkRecord(101, { description: '<p>Text.</p>' }),
          ]),
        ),
      });
      const result = await loadArtworkRecords(
        request([...head, 101], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.deferred_ids).toEqual([101]);
      expect(result).not.toHaveProperty('description_attribution');
    });

    it('is absent when the description is markup with no text', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { description: '<p> </p>' })])),
      });
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(result).not.toHaveProperty('description_attribution');
    });
  });

  describe('the 100-id cap', () => {
    const bulky = (id: number, chars: number) =>
      artworkRecord(id, { provenance_text: 'p'.repeat(chars) });

    it('attempts exactly 100 ids in one call, deferring none', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(envelope(range(100).map((id) => artworkRecord(id)))),
      });
      const result = await loadArtworkRecords(
        request(range(100), { include_related_media: false }),
        createMockContext(),
      );
      expect(artworkIdsRequested(fetch)).toEqual([range(100)]);
      expect(result.artworks.map((a) => a.id)).toEqual(range(100));
      expect(result.deferred_ids).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    it('attempts the first 100 ids and defers the rest in request order', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(envelope(range(100).map((id) => artworkRecord(id)))),
      });
      const result = await loadArtworkRecords(
        request([...range(100), 250, 101], { include_related_media: false }),
        createMockContext(),
      );
      expect(artworkIdsRequested(fetch)).toEqual([range(100)]);
      expect(result.artworks.map((a) => a.id)).toEqual(range(100));
      expect(result.missing_ids).toEqual([]);
      expect(result.deferred_ids).toEqual([250, 101]);
      expect(result.notices).toEqual([UNATTEMPTED_NOTICE]);
    });

    it('returns every found record whole, however large, with nothing deferred', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([bulky(3, 10), bulky(1, 300_000), bulky(2, 300_000)])),
      });
      const result = await loadArtworkRecords(
        request([1, 2, 3], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.artworks.map((a) => [a.id, a.provenance?.length])).toEqual([
        [1, 300_000],
        [2, 300_000],
        [3, 10],
      ]);
      expect(result.deferred_ids).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    it('reports only attempted ids as missing, never the deferred tail', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope(range(99).map((id) => artworkRecord(id)))) });
      const result = await loadArtworkRecords(
        request([...range(100), 101], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.missing_ids).toEqual([100]);
      expect(result.deferred_ids).toEqual([101]);
      expect(result.notices).toEqual([
        'No artwork exists for id 100; find ids with artic_search_artworks.',
        UNATTEMPTED_NOTICE,
      ]);
    });

    it('loads related media for every returned record, however large', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            { ...bulky(1, 300_000), sound_ids: [soundUuid(1)] },
            { ...bulky(2, 10), sound_ids: [soundUuid(2)] },
          ]),
        ),
        [SOUNDS]: jsonResponder(envelope([soundRecord(soundUuid(1)), soundRecord(soundUuid(2))])),
      });
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(result.deferred_ids).toEqual([]);
      expect(soundIdsRequested(fetch)).toEqual([[soundUuid(1), soundUuid(2)]]);
      expect(result.artworks.map((a) => a.related_media?.length)).toEqual([1, 1]);
      expect(result.notices).toEqual([]);
    });
  });

  describe('related media', () => {
    it('attaches each record its own media in the order its sound ids list them', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            artworkRecord(1, { sound_ids: [soundUuid(2), soundUuid(1)] }),
            artworkRecord(2, { sound_ids: [soundUuid(3)] }),
            artworkRecord(3),
          ]),
        ),
        [SOUNDS]: jsonResponder(
          envelope([
            soundRecord(soundUuid(3), { title: 'Third' }),
            soundRecord(soundUuid(1), { title: 'First' }),
            soundRecord(soundUuid(2), { title: 'Second' }),
          ]),
        ),
      });
      const result = await loadArtworkRecords(request([1, 2, 3]), createMockContext());
      expect(result.artworks[0]?.related_media?.map((m) => m.title)).toEqual(['Second', 'First']);
      expect(result.artworks[1]?.related_media?.map((m) => m.title)).toEqual(['Third']);
      expect(result.artworks[2]).not.toHaveProperty('related_media');
      expect(result.notices).toEqual([]);
      expect(soundIdsRequested(fetch)).toEqual([[soundUuid(2), soundUuid(1), soundUuid(3)]]);
    });

    it('shapes each item as id, title, url, and type', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { sound_ids: [soundUuid(1)] })])),
        [SOUNDS]: jsonResponder(
          envelope([soundRecord(soundUuid(1), { title: 'A <em>Talk</em>' })]),
        ),
      });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(result.artworks[0]?.related_media).toEqual([
        {
          id: soundUuid(1),
          title: 'A Talk',
          url: `https://www.artic.edu/assets/${soundUuid(1)}`,
          type: 'sound',
        },
      ]);
    });

    it('loads the union once, deduplicating ids shared between records', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            artworkRecord(1, { sound_ids: [soundUuid(1), soundUuid(2)] }),
            artworkRecord(2, { sound_ids: [soundUuid(2), soundUuid(3)] }),
          ]),
        ),
        [SOUNDS]: jsonResponder(
          envelope([
            soundRecord(soundUuid(1)),
            soundRecord(soundUuid(2)),
            soundRecord(soundUuid(3)),
          ]),
        ),
      });
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(soundIdsRequested(fetch)).toEqual([[soundUuid(1), soundUuid(2), soundUuid(3)]]);
      expect(result.artworks[0]?.related_media).toHaveLength(2);
      expect(result.artworks[1]?.related_media).toHaveLength(2);
    });

    it('skips the /sounds call when no record has sound ids', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(
          envelope([artworkRecord(1), artworkRecord(2, { sound_ids: [] })]),
        ),
      });
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(soundIdsRequested(fetch)).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    it('skips the /sounds call when media is not requested', async () => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { sound_ids: [soundUuid(1)] })])),
      });
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(soundIdsRequested(fetch)).toEqual([]);
      expect(result.artworks[0]).not.toHaveProperty('related_media');
    });

    it('leaves out a record whose sounds resolved to nothing rather than attaching an empty list', async () => {
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { sound_ids: [soundUuid(1)] })])),
        [SOUNDS]: jsonResponder(envelope([])),
      });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(result.artworks[0]).not.toHaveProperty('related_media');
      expect(result.notices).toEqual([]);
    });

    describe('the 100-item cap', () => {
      const ids = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => soundUuid(from + i));
      const soundsFor = (all: string[]) =>
        jsonResponder(envelope(all.map((id) => soundRecord(id))));

      it('loads the 67 sound ids that 100 records link in one posted search', async () => {
        const union = ids(1, 67);
        const linked = (index: number) =>
          [union[index % 67], union[(index + 1) % 67]].filter((id): id is string => !!id);
        const fetch = setup({
          [ARTWORKS]: jsonResponder(
            envelope(
              Array.from({ length: 100 }, (_, index) =>
                artworkRecord(index + 1, { sound_ids: linked(index) }),
              ),
            ),
          ),
          // The ids= listing's GET would pass the firewall's limit at 52 uuids.
          [SOUNDS]: behindFirewall(soundsFor([...union].reverse())),
        });
        const result = await loadArtworkRecords(
          request(Array.from({ length: 100 }, (_, i) => i + 1)),
          createMockContext(),
        );
        expect(soundIdsRequested(fetch)).toEqual([union]);
        const soundCall = fetch.mock.calls.findIndex(([url]) => new URL(url).pathname === SOUNDS);
        expect(searchCallOf(fetch, soundCall)).toMatchObject({
          method: 'POST',
          body: { limit: 67 },
        });
        expect(result.artworks).toHaveLength(100);
        for (const [index, artwork] of result.artworks.entries()) {
          expect(artwork.related_media?.map((media) => media.id)).toEqual(linked(index));
        }
        expect(result.notices).toEqual([]);
      });

      it('loads exactly 100 ids when the union is larger, in record order', async () => {
        const a = ids(1, 60);
        const b = ids(61, 50);
        const fetch = setup({
          [ARTWORKS]: jsonResponder(
            envelope([artworkRecord(1, { sound_ids: a }), artworkRecord(2, { sound_ids: b })]),
          ),
          [SOUNDS]: soundsFor([...a, ...b]),
        });
        await loadArtworkRecords(request([1, 2]), createMockContext());
        const [requested] = soundIdsRequested(fetch);
        expect(requested).toHaveLength(100);
        expect(requested).toEqual([...a, ...b.slice(0, 40)]);
      });

      it('names the records left with partial or no media in a notice', async () => {
        const a = ids(1, 60);
        const b = ids(61, 50);
        const c = ids(111, 3);
        setup({
          [ARTWORKS]: jsonResponder(
            envelope([
              artworkRecord(1, { sound_ids: a }),
              artworkRecord(2, { sound_ids: b }),
              artworkRecord(3, { sound_ids: c }),
            ]),
          ),
          [SOUNDS]: soundsFor([...a, ...b, ...c]),
        });
        const result = await loadArtworkRecords(request([1, 2, 3]), createMockContext());
        expect(result.artworks[0]?.related_media).toHaveLength(60);
        expect(result.artworks[1]?.related_media).toHaveLength(40);
        expect(result.artworks[2]).not.toHaveProperty('related_media');
        expect(result.notices).toEqual([
          'Linked sound recordings are capped at 100 per call; artwork 2, 3 is missing some or all of them. Call artic_get_artworks with fewer ids to load them.',
        ]);
      });

      it('does not cap or notify at exactly 100 ids', async () => {
        const a = ids(1, 67);
        const b = ids(68, 33);
        const fetch = setup({
          [ARTWORKS]: jsonResponder(
            envelope([artworkRecord(1, { sound_ids: a }), artworkRecord(2, { sound_ids: b })]),
          ),
          [SOUNDS]: soundsFor([...a, ...b]),
        });
        const result = await loadArtworkRecords(request([1, 2]), createMockContext());
        expect(soundIdsRequested(fetch)[0]).toHaveLength(100);
        expect(result.notices).toEqual([]);
        expect(result.artworks[1]?.related_media).toHaveLength(33);
      });

      it('counts shared ids once toward the cap', async () => {
        const shared = ids(1, 90);
        const fetch = setup({
          [ARTWORKS]: jsonResponder(
            envelope([
              artworkRecord(1, { sound_ids: shared }),
              artworkRecord(2, { sound_ids: [...shared, ...ids(91, 10)] }),
            ]),
          ),
          [SOUNDS]: soundsFor([...shared, ...ids(91, 10)]),
        });
        const result = await loadArtworkRecords(request([1, 2]), createMockContext());
        expect(soundIdsRequested(fetch)[0]).toHaveLength(100);
        expect(result.notices).toEqual([]);
      });

      it('adds the cap notice after the other notices', async () => {
        const many = ids(1, 105);
        setup({
          [ARTWORKS]: jsonResponder(
            envelope([
              artworkRecord(1, { sound_ids: many }),
              artworkRecord(2, { sound_ids: ids(500, 1) }),
            ]),
          ),
          [SOUNDS]: soundsFor([...many, ...ids(500, 1)]),
        });
        const result = await loadArtworkRecords(request([1, 2, 3]), createMockContext());
        expect(result.notices).toHaveLength(2);
        expect(result.notices[0]).toContain('No artwork exists for id 3');
        expect(result.notices[1]).toContain('capped at 100');
      });
    });
  });

  describe('a failed /sounds call', () => {
    const withBrokenSounds = (sounds: Responder) =>
      setup({
        [ARTWORKS]: jsonResponder(
          envelope([
            artworkRecord(1, { sound_ids: [soundUuid(1)], description: '<p>Text.</p>' }),
            artworkRecord(2),
          ]),
        ),
        [SOUNDS]: sounds,
      });

    it.each([
      ['a 5xx', jsonResponder({}, 500)],
      ['a rate limit', jsonResponder({}, 429)],
      ['a firewall 403', textResponder('<html>blocked</html>', 403)],
      ['a 400 rejection', textResponder(ES_BAD_REQUEST_TEXT, 400)],
      ['a rejected 403 JSON', jsonResponder({ status: 403, error: 'Forbidden' }, 403)],
      ['a network failure', networkErrorResponder()],
      ['an unreadable body', textResponder('not json')],
    ])('returns the records without media and a notice on %s', async (_name, sounds) => {
      withBrokenSounds(sounds);
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(result.artworks.map((a) => a.id)).toEqual([1, 2]);
      for (const artwork of result.artworks) expect(artwork).not.toHaveProperty('related_media');
      expect(result.notices).toEqual([degradedNotice]);
      expect(result.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
      expect(result.license_text).toBe(ARTWORK_LICENSE);
    });

    it('logs the degradation at warning', async () => {
      withBrokenSounds(jsonResponder({}, 500));
      const ctx = createMockContext();
      await loadArtworkRecords(request([1, 2]), ctx);
      const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.msg).toContain('sound recordings could not be loaded');
    });

    it('keeps the cap and degradation notices in order after a missing-id notice', async () => {
      withBrokenSounds(jsonResponder({}, 500));
      const result = await loadArtworkRecords(request([1, 2, 8]), createMockContext());
      expect(result.notices).toEqual([
        'No artwork exists for id 8; find ids with artic_search_artworks.',
        degradedNotice,
      ]);
    });

    it('does not degrade the primary: a failed /artworks call still fails the load', async () => {
      setup({ [ARTWORKS]: jsonResponder({}, 500), [SOUNDS]: jsonResponder(envelope([])) });
      await expect(loadArtworkRecords(request([1]), createMockContext())).rejects.toBeInstanceOf(
        McpError,
      );
    });
  });

  describe('cancellation', () => {
    it('rethrows rather than degrading when the signal aborts during the /sounds call', async () => {
      const controller = new AbortController();
      setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, { sound_ids: [soundUuid(1)] })])),
        [SOUNDS]: () => {
          controller.abort(new DOMException('cancelled by caller', 'AbortError'));
          throw controller.signal.reason;
        },
      });
      const ctx = createMockContext({ signal: controller.signal });
      const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).message).toBe('cancelled by caller');
      expect((ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning')).toEqual([]);
    });

    it('rethrows when the signal aborts during the primary call', async () => {
      const controller = new AbortController();
      setup({
        [ARTWORKS]: () => {
          controller.abort(new DOMException('cancelled by caller', 'AbortError'));
          throw controller.signal.reason;
        },
      });
      const ctx = createMockContext({ signal: controller.signal });
      const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
      expect((error as DOMException).message).toBe('cancelled by caller');
    });
  });

  describe('publication sections and text documents', () => {
    it('attaches each record its sections and its texts after its sounds, in the order its ids list them', async () => {
      const fetch = setupLinked(
        [
          artworkRecord(1, {
            sound_ids: [soundUuid(2), soundUuid(1)],
            section_ids: [520264, 421375],
            text_ids: [textUuid(9), textUuid(8)],
          }),
          artworkRecord(2, { section_ids: [36741370056, 421375] }),
          artworkRecord(3, { text_ids: [textUuid(8)] }),
          artworkRecord(4),
        ],
        {
          sounds: soundsResponder([1, 2]),
          sections: sectionsResponder([36741370056, 421375, 520264]),
          texts: textsResponder([8, 9]),
        },
      );
      const result = await loadArtworkRecords(request([1, 2, 3, 4]), createMockContext());
      expect(result.artworks[0]?.related_media).toEqual([
        {
          id: soundUuid(2),
          title: 'Synthetic stop 0002',
          url: `https://www.artic.edu/assets/${soundUuid(2)}`,
          type: 'sound',
        },
        {
          id: soundUuid(1),
          title: 'Synthetic stop 0001',
          url: `https://www.artic.edu/assets/${soundUuid(1)}`,
          type: 'sound',
        },
        {
          id: textUuid(9),
          title: 'Synthetic text 0009',
          url: `https://www.artic.edu/assets/${textUuid(9)}`,
          type: 'text',
        },
        {
          id: textUuid(8),
          title: 'Synthetic text 0008',
          url: `https://www.artic.edu/assets/${textUuid(8)}`,
          type: 'text',
        },
      ]);
      const link = (id: number) => ({
        id,
        title: `Cat. ${id} Synthetic Entry, 1877`,
        publication_title: 'Synthetic Paintings at the Art Institute of Chicago',
        web_url: `https://publications.artic.edu/synthetic/reader/works/section/${id}`,
      });
      expect(result.artworks.map((a) => a.publication_sections)).toEqual([
        [link(520264), link(421375)],
        [link(36741370056), link(421375)],
        undefined,
        undefined,
      ]);
      expect(result.artworks[1]).not.toHaveProperty('related_media');
      expect(result.artworks[2]?.related_media?.map((m) => m.id)).toEqual([textUuid(8)]);
      expect(result.artworks[2]).not.toHaveProperty('publication_sections');
      expect(result.artworks[3]).not.toHaveProperty('related_media');
      expect(result.artworks[3]).not.toHaveProperty('publication_sections');
      expect(sectionIdsRequested(fetch)).toEqual([[520264, 421375, 36741370056]]);
      expect(textIdsRequested(fetch)).toEqual([[textUuid(9), textUuid(8)]]);
      expect(result.notices).toEqual([]);
    });

    it.each([
      ['sounds', { sound_ids: [soundUuid(1)] }, SOUNDS],
      ['sections', { section_ids: [1] }, SECTIONS],
      ['texts', { text_ids: [textUuid(1)] }, TEXTS],
    ])('sends only the %s search when nothing else is linked', async (_kind, links, path) => {
      const fetch = setup({
        [ARTWORKS]: jsonResponder(envelope([artworkRecord(1, links), sparseArtworkRecord(2)])),
        [path]: jsonResponder(envelope([])),
      });
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(pathsRequested(fetch)).toEqual([ARTWORKS, path]);
      expect(result.notices).toEqual([]);
    });

    it('loads every kind for the attempted ids when later ids were deferred', async () => {
      const fetch = setupLinked([linkedArtwork(1)], {
        sounds: soundsResponder([1]),
        sections: sectionsResponder([1]),
        texts: textsResponder([1]),
      });
      const result = await loadArtworkRecords(request(range(101)), createMockContext());
      expect(result.deferred_ids).toEqual([101]);
      expect(pathsRequested(fetch)).toEqual([ARTWORKS, SOUNDS, SECTIONS, TEXTS]);
      expect(result.artworks).toHaveLength(1);
      expect(result.artworks[0]?.related_media?.map((m) => m.type)).toEqual(['sound', 'text']);
      expect(result.artworks[0]?.publication_sections).toHaveLength(1);
      expect(result.publication_citation).toBe(
        "Publication sections © Art Institute of Chicago and third parties, https://www.artic.edu/terms — cite the section's web_url.",
      );
    });

    it('sends no linked-item search and attaches nothing when related media is declined', async () => {
      const fetch = setupLinked([linkedArtwork(1)], {});
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(pathsRequested(fetch)).toEqual([ARTWORKS]);
      expect(result.artworks[0]).not.toHaveProperty('related_media');
      expect(result.artworks[0]).not.toHaveProperty('publication_sections');
      expect(result).not.toHaveProperty('publication_license_text');
      expect(result).not.toHaveProperty('publication_citation');
    });

    it.each([
      ['the API has none of the ids', sectionsResponder([]), textsResponder([])],
      [
        'no item has a usable URL',
        jsonResponder(
          searchEnvelope([
            sectionRecord(1, { web_url: null }),
            sectionRecord(2, { web_url: 'javascript:alert(1)' }),
          ]),
        ),
        jsonResponder(searchEnvelope([textRecord(textUuid(1), { content: 'Prose.' })])),
      ],
    ])('carries neither, and no publication terms, when %s', async (_name, sections, texts) => {
      setupLinked([artworkRecord(1, { section_ids: [1, 2], text_ids: [textUuid(1)] })], {
        sections,
        texts,
      });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(result.artworks[0]).not.toHaveProperty('publication_sections');
      expect(result.artworks[0]).not.toHaveProperty('related_media');
      expect(result).not.toHaveProperty('publication_license_text');
      expect(result).not.toHaveProperty('publication_citation');
      expect(result.notices).toEqual([]);
    });

    it('keeps the sounds of a record whose texts loaded nothing, and the reverse', async () => {
      setupLinked([linkedArtwork(1), linkedArtwork(2)], {
        sounds: soundsResponder([1]),
        sections: sectionsResponder([]),
        texts: textsResponder([2]),
      });
      const result = await loadArtworkRecords(request([1, 2]), createMockContext());
      expect(result.artworks.map((a) => a.related_media?.map((m) => m.type))).toEqual([
        ['sound'],
        ['text'],
      ]);
    });

    describe('publication terms', () => {
      it('carries the sections license verbatim and the citation when any record has a section', async () => {
        setupLinked([artworkRecord(1), artworkRecord(2, { section_ids: [2] })], {
          sections: sectionsResponder([2]),
        });
        const result = await loadArtworkRecords(request([1, 2]), createMockContext());
        expect(result.license_text).toBe(ARTWORK_LICENSE);
        expect(result.publication_license_text).toBe(SECTION_LICENSE);
        expect(result.publication_citation).toBe(PUBLICATION_CITATION);
        expect(PUBLICATION_CITATION).toBe(
          "Publication sections © Art Institute of Chicago and third parties, https://www.artic.edu/terms — cite the section's web_url.",
        );
      });

      it('carries neither for records with sounds and texts alone', async () => {
        setupLinked([artworkRecord(1, { sound_ids: [soundUuid(1)], text_ids: [textUuid(1)] })], {
          sounds: soundsResponder([1]),
          texts: textsResponder([1]),
        });
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(result.artworks[0]?.related_media).toHaveLength(2);
        expect(result).not.toHaveProperty('publication_license_text');
        expect(result).not.toHaveProperty('publication_citation');
      });

      it('carries neither when the sections load failed', async () => {
        setupLinked([linkedArtwork(1)], {
          sounds: soundsResponder([1]),
          sections: jsonResponder({}, 500),
          texts: textsResponder([1]),
        });
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(result).not.toHaveProperty('publication_license_text');
        expect(result).not.toHaveProperty('publication_citation');
      });

      it('carries both, the license empty, when the sections envelope states none', async () => {
        setupLinked([artworkRecord(1, { section_ids: [1] })], {
          sections: sectionsResponder([1], null),
        });
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(result.publication_license_text).toBe('');
        expect(result.publication_citation).toBe(PUBLICATION_CITATION);
      });
    });

    it('sends the three searches concurrently: none answers until all three are in flight', async () => {
      const held = barrier(3);
      const fetch = setupLinked([linkedArtwork(1)], {
        sounds: held(soundsResponder([1])),
        sections: held(sectionsResponder([1])),
        texts: held(textsResponder([1])),
      });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(pathsRequested(fetch)).toEqual([ARTWORKS, SOUNDS, SECTIONS, TEXTS]);
      expect(result.artworks[0]?.related_media?.map((m) => m.type)).toEqual(['sound', 'text']);
      expect(result.artworks[0]?.publication_sections).toHaveLength(1);
      expect(result.notices).toEqual([]);
    });

    it('lists sounds before texts when the texts answer first', async () => {
      const soundsMayAnswer = Promise.withResolvers<void>();
      setupLinked([artworkRecord(1, { sound_ids: [soundUuid(1)], text_ids: [textUuid(1)] })], {
        sounds: async (url, init) => {
          await soundsMayAnswer.promise;
          return await soundsResponder([1])(url, init);
        },
        texts: (url, init) => {
          soundsMayAnswer.resolve();
          return textsResponder([1])(url, init);
        },
      });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(result.artworks[0]?.related_media?.map((m) => m.type)).toEqual(['sound', 'text']);
    });

    describe('the 100-id cap of each kind', () => {
      it('loads the first 100 section ids in record order and names the records left short', async () => {
        const fetch = setupLinked(
          [
            artworkRecord(1, { section_ids: range(60) }),
            artworkRecord(2, { section_ids: range(50, 61) }),
            artworkRecord(3, { section_ids: range(3, 111) }),
            artworkRecord(4, { section_ids: range(2) }),
          ],
          { sections: sectionsResponder(range(113)) },
        );
        const result = await loadArtworkRecords(request([1, 2, 3, 4]), createMockContext());
        expect(sectionIdsRequested(fetch)).toEqual([range(100)]);
        expect(result.artworks.map((a) => a.publication_sections?.length)).toEqual([
          60,
          40,
          undefined,
          2,
        ]);
        expect(result.artworks[2]).not.toHaveProperty('publication_sections');
        expect(result.notices).toEqual([
          'Linked publication sections are capped at 100 per call; artwork 2, 3 is missing some or all of them. Call artic_get_artworks with fewer ids to load them.',
        ]);
      });

      it('loads the first 100 text ids in one posted search and names the records left short', async () => {
        const uuids = range(102).map(textUuid);
        const fetch = setupLinked(
          [
            artworkRecord(1, { text_ids: uuids.slice(0, 99) }),
            artworkRecord(2, { text_ids: uuids.slice(99) }),
          ],
          { texts: behindFirewall(textsResponder(range(102))) },
        );
        const result = await loadArtworkRecords(request([1, 2]), createMockContext());
        expect(textIdsRequested(fetch)).toEqual([uuids.slice(0, 100)]);
        expect(searchCallOf(fetch, 1)).toMatchObject({ method: 'POST', body: { limit: 100 } });
        expect(result.artworks.map((a) => a.related_media?.length)).toEqual([99, 1]);
        expect(result.notices).toEqual([
          'Linked text documents are capped at 100 per call; artwork 2 is missing some or all of them. Call artic_get_artworks with fewer ids to load them.',
        ]);
      });

      it('does not cap or notify at exactly 100 ids of every kind', async () => {
        const fetch = setupLinked(
          [
            artworkRecord(1, {
              sound_ids: range(100).map(soundUuid),
              section_ids: range(100),
              text_ids: range(100).map(textUuid),
            }),
          ],
          {
            sounds: soundsResponder(range(100)),
            sections: sectionsResponder(range(100)),
            texts: textsResponder(range(100)),
          },
        );
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(sectionIdsRequested(fetch)[0]).toHaveLength(100);
        expect(textIdsRequested(fetch)[0]).toHaveLength(100);
        expect(result.artworks[0]?.publication_sections).toHaveLength(100);
        expect(result.artworks[0]?.related_media).toHaveLength(200);
        expect(result.notices).toEqual([]);
      });

      it('counts a section two records share once, and attaches it to both', async () => {
        const fetch = setupLinked(
          [
            artworkRecord(1, { section_ids: range(100) }),
            artworkRecord(2, { section_ids: [100, 1] }),
          ],
          { sections: sectionsResponder(range(100)) },
        );
        const result = await loadArtworkRecords(request([1, 2]), createMockContext());
        expect(sectionIdsRequested(fetch)).toEqual([range(100)]);
        expect(result.artworks[1]?.publication_sections?.map((s) => s.id)).toEqual([100, 1]);
        expect(result.notices).toEqual([]);
      });

      it('gives each capped kind its own notice, after a degradation, naming its own records', async () => {
        setupLinked(
          [
            artworkRecord(1, { sound_ids: [soundUuid(1)], section_ids: range(100) }),
            artworkRecord(2, { section_ids: [101], text_ids: range(100).map(textUuid) }),
            artworkRecord(3, { text_ids: [textUuid(101)] }),
          ],
          {
            sounds: jsonResponder({}, 500),
            sections: sectionsResponder(range(100)),
            texts: textsResponder(range(100)),
          },
        );
        const result = await loadArtworkRecords(request([1, 2, 3, 9]), createMockContext());
        expect(result.notices.join(' ')).toBe(
          'No artwork exists for id 9; find ids with artic_search_artworks. The linked sound recordings could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry. Linked publication sections are capped at 100 per call; artwork 2 is missing some or all of them. Call artic_get_artworks with fewer ids to load them. Linked text documents are capped at 100 per call; artwork 3 is missing some or all of them. Call artic_get_artworks with fewer ids to load them.',
        );
      });
    });

    describe('a failed load', () => {
      const failing = jsonResponder({ status: 403, error: 'Forbidden' }, 403);

      it.each([
        ['sound recordings', { sounds: failing }, ['text'], 1],
        ['publication sections', { sections: failing }, ['sound', 'text'], undefined],
        ['text documents', { texts: failing }, ['sound'], 1],
        [
          'sound recordings and publication sections',
          { sounds: failing, sections: failing },
          ['text'],
          undefined,
        ],
        ['sound recordings and text documents', { sounds: failing, texts: failing }, undefined, 1],
        [
          'publication sections and text documents',
          { sections: failing, texts: failing },
          ['sound'],
          undefined,
        ],
        [
          'sound recordings, publication sections, and text documents',
          { sounds: failing, sections: failing, texts: failing },
          undefined,
          undefined,
        ],
      ])('of the %s names it and attaches the rest', async (kinds, broken, media, sections) => {
        setupLinked([linkedArtwork(1)], {
          sounds: soundsResponder([1]),
          sections: sectionsResponder([1]),
          texts: textsResponder([1]),
          ...broken,
        });
        const ctx = createMockContext();
        const result = await loadArtworkRecords(request([1]), ctx);
        expect(result.artworks.map((a) => a.id)).toEqual([1]);
        expect(result.artworks[0]?.related_media?.map((m) => m.type)).toEqual(media);
        expect(result.artworks[0]?.publication_sections?.length).toBe(sections);
        expect(result.notices).toEqual([
          `The linked ${kinds} could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry.`,
        ]);
        expect(warningsOf(ctx)).toHaveLength(Object.keys(broken).length);
      });

      it.each([
        ['a 5xx', jsonResponder({}, 500)],
        ['a rate limit', jsonResponder({}, 429)],
        ['a firewall 403', textResponder('<html>blocked</html>', 403)],
        ['a 400 rejection', textResponder(ES_BAD_REQUEST_TEXT, 400)],
        ['a network failure', networkErrorResponder()],
        ['an unreadable body', textResponder('not json')],
      ])('of the sections on %s degrades the same way', async (_name, sections) => {
        setupLinked([linkedArtwork(1)], {
          sounds: soundsResponder([1]),
          sections,
          texts: textsResponder([1]),
        });
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(result.artworks[0]).not.toHaveProperty('publication_sections');
        expect(result.artworks[0]?.related_media).toHaveLength(2);
        expect(result.notices).toEqual([
          'The linked publication sections could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry.',
        ]);
      });

      it('of a kind with more ids than the cap is reported as failed alone, not also as capped', async () => {
        setupLinked([artworkRecord(1, { section_ids: range(101) })], { sections: failing });
        const result = await loadArtworkRecords(request([1]), createMockContext());
        expect(result.notices).toEqual([
          'The linked publication sections could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry.',
        ]);
      });

      it('retries only the failed kind on the next call', async () => {
        let sectionCalls = 0;
        const fetch = setupLinked([linkedArtwork(1)], {
          sounds: soundsResponder([1]),
          sections: (url, init) => {
            sectionCalls += 1;
            return (sectionCalls === 1 ? failing : sectionsResponder([1]))(url, init);
          },
          texts: textsResponder([1]),
        });
        const first = await loadArtworkRecords(request([1]), createMockContext());
        expect(first.notices).toHaveLength(1);
        fetch.mockClear();
        const second = await loadArtworkRecords(request([1]), createMockContext());
        expect(pathsRequested(fetch)).toEqual([SECTIONS]);
        expect(second.artworks[0]?.publication_sections).toHaveLength(1);
        expect(second.artworks[0]?.related_media).toHaveLength(2);
        expect(second.notices).toEqual([]);
      });
    });

    describe('cancellation', () => {
      const cancelled = () => new DOMException('cancelled by caller', 'AbortError');
      const KINDS = ['sounds', 'sections', 'texts'] as const;

      /** Runs `work` and returns the unhandled rejections that surfaced during it. */
      async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
        const seen: unknown[] = [];
        const record = (reason: unknown) => seen.push(reason);
        process.on('unhandledRejection', record);
        try {
          await work();
          // Node reports an unhandled rejection after the microtask queue drains.
          await new Promise((resolve) => setImmediate(resolve));
        } finally {
          process.off('unhandledRejection', record);
        }
        return seen;
      }

      it.each(KINDS)('rethrows it from the %s load, the others in flight', async (kind) => {
        const controller = new AbortController();
        const held = barrier(3);
        const aborting: Responder = () => {
          controller.abort(cancelled());
          throw controller.signal.reason;
        };
        const responders = {
          sounds: hangingResponder,
          sections: hangingResponder,
          texts: hangingResponder,
          [kind]: aborting,
        };
        const fetch = setupLinked([linkedArtwork(1)], {
          sounds: held(responders.sounds),
          sections: held(responders.sections),
          texts: held(responders.texts),
        });
        const ctx = createMockContext({ signal: controller.signal });
        const unhandled = await unhandledDuring(async () => {
          const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
          expect(error).toBe(controller.signal.reason);
          expect((error as DOMException).message).toBe('cancelled by caller');
        });
        expect(unhandled).toEqual([]);
        expect(pathsRequested(fetch)).toHaveLength(4);
        expect(warningsOf(ctx)).toEqual([]);
      });

      it.each(KINDS)('rethrows it after the %s load has already degraded', async (kind) => {
        const controller = new AbortController();
        const ctx = createMockContext({ signal: controller.signal });
        const warn = ctx.log.warning.bind(ctx.log);
        ctx.log.warning = (...args) => {
          warn(...args);
          controller.abort(cancelled());
        };
        setupLinked([linkedArtwork(1)], {
          sounds: hangingResponder,
          sections: hangingResponder,
          texts: hangingResponder,
          [kind]: jsonResponder({ status: 403, error: 'Forbidden' }, 403),
        });
        const unhandled = await unhandledDuring(async () => {
          const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
          expect(error).toBe(controller.signal.reason);
        });
        expect(unhandled).toEqual([]);
        expect(warningsOf(ctx)).toHaveLength(1);
      });

      // The SDK aborts with the reason text of the client's cancelled notification, which is no Error.
      it('rethrows a plain string reason unchanged', async () => {
        const controller = new AbortController();
        const held = barrier(3);
        const fetch = setupLinked([linkedArtwork(1)], {
          sounds: held(hangingResponder),
          sections: held(hangingResponder),
          texts: held(() => {
            controller.abort('user cancelled');
            throw controller.signal.reason;
          }),
        });
        const ctx = createMockContext({ signal: controller.signal });
        const unhandled = await unhandledDuring(async () => {
          const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
          expect(error).toBe('user cancelled');
        });
        expect(unhandled).toEqual([]);
        expect(pathsRequested(fetch)).toEqual([ARTWORKS, SOUNDS, SECTIONS, TEXTS]);
        expect(warningsOf(ctx)).toEqual([]);
      });

      it('rethrows it when the other kinds answer normally', async () => {
        const controller = new AbortController();
        const held = barrier(3);
        setupLinked([linkedArtwork(1)], {
          sounds: held(soundsResponder([1])),
          sections: held(sectionsResponder([1])),
          texts: held(async () => {
            controller.abort(cancelled());
            throw controller.signal.reason;
          }),
        });
        const ctx = createMockContext({ signal: controller.signal });
        const error = await rejectionOf(loadArtworkRecords(request([1]), ctx));
        expect(error).toBe(controller.signal.reason);
        expect(warningsOf(ctx)).toEqual([]);
      });
    });
  });

  describe('sparse and in-copyright records', () => {
    it('loads a record with only an id', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope([sparseArtworkRecord(1)])) });
      const result = await loadArtworkRecords(request([1]), createMockContext());
      expect(result.artworks[0]).toMatchObject({ id: 1, title: '', artist_ids: [], styles: [] });
      expect(result.artworks[0]).not.toHaveProperty('image');
      expect(result.notices).toEqual([]);
    });

    it('carries the rights status of in-copyright works through to the records', async () => {
      setup({ [ARTWORKS]: jsonResponder(envelope([inCopyrightArtworkRecord(1)])) });
      const result = await loadArtworkRecords(
        request([1], { include_related_media: false }),
        createMockContext(),
      );
      expect(result.artworks[0]?.image?.rights).toBe('in_copyright');
      expect(result.artworks[0]?.image).not.toHaveProperty('url_large');
      expect(result.artworks[0]).not.toHaveProperty('manifest_url');
    });
  });

  it('defaults to the description and provenance sections', () => {
    expect(DEFAULT_SECTIONS).toEqual(['description', 'provenance']);
  });
});
