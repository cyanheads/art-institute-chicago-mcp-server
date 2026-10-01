/**
 * @fileoverview Tests for `AicService` through its constructor seams: status
 * classification, retry and deadline, pacer shed mapping, the byte ceiling,
 * cache TTLs per kind, request construction, `ids=` reordering, and
 * normalization of sparse, placeholder, and markup-bearing upstream records.
 * @module tests/services/aic-service.test
 */

import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { createPacer, logger, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_ORIGIN,
  artworkParams,
  createTestService,
  envelopeOfBytes,
  hangingResponder,
  jsonResponder,
  networkErrorResponder,
  queryParam,
  rejection,
  rejectionOf,
  routedFetch,
  scriptedFetch,
  searchBodyOf,
  streamingBody,
  TEST_CONTACT,
  TEST_VERSION,
  textResponder,
  urlOfCall,
} from '../fixtures/aic-service-kit.js';
import {
  AGENT_LICENSE,
  ALT_IMAGE_ID,
  API_INVALID_LIMIT_BODY,
  API_INVALID_RESULTS_BODY,
  API_INVALID_SYNTAX_BODY,
  API_NOT_FOUND_BODY,
  API_OTHER_403_BODY,
  ARTWORK_LICENSE,
  agentRecord,
  aggregationEnvelope,
  artworkRecord,
  EDGE_BLOCK_HTML,
  ES_BAD_REQUEST_TEXT,
  envelope,
  exhibitionRecord,
  IIIF_URL,
  IMAGE_ID,
  inCopyrightArtworkRecord,
  MOBILE_SOUND_LICENSE,
  mobileSoundRecord,
  placeholderYearArtworkRecord,
  searchEnvelope,
  soundRecord,
  soundUuid,
  sparseArtworkRecord,
} from '../fixtures/aic-upstream.js';

const MIB = 1024 * 1024;
const MINUTE = 60_000;

const emptySearch = () => jsonResponder(searchEnvelope([]));
const makeCtx = () => createMockContext();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Status classification -------------------------------------------------------

describe('AicService status classification', () => {
  const search = (service: ReturnType<typeof createTestService>['service']) =>
    service.searchArtworks(artworkParams({ query: 'water' }), makeCtx());

  describe('failures that are not retried', () => {
    it.each([
      ['403 "Invalid limit"', API_INVALID_LIMIT_BODY],
      ['403 "Invalid number of results"', API_INVALID_RESULTS_BODY],
    ])('maps %s to page_beyond_window', async (_name, body) => {
      const { service, fetch } = createTestService(scriptedFetch(jsonResponder(body, 403)));
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'page_beyond_window', retryable: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('maps any other API 403 body to upstream_rejected_query', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder(API_OTHER_403_BODY, 403)),
      );
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data).toMatchObject({
        reason: 'upstream_rejected_query',
        retryable: false,
        status: 403,
      });
      expect(error.message).toContain('Forbidden');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('quotes the API 403 error string on one line, escaped, and cut to 100 characters', async () => {
      const apiError = `Refused [x](https://x.test)\r\n# Injected <b>​${'y'.repeat(500)}`;
      const { service } = createTestService(
        scriptedFetch(jsonResponder({ ...API_OTHER_403_BODY, error: apiError }, 403)),
      );
      const error = await rejection(search(service));
      expect(error.data).toMatchObject({ reason: 'upstream_rejected_query' });
      expect(error.message).toBe(
        `The Art Institute API rejected the request this server built (HTTP 403, "Refused \\[x\\](https://x.test) # Injected \\<b\\>${'y'.repeat(56)}…").`,
      );
    });

    it('maps a 400 with a plain-text body served as JSON to upstream_rejected_query', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(textResponder(ES_BAD_REQUEST_TEXT, 400)),
      );
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data).toMatchObject({
        reason: 'upstream_rejected_query',
        retryable: false,
        status: 400,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the 400 body, which names index internals, off the wire and in the process log only', async () => {
      const processLog = vi.spyOn(logger, 'debug');
      const { service } = createTestService(scriptedFetch(textResponder(ES_BAD_REQUEST_TEXT, 400)));
      const ctx = makeCtx();
      const error = await rejection(service.searchArtworks(artworkParams({ query: 'x' }), ctx));
      const wire = JSON.stringify({ message: error.message, data: error.data });
      expect(wire).not.toContain('root_cause');
      expect(wire).not.toContain('artic-test-index');
      expect(wire).not.toContain('search_phase_execution_exception');
      // ctx.log reaches the client as notifications/message, so the body never goes there.
      const clientLog = (ctx.log as MockContextLogger).calls.map((call) => JSON.stringify(call));
      expect(clientLog.some((entry) => entry.includes('artic-test-index'))).toBe(false);
      expect(processLog).toHaveBeenCalledWith(
        'Art Institute API rejected a request',
        expect.objectContaining({
          requestId: ctx.requestId,
          extra: expect.objectContaining({
            status: 400,
            body: expect.stringContaining('artic-test-index'),
          }),
        }),
      );
    });

    it('maps a 400 with the API JSON error body to upstream_rejected_query', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder(API_INVALID_SYNTAX_BODY, 400)),
      );
      const error = await rejection(service.getArtworks([1], [], makeCtx()));
      expect(error.data).toMatchObject({ reason: 'upstream_rejected_query', retryable: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([404, 401, 405, 410, 418, 422])(
      'maps HTTP %s to upstream_rejected_query',
      async (status) => {
        const { service, fetch } = createTestService(
          scriptedFetch(jsonResponder(API_NOT_FOUND_BODY, status)),
        );
        const error = await rejection(search(service));
        expect(error.code).toBe(JsonRpcErrorCode.InternalError);
        expect(error.data).toMatchObject({
          reason: 'upstream_rejected_query',
          retryable: false,
          status,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('redirects', () => {
    const redirectTo = (status: number) => () =>
      new Response(null, {
        status,
        headers: { location: 'https://elsewhere.test/private?token=abc' },
      });

    it.each([301, 302, 303, 307, 308])(
      'fails an HTTP %s at once as ServiceUnavailable, naming the status but not the target',
      async (status) => {
        const { service, fetch } = createTestService(scriptedFetch(redirectTo(status)));
        const error = await rejection(search(service));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ retryable: false, status });
        expect(error.message).toContain(`HTTP ${status}`);
        expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
          'elsewhere.test',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );

    it('leaves the shared cooldown open, so other calls are not held back', async () => {
      const pacer = createPacer({
        name: 'aic-test-cooldown-redirect',
        cooldown: { baseMs: MINUTE, maxMs: MINUTE },
      });
      const { service } = createTestService(scriptedFetch(redirectTo(302)), { pacer });
      await rejection(search(service));
      expect(pacer.cooldown.remainingMs).toBe(0);
      pacer.dispose();
    });
  });

  describe('edge firewall blocks', () => {
    it('maps a 403 without the API JSON body to request_blocked, without retrying', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(textResponder(EDGE_BLOCK_HTML, 403, { 'content-type': 'text/html' })),
      );
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(error.data).toMatchObject({
        reason: 'request_blocked',
        retryable: false,
        status: 403,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an empty body', ''],
      ['JSON of another shape', '{"message":"slow down"}'],
      ['a status that is not a number', '{"status":"403","error":"Forbidden"}'],
      ['an error that is not a string', '{"status":403,"error":{"code":1}}'],
      ['a JSON array', '[]'],
    ])('treats a 403 with %s as an edge block', async (_name, text) => {
      const { service } = createTestService(scriptedFetch(textResponder(text, 403)));
      const error = await rejection(search(service));
      expect(error.data).toMatchObject({ reason: 'request_blocked', retryable: false });
    });

    it('leaves the shared cooldown open, so other calls are not held back', async () => {
      const pacer = createPacer({
        name: 'aic-test-cooldown',
        cooldown: { baseMs: MINUTE, maxMs: MINUTE },
      });
      const { service, fetch } = createTestService(
        scriptedFetch(
          textResponder(EDGE_BLOCK_HTML, 403, { 'content-type': 'text/html' }),
          jsonResponder(searchEnvelope([artworkRecord(1)])),
        ),
        { pacer },
      );
      const ctx = makeCtx();
      const blocked = await rejection(
        service.searchArtworks(artworkParams({ query: '<script>alert(1)</script>' }), ctx),
      );
      expect(blocked.data).toMatchObject({ reason: 'request_blocked' });
      expect(pacer.cooldown.remainingMs).toBe(0);
      const next = await service.searchArtworks(artworkParams({ query: 'water' }), ctx);
      expect(next.artworks).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      pacer.dispose();
    });

    it('closes the shared cooldown on a 429, unlike an edge block', async () => {
      const pacer = createPacer({
        name: 'aic-test-cooldown-429',
        cooldown: { baseMs: MINUTE, maxMs: MINUTE },
      });
      const { service } = createTestService(scriptedFetch(jsonResponder({}, 429)), {
        pacer,
        retry: { baseDelayMs: 0, maxRetries: 0 },
      });
      await rejection(search(service));
      expect(pacer.cooldown.remainingMs).toBeGreaterThan(0);
      pacer.dispose();
    });
  });

  describe('throttling', () => {
    it('maps 429 to rate_limited and retries up to the attempt budget', async () => {
      const { service, fetch } = createTestService(scriptedFetch(jsonResponder({}, 429)));
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'rate_limited', status: 429 });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('carries retryAfter from a numeric Retry-After header', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder({}, 429, { 'retry-after': '0' })),
      );
      const error = await rejection(search(service));
      expect(error.data?.retryAfter).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('fails fast on a Retry-After longer than the retry budget, keeping retryAfter', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder({}, 429, { 'retry-after': '30' })),
      );
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('carries an HTTP-date Retry-After as the string it arrived as', async () => {
      const date = 'Wed, 21 Oct 2099 07:28:00 GMT';
      const { service } = createTestService(
        scriptedFetch(jsonResponder({}, 429, { 'retry-after': date })),
      );
      const error = await rejection(search(service));
      expect(error.data?.retryAfter).toBe(date);
    });

    it('omits retryAfter when there is no Retry-After header or it is blank', async () => {
      const bare = createTestService(scriptedFetch(jsonResponder({}, 429)));
      expect(await rejection(search(bare.service))).toHaveProperty('data.reason', 'rate_limited');
      const blank = createTestService(
        scriptedFetch(jsonResponder({}, 429, { 'retry-after': '  ' })),
      );
      const error = await rejection(search(blank.service));
      expect(error.data).not.toHaveProperty('retryAfter');
    });

    it('recovers when the throttle clears within the retry budget', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder({}, 429), jsonResponder(searchEnvelope([artworkRecord(1)]))),
      );
      const result = await search(service);
      expect(result.artworks).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('transient failures', () => {
    it.each([500, 502, 503, 504])(
      'maps HTTP %s to ServiceUnavailable after three attempts',
      async (status) => {
        const { service, fetch } = createTestService(scriptedFetch(jsonResponder({}, status)));
        const error = await rejection(search(service));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ status });
        expect(fetch).toHaveBeenCalledTimes(3);
      },
    );

    it('recovers from a 5xx on a later attempt', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder({}, 503), jsonResponder({}, 500), emptySearch()),
      );
      await expect(search(service)).resolves.toMatchObject({ artworks: [], total: 0 });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('maps a network failure to ServiceUnavailable, keeping the cause', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(networkErrorResponder('connect ECONNRESET')),
      );
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('connect ECONNRESET');
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('honors retry.maxRetries', async () => {
      const none = createTestService(scriptedFetch(jsonResponder({}, 500)), {
        retry: { baseDelayMs: 0, maxRetries: 0 },
      });
      await rejection(search(none.service));
      expect(none.fetch).toHaveBeenCalledTimes(1);
      const five = createTestService(scriptedFetch(jsonResponder({}, 500)), {
        retry: { baseDelayMs: 0, maxRetries: 4 },
      });
      await rejection(search(five.service));
      expect(five.fetch).toHaveBeenCalledTimes(5);
    });
  });

  describe('unreadable 2xx bodies', () => {
    it.each([
      ['a non-JSON body', textResponder('<html>maintenance</html>', 200)],
      ['an empty body', textResponder('', 200)],
      ['a 204 with no content', () => new Response(null, { status: 204 })],
      ['a JSON array', jsonResponder([])],
      ['an object with no data array', jsonResponder({ info: {} })],
      ['data that is not an array', jsonResponder({ data: 'nope' })],
      ['null data', jsonResponder({ data: null })],
      ['a JSON null', textResponder('null', 200)],
      ['a truncated JSON body', textResponder('{"data":[{"id":1', 200)],
    ])('maps %s to ServiceUnavailable (unreadable response)', async (_name, responder) => {
      const { service, fetch } = createTestService(scriptedFetch(responder));
      const error = await rejection(search(service));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('unreadable response');
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('classifies by body, not content-type: valid JSON served as text/plain succeeds', async () => {
      const { service } = createTestService(
        scriptedFetch(
          textResponder(JSON.stringify(searchEnvelope([artworkRecord(1)])), 200, {
            'content-type': 'text/plain',
          }),
        ),
      );
      await expect(search(service)).resolves.toMatchObject({ total: 1 });
    });

    it('accepts an envelope with an empty data array', async () => {
      const { service } = createTestService(scriptedFetch(jsonResponder({ data: [] })));
      await expect(search(service)).resolves.toMatchObject({
        artworks: [],
        total: 0,
        license_text: '',
      });
    });
  });
});

// --- Request construction ----------------------------------------------------------

describe('AicService request boundary', () => {
  it('sends GET requests to the API host with the courtesy and Accept headers', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(searchEnvelope([]))));
    await service.searchArtworks(artworkParams(), makeCtx());
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toMatch(new RegExp(`^${API_ORIGIN}/api/v1/artworks/search\\?params=`));
    const headers = init?.headers as Record<string, string>;
    expect(headers['AIC-User-Agent']).toBe(
      `art-institute-chicago-mcp-server/${TEST_VERSION} (${TEST_CONTACT})`,
    );
    expect(headers.Accept).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBeUndefined();
  });

  it('asks fetch to hand back a redirect rather than follow it', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(searchEnvelope([]))));
    await service.searchArtworks(artworkParams(), makeCtx());
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('builds search params only from the fixed top-level key allowlist', async () => {
    const allowed = new Set(['q', 'query', 'sort', 'page', 'limit', 'fields', 'aggs']);
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(searchEnvelope([]))));
    const ctx = makeCtx();
    await service.searchArtworks(
      artworkParams({
        query: 'q',
        artist: 'a',
        department: 'd',
        year_from: 1,
        year_to: 2,
        public_domain_only: true,
        facets: ['department', 'artist'],
        sort: 'date_asc',
      }),
      ctx,
    );
    await service.searchAgents(
      { query: 'a', artists_only: true, born_from: 1, limit: 10, page: 1 },
      ctx,
    );
    await service.searchExhibitions(
      { query: 'a', sort: 'relevance', when: 'current', limit: 10, page: 1 },
      ctx,
    );
    await service.searchMobileSounds({ query: 'a', limit: 5, page: 1 }, ctx);
    await service.aggregate(
      'department_title.keyword',
      { include: '.*', public_domain_only: true, size: 5 },
      ctx,
    );
    await service.artistWorkStats([1, 2], ctx);
    expect(fetch).toHaveBeenCalledTimes(6);
    for (let call = 0; call < 6; call++) {
      for (const key of Object.keys(searchBodyOf(urlOfCall(fetch, call)))) {
        expect(allowed.has(key), `unexpected key ${key} in call ${call}`).toBe(true);
      }
    }
  });

  it('percent-encodes the params JSON so the query text cannot break out of the URL', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(searchEnvelope([]))));
    const query = 'a&b=c#d "quoted" é ?x';
    await service.searchArtworks(artworkParams({ query }), makeCtx());
    const url = new URL(urlOfCall(fetch));
    expect([...url.searchParams.keys()]).toEqual(['params']);
    expect(url.hash).toBe('');
    expect(searchBodyOf(urlOfCall(fetch)).q).toBe(query);
  });
});

