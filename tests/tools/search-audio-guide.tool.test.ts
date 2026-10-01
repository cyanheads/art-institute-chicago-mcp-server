/**
 * @fileoverview Tests for the `artic_search_audio_guide` tool driven through a
 * real `AicService` over a fake `fetch`: the required query and its
 * normalization, the request it builds, the page-window guard, pagination and
 * window caps, zero-hit guidance, stop normalization, the license and citation
 * fields, enrichment on the zero-result and under-cap pages, upstream failure
 * classes, and `format()` safety.
 * @module tests/tools/search-audio-guide.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAudioGuide } from '@/mcp-server/tools/definitions/search-audio-guide.tool.js';
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
  hasNoUnsafeCharacters,
  installAicService,
  structuredOf,
  textOf,
  UPSTREAM_FAILURES,
} from '../fixtures/aic-tool-kit.js';
import {
  API_INVALID_LIMIT_BODY,
  MOBILE_SOUND_LICENSE,
  mobileSoundRecord,
  searchEnvelope,
} from '../fixtures/aic-upstream.js';

interface AudioRun {
  cap: number;
  has_more: boolean;
  license_text: string;
  next_page?: number;
  notice?: string;
  page: number;
  shown: number;
  source_citation: string;
  stops: Record<string, unknown>[];
  totalCount: number;
  truncated: boolean;
}

type FetchFake = ReturnType<typeof scriptedFetch>;

const FIELDS = 'id,title,web_url,transcript';

const SOURCE_CITATION =
  'Audio guide content © Art Institute of Chicago and third parties, https://www.artic.edu/terms';

/** `HOSTILE_INLINE_RENDERED` for a title the service passes through the HTML-to-text step, which removes the tag. */
const HOSTILE_CONVERTED_RENDERED =
  'Bad \\[link\\](https://example.test) end # Injected heading tail';

const ZERO_HIT_NOTICE =
  "No audio-guide stops matched. Try the artwork's title or the artist's surname; for a known work, artic_get_artworks lists related_media.";

const WINDOW_RECOVERY =
  "Only the first 1,000 matches are reachable. Add words to the artic_search_audio_guide query, such as the artwork title or the artist's surname.";

afterEach(() => {
  disposeAicService();
  vi.useRealTimers();
});

const rows = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => mobileSoundRecord(from + index));

const envelopeOf = (data: unknown[], total: number = data.length) =>
  searchEnvelope(data, total, { license: MOBILE_SOUND_LICENSE });

/** Installs a service whose every call answers `body`; returns the fetch fake. */
function serve(body: unknown): FetchFake {
  return installAicService(scriptedFetch(jsonResponder(body)));
}

const emptyResults = () => serve(envelopeOf([], 0));

const bodyOf = (fetchFake: FetchFake, call = 0) => searchBodyOf(urlOfCall(fetchFake, call));

const listen = (input: Record<string, unknown> = { query: 'water lilies' }) =>
  runToolContract(searchAudioGuide, input as never);

// --- Query and request ----------------------------------------------------------------------

describe('artic_search_audio_guide request', () => {
  it('sends the text search to the mobile-sounds route with paging and the field allowlist', async () => {
    const fetchFake = emptyResults();
    await listen({ query: 'water lilies' });
    expect(new URL(urlOfCall(fetchFake)).pathname).toBe('/api/v1/mobile-sounds/search');
    expect(bodyOf(fetchFake)).toEqual({
      q: 'water lilies',
      query: {
        bool: {
          must: [{ simple_query_string: { query: 'water lilies', default_operator: 'and' } }],
        },
      },
      page: 1,
      limit: 5,
      fields: FIELDS,
    });
  });

  it('trims the query before building the request', async () => {
    const fetchFake = emptyResults();
    await listen({ query: '   seurat  ' });
    expect(bodyOf(fetchFake)).toMatchObject({ q: 'seurat' });
  });

  it('passes page and limit upstream', async () => {
    const fetchFake = serve(envelopeOf(rows(3, 41), 100));
    await listen({ query: 'a', page: 3, limit: 20 });
    expect(bodyOf(fetchFake)).toMatchObject({ page: 3, limit: 20 });
  });

  it('keeps query operators and punctuation as typed', async () => {
    const fetchFake = emptyResults();
    await listen({ query: '"la grande" -jatte | (sunday)' });
    expect(bodyOf(fetchFake)).toMatchObject({ q: '"la grande" -jatte | (sunday)' });
  });
});

