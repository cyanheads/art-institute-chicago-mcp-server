/**
 * @fileoverview Tests for the `artic_get_artworks` tool driven through a real
 * `AicService` over a fake `fetch`: id and section normalization, the batch
 * request, request-order reassembly and missing ids, the response budget,
 * related-media fan-out (cap, degradation, cancellation), upstream failure
 * classes on the primary call, and `format()` safety.
 * @module tests/tools/get-artworks.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArtworks } from '@/mcp-server/tools/definitions/get-artworks.tool.js';
import { type AicServiceOptions, disposeAicService } from '@/services/aic/aic-service.js';
import { DESCRIPTION_ATTRIBUTION } from '@/services/aic/artwork-records.js';
import {
  hangingResponder,
  jsonResponder,
  networkErrorResponder,
  queryParam,
  type Responder,
  routedFetch,
  scriptedFetch,
  textResponder,
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
  ALT_IMAGE_ID,
  API_NOT_FOUND_BODY,
  ARTWORK_LICENSE,
  artworkRecord,
  EDGE_BLOCK_HTML,
  ES_BAD_REQUEST_TEXT,
  envelope,
  IIIF_URL,
  IMAGE_ID,
  inCopyrightArtworkRecord,
  placeholderYearArtworkRecord,
  soundRecord,
  soundUuid,
  sparseArtworkRecord,
} from '../fixtures/aic-upstream.js';

interface GetRun {
  artworks: Record<string, unknown>[];
  deferred_ids: number[];
  description_attribution?: string;
  license_text: string;
  missing_ids: number[];
  notice?: string;
}

type FetchFake = ReturnType<typeof routedFetch>;

const ARTWORKS = '/api/v1/artworks';
const SOUNDS = '/api/v1/sounds';

const DETAIL_FIELDS =
  'id,title,alt_titles,main_reference_number,artist_display,artist_id,artist_ids,date_display,date_start,date_end,date_qualifier_title,place_of_origin,medium_display,dimensions,inscriptions,credit_line,copyright_notice,edition,artwork_type_title,department_title,classification_title,style_title,style_titles,subject_titles,material_titles,technique_titles,theme_titles,is_public_domain,is_on_view,gallery_title,on_loan_display,image_id,alt_image_ids,thumbnail,sound_ids';

/** `HOSTILE_INLINE_RENDERED` for a field the service passes through the HTML-to-text step, which removes the tag. */
const HOSTILE_CONVERTED_RENDERED =
  'Bad \\[link\\](https://example.test) end # Injected heading tail';

const DEGRADED_NOTICE =
  'Related media could not be loaded; the artwork records are complete. Call artic_get_artworks again to retry related media.';

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

/**
 * Installs a service routing `/artworks` to `artworks` and `/sounds` to
 * `sounds`. A call to an unrouted path fails the fetch, so tests also assert
 * `paths()` to prove which routes were hit.
 */
function serve(
  artworks: Responder | unknown[],
  sounds?: Responder | unknown[],
  options?: Partial<AicServiceOptions>,
): FetchFake {
  const asResponder = (value: Responder | unknown[]): Responder =>
    Array.isArray(value) ? jsonResponder(envelope(value)) : value;
  return installAicService(
    routedFetch({
      [ARTWORKS]: asResponder(artworks),
      ...(sounds ? { [SOUNDS]: asResponder(sounds) } : {}),
    }),
    options,
  );
}

const paths = (fetchFake: FetchFake) =>
  fetchFake.mock.calls.map(([url]) => new URL(url).pathname.replace('/api/v1', ''));

const callTo = (fetchFake: FetchFake, path: string) => {
  const index = fetchFake.mock.calls.findIndex(
    ([url]) => new URL(url).pathname === `/api/v1${path}`,
  );
  if (index < 0) throw new Error(`No call to ${path}`);
  return urlOfCall(fetchFake as never, index);
};

const get = (input: Record<string, unknown>) => runToolContract(getArtworks, input as never);

const records = (ids: number[], overrides: Record<string, unknown> = {}) =>
  ids.map((id) => artworkRecord(id, overrides));

const withSounds = (id: number, count: number, from: number) =>
  artworkRecord(id, { sound_ids: Array.from({ length: count }, (_, i) => soundUuid(from + i)) });

const soundsFor = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => soundRecord(soundUuid(from + i)));

// --- ids ----------------------------------------------------------------------------------------