// --- Retry, deadline, cancellation -----------------------------------------------

describe('AicService deadline and cancellation', () => {
  it('fails with a retry-deadline Timeout when a request outlasts the total deadline', async () => {
    const { service, fetch } = createTestService(scriptedFetch(hangingResponder), {
      retry: { baseDelayMs: 0, deadlineMs: 60 },
    });
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 60 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out one attempt after 10 seconds when more of the deadline remains', async () => {
    vi.useFakeTimers();
    const { service, fetch } = createTestService(scriptedFetch(hangingResponder), {
      retry: { baseDelayMs: 0, deadlineMs: 60_000, maxRetries: 0 },
    });
    const pending = rejection(service.searchArtworks(artworkParams(), makeCtx()));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ timeoutMs: 10_000 });
    expect(error.data?.reason).not.toBe('retry_deadline_exceeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clips the attempt timeout to what remains of the deadline', async () => {
    vi.useFakeTimers();
    const { service } = createTestService(scriptedFetch(hangingResponder), {
      retry: { baseDelayMs: 0, deadlineMs: 5_000, maxRetries: 0 },
    });
    const pending = rejection(service.searchArtworks(artworkParams(), makeCtx()));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('rethrows a caller cancellation without retrying', async () => {
    const controller = new AbortController();
    const { service, fetch } = createTestService(scriptedFetch(hangingResponder));
    const ctx = createMockContext({ signal: controller.signal });
    const pending = rejectionOf(service.searchArtworks(artworkParams(), ctx));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).message).toBe('cancelled by caller');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()));
    const ctx = createMockContext({ signal: controller.signal });
    const error = await rejectionOf(service.searchArtworks(artworkParams(), ctx));
    expect((error as Error).name).toBe('AbortError');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// --- Pacer -----------------------------------------------------------------------------

describe('AicService pacer', () => {
  function shedPacer(retryAfter?: number): Pacer & { run: ReturnType<typeof vi.fn> } {
    return {
      cooldown: { consecutive: 0, remainingMs: 0 },
      dispose: vi.fn(),
      [Symbol.dispose]: vi.fn(),
      run: vi.fn(async () => {
        throw rateLimited('queue shed', {
          reason: 'pacer_shed',
          shedKind: 'wait_projected',
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      }),
    };
  }

  it('rethrows a pacer shed as rate_limited, keeping retryAfter, without retrying or fetching', async () => {
    const pacer = shedPacer(12);
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()), { pacer });
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 12 });
    expect(error.data?.reason).not.toBe('pacer_shed');
    expect(error.cause).toBeInstanceOf(McpError);
    expect(pacer.run).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('omits retryAfter when the shed carried none', async () => {
    const { service } = createTestService(scriptedFetch(emptySearch()), { pacer: shedPacer() });
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.data).toMatchObject({ reason: 'rate_limited' });
    expect(error.data).not.toHaveProperty('retryAfter');
  });

  it('lets other errors from the pacer through unchanged', async () => {
    const pacer = shedPacer();
    pacer.run.mockRejectedValue(new McpError(JsonRpcErrorCode.RequestCancelled, 'queue disposed'));
    const { service } = createTestService(scriptedFetch(emptySearch()), { pacer });
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('paces every attempt, bounding queue time by the remaining deadline', async () => {
    const calls: { maxWaitMs?: number; signal?: AbortSignal }[] = [];
    const inner = createPacer({ name: 'aic-test-spy' });
    const pacer: Pacer = {
      get cooldown() {
        return inner.cooldown;
      },
      dispose: () => inner.dispose(),
      [Symbol.dispose]: () => inner.dispose(),
      run: (task, options) => {
        calls.push({
          ...(options?.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        return inner.run(task, options);
      },
    };
    const { service } = createTestService(scriptedFetch(jsonResponder({}, 503), emptySearch()), {
      pacer,
      retry: { baseDelayMs: 0, deadlineMs: 5_000 },
    });
    await service.searchArtworks(artworkParams(), makeCtx());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.maxWaitMs).toBeGreaterThan(0);
      expect(call.maxWaitMs).toBeLessThanOrEqual(5_000);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    inner.dispose();
  });

  it('does not touch the pacer on a cache hit', async () => {
    const pacer = shedPacer();
    const inner = createPacer({ name: 'aic-test-hit' });
    pacer.run.mockImplementation(
      (task: (signal: AbortSignal) => Promise<unknown>, options?: object) =>
        inner.run(task, options),
    );
    const { service } = createTestService(scriptedFetch(emptySearch()), { pacer });
    const ctx = makeCtx();
    await service.searchArtworks(artworkParams({ query: 'a' }), ctx);
    await service.searchArtworks(artworkParams({ query: 'a' }), ctx);
    expect(pacer.run).toHaveBeenCalledTimes(1);
    inner.dispose();
  });

  it('sheds the second call of a real pacer that cannot start it within the deadline', async () => {
    const pacer = createPacer({ name: 'aic-test-gap', minStartGapMs: MINUTE });
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()), { pacer });
    const ctx = makeCtx();
    await service.searchArtworks(artworkParams({ query: 'one' }), ctx);
    const error = await rejection(service.searchArtworks(artworkParams({ query: 'two' }), ctx));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);
    pacer.dispose();
  });

  it('builds a production pacer from requestsPerMinute when none is injected', async () => {
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()), {
      productionPacer: true,
      requestsPerMinute: 1,
    });
    const ctx = makeCtx();
    await service.searchArtworks(artworkParams({ query: 'one' }), ctx);
    const error = await rejection(service.searchArtworks(artworkParams({ query: 'two' }), ctx));
    expect(error.data).toMatchObject({ reason: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('closes the production pacer on dispose', async () => {
    const { service } = createTestService(scriptedFetch(emptySearch()), { productionPacer: true });
    await service.searchArtworks(artworkParams(), makeCtx());
    expect(() => service.dispose()).not.toThrow();
    expect(() => service.dispose()).not.toThrow();
  });

  it('disposes an injected pacer', () => {
    const pacer = shedPacer();
    const { service } = createTestService(scriptedFetch(emptySearch()), { pacer });
    service.dispose();
    expect(pacer.dispose).toHaveBeenCalledTimes(1);
  });
});

// --- Byte ceiling ------------------------------------------------------------------------

describe('AicService body ceiling', () => {
  const noRetry = { retry: { baseDelayMs: 0, maxRetries: 0 } };

  it('accepts a body of exactly 5 MiB', async () => {
    const { service } = createTestService(
      scriptedFetch(textResponder(envelopeOfBytes(5 * MIB))),
      noRetry,
    );
    await expect(service.searchArtworks(artworkParams(), makeCtx())).resolves.toMatchObject({
      artworks: [],
    });
  });

  it('rejects a body one byte past 5 MiB as an unreadable response', async () => {
    const { service } = createTestService(
      scriptedFetch(textResponder(envelopeOfBytes(5 * MIB + 1))),
      noRetry,
    );
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('unreadable response');
    expect(error.data).toMatchObject({ status: 200 });
  });

  it('stops reading and cancels the stream once the ceiling is passed', async () => {
    const chunk = new Uint8Array(MIB).fill(0x78);
    const body = streamingBody(Array.from({ length: 20 }, () => chunk));
    const { service } = createTestService(scriptedFetch(body.responder), noRetry);
    await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(10);
  });

  it('counts bytes, not characters', async () => {
    const twoByteChars = 'é'.repeat(2_700_000);
    const text = JSON.stringify({ data: [], info: { license_text: twoByteChars } });
    expect(text.length).toBeLessThan(5 * MIB);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(5 * MIB);
    const { service } = createTestService(scriptedFetch(textResponder(text)), noRetry);
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.message).toContain('unreadable response');
  });

  it('treats an oversized error body as unreadable rather than as the error it carries', async () => {
    const { service } = createTestService(
      scriptedFetch(textResponder(envelopeOfBytes(5 * MIB + 1), 400)),
      noRetry,
    );
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('decodes a multi-byte character split across stream chunks', async () => {
    const title = 'Café 漢字 \u{1f3a8}';
    const bytes = new TextEncoder().encode(
      JSON.stringify(searchEnvelope([artworkRecord(1, { title })])),
    );
    const at =
      new TextEncoder().encode(
        JSON.stringify(searchEnvelope([artworkRecord(1, { title })])).split('Caf')[0] ?? '',
      ).length + 4;
    const { service } = createTestService(
      scriptedFetch(
        streamingBody([bytes.slice(0, at), bytes.slice(at, at + 3), bytes.slice(at + 3)]).responder,
      ),
    );
    const result = await service.searchArtworks(artworkParams(), makeCtx());
    expect(result.artworks[0]?.title).toBe(title);
  });

  it('reads a response with no body as empty, which is not a valid envelope', async () => {
    const { service } = createTestService(
      scriptedFetch(() => new Response(null, { status: 200 })),
      noRetry,
    );
    const error = await rejection(service.searchArtworks(artworkParams(), makeCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});

// --- Cache -----------------------------------------------------------------------------------

describe('AicService cache', () => {
  const ctx = makeCtx();

  it('serves an identical request from cache without spending a fetch', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(jsonResponder(searchEnvelope([artworkRecord(1)], 1))),
    );
    const first = await service.searchArtworks(artworkParams({ query: 'water' }), ctx);
    const second = await service.searchArtworks(artworkParams({ query: 'water' }), ctx);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('logs a cache hit to the process log only, so no caller learns what another one asked', async () => {
    const processLog = vi.spyOn(logger, 'debug');
    const { service } = createTestService(scriptedFetch(emptySearch()));
    const logCtx = makeCtx();
    await service.searchArtworks(artworkParams(), logCtx);
    await service.searchArtworks(artworkParams(), logCtx);
    const calls = (logCtx.log as MockContextLogger).calls;
    expect(calls.some((c) => c.msg.includes('cache hit'))).toBe(false);
    expect(processLog).toHaveBeenCalledWith(
      'Art Institute API cache hit',
      expect.objectContaining({
        requestId: logCtx.requestId,
        extra: expect.objectContaining({ path: '/artworks/search' }),
      }),
    );
  });

  it('keys by the full request, so any changed parameter is a miss', async () => {
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()));
    await service.searchArtworks(artworkParams({ query: 'a' }), ctx);
    await service.searchArtworks(artworkParams({ query: 'b' }), ctx);
    await service.searchArtworks(artworkParams({ query: 'a', page: 2 }), ctx);
    await service.searchArtworks(artworkParams({ query: 'a', limit: 20 }), ctx);
    await service.searchArtworks(artworkParams({ query: 'a', public_domain_only: true }), ctx);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not cache failures', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(jsonResponder({}, 429, { 'retry-after': '30' }), emptySearch()),
    );
    await rejection(service.searchArtworks(artworkParams(), ctx));
    await expect(service.searchArtworks(artworkParams(), ctx)).resolves.toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache an unreadable 200', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(textResponder('nope'), emptySearch()),
      { retry: { baseDelayMs: 0, maxRetries: 0 } },
    );
    await rejection(service.searchArtworks(artworkParams(), ctx));
    await service.searchArtworks(artworkParams(), ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  const kinds = [
    [
      'artwork search',
      15 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) =>
        s.searchArtworks(artworkParams(), ctx),
    ],
    [
      'agent search',
      15 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) =>
        s.searchAgents({ query: 'a', artists_only: true, limit: 5, page: 1 }, ctx),
    ],
    [
      'exhibition search',
      15 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) =>
        s.searchExhibitions({ sort: 'start_desc', when: 'any', limit: 5, page: 1 }, ctx),
    ],
    [
      'mobile sound search',
      15 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) =>
        s.searchMobileSounds({ query: 'a', limit: 5, page: 1 }, ctx),
    ],
    [
      'artist work stats',
      15 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) => s.artistWorkStats([1], ctx),
    ],
    [
      'artworks by id',
      6 * 60 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) => s.getArtworks([1], [], ctx),
    ],
    [
      'agents by id',
      6 * 60 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) => s.getAgents([1], ctx),
    ],
    [
      'sounds by id',
      6 * 60 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) => s.getSounds([soundUuid(1)], ctx),
    ],
    [
      'vocabulary aggregation',
      24 * 60 * MINUTE,
      (s: ReturnType<typeof createTestService>['service']) =>
        s.aggregate('department_title.keyword', { public_domain_only: false, size: 5 }, ctx),
    ],
  ] as const;

  it.each(kinds)('%s is cached for its TTL and refetched at expiry', async (_name, ttl, call) => {
    const { service, fetch, clock } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await call(service);
    clock.now += ttl - 1;
    await call(service);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await call(service);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares nothing between distinct kinds of request', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await service.getArtworks([1], [], ctx);
    await service.getAgents([1], ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches a body up to 2 MiB and refuses to cache a larger one', async () => {
    const small = createTestService(scriptedFetch(textResponder(envelopeOfBytes(2 * MIB))));
    await small.service.searchArtworks(artworkParams(), ctx);
    await small.service.searchArtworks(artworkParams(), ctx);
    expect(small.fetch).toHaveBeenCalledTimes(1);

    const large = createTestService(scriptedFetch(textResponder(envelopeOfBytes(2 * MIB + 1))));
    await large.service.searchArtworks(artworkParams(), ctx);
    await large.service.searchArtworks(artworkParams(), ctx);
    expect(large.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a cached result independent of what a caller does to it', async () => {
    const { service } = createTestService(
      scriptedFetch(jsonResponder(searchEnvelope([artworkRecord(1)], 1))),
    );
    const first = await service.searchArtworks(artworkParams(), ctx);
    first.artworks.length = 0;
    const second = await service.searchArtworks(artworkParams(), ctx);
    expect(second.artworks).toHaveLength(1);
  });
});

// --- searchArtworks ------------------------------------------------------------------------------

describe('AicService.searchArtworks', () => {
  const ctx = makeCtx();
  const run = async (
    params: Parameters<typeof artworkParams>[0],
    response: ReturnType<typeof jsonResponder> = emptySearch(),
  ) => {
    const test = createTestService(scriptedFetch(response));
    const result = await test.service.searchArtworks(artworkParams(params), ctx);
    return { ...test, result, body: searchBodyOf(urlOfCall(test.fetch)) };
  };

  it('sends a bare popularity search with only paging and the field allowlist', async () => {
    const { body, result } = await run({});
    expect(body).toEqual({
      page: 1,
      limit: 10,
      fields: expect.stringContaining('id,title,artist_display'),
    });
    expect(result.sort_applied).toBe('popularity');
  });

  it('requests exactly the documented field allowlist', async () => {
    const { body } = await run({});
    expect(body.fields).toBe(
      'id,title,artist_display,artist_id,artist_title,date_display,date_start,date_end,medium_display,artwork_type_title,department_title,place_of_origin,is_public_domain,is_on_view,gallery_title,image_id,thumbnail',
    );
  });

  it('filters text through a simple_query_string must clause and keeps q for ranking', async () => {
    const { body, result } = await run({ query: 'water lilies' });
    expect(body.q).toBe('water lilies');
    expect(body.query).toEqual({
      bool: { must: [{ simple_query_string: { query: 'water lilies', default_operator: 'and' } }] },
    });
    expect(result.sort_applied).toBe('relevance');
  });

  it('maps every structured filter to a bool.filter clause', async () => {
    const { body } = await run({
      artist: 'Test Artist',
      artist_id: 900,
      department: 'PC-10',
      artwork_type: 'Painting',
      style: 'TM-1',
      subject: 'landscape',
      classification: 'oil on canvas',
      place_of_origin: 'France',
      gallery: 'Gallery 240',
      public_domain_only: true,
      on_view_only: true,
      has_image: true,
    });
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter).toEqual([
      { match: { artist_titles: { query: 'Test Artist', operator: 'and' } } },
      { term: { artist_ids: 900 } },
      { term: { department_id: 'PC-10' } },
      { term: { 'artwork_type_title.keyword': { value: 'Painting', case_insensitive: true } } },
      { term: { style_ids: 'TM-1' } },
      { term: { 'subject_titles.keyword': { value: 'landscape', case_insensitive: true } } },
      {
        term: {
          'classification_titles.keyword': { value: 'oil on canvas', case_insensitive: true },
        },
      },
      { term: { 'place_of_origin.keyword': { value: 'France', case_insensitive: true } } },
      { term: { 'gallery_title.keyword': { value: 'Gallery 240', case_insensitive: true } } },
      { term: { is_public_domain: true } },
      { term: { is_on_view: true } },
      { exists: { field: 'image_id' } },
    ]);
  });

  it('adds no filter clauses for unset optional inputs', async () => {
    const { body } = await run({});
    expect(body).not.toHaveProperty('query');
  });

  it.each([
    [{ year_from: 1800 }, [{ range: { date_end: { gte: 1800 } } }]],
    [{ year_to: 1900 }, [{ range: { date_start: { lte: 1900 } } }]],
    [
      { year_from: 1800, year_to: 1900 },
      [{ range: { date_end: { gte: 1800 } } }, { range: { date_start: { lte: 1900 } } }],
    ],
    [
      { year_from: -500, year_to: -400 },
      [{ range: { date_end: { gte: -500 } } }, { range: { date_start: { lte: -400 } } }],
    ],
  ])('builds an overlap range for %j and bounds out placeholder years', async (years, overlap) => {
    const { body } = await run(years);
    expect((body.query as { bool: { filter: unknown[] } }).bool.filter).toEqual([
      ...overlap,
      { range: { date_start: { gte: -8000 } } },
      { range: { date_end: { lte: 2100 } } },
    ]);
  });

  it('keeps a year of zero as a real bound', async () => {
    const { body } = await run({ year_from: 0 });
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter[0]).toEqual({ range: { date_end: { gte: 0 } } });
  });

  it.each([
    ['date_asc', 'asc'],
    ['date_desc', 'desc'],
  ] as const)(
    'sorts %s by date_start, drops q, and bounds placeholder years',
    async (sort, order) => {
      const { body, result } = await run({ sort, query: 'harbor' });
      expect(body).not.toHaveProperty('q');
      expect(body.sort).toEqual([{ date_start: { order } }]);
      expect(body.query).toEqual({
        bool: {
          must: [{ simple_query_string: { query: 'harbor', default_operator: 'and' } }],
          filter: [{ range: { date_start: { gte: -8000, lte: 2100 } } }],
        },
      });
      expect(result.sort_applied).toBe(sort);
    },
  );

  it('adds the facet aggregations, keyed by facet name, with the artist facet bucketed on the id', async () => {
    const { body } = await run({ facets: ['department', 'artist', 'place_of_origin'] });
    expect(body.aggs).toEqual({
      department: { terms: { field: 'department_title.keyword', size: 15 } },
      artist: {
        terms: { field: 'artist_id', size: 15 },
        aggs: { label: { top_hits: { size: 1, _source: ['artist_title'] } } },
      },
      place_of_origin: { terms: { field: 'place_of_origin.keyword', size: 15 } },
    });
  });

  it('sends no aggs for an empty facet list and returns no facets key', async () => {
    const { body, result } = await run({ facets: [] });
    expect(body).not.toHaveProperty('aggs');
    expect(result).not.toHaveProperty('facets');
  });

  it('passes limit 0 through for a counts-only request', async () => {
    const { body, result } = await run(
      { limit: 0, facets: ['department'] },
      jsonResponder(
        aggregationEnvelope('department', [{ key: 'Prints and Drawings', doc_count: 7 }], 0, 42),
      ),
    );
    expect(body.limit).toBe(0);
    expect(result.artworks).toEqual([]);
    expect(result.total).toBe(42);
    expect(result.facets).toEqual({ department: [{ value: 'Prints and Drawings', count: 7 }] });
  });

  it('parses facet buckets, stringifying keys and labelling artists from the top hit', async () => {
    const response = jsonResponder(
      searchEnvelope([], 0, {
        aggregations: {
          artwork_type: { buckets: [{ key: 42, doc_count: 3 }], sum_other_doc_count: 0 },
          artist: {
            buckets: [
              {
                key: 900,
                doc_count: 5,
                label: { hits: { hits: [{ _source: { artist_title: 'Test Artist' } }] } },
              },
              {
                key: '901',
                doc_count: 2,
                label: { hits: { hits: [{ _source: { artist_title: null } }] } },
              },
              { key: 902, doc_count: 1 },
            ],
          },
        },
      }),
    );
    const { result } = await run({ facets: ['artwork_type', 'artist'] }, response);
    expect(result.facets?.artwork_type).toEqual([{ value: '42', count: 3 }]);
    expect(result.facets?.artist).toEqual([
      { artist_id: 900, count: 5, name: 'Test Artist' },
      { artist_id: 901, count: 2 },
      { artist_id: 902, count: 1 },
    ]);
  });

  it('returns an empty list for a requested facet the response did not aggregate', async () => {
    const { result } = await run({ facets: ['style', 'artist'] });
    expect(result.facets).toEqual({ style: [], artist: [] });
  });

  it('reads total from pagination and falls back to the row count', async () => {
    const withTotal = await run({}, jsonResponder(searchEnvelope([artworkRecord(1)], 5000)));
    expect(withTotal.result.total).toBe(5000);
    const without = await run({}, jsonResponder(envelope([artworkRecord(1), artworkRecord(2)])));
    expect(without.result.total).toBe(2);
    const garbage = await run(
      {},
      jsonResponder({ ...searchEnvelope([artworkRecord(1)]), pagination: { total: 'many' } }),
    );
    expect(garbage.result.total).toBe(1);
  });

  it('returns the upstream license text verbatim, or empty when absent', async () => {
    const withLicense = await run({}, jsonResponder(searchEnvelope([artworkRecord(1)])));
    expect(withLicense.result.license_text).toBe(ARTWORK_LICENSE);
    const without = await run(
      {},
      jsonResponder(searchEnvelope([artworkRecord(1)], 1, { license: null })),
    );
    expect(without.result.license_text).toBe('');
  });

  it('skips records without an integer id', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope(
          [artworkRecord(1), null, { title: 'no id' }, { id: '2' }, { id: 1.5 }, artworkRecord(3)],
          6,
        ),
      ),
    );
    expect(result.artworks.map((a) => a.id)).toEqual([1, 3]);
  });

  describe('normalization', () => {
    const one = async (
      record: Record<string, unknown>,
      envelopeOptions?: Parameters<typeof searchEnvelope>[2],
    ) =>
      (await run({}, jsonResponder(searchEnvelope([record], 1, envelopeOptions)))).result
        .artworks[0];

    it('maps a full record', async () => {
      const artwork = await one(
        artworkRecord(7, { gallery_title: 'Gallery 240', is_on_view: true }),
      );
      expect(artwork).toEqual({
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
        is_on_view: true,
        gallery: 'Gallery 240',
        image: {
          url: `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
          url_large: `${IIIF_URL}/${IMAGE_ID}/full/1686,/0/default.jpg`,
          iiif_info_url: `${IIIF_URL}/${IMAGE_ID}/info.json`,
          alt_text: 'A synthetic landscape',
          width: 100,
          height: 80,
          rights: 'public_domain',
        },
        web_url: 'https://www.artic.edu/artworks/7',
      });
    });

    it('fabricates nothing for a record with only an id', async () => {
      const artwork = await one(sparseArtworkRecord(9));
      expect(artwork).toEqual({
        id: 9,
        title: '',
        is_public_domain: false,
        is_on_view: false,
        web_url: 'https://www.artic.edu/artworks/9',
      });
    });

    it('treats null and empty strings as absent', async () => {
      const artwork = await one(
        artworkRecord(1, {
          artist_display: '',
          artist_id: null,
          date_display: '  ',
          medium_display: null,
          place_of_origin: '',
          gallery_title: '',
          image_id: '',
          thumbnail: null,
          is_public_domain: null,
          is_on_view: null,
        }),
      );
      for (const key of [
        'artist_display',
        'artist_id',
        'date_display',
        'medium',
        'place_of_origin',
        'gallery',
        'image',
      ]) {
        expect(artwork).not.toHaveProperty(key);
      }
      expect(artwork).toMatchObject({ is_public_domain: false, is_on_view: false });
    });

    it('screens placeholder years out while keeping date_display', async () => {
      const artwork = await one(placeholderYearArtworkRecord(3));
      expect(artwork).not.toHaveProperty('date_start');
      expect(artwork).not.toHaveProperty('date_end');
      expect(artwork?.date_display).toBe('Dates unknown');
    });

    it('keeps the in-range end of a half-placeholder span', async () => {
      const artwork = await one(artworkRecord(3, { date_start: -1_824_528_578, date_end: 1900 }));
      expect(artwork).not.toHaveProperty('date_start');
      expect(artwork?.date_end).toBe(1900);
    });

    it('keeps BCE years', async () => {
      const artwork = await one(artworkRecord(3, { date_start: -924, date_end: -900 }));
      expect(artwork).toMatchObject({ date_start: -924, date_end: -900 });
    });

    it('gives an in-copyright image the display URL only', async () => {
      const artwork = await one(inCopyrightArtworkRecord(4));
      expect(artwork?.image).toMatchObject({ rights: 'in_copyright' });
      expect(artwork?.image).not.toHaveProperty('url_large');
      expect(artwork?.is_public_domain).toBe(false);
    });

    it('treats a public-domain flag that is not exactly true as in copyright', async () => {
      const artwork = await one(artworkRecord(4, { is_public_domain: 'true' }));
      expect(artwork?.is_public_domain).toBe(false);
      expect(artwork?.image).toMatchObject({ rights: 'in_copyright' });
    });

    it('never carries the lqip thumbnail', async () => {
      const artwork = await one(artworkRecord(4));
      expect(JSON.stringify(artwork)).not.toContain('lqip');
      expect(JSON.stringify(artwork)).not.toContain('data:image');
    });

    it('reads the IIIF base from the envelope config, with a fallback when it is missing', async () => {
      const custom = await one(artworkRecord(1), { iiifUrl: 'https://www.artic.edu/iiif/3' });
      expect(custom?.image?.url).toBe(
        `https://www.artic.edu/iiif/3/${IMAGE_ID}/full/843,/0/default.jpg`,
      );
      for (const iiifUrl of [null, '']) {
        const fallback = await one(artworkRecord(1), { iiifUrl });
        expect(fallback?.image?.url).toBe(`${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`);
      }
    });

    it.each(['javascript:alert(1)', 'http://www.artic.edu/iiif/2', 'https://iiif.example.test/2'])(
      'builds image URLs on the built-in base when the envelope reports %s',
      async (iiifUrl) => {
        const artwork = await one(artworkRecord(1), { iiifUrl });
        expect(artwork?.image).toMatchObject({
          url: `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
          iiif_info_url: `${IIIF_URL}/${IMAGE_ID}/info.json`,
        });
      },
    );

    it('omits the image when the image id is not uuid-shaped', async () => {
      for (const image_id of ['../x?y', 'abc', `${IMAGE_ID}/../../x`]) {
        const artwork = await one(artworkRecord(1, { image_id }));
        expect(artwork).not.toHaveProperty('image');
      }
    });

    it('converts markup in titles and flattens line breaks there', async () => {
      const artwork = await one(
        artworkRecord(1, { title: 'The <em>Great</em>\r\nVoyage &amp; Return' }),
      );
      expect(artwork?.title).toBe('The Great Voyage & Return');
    });

    it('keeps other upstream text exactly as received, line breaks included', async () => {
      const display = 'Test Artist\r\nFrench, 1840-1900\r\n[bracketed] <tagged>';
      const artwork = await one(artworkRecord(1, { artist_display: display }));
      expect(artwork?.artist_display).toBe(display);
    });
  });
});

// --- getArtworks -----------------------------------------------------------------------------------------

describe('AicService.getArtworks', () => {
  const ctx = makeCtx();

  it('requests ids as a comma list in request order with the detail field allowlist', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await service.getArtworks([30, 10, 20], [], ctx);
    const url = urlOfCall(fetch);
    expect(new URL(url).pathname).toBe('/api/v1/artworks');
    expect(queryParam(url, 'ids')).toBe('30,10,20');
    const fields = (queryParam(url, 'fields') ?? '').split(',');
    expect(fields).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'sound_ids',
        'artist_ids',
        'thumbnail',
        'on_loan_display',
      ]),
    );
    expect(fields).not.toContain('description');
    expect(fields).not.toContain('provenance_text');
  });

  it('adds section fields in canonical order whatever order the caller named them', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await service.getArtworks(
      [1],
      ['catalogue', 'publication_history', 'exhibition_history', 'provenance', 'description'],
      ctx,
    );
    const fields = (queryParam(urlOfCall(fetch), 'fields') ?? '').split(',');
    expect(fields.slice(-6)).toEqual([
      'description',
      'short_description',
      'provenance_text',
      'exhibition_history',
      'publication_history',
      'catalogue_display',
    ]);
  });

  it('adds only the requested sections', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await service.getArtworks([1], ['provenance'], ctx);
    const fields = (queryParam(urlOfCall(fetch), 'fields') ?? '').split(',');
    expect(fields).toContain('provenance_text');
    expect(fields).not.toContain('description');
    expect(fields).not.toContain('catalogue_display');
  });

  it('reorders records to request order and reports missing ids in request order', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(envelope([artworkRecord(20), artworkRecord(10), artworkRecord(40)])),
      ),
    );
    const result = await service.getArtworks([40, 30, 10, 50, 20], [], ctx);
    expect(result.entries.map((e) => e.detail.id)).toEqual([40, 10, 20]);
    expect(result.missing_ids).toEqual([30, 50]);
  });

  it('reports every id as missing when the API returns none', async () => {
    const { service } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    const result = await service.getArtworks([5, 6], [], ctx);
    expect(result.entries).toEqual([]);
    expect(result.missing_ids).toEqual([5, 6]);
  });

  it('ignores records the API returned that were not requested', async () => {
    const { service } = createTestService(
      scriptedFetch(jsonResponder(envelope([artworkRecord(1), artworkRecord(99)]))),
    );
    const result = await service.getArtworks([1], [], ctx);
    expect(result.entries.map((e) => e.detail.id)).toEqual([1]);
    expect(result.missing_ids).toEqual([]);
  });

  it('counts a record without an integer id as missing', async () => {
    const { service } = createTestService(
      scriptedFetch(jsonResponder(envelope([{ id: '1', title: 'x' }]))),
    );
    const result = await service.getArtworks([1], [], ctx);
    expect(result.missing_ids).toEqual([1]);
  });

  it('carries the sound ids beside each record and drops non-string and blank ones', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          envelope([
            artworkRecord(1, { sound_ids: [soundUuid(1), '', null, 5, soundUuid(2)] }),
            artworkRecord(2, { sound_ids: null }),
            artworkRecord(3),
          ]),
        ),
      ),
    );
    const { entries } = await service.getArtworks([1, 2, 3], [], ctx);
    expect(entries.map((e) => e.sound_ids)).toEqual([[soundUuid(1), soundUuid(2)], [], []]);
  });

  it('returns the license text of the batch', async () => {
    const { service } = createTestService(
      scriptedFetch(jsonResponder(envelope([artworkRecord(1)]))),
    );
    expect((await service.getArtworks([1], [], ctx)).license_text).toBe(ARTWORK_LICENSE);
  });

  describe('detail normalization', () => {
    const detail = async (record: Record<string, unknown>) => {
      const { service } = createTestService(scriptedFetch(jsonResponder(envelope([record]))));
      return (await service.getArtworks([record.id as number], [], ctx)).entries[0]?.detail;
    };

    it('maps a populated record, converting HTML text fields and building URLs', async () => {
      const result = await detail(
        artworkRecord(1, {
          alt_titles: ['Alt <em>One</em>', '', 'Alt Two'],
          date_qualifier_title: 'circa',
          inscriptions: 'Signed lower right',
          copyright_notice: null,
          edition: 'Edition 3 of 10',
          dimensions: '10 x 10 cm',
          on_loan_display: 'On loan from a synthetic lender',
          artist_ids: [900, 901],
          style_titles: ['Impressionism', 'Post-Impressionism', ''],
          subject_titles: ['landscape'],
          material_titles: ['oil paint', 'canvas'],
          technique_titles: ['impasto'],
          theme_titles: ['nature'],
          alt_image_ids: [ALT_IMAGE_ID],
          description: '<p>A <em>synthetic</em> description.</p><p>Second.</p>',
          short_description: '<p>Short.</p>',
          provenance_text: 'Owner A, 1900;\n\nOwner B, 1950.',
          exhibition_history: 'Show A, 1950',
          publication_history: 'Book A, 1960',
          catalogue_display: '<p>Cat. no. 5</p>',
        }),
      );
      expect(result).toMatchObject({
        id: 1,
        main_reference_number: '1.1900',
        alt_titles: ['Alt One', 'Alt Two'],
        date_qualifier: 'circa',
        inscriptions: 'Signed lower right',
        edition: 'Edition 3 of 10',
        dimensions: '10 x 10 cm',
        credit_line: 'Gift of a synthetic donor',
        classification: 'oil on canvas',
        style: 'Impressionism',
        on_loan: 'On loan from a synthetic lender',
        artist_ids: [900, 901],
        styles: ['Impressionism', 'Post-Impressionism'],
        subjects: ['landscape'],
        materials: ['oil paint', 'canvas'],
        techniques: ['impasto'],
        themes: ['nature'],
        description: 'A synthetic description.\n\nSecond.',
        short_description: 'Short.',
        provenance: 'Owner A, 1900;\n\nOwner B, 1950.',
        exhibition_history: 'Show A, 1950',
        publication_history: 'Book A, 1960',
        catalogue: 'Cat. no. 5',
        manifest_url: 'https://api.artic.edu/api/v1/artworks/1/manifest.json',
        alt_images: [
          {
            url: `${IIIF_URL}/${ALT_IMAGE_ID}/full/843,/0/default.jpg`,
            iiif_info_url: `${IIIF_URL}/${ALT_IMAGE_ID}/info.json`,
          },
        ],
      });
      expect(result).not.toHaveProperty('copyright_notice');
      expect(result).not.toHaveProperty('sound_ids');
    });

    it('returns empty arrays and no optional keys for a record with only an id', async () => {
      const result = await detail(sparseArtworkRecord(8));
      expect(result).toEqual({
        id: 8,
        title: '',
        is_public_domain: false,
        is_on_view: false,
        web_url: 'https://www.artic.edu/artworks/8',
        main_reference_number: '',
        artist_ids: [],
        styles: [],
        subjects: [],
        materials: [],
        techniques: [],
        themes: [],
      });
    });

    it('offers a manifest only for public-domain works', async () => {
      expect(await detail(artworkRecord(1, { is_public_domain: true }))).toHaveProperty(
        'manifest_url',
      );
      expect(await detail(inCopyrightArtworkRecord(2))).not.toHaveProperty('manifest_url');
    });

    it('maps an empty date qualifier to absent', async () => {
      expect(await detail(artworkRecord(1, { date_qualifier_title: '' }))).not.toHaveProperty(
        'date_qualifier',
      );
    });

    it('drops a description that is only markup', async () => {
      const result = await detail(
        artworkRecord(1, { description: '<p> </p><br/>', short_description: '&nbsp;' }),
      );
      expect(result).not.toHaveProperty('description');
      expect(result).not.toHaveProperty('short_description');
    });

    it('omits alt_images and alt_titles when none are present', async () => {
      const result = await detail(artworkRecord(1, { alt_image_ids: [], alt_titles: [] }));
      expect(result).not.toHaveProperty('alt_images');
      expect(result).not.toHaveProperty('alt_titles');
    });

    it('keeps only the uuid-shaped alternate image ids', async () => {
      const result = await detail(
        artworkRecord(1, { alt_image_ids: ['../x?y', ALT_IMAGE_ID, 'abc'] }),
      );
      expect(result?.alt_images).toEqual([
        {
          url: `${IIIF_URL}/${ALT_IMAGE_ID}/full/843,/0/default.jpg`,
          iiif_info_url: `${IIIF_URL}/${ALT_IMAGE_ID}/info.json`,
        },
      ]);
      const none = await detail(artworkRecord(1, { alt_image_ids: ['../x?y'] }));
      expect(none).not.toHaveProperty('alt_images');
    });
  });
});

// --- getSounds ---------------------------------------------------------------------------------------------

describe('AicService.getSounds', () => {
  const ctx = makeCtx();

  it('requests the uuids in order with the sound fields', async () => {
    const { service, fetch } = createTestService(scriptedFetch(jsonResponder(envelope([]))));
    await service.getSounds([soundUuid(2), soundUuid(1)], ctx);
    const url = urlOfCall(fetch);
    expect(new URL(url).pathname).toBe('/api/v1/sounds');
    expect(queryParam(url, 'ids')).toBe(`${soundUuid(2)},${soundUuid(1)}`);
    expect(queryParam(url, 'fields')).toBe('id,title,type,content');
  });

  it('reorders to request order and drops unknown uuids without reporting them', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          envelope([soundRecord(soundUuid(3)), soundRecord(soundUuid(1))], { license: 'CC0' }),
        ),
      ),
    );
    const result = await service.getSounds([soundUuid(1), soundUuid(2), soundUuid(3)], ctx);
    expect(result.sounds.map((s) => s.id)).toEqual([soundUuid(1), soundUuid(3)]);
    expect(result.license_text).toBe('CC0');
  });

  it('drops assets with no content URL or a non-string id, and tolerates null entries', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          envelope([
            soundRecord(soundUuid(1), { content: null }),
            soundRecord(soundUuid(2), { content: '  ' }),
            null,
            { id: 7, content: 'https://www.artic.edu/assets/7' },
            soundRecord(soundUuid(3)),
          ]),
        ),
      ),
    );
    const result = await service.getSounds([soundUuid(1), soundUuid(2), soundUuid(3)], ctx);
    expect(result.sounds.map((s) => s.id)).toEqual([soundUuid(3)]);
  });

  it('drops assets whose content URL is not http or https', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          envelope([
            soundRecord(soundUuid(1), { content: 'javascript:alert(1)' }),
            soundRecord(soundUuid(2), { content: 'data:audio/mpeg;base64,AAAA' }),
            soundRecord(soundUuid(3), { content: 'http://www.artic.edu/assets/3' }),
          ]),
        ),
      ),
    );
    const result = await service.getSounds([soundUuid(1), soundUuid(2), soundUuid(3)], ctx);
    expect(result.sounds.map((s) => [s.id, s.url])).toEqual([
      [soundUuid(3), 'http://www.artic.edu/assets/3'],
    ]);
  });

  it('converts markup in titles and omits an absent type', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          envelope([soundRecord(soundUuid(1), { title: 'Stop on <em>Light</em>', type: null })]),
        ),
      ),
    );
    const [sound] = (await service.getSounds([soundUuid(1)], ctx)).sounds;
    expect(sound).toEqual({
      id: soundUuid(1),
      title: 'Stop on Light',
      url: `https://www.artic.edu/assets/${soundUuid(1)}`,
    });
  });
});

// --- Agents ----------------------------------------------------------------------------------------------------

describe('AicService agents', () => {
  const ctx = makeCtx();

  describe('searchAgents', () => {
    const run = async (
      params: Partial<
        Parameters<ReturnType<typeof createTestService>['service']['searchAgents']>[0]
      >,
      response = jsonResponder(searchEnvelope([], 0, { license: AGENT_LICENSE })),
    ) => {
      const test = createTestService(scriptedFetch(response));
      const result = await test.service.searchAgents(
        { query: 'monet', artists_only: true, limit: 10, page: 1, ...params },
        ctx,
      );
      return { result, body: searchBodyOf(urlOfCall(test.fetch)), url: urlOfCall(test.fetch) };
    };

    it('matches the query on name fields with AND semantics and filters to artists', async () => {
      const { body, url } = await run({});
      expect(new URL(url).pathname).toBe('/api/v1/agents/search');
      expect(body.q).toBe('monet');
      expect(body.query).toEqual({
        bool: {
          must: [
            {
              simple_query_string: {
                query: 'monet',
                fields: ['title', 'alt_titles', 'sort_title'],
                default_operator: 'and',
              },
            },
          ],
          filter: [{ term: { is_artist: true } }],
        },
      });
      expect(body.fields).toBe(
        'id,title,sort_title,alt_titles,is_artist,agent_type_title,birth_date,death_date,description',
      );
    });

    it('drops the artist filter when artists_only is false', async () => {
      const { body } = await run({ artists_only: false });
      expect((body.query as { bool: object }).bool).not.toHaveProperty('filter');
    });

    it.each([
      [{ born_from: 1800 }, { gte: 1800 }],
      [{ born_to: 1900 }, { lte: 1900 }],
      [
        { born_from: 1800, born_to: 1900 },
        { gte: 1800, lte: 1900 },
      ],
      [{ born_from: 0 }, { gte: 0 }],
    ])('builds the birth range for %j', async (born, range) => {
      const { body } = await run({ artists_only: false, ...born });
      expect((body.query as { bool: { filter: unknown[] } }).bool.filter).toEqual([
        { range: { birth_date: range } },
      ]);
    });

    it('maps agents, screening placeholder years and converting biography markup', async () => {
      const { result } = await run(
        {},
        jsonResponder(
          searchEnvelope(
            [
              agentRecord(1, {
                alt_titles: ['Alt', '', 'Other'],
                description: '<p>Painter of <em>light</em>.</p>',
                birth_date: -1_824_528_578,
                death_date: 1900,
              }),
              agentRecord(2, {
                is_artist: null,
                agent_type_title: '',
                sort_title: null,
                birth_date: null,
                death_date: null,
              }),
            ],
            2,
            { license: AGENT_LICENSE },
          ),
        ),
      );
      expect(result.total).toBe(2);
      expect(result.license_text).toBe(AGENT_LICENSE);
      expect(result.agents[0]).toEqual({
        id: 1,
        name: 'Synthetic Agent 1',
        sort_name: 'Agent, Synthetic 1',
        agent_type: 'Individual',
        death_year: 1900,
        biography: 'Painter of light.',
        alt_names: ['Alt', 'Other'],
        is_artist: true,
      });
      expect(result.agents[1]).toEqual({
        id: 2,
        name: 'Synthetic Agent 2',
        alt_names: [],
        is_artist: false,
      });
    });
  });

  describe('getAgents', () => {
    it('reorders to request order and reports missing ids', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(
          jsonResponder(envelope([agentRecord(3), agentRecord(1)], { license: AGENT_LICENSE })),
        ),
      );
      const result = await service.getAgents([1, 2, 3], ctx);
      expect(result.agents.map((a) => a.id)).toEqual([1, 3]);
      expect(result.missing_ids).toEqual([2]);
      expect(result.license_text).toBe(AGENT_LICENSE);
      expect(queryParam(urlOfCall(fetch), 'ids')).toBe('1,2,3');
      expect(new URL(urlOfCall(fetch)).pathname).toBe('/api/v1/agents');
    });
  });

  describe('artistWorkStats', () => {
    const bucket = (key: number | string, count: number, sources: unknown[]) => ({
      key,
      doc_count: count,
      works: { hits: { hits: sources.map((_source) => ({ _source })) } },
    });

    it('asks for counts and boosted-first sample works in one aggregation', async () => {
      const { service, fetch } = createTestService(
        scriptedFetch(jsonResponder(aggregationEnvelope('by_artist', []))),
      );
      await service.artistWorkStats([5, 6, 7], ctx);
      expect(searchBodyOf(urlOfCall(fetch))).toEqual({
        limit: 0,
        query: { bool: { filter: [{ terms: { artist_ids: [5, 6, 7] } }] } },
        aggs: {
          by_artist: {
            terms: { field: 'artist_ids', include: [5, 6, 7], size: 3 },
            aggs: {
              works: {
                top_hits: {
                  size: 3,
                  sort: [{ is_boosted: { order: 'desc' } }],
                  _source: ['id', 'title', 'date_display'],
                },
              },
            },
          },
        },
      });
    });

    it('gives every requested id an entry, counting 0 for an agent with no works', async () => {
      const { service } = createTestService(
        scriptedFetch(
          jsonResponder(
            aggregationEnvelope('by_artist', [
              bucket(5, 12, [
                { id: 100, title: 'First <em>Work</em>', date_display: '1890' },
                { id: 101, title: 'Second', date_display: '' },
              ]),
            ]),
          ),
        ),
      );
      const stats = await service.artistWorkStats([5, 6], ctx);
      expect([...stats.keys()]).toEqual([5, 6]);
      expect(stats.get(5)).toEqual({
        artwork_count: 12,
        sample_works: [
          { id: 100, title: 'First Work', date_display: '1890' },
          { id: 101, title: 'Second' },
        ],
      });
      expect(stats.get(6)).toEqual({ artwork_count: 0, sample_works: [] });
    });

    it('coerces string bucket keys and ignores buckets for ids that were not requested', async () => {
      const { service } = createTestService(
        scriptedFetch(
          jsonResponder(aggregationEnvelope('by_artist', [bucket('5', 3, []), bucket(99, 50, [])])),
        ),
      );
      const stats = await service.artistWorkStats([5], ctx);
      expect([...stats.keys()]).toEqual([5]);
      expect(stats.get(5)?.artwork_count).toBe(3);
    });

    it('drops top hits that carry no integer id and tolerates a bucket with no hits', async () => {
      const { service } = createTestService(
        scriptedFetch(
          jsonResponder(
            aggregationEnvelope('by_artist', [
              bucket(5, 2, [{ title: 'No id' }, undefined, { id: 8, title: 'Kept' }]),
              { key: 6, doc_count: 4 },
            ]),
          ),
        ),
      );
      const stats = await service.artistWorkStats([5, 6], ctx);
      expect(stats.get(5)?.sample_works).toEqual([{ id: 8, title: 'Kept' }]);
      expect(stats.get(6)).toEqual({ artwork_count: 4, sample_works: [] });
    });

    it('treats a response with no aggregation as zero counts', async () => {
      const { service } = createTestService(scriptedFetch(emptySearch()));
      const stats = await service.artistWorkStats([5], ctx);
      expect(stats.get(5)).toEqual({ artwork_count: 0, sample_works: [] });
    });
  });
});

