/**
 * @fileoverview Tests for the `artic://artworks/{id}` resource driven through a
 * real `AicService` over a fake `fetch`: param validation, the by-id request
 * and its default sections, the record envelope (license, description
 * attribution, notice), unknown ids, related-media degradation and cap, a
 * record over the response budget, upstream failure classes, and the
 * resource's declared metadata.
 * @module tests/resources/artwork.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artworkResource } from '@/mcp-server/resources/definitions/artwork.resource.js';
import { type AicServiceOptions, disposeAicService } from '@/services/aic/aic-service.js';
import { DESCRIPTION_ATTRIBUTION } from '@/services/aic/artwork-records.js';
import {
  hangingResponder,
  jsonResponder,
  queryParam,
  type Responder,
  rejectionOf,
  routedFetch,
  textResponder,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import { installAicService, UPSTREAM_FAILURES } from '../fixtures/aic-tool-kit.js';
import {
  ALT_IMAGE_ID,
  ARTWORK_LICENSE,
  artworkRecord,
  envelope,
  IIIF_URL,
  IMAGE_ID,
  placeholderYearArtworkRecord,
  soundRecord,
  soundUuid,
  sparseArtworkRecord,
} from '../fixtures/aic-upstream.js';

interface ResourceBody {
  artwork: Record<string, unknown>;
  description_attribution?: string;
  license_text: string;
  notice?: string;
}

type FetchFake = ReturnType<typeof routedFetch>;

const ARTWORKS = '/api/v1/artworks';
const SOUNDS = '/api/v1/sounds';

const DETAIL_FIELDS =
  'id,title,alt_titles,main_reference_number,artist_display,artist_id,artist_ids,date_display,date_start,date_end,date_qualifier_title,place_of_origin,medium_display,dimensions,inscriptions,credit_line,copyright_notice,edition,artwork_type_title,department_title,classification_title,style_title,style_titles,subject_titles,material_titles,technique_titles,theme_titles,is_public_domain,is_on_view,gallery_title,on_loan_display,image_id,alt_image_ids,thumbnail,sound_ids';

const RELATED_MEDIA_DEGRADED =
  'Related media could not be loaded; the artwork records are complete. Call artic_get_artworks again to retry related media.';

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

/**
 * Installs a service routing `/artworks` to `artworks` and `/sounds` to
 * `sounds`; a call to an unrouted path fails the fetch.
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

const callTo = (fetchFake: FetchFake, path: string): string => {
  const index = fetchFake.mock.calls.findIndex(
    ([url]) => new URL(url).pathname === `/api/v1${path}`,
  );
  if (index < 0) throw new Error(`No call to ${path}`);
  return urlOfCall(fetchFake as never, index);
};

const context = (signal?: AbortSignal) =>
  createMockContext({ errors: artworkResource.errors, ...(signal ? { signal } : {}) });

/** Parses `{ id }` the way the framework does, then runs the handler. */
async function read(id: string, signal?: AbortSignal): Promise<ResourceBody> {
  const params = artworkResource.params!.parse({ id });
  return (await artworkResource.handler(params, context(signal))) as ResourceBody;
}

const readError = async (id: string, signal?: AbortSignal): Promise<McpError> => {
  const error = await rejectionOf(read(id, signal));
  if (!(error instanceof McpError)) throw error;
  return error;
};

const withSounds = (id: number, count: number, from = 1) =>
  artworkRecord(id, { sound_ids: Array.from({ length: count }, (_, i) => soundUuid(from + i)) });

const soundsFor = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => soundRecord(soundUuid(from + i)));

// --- Params ------------------------------------------------------------------------------------