// --- Input validation ------------------------------------------------------------------------------

describe('artic_search_audio_guide input validation', () => {
  it.each([
    ['a missing query', {}, 'query'],
    ['an empty query', { query: '' }, 'query'],
    ['a whitespace-only query', { query: '   \t ' }, 'query'],
    ['an object query', { query: { text: 'a' } }, 'query'],
    ['a query over 200 characters', { query: 'x'.repeat(201) }, 'query'],
    ['page 0', { query: 'a', page: 0 }, 'page'],
    ['page 201', { query: 'a', page: 201 }, 'page'],
    ['a fractional page', { query: 'a', page: 1.5 }, 'page'],
    ['limit 0', { query: 'a', limit: 0 }, 'limit'],
    ['limit 21', { query: 'a', limit: 21 }, 'limit'],
  ])('rejects %s without calling upstream', async (_name, input, field) => {
    const fetchFake = emptyResults();
    const error = errorOf(await listen(input));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(JSON.stringify(error.data.issues)).toContain(`"${field}"`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    ['a query of exactly 200 characters', { query: 'x'.repeat(200) }],
    ['limit 20', { query: 'a', limit: 20 }],
    ['page 50 at limit 20, which ends on match 1,000', { query: 'a', page: 50, limit: 20 }],
    ['page 200 at limit 5, which ends on match 1,000', { query: 'a', page: 200, limit: 5 }],
  ])('accepts %s', async (_name, input) => {
    emptyResults();
    expect((await listen(input)).isError).toBeUndefined();
  });

  it.each([
    ['page', { page: '' }],
    ['limit', { limit: '   ' }],
  ])('reads a blank %s as unset, taking its default', async (_name, extra) => {
    const fetchFake = emptyResults();
    const result = await listen({ query: 'a', ...extra });
    expect(result.isError).toBeUndefined();
    expect(bodyOf(fetchFake)).toMatchObject({ page: 1, limit: 5 });
  });
});

// --- Page-window guard ---------------------------------------------------------------------------------

describe('artic_search_audio_guide window guard', () => {
  it.each([
    ['page 51 at limit 20', { page: 51, limit: 20 }],
    ['page 101 at limit 10', { page: 101, limit: 10 }],
    ['page 200 at limit 6', { page: 200, limit: 6 }],
  ])('fails page_beyond_window for %s before any upstream call', async (_name, paging) => {
    const fetchFake = emptyResults();
    const result = await listen({ query: 'a', ...paging });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('page_beyond_window');
    expect(error.data.recovery?.hint).toBe(WINDOW_RECOVERY);
    expect(textOf(result)).toContain(`Recovery: ${WINDOW_RECOVERY}`);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('serves the last reachable page, where page times limit equals 1,000', async () => {
    const fetchFake = serve(envelopeOf(rows(20, 981), 5000));
    const out = structuredOf<AudioRun>(await listen({ query: 'a', page: 50, limit: 20 }));
    expect(out).toMatchObject({ page: 50, has_more: true, truncated: true, shown: 20 });
    expect(out).not.toHaveProperty('next_page');
    expect(out.notice).toBe(WINDOW_NOTICE);
    expect(bodyOf(fetchFake)).toMatchObject({ page: 50, limit: 20 });
  });

  it.each([
    ['Invalid limit', API_INVALID_LIMIT_BODY],
    [
      'Invalid number of results',
      { ...API_INVALID_LIMIT_BODY, error: 'Invalid number of results' },
    ],
  ])('maps an upstream "%s" refusal to page_beyond_window', async (_name, body) => {
    installAicService(scriptedFetch(jsonResponder(body, 403)));
    const error = errorOf(await listen({ query: 'a' }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('page_beyond_window');
    expect(error.data.recovery?.hint).toBe(WINDOW_RECOVERY);
  });
});

// --- Pagination and enrichment ---------------------------------------------------------------------------

describe('artic_search_audio_guide paging and enrichment', () => {
  it('returns the zero-result page with every required enrichment field', async () => {
    emptyResults();
    const out = structuredOf<AudioRun>(await listen({ query: 'nothing' }));
    expect(out).toEqual({
      stops: [],
      page: 1,
      has_more: false,
      license_text: MOBILE_SOUND_LICENSE,
      source_citation: SOURCE_CITATION,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 5,
      notice: ZERO_HIT_NOTICE,
    });
  });

  it('reports the caller limit as the cap on the zero-result page', async () => {
    emptyResults();
    const out = structuredOf<AudioRun>(await listen({ query: 'nothing', limit: 17 }));
    expect(out).toMatchObject({ cap: 17, shown: 0, totalCount: 0 });
  });

  it('returns the under-cap page with the total, no next page, and no notice', async () => {
    serve(envelopeOf(rows(3), 3));
    const out = structuredOf<AudioRun>(await listen());
    expect(out).toMatchObject({
      page: 1,
      has_more: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 5,
      license_text: MOBILE_SOUND_LICENSE,
      source_citation: SOURCE_CITATION,
    });
    expect(out.stops.map((stop) => stop.id)).toEqual([1, 2, 3]);
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('points at the next page when matches remain inside the window', async () => {
    serve(envelopeOf(rows(5), 12));
    const out = structuredOf<AudioRun>(await listen());
    expect(out).toMatchObject({
      has_more: true,
      next_page: 2,
      totalCount: 12,
      truncated: true,
      shown: 5,
      cap: 5,
      notice: 'More matches: call again with page 2.',
    });
  });

  it('ends on the last partial page', async () => {
    serve(envelopeOf(rows(2, 11), 12));
    const out = structuredOf<AudioRun>(await listen({ query: 'a', page: 3 }));
    expect(out).toMatchObject({ page: 3, has_more: false, truncated: false, shown: 2 });
    expect(out).not.toHaveProperty('next_page');
    expect(out).not.toHaveProperty('notice');
  });

  it('has no more when the page ends exactly on the total', async () => {
    serve(envelopeOf(rows(5, 6), 10));
    const out = structuredOf<AudioRun>(await listen({ query: 'a', page: 2 }));
    expect(out.has_more).toBe(false);
    expect(out).not.toHaveProperty('next_page');
  });

  it('explains a page past the last match', async () => {
    serve(envelopeOf([], 12));
    const out = structuredOf<AudioRun>(await listen({ query: 'a', page: 9 }));
    expect(out).toMatchObject({ has_more: false, truncated: false, shown: 0, totalCount: 12 });
    expect(out.notice).toBe('Page 9 is past the last match (12 total); request a lower page.');
  });

  it('offers page 50 at limit 20 because it still ends inside the window', async () => {
    serve(envelopeOf(rows(20, 961), 5000));
    const out = structuredOf<AudioRun>(await listen({ query: 'a', page: 49, limit: 20 }));
    expect(out).toMatchObject({ has_more: true, next_page: 50 });
  });

  it('skips upstream rows with no integer id and counts only what it returns', async () => {
    serve(envelopeOf([mobileSoundRecord(1), { title: 'no id' }, null, { id: 'x' }], 4));
    const out = structuredOf<AudioRun>(await listen());
    expect(out.stops.map((stop) => stop.id)).toEqual([1]);
    expect(out.shown).toBe(1);
  });

  it('falls back to the row count when the envelope reports no total', async () => {
    serve({ data: [mobileSoundRecord(1)], info: { license_text: 'x' } });
    const out = structuredOf<AudioRun>(await listen());
    expect(out).toMatchObject({ totalCount: 1, shown: 1, has_more: false });
  });

  it('keeps the source citation when the upstream license text is missing', async () => {
    serve({ data: [], pagination: { total: 0 } });
    const out = structuredOf<AudioRun>(await listen());
    expect(out.license_text).toBe('');
    expect(out.source_citation).toBe(SOURCE_CITATION);
  });
});

// --- Records ------------------------------------------------------------------------------------------------

describe('artic_search_audio_guide records', () => {
  it('normalizes a stop, converting HTML to text and keeping the MP3 URL as received', async () => {
    serve(
      envelopeOf(
        [
          mobileSoundRecord(970, {
            title: 'Stop &amp; <em>Go</em>',
            web_url: 'https://www.artic.edu/iiif/audio/970%20fixed.mp3',
            transcript: '<p>First paragraph.</p><p>Second &quot;paragraph&quot;.</p>',
          }),
        ],
        1,
      ),
    );
    const [stop] = structuredOf<AudioRun>(await listen()).stops;
    expect(stop).toMatchObject({
      id: 970,
      title: 'Stop & Go',
      audio_url: 'https://www.artic.edu/iiif/audio/970%20fixed.mp3',
    });
    expect(stop?.transcript).toMatch(/^First paragraph\.\s+Second "paragraph"\.$/);
    expect(JSON.stringify(stop)).not.toMatch(/<p>|<em>|&quot;|&amp;/);
  });

  it.each([
    ['a null', null],
    ['an empty string', ''],
  ])('omits the audio URL when the record carries %s', async (_name, webUrl) => {
    serve(envelopeOf([mobileSoundRecord(1, { web_url: webUrl })], 1));
    const result = await listen();
    const [stop] = structuredOf<AudioRun>(result).stops;
    expect(stop).not.toHaveProperty('audio_url');
    expect(textOf(result)).toContain('- **Audio:** no recording URL');
  });

  it.each([
    ['a null', null],
    ['an empty string', ''],
    ['markup with no text', '<p></p><br>'],
  ])('omits the transcript when the record carries %s', async (_name, transcript) => {
    serve(envelopeOf([mobileSoundRecord(1, { transcript })], 1));
    const result = await listen();
    const [stop] = structuredOf<AudioRun>(result).stops;
    expect(stop).not.toHaveProperty('transcript');
    expect(textOf(result)).not.toContain('### Transcript');
  });

  it('survives a record that carries nothing but an id', async () => {
    serve(envelopeOf([{ id: 5 }], 1));
    const result = await listen();
    const [stop] = structuredOf<AudioRun>(result).stops;
    expect(stop).toEqual({ id: 5, title: '' });
    const text = textOf(result);
    expect(text).toContain('## (untitled) (id 5)');
    expect(text).toContain('- **Audio:** no recording URL');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('keeps a Spanish transcript with its accents', async () => {
    serve(
      envelopeOf(
        [mobileSoundRecord(1, { transcript: '<p>Pintura de una tarde de domingo.</p>' })],
        1,
      ),
    );
    const [stop] = structuredOf<AudioRun>(await listen()).stops;
    expect(stop?.transcript).toBe('Pintura de una tarde de domingo.');
  });

  it('keeps file-name titles as received', async () => {
    serve(envelopeOf([mobileSoundRecord(1, { title: '970_fixed_v2.mp3' })], 1));
    const [stop] = structuredOf<AudioRun>(await listen()).stops;
    expect(stop?.title).toBe('970_fixed_v2.mp3');
  });
});

// --- Upstream failures -------------------------------------------------------------------------------------------

describe('artic_search_audio_guide upstream failures', () => {
  it.each(UPSTREAM_FAILURES)(
    'maps $name',
    async ({ responder, options, code, reason, forbidden }) => {
      installAicService(scriptedFetch(responder), options);
      const result = await listen();
      const error = errorOf(result);
      expect(error.code).toBe(code);
      if (reason) {
        const hint = searchAudioGuide.errors?.find((entry) => entry.reason === reason)?.recovery;
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
      searchAudioGuide,
      { query: 'water' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(fetchFake).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('declares the four contract reasons with their codes', () => {
    expect(searchAudioGuide.errors?.map((entry) => [entry.reason, entry.code])).toEqual([
      ['page_beyond_window', JsonRpcErrorCode.ValidationError],
      ['rate_limited', JsonRpcErrorCode.RateLimited],
      ['request_blocked', JsonRpcErrorCode.Forbidden],
      ['upstream_rejected_query', JsonRpcErrorCode.InternalError],
    ]);
  });
});

// --- format() ----------------------------------------------------------------------------------------------------

describe('artic_search_audio_guide format', () => {
  it('carries the same data as structuredContent', async () => {
    serve(
      envelopeOf(
        [
          mobileSoundRecord(970, { transcript: '<p>A synthetic transcript.</p>' }),
          mobileSoundRecord(971, { web_url: null, transcript: null }),
        ],
        12,
      ),
    );
    const result = await listen({ query: 'a', limit: 2 });
    const out = structuredOf<AudioRun>(result);
    const text = textOf(result);

    expect(text).toContain('# Audio-guide stops (2 on this page)');
    expect(text).toContain(`**Page:** ${out.page}`);
    expect(text).toContain('**More matches:** yes');
    expect(text).toContain(`**Next page:** ${out.next_page}`);
    for (const stop of out.stops) {
      expect(text).toContain(`## ${stop.title} (id ${stop.id})`);
    }
    expect(text).toContain('- **Audio:** https://www.artic.edu/iiif/audio/970%20fixed.mp3');
    expect(text).toContain('- **Audio:** no recording URL');
    expect(text).toContain('### Transcript\n> A synthetic transcript.');
    expect(text).toContain('## License');
    expect(text).toContain(`> ${out.license_text}`);
    expect(text).toContain(`**Source citation:** ${out.source_citation}`);
  });

  it('equals the format() of the structured output', async () => {
    serve(envelopeOf(rows(2), 2));
    const result = await listen();
    const { totalCount, truncated, shown, cap, notice, ...output } = structuredOf<AudioRun>(result);
    void [totalCount, truncated, shown, cap, notice];
    expect(searchAudioGuide.format?.(output as never)).toEqual([
      { type: 'text', text: textOf(result) },
    ]);
  });

  it('says there are no stops on an empty page and still prints the license and citation', async () => {
    emptyResults();
    const text = textOf(await listen());
    expect(text).toContain('No stops on this page.');
    expect(text).toContain(`> ${MOBILE_SOUND_LICENSE}`);
    expect(text).toContain(`**Source citation:** ${SOURCE_CITATION}`);
  });

  it('leaves percent-encoding alone, encodes brackets in printed URLs, and keeps structuredContent untouched', async () => {
    serve(
      envelopeOf([mobileSoundRecord(1, { web_url: 'https://audio.example.test/a%20b[1].mp3' })], 1),
    );
    const result = await listen();
    const text = textOf(result);
    expect(text).toContain('https://audio.example.test/a%20b%5B1%5D.mp3');
    expect(text).not.toContain('b[1]');
    const [stop] = structuredOf<AudioRun>(result).stops;
    expect(stop?.audio_url).toBe('https://audio.example.test/a%20b[1].mp3');
  });

  it('keeps hostile upstream text out of inline markdown slots and structuredContent verbatim', async () => {
    serve(
      searchEnvelope(
        [
          mobileSoundRecord(1, {
            title: 'Stop&#13;&#10;# Injected title &lt;x&gt; [y]',
            transcript: 'Line one<br># Fake heading<br><br>Line three\u0007',
          }),
          mobileSoundRecord(2, { title: HOSTILE_INLINE }),
        ],
        2,
        { license: 'License one\r\n# Fake heading\r\n\r\nLicense three' },
      ),
    );
    const result = await listen();
    const text = textOf(result);
    const stops = structuredOf<AudioRun>(result).stops;

    expect(text).toContain('## Stop # Injected title \\<x\\> \\[y\\] (id 1)');
    expect(text).toContain(`## ${HOSTILE_CONVERTED_RENDERED} (id 2)`);
    expect(hasNoUnsafeCharacters(text)).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Audio-guide stops (2 on this page)',
    ]);
    const transcript = text.slice(text.indexOf('### Transcript')).split('\n').slice(1, 5);
    expect(transcript).toEqual(['> Line one', '> # Fake heading', '>', '> Line three']);
    const licenseStart = text.indexOf('## License');
    const licenseLines = text.slice(licenseStart).split('\n').slice(1, 5);
    expect(licenseLines).toEqual(['> License one', '> # Fake heading', '>', '> License three']);

    expect(stops[0]?.title).toBe('Stop\n# Injected title <x> [y]');
    expect(structuredOf<AudioRun>(result).license_text).toBe(
      'License one\r\n# Fake heading\r\n\r\nLicense three',
    );
  });
});