// --- Exhibitions -----------------------------------------------------------------------------------------------------

describe('AicService.searchExhibitions', () => {
  const ctx = makeCtx();
  const run = async (
    params: Partial<
      Parameters<ReturnType<typeof createTestService>['service']['searchExhibitions']>[0]
    >,
    response = jsonResponder(searchEnvelope([])),
  ) => {
    const test = createTestService(scriptedFetch(response));
    const result = await test.service.searchExhibitions(
      { sort: 'start_desc', when: 'any', limit: 10, page: 1, ...params },
      ctx,
    );
    return { result, body: searchBodyOf(urlOfCall(test.fetch)), url: urlOfCall(test.fetch) };
  };
  const filterOf = (body: Record<string, unknown>) =>
    (body.query as { bool: { filter?: unknown[] } } | undefined)?.bool.filter;

  it.each([
    ['any', undefined],
    [
      'current',
      [{ range: { aic_start_at: { lte: 'now' } } }, { range: { aic_end_at: { gte: 'now' } } }],
    ],
    ['upcoming', [{ range: { aic_start_at: { gt: 'now' } } }]],
    ['past', [{ range: { aic_end_at: { lt: 'now' } } }]],
  ] as const)(
    'maps when=%s with Elasticsearch date math, never a server timestamp',
    async (when, filter) => {
      const { body, url } = await run({ when });
      expect(new URL(url).pathname).toBe('/api/v1/exhibitions/search');
      expect(filterOf(body)).toEqual(filter);
    },
  );

  it('builds an overlap window from date_from and date_to', async () => {
    const { body } = await run({ date_from: '2020-01-01', date_to: '2020-12-31' });
    expect(filterOf(body)).toEqual([
      { range: { aic_end_at: { gte: '2020-01-01' } } },
      { range: { aic_start_at: { lte: '2020-12-31' } } },
    ]);
  });

  it('combines when and a date window', async () => {
    const { body } = await run({ when: 'past', date_from: '2010-01-01' });
    expect(filterOf(body)).toEqual([
      { range: { aic_end_at: { lt: 'now' } } },
      { range: { aic_end_at: { gte: '2010-01-01' } } },
    ]);
  });

  it('ranks by relevance with q and a must clause when a query is given and sort is relevance', async () => {
    const { body, result } = await run({ query: 'impressionism', sort: 'relevance' });
    expect(body.q).toBe('impressionism');
    expect(body).not.toHaveProperty('sort');
    expect(result.sort_applied).toBe('relevance');
  });

  it('falls back to start_desc when relevance is asked for without a query', async () => {
    const { body, result } = await run({ sort: 'relevance' });
    expect(body).not.toHaveProperty('q');
    expect(body.sort).toEqual([{ aic_start_at: { order: 'desc' } }]);
    expect(result.sort_applied).toBe('start_desc');
  });

  it.each([
    ['start_asc', 'asc'],
    ['start_desc', 'desc'],
  ] as const)('sorts %s without q even when a query is present', async (sort, order) => {
    const { body, result } = await run({ query: 'impressionism', sort });
    expect(body).not.toHaveProperty('q');
    expect(body.sort).toEqual([{ aic_start_at: { order } }]);
    expect((body.query as { bool: { must: unknown[] } }).bool.must).toEqual([
      { simple_query_string: { query: 'impressionism', default_operator: 'and' } },
    ]);
    expect(result.sort_applied).toBe(sort);
  });

  it('maps a populated exhibition, pairing artwork ids with titles by index', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([
          exhibitionRecord(1, {
            status: 'Confirmed',
            gallery_title: 'Gallery 100',
            short_description: '<p>A <em>synthetic</em> show.</p>',
            web_url: 'https://www.artic.edu/exhibitions/1',
            image_id: IMAGE_ID,
            image_url: 'https://imgix.example.test/x.jpg',
            artwork_ids: [10, 11],
            artwork_titles: ['Work <em>A</em>', 'Work B'],
            artist_ids: [900],
            is_featured: true,
          }),
        ]),
      ),
    );
    expect(result.exhibitions[0]).toEqual({
      id: 1,
      title: 'Synthetic Exhibition 1',
      status: 'Confirmed',
      start: '2020-01-01T00:00:00-06:00',
      end: '2020-06-01T00:00:00-05:00',
      gallery: 'Gallery 100',
      summary: 'A synthetic show.',
      web_url: 'https://www.artic.edu/exhibitions/1',
      image_url: `${IIIF_URL}/${IMAGE_ID}/full/843,/0/default.jpg`,
      is_featured: true,
      artwork_count: 2,
      artworks: [
        { id: 10, title: 'Work A' },
        { id: 11, title: 'Work B' },
      ],
      artist_ids: [900],
    });
  });

  it('gives each artwork its id alone when ids and titles differ in length', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([
          exhibitionRecord(1, { artwork_ids: [10, 11, 12], artwork_titles: ['Only one'] }),
        ]),
      ),
    );
    expect(result.exhibitions[0]?.artworks).toEqual([{ id: 10 }, { id: 11 }, { id: 12 }]);
    expect(result.exhibitions[0]?.artwork_count).toBe(3);
  });

  it('never pairs a blank title', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([exhibitionRecord(1, { artwork_ids: [10, 11], artwork_titles: ['', 'B'] })]),
      ),
    );
    expect(result.exhibitions[0]?.artworks).toEqual([{ id: 10 }, { id: 11, title: 'B' }]);
  });

  it('falls back to the upstream image_url when there is no image id, and omits both when absent', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([
          exhibitionRecord(1, { image_url: 'https://imgix.example.test/x.jpg' }),
          exhibitionRecord(2),
        ]),
      ),
    );
    expect(result.exhibitions[0]?.image_url).toBe('https://imgix.example.test/x.jpg');
    expect(result.exhibitions[1]).not.toHaveProperty('image_url');
  });

  it('omits URLs that are not http or https, and reads a malformed image id as absent', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([
          exhibitionRecord(1, {
            web_url: 'javascript:alert(1)',
            image_url: 'data:image/png;base64,AAAA',
          }),
          exhibitionRecord(2, {
            image_id: '../x?y',
            image_url: 'https://imgix.example.test/x.jpg',
          }),
          exhibitionRecord(3, { image_id: '../x?y' }),
        ]),
      ),
    );
    expect(result.exhibitions[0]).not.toHaveProperty('web_url');
    expect(result.exhibitions[0]).not.toHaveProperty('image_url');
    expect(result.exhibitions[1]?.image_url).toBe('https://imgix.example.test/x.jpg');
    expect(result.exhibitions[2]).not.toHaveProperty('image_url');
  });

  it('omits what an older sparse exhibition lacks', async () => {
    const { result } = await run({}, jsonResponder(searchEnvelope([{ id: 5, title: 'Old show' }])));
    expect(result.exhibitions[0]).toEqual({
      id: 5,
      title: 'Old show',
      artwork_count: 0,
      artworks: [],
      artist_ids: [],
    });
  });

  it('keeps is_featured false but drops a non-boolean', async () => {
    const { result } = await run(
      {},
      jsonResponder(
        searchEnvelope([
          exhibitionRecord(1, { is_featured: false }),
          exhibitionRecord(2, { is_featured: null }),
        ]),
      ),
    );
    expect(result.exhibitions[0]?.is_featured).toBe(false);
    expect(result.exhibitions[1]).not.toHaveProperty('is_featured');
  });
});