describe('artic://artworks/{id} params', () => {
  it.each(['1', '27992', '007', '0', '9'.repeat(16)])('accepts the digit string %j', (id) => {
    expect(artworkResource.params!.parse({ id })).toEqual({ id });
  });

  it('rejects an id past 16 digits without echoing it back', () => {
    const id = '7'.repeat(200_000);
    const result = artworkResource.params!.safeParse({ id });
    expect(result.success).toBe(false);
    expect(result.error?.message).not.toContain('7'.repeat(17));
    expect(JSON.stringify(result.error?.issues)).not.toContain('7'.repeat(17));
  });

  it.each([
    ['an empty string', ''],
    ['letters', 'abc'],
    ['digits with a suffix', '12a'],
    ['a negative number', '-5'],
    ['a decimal', '1.5'],
    ['leading whitespace', ' 12'],
    ['trailing whitespace', '12 '],
    ['a trailing newline', '12\n'],
    ['an embedded slash', '12/34'],
    ['a comma list', '1,2'],
    ['fullwidth digits', '１２'],
    ['a URL', 'https://www.artic.edu/artworks/12'],
    ['17 digits', '1'.repeat(17)],
  ])('rejects %s', (_name, id) => {
    expect(artworkResource.params!.safeParse({ id }).success).toBe(false);
  });

  it('rejects a missing id and a numeric id', () => {
    expect(artworkResource.params!.safeParse({}).success).toBe(false);
    expect(artworkResource.params!.safeParse({ id: 12 }).success).toBe(false);
  });

  it('never reaches upstream for a malformed id', () => {
    const fetchFake = serve([]);
    expect(() => artworkResource.params!.parse({ id: 'abc' })).toThrow();
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

// --- Valid read --------------------------------------------------------------------------------------

describe('artic://artworks/{id} read', () => {
  it('requests the one id with the default sections', async () => {
    const fetchFake = serve([artworkRecord(7)]);
    await read('7');
    expect(queryParam(callTo(fetchFake, '/artworks'), 'ids')).toBe('7');
    expect(queryParam(callTo(fetchFake, '/artworks'), 'fields')).toBe(
      `${DETAIL_FIELDS},description,short_description,provenance_text`,
    );
  });

  it('reads a zero-padded id as its number', async () => {
    const fetchFake = serve([artworkRecord(7)]);
    const body = await read('007');
    expect(queryParam(callTo(fetchFake, '/artworks'), 'ids')).toBe('7');
    expect(body.artwork.id).toBe(7);
  });

  it('returns the record with the license text and no notice or attribution when nothing applies', async () => {
    serve([artworkRecord(7)]);
    const body = await read('7');
    expect(body).toMatchObject({
      artwork: {
        id: 7,
        title: 'Synthetic Work 7',
        web_url: 'https://www.artic.edu/artworks/7',
        manifest_url: 'https://api.artic.edu/api/v1/artworks/7/manifest.json',
        image: {
          url: `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
          url_large: `${IIIF_URL}/${IMAGE_ID}/full/1686,/0/default.jpg`,
        },
      },
      license_text: ARTWORK_LICENSE,
    });
    expect(body).not.toHaveProperty('notice');
    expect(body).not.toHaveProperty('description_attribution');
    expect(Object.keys(body).sort()).toEqual(['artwork', 'license_text']);
  });

  it('adds the CC BY attribution when the record carries description text', async () => {
    serve([
      artworkRecord(7, { description: '<p>A synthetic description.</p>', provenance_text: 'p' }),
    ]);
    const body = await read('7');
    expect(body.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
    expect(body.artwork.description).toBe('A synthetic description.');
    expect(body.artwork.provenance).toBe('p');
  });

  it('adds the attribution for a short description alone', async () => {
    serve([artworkRecord(7, { short_description: '<p>Short.</p>' })]);
    expect((await read('7')).description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
  });

  it('leaves the attribution off when only provenance text is present', async () => {
    serve([artworkRecord(7, { provenance_text: 'Passed down.' })]);
    expect(await read('7')).not.toHaveProperty('description_attribution');
  });

  it('gives an in-copyright record the display image only and no manifest', async () => {
    serve([
      artworkRecord(8, { is_public_domain: false, copyright_notice: '(c) Synthetic estate' }),
    ]);
    const { artwork } = await read('8');
    expect(artwork).toMatchObject({
      copyright_notice: '(c) Synthetic estate',
      image: { rights: 'in_copyright' },
    });
    expect(artwork).not.toHaveProperty('manifest_url');
    expect(artwork.image).not.toHaveProperty('url_large');
  });

  it('keeps alternate images and constructs their URLs', async () => {
    serve([artworkRecord(9, { alt_image_ids: [ALT_IMAGE_ID] })]);
    expect((await read('9')).artwork.alt_images).toEqual([
      {
        url: `${IIIF_URL}/${ALT_IMAGE_ID}/full/843,/0/default.jpg`,
        iiif_info_url: `${IIIF_URL}/${ALT_IMAGE_ID}/info.json`,
      },
    ]);
  });

  it('survives a record that carries nothing but an id', async () => {
    serve([sparseArtworkRecord(5)]);
    const body = await read('5');
    expect(body.artwork).toEqual({
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
    expect(body.license_text).toBe(ARTWORK_LICENSE);
  });

  it('drops placeholder years and keeps the display date', async () => {
    serve([placeholderYearArtworkRecord(6)]);
    const { artwork } = await read('6');
    expect(artwork).not.toHaveProperty('date_start');
    expect(artwork).not.toHaveProperty('date_end');
    expect(artwork.date_display).toBe('Dates unknown');
  });

  it('ignores records the caller did not ask for', async () => {
    serve([artworkRecord(99), artworkRecord(7)]);
    expect((await read('7')).artwork.id).toBe(7);
  });

  it('returns a JSON-safe body whose text fields are verbatim, with no markdown escaping', async () => {
    serve([
      artworkRecord(7, {
        title: 'Line one&#13;&#10;# Not a heading [x] &lt;y&gt;',
        artist_display: 'Artist\r\nFrench',
      }),
    ]);
    const body = await read('7');
    expect(body.artwork.title).toBe('Line one\n# Not a heading [x] <y>');
    expect(body.artwork.artist_display).toBe('Artist\r\nFrench');
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });
});

// --- Unknown ids ---------------------------------------------------------------------------------------

describe('artic://artworks/{id} unknown id', () => {
  it('fails artwork_not_found with the NotFound code when upstream omits the id', async () => {
    const fetchFake = serve([]);
    const error = await readError('404404');
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('artwork_not_found');
    expect(error.message).toContain('404404');
    expect(paths(fetchFake)).toEqual(['/artworks']);
  });

  it('fails artwork_not_found when upstream returns only other records', async () => {
    serve([artworkRecord(1), artworkRecord(2)]);
    expect((await readError('3')).data?.reason).toBe('artwork_not_found');
  });

  it('fails artwork_not_found for id 0', async () => {
    const fetchFake = serve([]);
    expect((await readError('0')).data?.reason).toBe('artwork_not_found');
    expect(queryParam(callTo(fetchFake, '/artworks'), 'ids')).toBe('0');
  });

  it('fails artwork_not_found for a 16-digit id past 2^53 without calling upstream', async () => {
    const fetchFake = serve([]);
    const error = await readError('9999999999999999');
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('artwork_not_found');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('makes no related-media call for a miss', async () => {
    const fetchFake = serve([], []);
    await readError('7');
    expect(paths(fetchFake)).toEqual(['/artworks']);
  });

  it('ignores a record whose id is missing or not an integer', async () => {
    serve([{ title: 'no id' }, { id: 'x' }, null]);
    expect((await readError('7')).data?.reason).toBe('artwork_not_found');
  });
});

// --- Related media -------------------------------------------------------------------------------------------

describe('artic://artworks/{id} related media', () => {
  it('loads related media in one extra call and attaches it', async () => {
    const [u1, u2] = [soundUuid(1), soundUuid(2)] as [string, string];
    const fetchFake = serve([artworkRecord(7, { sound_ids: [u1, u2] })], soundsFor(2));
    const body = await read('7');
    expect(paths(fetchFake)).toEqual(['/artworks', '/sounds']);
    expect(queryParam(callTo(fetchFake, '/sounds'), 'ids')).toBe(`${u1},${u2}`);
    expect((body.artwork.related_media as { id: string }[]).map((media) => media.id)).toEqual([
      u1,
      u2,
    ]);
    expect(body).not.toHaveProperty('notice');
  });

  it('makes no second call when the record links no media', async () => {
    const fetchFake = serve([artworkRecord(7)]);
    const body = await read('7');
    expect(paths(fetchFake)).toEqual(['/artworks']);
    expect(body.artwork).not.toHaveProperty('related_media');
  });

  it('omits related_media when every linked sound is gone upstream', async () => {
    serve([withSounds(7, 2)], []);
    const body = await read('7');
    expect(body.artwork).not.toHaveProperty('related_media');
    expect(body).not.toHaveProperty('notice');
  });

  it.each([
    ['a 429 rate limit', jsonResponder({}, 429, { 'retry-after': '0' })],
    ['a 500 server error', textResponder('boom', 500)],
    ['an unreadable 200 body', textResponder('<html>maintenance</html>', 200)],
    ['a 400 from the search backend', textResponder('400 Bad Request: {"error":"x"}', 400)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])(
    'returns the record without media and a retry notice when /sounds fails with %s',
    async (_name, sounds) => {
      serve([withSounds(7, 2)], sounds as Responder);
      const body = await read('7');
      expect(body.artwork.id).toBe(7);
      expect(body.artwork).not.toHaveProperty('related_media');
      expect(body.notice).toBe(RELATED_MEDIA_DEGRADED);
      expect(body.license_text).toBe(ARTWORK_LICENSE);
    },
  );

  it('caps related media at 20 sounds and says so', async () => {
    serve([withSounds(7, 25)], soundsFor(20));
    const body = await read('7');
    expect(body.artwork.related_media as unknown[]).toHaveLength(20);
    expect(body.notice).toBe(
      'Related media is capped at 20 items per call; artwork 7 is missing some or all of its related media. Call artic_get_artworks with fewer ids to load it.',
    );
  });

  it('asks for exactly 20 sound ids when the record links more', async () => {
    const fetchFake = serve([withSounds(7, 25)], soundsFor(20));
    await read('7');
    expect(queryParam(callTo(fetchFake, '/sounds'), 'ids')?.split(',')).toHaveLength(20);
  });

  it('does not cap a record with exactly 20 sounds', async () => {
    serve([withSounds(7, 20)], soundsFor(20));
    const body = await read('7');
    expect(body.artwork.related_media as unknown[]).toHaveLength(20);
    expect(body).not.toHaveProperty('notice');
  });

  it('rethrows cancellation during the related-media call rather than degrading', async () => {
    const controller = new AbortController();
    const fetchFake = serve([withSounds(7, 1)], hangingResponder);
    const pending = rejectionOf(read('7', controller.signal));
    await vi.waitFor(() => expect(paths(fetchFake)).toContain('/sounds'));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });
});

// --- Response budget -------------------------------------------------------------------------------------------

describe('artic://artworks/{id} response budget', () => {
  it('returns a single record over the budget whole, with nothing deferred and no notice', async () => {
    const provenance = 'p'.repeat(250_000);
    serve([artworkRecord(7, { provenance_text: provenance })]);
    const body = await read('7');
    expect(body.artwork.provenance).toBe(provenance);
    expect(body).not.toHaveProperty('notice');
    expect(JSON.stringify(body).length).toBeGreaterThan(250_000);
  });

  it('returns an over-budget record with its related media and the attribution intact', async () => {
    serve(
      [
        artworkRecord(7, {
          provenance_text: 'p'.repeat(250_000),
          description: '<p>Described.</p>',
          sound_ids: [soundUuid(1)],
        }),
      ],
      soundsFor(1),
    );
    const body = await read('7');
    expect(body.artwork.related_media as unknown[]).toHaveLength(1);
    expect(body.description_attribution).toBe(DESCRIPTION_ATTRIBUTION);
    expect(body).not.toHaveProperty('notice');
  });
});

// --- Upstream failures -------------------------------------------------------------------------------------------

describe('artic://artworks/{id} upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name on the artwork fetch',
    async ({ responder, options, code, reason, forbidden }) => {
      serve(responder, undefined, options);
      const error = await readError('7');
      expect(error.code).toBe(code);
      if (reason) expect(error.data?.reason).toBe(reason);
      for (const leak of forbidden ?? []) {
        expect(`${error.message} ${JSON.stringify(error.data ?? {})}`).not.toContain(leak);
      }
    },
  );

  it('rethrows cancellation rather than reporting a service failure', async () => {
    const controller = new AbortController();
    const fetchFake = serve(hangingResponder);
    const pending = rejectionOf(read('7', controller.signal));
    await vi.waitFor(() => expect(fetchFake).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    const error = await pending;
    expect(error).not.toBeInstanceOf(McpError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

// --- Definition ----------------------------------------------------------------------------------------------------

describe('artic://artworks/{id} definition', () => {
  it('is named, typed, and cacheable as designed', () => {
    expect(artworkResource.name).toBe('artic-artwork');
    expect(artworkResource.mimeType).toBe('application/json');
    expect(artworkResource.cacheHint).toEqual({ ttlMs: 21_600_000, cacheScope: 'public' });
  });

  it('declares no list(), the collection being unbounded', () => {
    expect(artworkResource.list).toBeUndefined();
  });

  it('declares the four contract reasons with their codes and recoveries', () => {
    expect(
      artworkResource.errors?.map((entry) => [entry.reason, entry.code, entry.recovery]),
    ).toEqual([
      [
        'artwork_not_found',
        JsonRpcErrorCode.NotFound,
        'Find artwork ids with artic_search_artworks, then read artic://artworks/<id> again.',
      ],
      [
        'rate_limited',
        JsonRpcErrorCode.RateLimited,
        'Wait about a minute and retry; the Art Institute API allows about 60 requests per minute from this server, so batch ids into one artic_get_artworks call.',
      ],
      [
        'request_blocked',
        JsonRpcErrorCode.Forbidden,
        'Wait about a minute, then read artic://artworks/<id> again.',
      ],
      [
        'upstream_rejected_query',
        JsonRpcErrorCode.InternalError,
        'Fetch the record with artic_get_artworks instead; the server built a request the API rejected.',
      ],
    ]);
  });
});