describe('artic_get_artworks ids', () => {
  it.each([
    ['an array of numbers', [101, 102, 103], '101,102,103'],
    ['a comma string with spaces', '101, 102,103', '101,102,103'],
    ['numeric strings in an array', ['101', 102, ' 103 '], '101,102,103'],
    ['an artic.edu page URL', 'https://www.artic.edu/artworks/27992', '27992'],
    [
      'an artic.edu page URL with a slug',
      'https://www.artic.edu/artworks/27992/a-sunday-on-la-grande-jatte',
      '27992',
    ],
    ['a URL with a query string, without www', 'http://artic.edu/artworks/27992?x=1', '27992'],
    [
      'URLs mixed with ids in a comma string',
      'https://www.artic.edu/artworks/5/slug, 6,https://www.artic.edu/artworks/7',
      '5,6,7',
    ],
    ['duplicates across forms', ['5', 5, 'https://www.artic.edu/artworks/5', 6], '5,6'],
    ['blank elements', '1,, ,2,', '1,2'],
  ])('reads %s', async (_name, ids, expected) => {
    const fetchFake = serve([], undefined);
    const result = await get({ ids });
    expect(result.isError).toBeUndefined();
    expect(queryParam(callTo(fetchFake, '/artworks'), 'ids')).toBe(expected);
  });

  it('keeps ids in the order given', async () => {
    const fetchFake = serve([]);
    await get({ ids: [9, 3, 7] });
    expect(queryParam(callTo(fetchFake, '/artworks'), 'ids')).toBe('9,3,7');
  });

  it.each([
    ['an empty array', []],
    ['an empty string', ''],
    ['only blanks', ' , ,'],
    ['a non-numeric string', 'abc'],
    ['a non-artwork artic.edu URL', 'https://www.artic.edu/exhibitions/5'],
    ['a lookalike host', 'https://www.artic.edu.evil.test/artworks/5'],
    ['zero', [0]],
    ['a negative id', [-4]],
    ['a fractional id', [1.5]],
    ['more than 10 ids', Array.from({ length: 11 }, (_, i) => i + 1)],
  ])('rejects %s without calling upstream', async (_name, ids) => {
    const fetchFake = serve([]);
    const error = errorOf(await get({ ids }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain('"ids"');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('rejects a missing ids field', async () => {
    const fetchFake = serve([]);
    expect(errorOf(await get({})).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('accepts exactly 10 ids', async () => {
    serve([]);
    expect(
      (await get({ ids: Array.from({ length: 10 }, (_, i) => i + 1) })).isError,
    ).toBeUndefined();
  });

  it.each([
    ['an array', Array.from({ length: 60 }, (_, i) => i + 1)],
    ['a comma string', Array.from({ length: 60 }, (_, i) => i + 1).join(',')],
  ])(
    'cuts an over-long id list from %s before validation, leaving one bounded issue',
    async (_name, ids) => {
      serve([]);
      const error = errorOf(await get({ ids }));
      const issues = error.data.issues as { code: string; path: unknown[] }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: 'too_big', path: ['ids'] });
    },
  );
});

// --- sections and the request --------------------------------------------------------------------

describe('artic_get_artworks request', () => {
  it('requests the default sections, description and provenance', async () => {
    const fetchFake = serve([]);
    await get({ ids: [1] });
    expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).toBe(
      `${DETAIL_FIELDS},description,short_description,provenance_text`,
    );
  });

  it('adds section fields in canonical order whatever order they were named in', async () => {
    const fetchFake = serve([]);
    await get({
      ids: [1],
      sections: [
        'catalogue',
        'publication_history',
        'exhibition_history',
        'provenance',
        'description',
      ],
    });
    expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).toBe(
      `${DETAIL_FIELDS},description,short_description,provenance_text,exhibition_history,publication_history,catalogue_display`,
    );
  });

  it('requests no section text for an empty list', async () => {
    const fetchFake = serve([]);
    await get({ ids: [1], sections: [] });
    expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).toBe(DETAIL_FIELDS);
  });

  it.each(['', '   '])(
    'reads blank sections %j as unset, so the defaults apply',
    async (sections) => {
      const fetchFake = serve([]);
      await get({ ids: [1], sections });
      expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).toContain('provenance_text');
      expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).not.toContain(
        'exhibition_history',
      );
    },
  );

  it('reads sections from a comma string and drops duplicates', async () => {
    const fetchFake = serve([]);
    await get({ ids: [1], sections: ' catalogue, publication_history ,catalogue' });
    const fields = queryParam(callTo(fetchFake, '/artworks'), 'fields');
    expect(fields).toBe(`${DETAIL_FIELDS},publication_history,catalogue_display`);
  });

  it.each([
    ['an unknown section', { sections: ['bogus'] }],
    ['an unknown section in a comma string', { sections: 'description,bogus' }],
    ['a non-boolean include_related_media', { include_related_media: 'maybe' }],
  ])('rejects %s without calling upstream', async (_name, extra) => {
    const fetchFake = serve([]);
    expect(errorOf(await get({ ids: [1], ...extra })).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('cuts an over-long section list before validation, leaving a bounded issue count', async () => {
    serve([]);
    const sections = [
      'description',
      'provenance',
      'exhibition_history',
      'publication_history',
      'catalogue',
      ...Array.from({ length: 40 }, (_, i) => `bogus${i}`),
    ];
    const error = errorOf(await get({ ids: [1], sections }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((error.data.issues as unknown[]).length).toBeLessThanOrEqual(2);
  });
});

// --- results ---------------------------------------------------------------------------------------

describe('artic_get_artworks results', () => {
  it('returns the all-missing zero-result page as a result with a pointer to search', async () => {
    const fetchFake = serve([]);
    const out = structuredOf<GetRun>(await get({ ids: [11, 12] }));
    expect(out).toEqual({
      artworks: [],
      missing_ids: [11, 12],
      deferred_ids: [],
      license_text: ARTWORK_LICENSE,
      notice: 'None of these ids exist. Find ids with artic_search_artworks.',
    });
    expect(paths(fetchFake)).toEqual(['/artworks']);
  });

  it('returns the under-cap page with every record and no notice', async () => {
    serve(records([1, 2, 3]));
    const out = structuredOf<GetRun>(await get({ ids: [1, 2, 3], include_related_media: false }));
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1, 2, 3]);
    expect(out).toMatchObject({ missing_ids: [], deferred_ids: [] });
    expect(out).not.toHaveProperty('notice');
  });

  it('reassembles records in request order when upstream answers in another order', async () => {
    serve([artworkRecord(3), artworkRecord(1), artworkRecord(2)]);
    const out = structuredOf<GetRun>(await get({ ids: [1, 2, 3] }));
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1, 2, 3]);
  });

  it('lists missing ids in request order and names them in the notice', async () => {
    serve([artworkRecord(2), artworkRecord(1)]);
    const one = structuredOf<GetRun>(await get({ ids: [1, 9, 2] }));
    expect(one.missing_ids).toEqual([9]);
    expect(one.artworks.map((artwork) => artwork.id)).toEqual([1, 2]);
    expect(one.notice).toBe('No artwork exists for id 9; find ids with artic_search_artworks.');

    serve([artworkRecord(2)]);
    const two = structuredOf<GetRun>(await get({ ids: [9, 2, 8] }));
    expect(two.missing_ids).toEqual([9, 8]);
    expect(two.notice).toContain('id 9, 8');
  });

  it('ignores records the caller did not ask for', async () => {
    serve([artworkRecord(1), artworkRecord(99)]);
    const out = structuredOf<GetRun>(await get({ ids: [1] }));
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1]);
    expect(out.missing_ids).toEqual([]);
  });

  it('normalizes a full record, constructing URLs and dropping empty strings', async () => {
    serve([
      artworkRecord(7, {
        alt_titles: ['Alternate One', '', '<em>Alternate Two</em>'],
        alt_image_ids: [ALT_IMAGE_ID],
        artist_ids: [900, 901],
        date_qualifier_title: '',
        dimensions: '10 x 10 cm',
        style_titles: ['Impressionism', 'Post-Impressionism'],
        technique_titles: ['glazing'],
        theme_titles: ['nature'],
      }),
    ]);
    const [record] = structuredOf<GetRun>(
      await get({ ids: [7], include_related_media: false }),
    ).artworks;
    expect(record).toMatchObject({
      id: 7,
      title: 'Synthetic Work 7',
      alt_titles: ['Alternate One', 'Alternate Two'],
      main_reference_number: '7.1900',
      artist_ids: [900, 901],
      classification: 'oil on canvas',
      style: 'Impressionism',
      styles: ['Impressionism', 'Post-Impressionism'],
      subjects: ['landscape'],
      materials: ['oil paint'],
      techniques: ['glazing'],
      themes: ['nature'],
      credit_line: 'Gift of a synthetic donor',
      manifest_url: 'https://api.artic.edu/api/v1/artworks/7/manifest.json',
      web_url: 'https://www.artic.edu/artworks/7',
      alt_images: [
        {
          url: `${IIIF_URL}/${ALT_IMAGE_ID}/full/843,/0/default.jpg`,
          iiif_info_url: `${IIIF_URL}/${ALT_IMAGE_ID}/info.json`,
        },
      ],
      image: {
        rights: 'public_domain',
        url_large: `${IIIF_URL}/${IMAGE_ID}/full/1686,/0/default.jpg`,
      },
    });
    expect(record).not.toHaveProperty('date_qualifier');
    expect(record).not.toHaveProperty('related_media');
    expect(JSON.stringify(record)).not.toMatch(/lqip|base64/);
  });

  it('gives an in-copyright record the display image only and no manifest', async () => {
    serve([inCopyrightArtworkRecord(8)]);
    const [record] = structuredOf<GetRun>(await get({ ids: [8] })).artworks;
    expect(record).toMatchObject({
      gallery: 'Gallery 240',
      copyright_notice: '(c) Synthetic estate',
      image: { rights: 'in_copyright' },
    });
    expect(record).not.toHaveProperty('manifest_url');
    expect(record?.image).not.toHaveProperty('url_large');
  });

  it('survives a record that carries nothing but an id', async () => {
    serve([sparseArtworkRecord(5)]);
    const result = await get({ ids: [5] });
    const [record] = structuredOf<GetRun>(result).artworks;
    expect(record).toEqual({
      id: 5,
      title: '',
      main_reference_number: '',
      artist_ids: [],
      styles: [],
      subjects: [],
      materials: [],
      techniques: [],
      themes: [],
      is_public_domain: false,
      is_on_view: false,
      web_url: 'https://www.artic.edu/artworks/5',
    });
    const text = textOf(result);
    expect(text).toContain('## (untitled) (id 5)');
    expect(text).toContain('**Reference number:** not recorded');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('omits placeholder years but keeps the display date', async () => {
    serve([placeholderYearArtworkRecord(6)]);
    const [record] = structuredOf<GetRun>(await get({ ids: [6] })).artworks;
    expect(record).toMatchObject({ date_display: 'Dates unknown' });
    expect(record).not.toHaveProperty('date_start');
    expect(record).not.toHaveProperty('date_end');
  });

  it('converts HTML text sections to plain text and attributes description text', async () => {
    serve([
      artworkRecord(1, {
        description: '<p>First &amp; foremost.</p><p>Second<br>line.</p>',
        short_description: '<em>Short</em> take.',
        catalogue_display: '<p>Catalogue &quot;entry&quot;</p>',
        provenance_text: 'Owner A\n\nOwner B',
      }),
    ]);
    const out = structuredOf<GetRun>(
      await get({ ids: [1], sections: ['description', 'provenance', 'catalogue'] }),
    );
    expect(out.artworks[0]).toMatchObject({
      description: 'First & foremost.\n\nSecond\nline.',
      short_description: 'Short take.',
      catalogue: 'Catalogue "entry"',
      provenance: 'Owner A\n\nOwner B',
    });
    expect(out.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
  });

  it('attributes a record that carries only a short description', async () => {
    serve([artworkRecord(1, { short_description: 'Only short.' })]);
    const out = structuredOf<GetRun>(await get({ ids: [1] }));
    expect(out.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
  });

  it('carries no attribution when no record has description text', async () => {
    serve([artworkRecord(1, { provenance_text: 'Owner A' })]);
    const result = await get({ ids: [1], sections: ['provenance'] });
    expect(structuredOf<GetRun>(result)).not.toHaveProperty('description_attribution');
    expect(textOf(result)).not.toContain('Description attribution');
  });
});

describe('artic_get_artworks response budget', () => {
  const big = (id: number, chars: number) =>
    artworkRecord(id, { provenance_text: 'p'.repeat(chars) });

  /** UTF-8 bytes the call puts on the wire: format() text and structuredContent, each as JSON. */
  const wireBytes = (result: Awaited<ReturnType<typeof get>>) =>
    Buffer.byteLength(JSON.stringify(textOf(result))) +
    Buffer.byteLength(JSON.stringify(result.structuredContent));

  it('counts the format() markdown as well as the structured record', async () => {
    serve([big(1, 30_000), big(2, 30_000)]);
    const out = structuredOf<GetRun>(
      await get({ ids: [1, 2], sections: ['provenance'], include_related_media: false }),
    );
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1]);
    expect(out.deferred_ids).toEqual([2]);
  });

  it('keeps a ten-id response with related media under 100,000 bytes on the wire', async () => {
    serve(
      Array.from({ length: 10 }, (_, i) => ({
        ...big(i + 1, 19_000),
        description: `<p>${'d'.repeat(1_000)}</p>`,
        sound_ids: [soundUuid(2 * i + 1), soundUuid(2 * i + 2)],
      })),
      Array.from({ length: 20 }, (_, i) =>
        soundRecord(soundUuid(i + 1), { title: `A long related media title ${'t'.repeat(40)}` }),
      ),
    );
    const result = await get({ ids: Array.from({ length: 10 }, (_, i) => i + 1) });
    const out = structuredOf<GetRun>(result);
    expect(out.deferred_ids.length).toBeGreaterThan(0);
    expect(wireBytes(result)).toBeLessThanOrEqual(100_000);
  });

  it.each(Array.from({ length: 13 }, (_, i) => 600 + 50 * i))(
    'keeps the whole result under 100,000 bytes at the worst case: ten ids, every section, 20 long-titled media items (%i-character sections)',
    async (chars) => {
      const ids = Array.from({ length: 10 }, (_, i) => 100_001 + i);
      const text = (char: string) => char.repeat(chars);
      serve(
        ids.slice(0, 9).map((id, i) =>
          artworkRecord(id, {
            description: `<p>${text('d')}</p>`,
            short_description: text('s'),
            provenance_text: text('p'),
            exhibition_history: text('e'),
            publication_history: text('u'),
            catalogue_display: `<p>${text('c')}</p>`,
            sound_ids: [soundUuid(3 * i + 1), soundUuid(3 * i + 2), soundUuid(3 * i + 3)],
          }),
        ),
        Array.from({ length: 27 }, (_, i) =>
          soundRecord(soundUuid(i + 1), { title: `Audio Lecture: ${'l'.repeat(385)}` }),
        ),
      );
      const result = await get({
        ids,
        sections: [
          'description',
          'provenance',
          'exhibition_history',
          'publication_history',
          'catalogue',
        ],
      });
      const out = structuredOf<GetRun>(result);
      expect(out.missing_ids).toEqual([100_010]);
      expect(out.deferred_ids.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(100_000);
    },
  );

  it('defers records once their wire bytes would pass the budget', async () => {
    serve([big(1, 20_000), big(2, 20_000), big(3, 20_000)]);
    const result = await get({
      ids: [1, 2, 3],
      sections: ['provenance'],
      include_related_media: false,
    });
    const out = structuredOf<GetRun>(result);
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1, 2]);
    expect(out.deferred_ids).toEqual([3]);
    expect(out.notice).toBe(
      'The response budget was reached; call artic_get_artworks again with ids 3 (or fewer sections) for the rest.',
    );
    expect(textOf(result)).toContain('**Deferred ids:** 3');
  });

  it('always keeps the first record, however large, and defers the rest in order', async () => {
    serve([big(1, 250_000), big(2, 10), big(3, 10)]);
    const out = structuredOf<GetRun>(
      await get({ ids: [1, 2, 3], sections: ['provenance'], include_related_media: false }),
    );
    expect(out.artworks.map((artwork) => artwork.id)).toEqual([1]);
    expect(out.deferred_ids).toEqual([2, 3]);
    expect(out.notice).toContain('ids 2, 3');
  });

  it('defers nothing when the records fit', async () => {
    serve([big(1, 20_000), big(2, 20_000)]);
    const out = structuredOf<GetRun>(
      await get({ ids: [1, 2], sections: ['provenance'], include_related_media: false }),
    );
    expect(out.deferred_ids).toEqual([]);
  });

  it('joins the missing-id and deferral notices', async () => {
    serve([big(1, 250_000), big(2, 10)]);
    const out = structuredOf<GetRun>(
      await get({ ids: [1, 9, 2], sections: ['provenance'], include_related_media: false }),
    );
    expect(out.notice).toBe(
      'No artwork exists for id 9; find ids with artic_search_artworks. The response budget was reached; call artic_get_artworks again with ids 2 (or fewer sections) for the rest.',
    );
  });
});

