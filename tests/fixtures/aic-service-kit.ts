/**
 * @fileoverview Test kit for driving `AicService` through its constructor
 * seams: scripted and routed fetch fakes, response builders, service
 * construction, and request inspection helpers.
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

export const API_ORIGIN = 'https://api.artic.edu';
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

/** URL of the nth recorded call. */
export function urlOfCall(fetchFake: Mock<FetchFn>, call = 0): string {
  const args = fetchFake.mock.calls[call];
  if (!args) throw new Error(`No fetch call at index ${call}`);
  return args[0];
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
