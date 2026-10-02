/**
 * @fileoverview Test kit for driving `AicService` through its constructor
 * seams: scripted and routed fetch fakes, the edge firewall in front of them,
 * response builders, service construction, and request inspection helpers.
 * @module tests/fixtures/aic-service-kit
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { type Mock, vi } from 'vitest';
import {
  AicService,
  type AicServiceOptions,
  type ArtworkSearchParams,
  type FetchFn,
} from '@/services/aic/aic-service.js';
import { EDGE_BLOCK_HTML } from './aic-upstream.js';

export const API_ORIGIN = 'https://api.artic.edu';

/** The longest query string, in bytes and without the `?`, the API's edge firewall lets a GET carry. */
export const GET_QUERY_LIMIT = 2048;
/** The smallest POST body, in bytes, the API's edge firewall blocks (7,528 bytes measured passing). */
export const POST_BODY_LIMIT = 8192;
export const TEST_VERSION = '9.9.9';
export const TEST_CONTACT = 'https://example.test/contact';

/** Produces one response per request. Responses are single-use, so every call builds a fresh one. */
export type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

export function jsonResponder(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

/** A text body served with a JSON content type, as the search backend's 400 is. */
export function textResponder(
  text: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Responder {
  return () => new Response(text, { status, headers });
}

/** Rejects the way `fetch` does when the network fails. */
export function networkErrorResponder(message = 'fetch failed'): Responder {
  return () => {
    throw new TypeError(message);
  };
}

/** Never settles until the request signal aborts, then rejects with the signal's reason. */
export const hangingResponder: Responder = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/**
 * A fetch fake that answers calls in order; the last step repeats once the
 * script runs out. Records every call on the returned mock.
 */
export function scriptedFetch(...steps: Responder[]): Mock<FetchFn> {
  let index = 0;
  return vi.fn<FetchFn>(async (url, init) => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (!step) throw new Error('scriptedFetch needs at least one step');
    return await step(url, init);
  });
}

/**
 * Puts the API's edge firewall in front of `inner`: a GET whose query string
 * passes 2,048 bytes, a POST body of 8,192 bytes or more, or any request whose
 * search text carries markup, gets the 403 block page; everything else reaches `inner`.
 */
export function behindFirewall(inner: Responder): Responder {
  return (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    const text = `${new URL(url).searchParams.get('params') ?? ''}${body}`;
    const tooLong =
      init.method === 'POST'
        ? Buffer.byteLength(body) >= POST_BODY_LIMIT
        : queryStringBytes(url) > GET_QUERY_LIMIT;
    if (tooLong || /<[a-z/!]/i.test(text)) {
      return new Response(EDGE_BLOCK_HTML, {
        status: 403,
        headers: { 'content-type': 'text/html' },
      });
    }
    return inner(url, init);
  };
}

/** A fetch fake that answers by URL pathname (e.g. `/api/v1/sounds`); unrouted paths fail loudly. */
export function routedFetch(routes: Record<string, Responder>): Mock<FetchFn> {
  return vi.fn<FetchFn>(async (url, init) => {
    const responder = routes[new URL(url).pathname];
    if (!responder) throw new Error(`No test route for ${url}`);
    return await responder(url, init);
  });
}

export interface TestService {
  /** The fake clock's current time; assign to advance it. */
  readonly clock: { now: number };
  fetch: Mock<FetchFn>;
  service: AicService;
}

/**
 * An `AicService` wired like the design's Test Boundary: an unlimited pacer,
 * zero retry backoff, and a controllable clock for cache TTLs. Set
 * `productionPacer` to leave the pacer unset so the service builds its own
 * from `requestsPerMinute`.
 */
export function createTestService(
  fetchFake: Mock<FetchFn>,
  {
    productionPacer = false,
    ...options
  }: Partial<AicServiceOptions> & { productionPacer?: boolean } = {},
): TestService {
  const clock = { now: 1_000_000 };
  const service = new AicService({
    contact: TEST_CONTACT,
    version: TEST_VERSION,
    fetch: fetchFake,
    now: () => clock.now,
    ...(productionPacer ? {} : { pacer: createPacer({ name: 'aic-test' }) }),
    retry: { baseDelayMs: 0 },
    ...options,
  });
  return { fetch: fetchFake, service, clock };
}

/** The decoded `params=` JSON of a request, or the plain query params for an `ids=` request. */
export function searchBodyOf(url: string): Record<string, unknown> {
  const raw = new URL(url).searchParams.get('params');
  if (raw === null) throw new Error(`Request has no params query: ${url}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

export function queryParam(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

/** Bytes in a URL's query string, without the `?` (percent-encoding leaves it ASCII). */
export function queryStringBytes(url: string): number {
  return Math.max(0, new URL(url).search.length - 1);
}

/** URL of the nth recorded call. */
export function urlOfCall(fetchFake: Mock<FetchFn>, call = 0): string {
  const args = fetchFake.mock.calls[call];
  if (!args) throw new Error(`No fetch call at index ${call}`);
  return args[0];
}

/** One recorded search call as the API receives it. */
export interface SearchCall {
  /** The search JSON: the decoded `params` query of a GET, or the parsed body of a POST. */
  body: Record<string, unknown>;
  headers: Record<string, string>;
  init: RequestInit;
  method: 'GET' | 'POST';
  url: string;
}

/** The nth recorded search call, sent as a GET (no `method` set) or a POST. */
export function searchCallOf(fetchFake: Mock<FetchFn>, call = 0): SearchCall {
  const args = fetchFake.mock.calls[call];
  if (!args) throw new Error(`No fetch call at index ${call}`);
  const [url, init] = args;
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (init.method === 'POST') {
    if (typeof init.body !== 'string') throw new Error(`POST without a string body: ${url}`);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return { body, headers, init, method: 'POST', url };
  }
  if (init.method !== undefined) throw new Error(`Unexpected method ${init.method}: ${url}`);
  return { body: searchBodyOf(url), headers, init, method: 'GET', url };
}

/** Awaits a promise that must reject and returns what it rejected with. */
export async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the promise to reject');
}

/** Awaits a promise that must reject, whatever the rejection is. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

/** `searchArtworks` params with every required field set to its quiet default. */
export function artworkParams(overrides: Partial<ArtworkSearchParams> = {}): ArtworkSearchParams {
  return {
    has_image: false,
    limit: 10,
    on_view_only: false,
    page: 1,
    public_domain_only: false,
    sort: 'relevance',
    ...overrides,
  };
}

/** A valid JSON envelope of exactly `bytes` bytes, padded through `info.license_text`. */
export function envelopeOfBytes(bytes: number): string {
  const frame = (pad: string) => JSON.stringify({ data: [], info: { license_text: pad } });
  const overhead = frame('').length;
  if (bytes < overhead) throw new Error(`Cannot build an envelope smaller than ${overhead} bytes`);
  return frame('x'.repeat(bytes - overhead));
}

/** A response whose body streams in `chunkBytes` chunks and records how far it was read. */
export function streamingBody(
  chunks: Uint8Array[],
  status = 200,
): { cancelled: () => boolean; pulled: () => number; responder: Responder } {
  let pulled = 0;
  let cancelled = false;
  const responder: Responder = () => {
    pulled = 0;
    cancelled = false;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  };
  return { responder, pulled: () => pulled, cancelled: () => cancelled };
}