// --- related media -------------------------------------------------------------------------------------

describe('artic_get_artworks related media', () => {
  it('loads the union of sound ids once, in record order, and attaches each record its own', async () => {
    const [u1, u2, u3] = [soundUuid(1), soundUuid(2), soundUuid(3)] as [string, string, string];
    const fetchFake = serve(
      [
        artworkRecord(1, { sound_ids: [u1, u2] }),
        artworkRecord(2, { sound_ids: [u2, u3] }),
        artworkRecord(3),
      ],
      [
        soundRecord(u3),
        soundRecord(u1, { title: '<em>First</em> stop' }),
        soundRecord(u2, { type: undefined }),
      ],
    );
    const out = structuredOf<GetRun>(await get({ ids: [1, 2, 3] }));
    expect(paths(fetchFake)).toEqual(['/artworks', '/sounds']);
    expect(queryParam(callTo(fetchFake, '/sounds'), 'ids')).toBe(`${u1},${u2},${u3}`);
    expect(queryParam(callTo(fetchFake, '/sounds'), 'fields')).toBe('id,title,type,content');
    const [first, second, third] = out.artworks;
    expect(first?.related_media).toEqual([
      { id: u1, title: 'First stop', url: `https://www.artic.edu/assets/${u1}`, type: 'sound' },
      {
        id: u2,
        title: `Synthetic stop ${u2.slice(-4)}`,
        url: `https://www.artic.edu/assets/${u2}`,
      },
    ]);
    expect(fieldOf<{ id: string }[]>(second, 'related_media').map((media) => media.id)).toEqual([
      u2,
      u3,
    ]);
    expect(third).not.toHaveProperty('related_media');
    expect(out).not.toHaveProperty('notice');
  });

  it('makes no second call when no record links media', async () => {
    const fetchFake = serve(records([1, 2]));
    await get({ ids: [1, 2] });
    expect(paths(fetchFake)).toEqual(['/artworks']);
  });

  it('makes no second call and attaches nothing when related media is declined', async () => {
    const fetchFake = serve([withSounds(1, 2, 1)]);
    const out = structuredOf<GetRun>(await get({ ids: [1], include_related_media: false }));
    expect(paths(fetchFake)).toEqual(['/artworks']);
    expect(out.artworks[0]).not.toHaveProperty('related_media');
  });

  it('does not load media for ids that were missing or deferred', async () => {
    const fetchFake = serve([withSounds(1, 1, 1)]);
    await get({ ids: [1, 2] });
    expect(queryParam(callTo(fetchFake, '/sounds'), 'ids')).toBe(soundUuid(1));
  });

  it('caps the load at 20 ids across records and names the record left short', async () => {
    const fetchFake = serve(
      [withSounds(1, 10, 1), withSounds(2, 10, 11), withSounds(3, 4, 21)],
      soundsFor(1, 24),
    );
    const out = structuredOf<GetRun>(await get({ ids: [1, 2, 3] }));
    const requested = (queryParam(callTo(fetchFake, '/sounds'), 'ids') ?? '').split(',');
    expect(requested).toHaveLength(20);
    expect(requested[19]).toBe(soundUuid(20));
    expect(fieldOf<unknown[]>(out.artworks[0], 'related_media').length).toBe(10);
    expect(fieldOf<unknown[]>(out.artworks[1], 'related_media').length).toBe(10);
    expect(out.artworks[2]).not.toHaveProperty('related_media');
    expect(out.notice).toBe(
      'Related media is capped at 20 items per call; artwork 3 is missing some or all of its related media. Call artic_get_artworks with fewer ids to load it.',
    );
  });

  it('keeps the loaded part of a record that straddles the cap', async () => {
    serve([withSounds(1, 12, 1), withSounds(2, 12, 13)], soundsFor(1, 24));
    const out = structuredOf<GetRun>(await get({ ids: [1, 2] }));
    expect(fieldOf<unknown[]>(out.artworks[0], 'related_media').length).toBe(12);
    expect(fieldOf<unknown[]>(out.artworks[1], 'related_media').length).toBe(8);
    expect(out.notice).toContain('artwork 2 is missing some or all');
  });

  it('does not cap exactly 20 ids', async () => {
    serve([withSounds(1, 20, 1)], soundsFor(1, 20));
    const out = structuredOf<GetRun>(await get({ ids: [1] }));
    expect(fieldOf<unknown[]>(out.artworks[0], 'related_media').length).toBe(20);
    expect(out).not.toHaveProperty('notice');
  });

  it.each([
    ['429 rate limit', jsonResponder({}, 429)],
    ['403 edge block', textResponder(EDGE_BLOCK_HTML, 403, { 'content-type': 'text/html' })],
    ['400 text body', textResponder(ES_BAD_REQUEST_TEXT, 400)],
    ['404 API error body', jsonResponder(API_NOT_FOUND_BODY, 404)],
    ['500 server error', textResponder('boom', 500, { 'content-type': 'text/plain' })],
    ['200 with a non-JSON body', textResponder('<html>maintenance</html>', 200)],
    ['200 JSON without the data envelope', jsonResponder({ unexpected: true })],
    ['network failure', networkErrorResponder()],
  ])(
    'degrades on a %s from the sounds call, keeping complete records and saying how to retry',
    async (_name, responder) => {
      serve([withSounds(1, 2, 1), artworkRecord(2)], responder);
      const result = await get({ ids: [1, 2] });
      const out = structuredOf<GetRun>(result);
      expect(out.artworks.map((artwork) => artwork.id)).toEqual([1, 2]);
      for (const artwork of out.artworks) expect(artwork).not.toHaveProperty('related_media');
      expect(out.notice).toBe(DEGRADED_NOTICE);
      expect(JSON.stringify(result)).not.toContain('artic-test-index');
    },
  );

  it('degrades on a sounds call that outlasts the retry deadline', async () => {
    serve([withSounds(1, 1, 1)], hangingResponder, { retry: { baseDelayMs: 0, deadlineMs: 50 } });
    const out = structuredOf<GetRun>(await get({ ids: [1] }));
    expect(out.artworks).toHaveLength(1);
    expect(out.notice).toBe(DEGRADED_NOTICE);
  });

  it('puts the degradation fragment after the other notice fragments', async () => {
    serve([withSounds(1, 1, 1)], jsonResponder({}, 500));
    const out = structuredOf<GetRun>(await get({ ids: [1, 9] }));
    expect(out.notice).toBe(
      `No artwork exists for id 9; find ids with artic_search_artworks. ${DEGRADED_NOTICE}`,
    );
  });

  it('logs the degraded failure at warning level', async () => {
    serve([withSounds(1, 1, 1)], jsonResponder({}, 500));
    const ctx = createMockContext({ errors: getArtworks.errors });
    const output = await getArtworks.handler(getArtworks.input.parse({ ids: '1' }), ctx);
    expect(output.artworks).toHaveLength(1);
    const log = ctx.log as MockContextLogger;
    expect(log.calls.some((call) => call.level === 'warning')).toBe(true);
  });

  it('rethrows a cancellation during the sounds call instead of degrading', async () => {
    const controller = new AbortController();
    const fetchFake = serve([withSounds(1, 1, 1)], hangingResponder);
    const pending = runToolContract(
      getArtworks,
      { ids: [1] },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(paths(fetchFake)).toEqual(['/artworks', '/sounds']));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    const result = await pending;
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

// --- format() ----------------------------------------------------------------------------------------------

describe('artic_get_artworks format', () => {
  it('renders every record id, title, link, categorization, and the id bookkeeping from structuredContent', async () => {
    serve(
      [
        artworkRecord(1, {
          alt_titles: ['Other Title'],
          artist_ids: [900, 901],
          dimensions: '10 x 10 cm',
          edition: '1/10',
          on_loan_display: 'On loan from a synthetic lender',
          style_titles: ['Impressionism', 'Realism'],
          alt_image_ids: [ALT_IMAGE_ID],
          provenance_text: 'Owner A\nOwner B',
          description: '<p>A description.</p>',
        }),
        artworkRecord(2),
      ],
      [],
    );
    const result = await get({ ids: [1, 2, 3] });
    const out = structuredOf<GetRun>(result);
    const text = textOf(result);
    expect(text).toContain('# Artworks (2 records)');
    for (const artwork of out.artworks) {
      expect(text).toContain(`(id ${artwork.id})`);
      expect(text).toContain(String(artwork.title));
      expect(text).toContain(String(artwork.web_url));
      expect(text).toContain(String(artwork.manifest_url));
    }
    expect(text).toContain('- **Reference number:** 1.1900');
    expect(text).toContain('- **Alternate titles:** Other Title');
    expect(text).toContain('- **Artist ids:** 900, 901');
    expect(text).toContain('- **Dimensions:** 10 x 10 cm');
    expect(text).toContain('- **Edition:** 1/10');
    expect(text).toContain('- **On loan:** On loan from a synthetic lender');
    expect(text).toContain('- **Styles:** Impressionism; Realism');
    expect(text).toContain('- **Classification:** oil on canvas');
    expect(text).toContain(`display ${IIIF_URL}/${ALT_IMAGE_ID}/full/843,/0/default.jpg`);
    expect(text).toContain('### Description\n> A description.');
    expect(text).toContain('### Provenance\n> Owner A\n> Owner B');
    expect(text).toContain('**Missing ids:** 3');
    expect(text).toContain('**Deferred ids:** none');
    expect(text).toContain(`**Description attribution:** ${DESCRIPTION_ATTRIBUTION}`);
    expect(text).toContain(`## License\n> ${ARTWORK_LICENSE}`);
  });

  it('says there are no records when every id is missing', async () => {
    serve([]);
    const text = textOf(await get({ ids: [1] }));
    expect(text).toContain('No records.');
    expect(text).toContain('**Missing ids:** 1');
  });

  it('equals the format() of the structured output', async () => {
    serve(records([1, 2]));
    const result = await get({ ids: [1, 2], include_related_media: false });
    const { notice, ...output } = structuredOf<GetRun>(result);
    void notice;
    expect(getArtworks.format?.(output as never)).toEqual([{ type: 'text', text: textOf(result) }]);
  });

  it('lists related media with its type, URL, and id, and encodes brackets in printed URLs', async () => {
    const uuid = soundUuid(1);
    serve(
      [withSounds(1, 1, 1)],
      [soundRecord(uuid, { content: 'https://www.artic.edu/assets/a[1]', title: 'A stop' })],
    );
    const result = await get({ ids: [1] });
    const text = textOf(result);
    expect(text).toContain('### Related media');
    expect(text).toContain(`- A stop (sound) · https://www.artic.edu/assets/a%5B1%5D · id ${uuid}`);
    expect(text).not.toContain('a[1]');
    const [record] = structuredOf<GetRun>(result).artworks;
    expect(fieldOf<{ url: string }[]>(record, 'related_media')[0]?.url).toBe(
      'https://www.artic.edu/assets/a[1]',
    );
  });

  it('keeps a hostile related-media id and asset URL inside their list item', async () => {
    const id = 'uuid\r\n# Injected id';
    serve(
      [artworkRecord(1, { sound_ids: [id] })],
      [soundRecord(id, { content: 'https://www.artic.edu/assets/x\n# Injected url', title: 'A' })],
    );
    const result = await get({ ids: [1] });
    const text = textOf(result);
    expect(text).toContain(
      '- A (sound) · https://www.artic.edu/assets/x%0A#%20Injected%20url · id uuid # Injected id',
    );
    expect(text.split('\n').filter((line) => line.startsWith('# Injected'))).toEqual([]);
    const [record] = structuredOf<GetRun>(result).artworks;
    expect(fieldOf<{ id: string }[]>(record, 'related_media')[0]?.id).toBe(id);
  });

  it('keeps hostile upstream text out of inline slots and quotes free text line by line', async () => {
    const freeText = 'Line one\r\n# Injected heading\r\n\r\nLine three\u0007\u202e';
    serve(
      [
        artworkRecord(1, {
          title: 'Study&#13;&#10;# Injected title &lt;x&gt; [y]',
          alt_titles: [HOSTILE_INLINE],
          main_reference_number: HOSTILE_INLINE,
          artist_display: HOSTILE_INLINE,
          date_qualifier_title: HOSTILE_INLINE,
          dimensions: HOSTILE_INLINE,
          credit_line: HOSTILE_INLINE,
          copyright_notice: HOSTILE_INLINE,
          edition: HOSTILE_INLINE,
          classification_title: HOSTILE_INLINE,
          style_title: HOSTILE_INLINE,
          style_titles: [HOSTILE_INLINE],
          subject_titles: [HOSTILE_INLINE],
          material_titles: [HOSTILE_INLINE],
          technique_titles: [HOSTILE_INLINE],
          theme_titles: [HOSTILE_INLINE],
          on_loan_display: HOSTILE_INLINE,
          inscriptions: freeText,
          provenance_text: freeText,
          exhibition_history: freeText,
          publication_history: freeText,
          description: 'First<br># Injected description<br>Third',
          short_description: 'Short<br># Injected short',
          catalogue_display: 'Cat<br># Injected catalogue',
          sound_ids: [soundUuid(1)],
        }),
      ],
      [soundRecord(soundUuid(1), { title: HOSTILE_INLINE, type: HOSTILE_INLINE })],
    );
    const result = await get({
      ids: [1],
      sections: [
        'description',
        'provenance',
        'exhibition_history',
        'publication_history',
        'catalogue',
      ],
    });
    const text = textOf(result);
    const [record] = structuredOf<GetRun>(result).artworks;

    expect(text).toContain('## Study # Injected title \\<x\\> \\[y\\] (id 1)');
    expect(text).toContain(`- **Artist:** ${HOSTILE_INLINE_RENDERED} · artist_id 900`);
    expect(text).toContain(`- **Reference number:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Alternate titles:** ${HOSTILE_CONVERTED_RENDERED}`);
    expect(text).toContain(`- **Date qualifier:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Dimensions:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Credit line:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Copyright notice:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Edition:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Classification:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(`- **Style:** ${HOSTILE_INLINE_RENDERED}`);
    for (const label of ['Styles', 'Subjects', 'Materials', 'Techniques', 'Themes']) {
      expect(text).toContain(`- **${label}:** ${HOSTILE_INLINE_RENDERED}`);
    }
    expect(text).toContain(`- **On loan:** ${HOSTILE_INLINE_RENDERED}`);
    expect(text).toContain(
      `- ${HOSTILE_CONVERTED_RENDERED} (${HOSTILE_INLINE_RENDERED}) · https://www.artic.edu/assets/${soundUuid(1)}`,
    );

    for (const heading of [
      'Inscriptions',
      'Provenance',
      'Exhibition history',
      'Publication history',
    ]) {
      expect(text).toContain(`### ${heading}\n> Line one\n> # Injected heading\n>\n> Line three`);
    }
    expect(text).toContain('> First\n> # Injected description\n> Third');
    expect(text).toContain('> Short\n> # Injected short');
    expect(text).toContain('> Cat\n> # Injected catalogue');

    expect(hasNoUnsafeCharacters(text)).toBe(true);
    const bareHeadings = text.split('\n').filter((line) => /^#{1,6} (Injected|Fake)/.test(line));
    expect(bareHeadings).toEqual([]);

    expect(record?.title).toBe('Study\n# Injected title <x> [y]');
    expect(record?.artist_display).toBe(HOSTILE_INLINE);
    expect(record?.dimensions).toBe(HOSTILE_INLINE);
    expect(record?.inscriptions).toBe(freeText);
    expect(record?.provenance).toBe(freeText);
  });
});

// --- failures on the primary call ------------------------------------------------------------------------------

describe('artic_get_artworks upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'fails the call on $name from the batch fetch',
    async ({ responder, options, code, reason, forbidden }) => {
      const fetchFake = installAicService(scriptedFetch(responder), options);
      const result = await get({ ids: [1, 2] });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        const hint = recoveryFor(getArtworks, reason);
        expect(error.data.reason).toBe(reason);
        expect(error.data.recovery?.hint).toBe(hint);
        expect(textOf(result)).toContain(`Recovery: ${hint}`);
      }
      for (const leak of forbidden ?? []) {
        expect(JSON.stringify(result)).not.toContain(leak);
      }
      expect(fetchFake.mock.calls.every(([url]) => new URL(url).pathname === ARTWORKS)).toBe(true);
    },
  );

  it('declares exactly the three shared service reasons', () => {
    expect(getArtworks.errors?.map((entry) => [entry.reason, entry.code])).toEqual([
      ['rate_limited', JsonRpcErrorCode.RateLimited],
      ['request_blocked', JsonRpcErrorCode.Forbidden],
      ['upstream_rejected_query', JsonRpcErrorCode.InternalError],
    ]);
  });
});