// --- Mobile sounds -----------------------------------------------------------------------------------------------------

describe('AicService.searchMobileSounds', () => {
  const ctx = makeCtx();

  it('searches stop titles and transcripts with AND semantics', async () => {
    const { service, fetch } = createTestService(scriptedFetch(emptySearch()));
    await service.searchMobileSounds({ query: 'water lilies', limit: 5, page: 2 }, ctx);
    const url = urlOfCall(fetch);
    expect(new URL(url).pathname).toBe('/api/v1/mobile-sounds/search');
    expect(searchBodyOf(url)).toEqual({
      q: 'water lilies',
      query: {
        bool: {
          must: [{ simple_query_string: { query: 'water lilies', default_operator: 'and' } }],
        },
      },
      page: 2,
      limit: 5,
      fields: 'id,title,web_url,transcript',
    });
  });

  it('maps stops, converting transcript markup and keeping the encoded MP3 URL', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope(
            [
              mobileSoundRecord(1, { title: 'Stop <em>One</em>' }),
              mobileSoundRecord(2, { transcript: null, web_url: '' }),
            ],
            2,
            { license: MOBILE_SOUND_LICENSE },
          ),
        ),
      ),
    );
    const result = await service.searchMobileSounds({ query: 'a', limit: 5, page: 1 }, ctx);
    expect(result.license_text).toBe(MOBILE_SOUND_LICENSE);
    expect(result.total).toBe(2);
    expect(result.stops[0]).toEqual({
      id: 1,
      title: 'Stop One',
      audio_url: 'https://www.artic.edu/iiif/audio/970%20fixed.mp3',
      transcript: 'First paragraph.\n\nSecond paragraph.',
    });
    expect(result.stops[1]).toEqual({ id: 2, title: 'Synthetic audio stop 2' });
  });

  it('omits an audio URL that is not http or https', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          searchEnvelope([mobileSoundRecord(1, { web_url: 'javascript:alert(1)' })], 1, {
            license: MOBILE_SOUND_LICENSE,
          }),
        ),
      ),
    );
    const result = await service.searchMobileSounds({ query: 'a', limit: 5, page: 1 }, ctx);
    expect(result.stops[0]).not.toHaveProperty('audio_url');
  });
});

// --- aggregate ---------------------------------------------------------------------------------------------------------------

describe('AicService.aggregate', () => {
  const ctx = makeCtx();

  it('aggregates one keyword field, sized, with no query by default', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(jsonResponder(aggregationEnvelope('v', []))),
    );
    await service.aggregate('style_titles.keyword', { public_domain_only: false, size: 25 }, ctx);
    expect(searchBodyOf(urlOfCall(fetch))).toEqual({
      limit: 0,
      aggs: { v: { terms: { field: 'style_titles.keyword', size: 25 } } },
    });
  });

  it('restricts to public-domain works and passes the include regex through', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(jsonResponder(aggregationEnvelope('v', []))),
    );
    await service.aggregate(
      'style_titles.keyword',
      { public_domain_only: true, size: 5, include: '.*[iI].*' },
      ctx,
    );
    expect(searchBodyOf(urlOfCall(fetch))).toEqual({
      limit: 0,
      query: { bool: { filter: [{ term: { is_public_domain: true } }] } },
      aggs: { v: { terms: { field: 'style_titles.keyword', size: 5, include: '.*[iI].*' } } },
    });
  });

  it('omits a blank include', async () => {
    const { service, fetch } = createTestService(
      scriptedFetch(jsonResponder(aggregationEnvelope('v', []))),
    );
    await service.aggregate(
      'style_titles.keyword',
      { public_domain_only: false, size: 5, include: '' },
      ctx,
    );
    expect(searchBodyOf(urlOfCall(fetch)).aggs).toEqual({
      v: { terms: { field: 'style_titles.keyword', size: 5 } },
    });
  });

  it('returns buckets with stringified keys and the remainder count', async () => {
    const { service } = createTestService(
      scriptedFetch(
        jsonResponder(
          aggregationEnvelope(
            'v',
            [
              { key: 'Impressionism', doc_count: 9 },
              { key: 2024, doc_count: 3 },
            ],
            41,
          ),
        ),
      ),
    );
    const result = await service.aggregate(
      'style_titles.keyword',
      { public_domain_only: false, size: 2 },
      ctx,
    );
    expect(result).toEqual({
      buckets: [
        { key: 'Impressionism', doc_count: 9 },
        { key: '2024', doc_count: 3 },
      ],
      license_text: ARTWORK_LICENSE,
      sum_other_doc_count: 41,
    });
  });

  it('returns no buckets and a zero remainder when the aggregation is absent', async () => {
    const { service } = createTestService(scriptedFetch(emptySearch()));
    const result = await service.aggregate(
      'style_titles.keyword',
      { public_domain_only: false, size: 2 },
      ctx,
    );
    expect(result.buckets).toEqual([]);
    expect(result.sum_other_doc_count).toBe(0);
  });
});

// --- Routed integration across calls ------------------------------------------------------------------------------------------------

describe('AicService across routes', () => {
  it('serves different resources from the same instance and cache', async () => {
    const fetch = routedFetch({
      '/api/v1/artworks': jsonResponder(envelope([artworkRecord(1)])),
      '/api/v1/sounds': jsonResponder(envelope([soundRecord(soundUuid(1))])),
    });
    const { service } = createTestService(fetch);
    const ctx = makeCtx();
    const artworks = await service.getArtworks([1], [], ctx);
    const sounds = await service.getSounds([soundUuid(1)], ctx);
    expect(artworks.entries).toHaveLength(1);
    expect(sounds.sounds).toHaveLength(1);
    await service.getArtworks([1], [], ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
