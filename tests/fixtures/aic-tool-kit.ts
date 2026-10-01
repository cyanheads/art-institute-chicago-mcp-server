/**
 * @fileoverview Wires the process-wide `AicService` the tool definitions read
 * to a fake `fetch`, with the same seams as `createTestService`: an unlimited
 * pacer, zero retry backoff, and a controllable clock.
 * @module tests/fixtures/aic-tool-kit
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import type { Mock } from 'vitest';
import {
  type AicServiceOptions,
  disposeAicService,
  type FetchFn,
  initAicService,
} from '@/services/aic/aic-service.js';
import {
  envelopeOfBytes,
  hangingResponder,
  jsonResponder,
  networkErrorResponder,
  type Responder,
  TEST_CONTACT,
  TEST_VERSION,
  textResponder,
} from './aic-service-kit.js';
import {
  API_NOT_FOUND_BODY,
  API_OTHER_403_BODY,
  EDGE_BLOCK_HTML,
  ES_BAD_REQUEST_TEXT,
} from './aic-upstream.js';

/** Installs the global service over `fetchFake`; pair with `disposeAicService()` in `afterEach`. */
export function installAicService(
  fetchFake: Mock<FetchFn>,
  options: Partial<AicServiceOptions> = {},
): Mock<FetchFn> {
  disposeAicService();
  initAicService({
    contact: TEST_CONTACT,
    version: TEST_VERSION,
    fetch: fetchFake,
    pacer: createPacer({ name: 'aic-tool-test' }),
    retry: { baseDelayMs: 0 },
    ...options,
  });
  return fetchFake;
}

// --- Tool result readers --------------------------------------------------------

export type ToolRun = Awaited<ReturnType<typeof runToolContract>>;

/** The structured output of a successful run; fails the test when the run errored. */
export function structuredOf<T>(result: ToolRun): T {
  if (result.isError) throw new Error(`Expected a successful run, got: ${textOf(result)}`);
  return result.structuredContent as T;
}

export interface ToolErrorSurface {
  code: number;
  data: Record<string, unknown> & { recovery?: { hint?: string }; reason?: string };
  message: string;
}

/** The error envelope of a failed run; fails the test when the run succeeded. */
export function errorOf(result: ToolRun): ToolErrorSurface {
  if (!result.isError) throw new Error('Expected the run to fail');
  return (result.structuredContent as { error: ToolErrorSurface }).error;
}

/** A field of a structured record that a test has already shown to be present. */
export const fieldOf = <T>(record: Record<string, unknown> | undefined, key: string): T =>
  record?.[key] as T;

/** Text of the first content block (the tool's `format()` output on success, the error text on failure). */
export function textOf(result: ToolRun): string {
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('Expected the first content block to be text');
  return block.text;
}

// --- Upstream failure matrix ------------------------------------------------------

export interface UpstreamFailureCase {
  code: number;
  /** Strings that must not reach the caller, such as the search backend's internal index names. */
  forbidden?: string[];
  name: string;
  /** Service options this case needs, such as a short retry deadline. */
  options?: Partial<AicServiceOptions>;
  reason?: string;
  responder: Responder;
}

/** The recovery hint a tool declares for one of its error reasons. */
export function recoveryFor(
  tool: { errors?: readonly { reason: string; recovery: string }[] | undefined },
  reason: string,
): string | undefined {
  return tool.errors?.find((entry) => entry.reason === reason)?.recovery;
}

/** Each upstream failure class and the error surface a caller must see for it. */
export const UPSTREAM_FAILURES: readonly UpstreamFailureCase[] = [
  {
    name: '429 rate limit',
    responder: jsonResponder({}, 429, { 'retry-after': '0' }),
    code: JsonRpcErrorCode.RateLimited,
    reason: 'rate_limited',
  },
  {
    name: '403 edge block without the API error body',
    responder: textResponder(EDGE_BLOCK_HTML, 403, { 'content-type': 'text/html' }),
    code: JsonRpcErrorCode.Forbidden,
    reason: 'request_blocked',
  },
  {
    name: '403 API refusal unrelated to paging',
    responder: jsonResponder(API_OTHER_403_BODY, 403),
    code: JsonRpcErrorCode.InternalError,
    reason: 'upstream_rejected_query',
  },
  {
    name: '400 text body from the search backend',
    responder: textResponder(ES_BAD_REQUEST_TEXT, 400),
    code: JsonRpcErrorCode.InternalError,
    reason: 'upstream_rejected_query',
    forbidden: ['artic-test-index', 'parsing_exception', 'search_phase_execution_exception'],
  },
  {
    name: '404 API error body',
    responder: jsonResponder(API_NOT_FOUND_BODY, 404),
    code: JsonRpcErrorCode.InternalError,
    reason: 'upstream_rejected_query',
  },
  {
    name: '302 redirect, which is never followed',
    responder: () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/x' } }),
    code: JsonRpcErrorCode.ServiceUnavailable,
    forbidden: ['elsewhere.test'],
  },
  {
    name: '500 server error',
    responder: textResponder('upstream exploded', 500, { 'content-type': 'text/plain' }),
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    name: '200 with a body that is not JSON',
    responder: textResponder('<html>maintenance</html>', 200, { 'content-type': 'text/html' }),
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    name: '200 JSON without the data envelope',
    responder: jsonResponder({ unexpected: true }),
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    name: 'network failure',
    responder: networkErrorResponder('connect ECONNRESET'),
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    name: 'body past the byte ceiling',
    responder: textResponder(envelopeOfBytes(5 * 1024 * 1024 + 1024), 200),
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    name: 'request that outlasts the retry deadline',
    responder: hangingResponder,
    options: { retry: { baseDelayMs: 0, deadlineMs: 50 } },
    code: JsonRpcErrorCode.Timeout,
  },
];

// --- Hostile upstream text ------------------------------------------------------------

/**
 * An upstream string for an inline markdown slot that carries every character
 * `inlineSafe` must neutralize: a link, an HTML tag, CR/LF with a heading
 * injection, C0 and C1 controls, and bidi controls. Synthetic.
 */
export const HOSTILE_INLINE =
  'Bad [link](https://example.test) <img src=x> end\r\n# Injected heading\u0007\u001b\u007f\u009b\u202e\u2066 tail';

/** What `inlineSafe(HOSTILE_INLINE)` must render: flattened, escaped, controls stripped. */
export const HOSTILE_INLINE_RENDERED =
  'Bad \\[link\\](https://example.test) \\<img src=x\\> end # Injected heading tail';

/** Asserts a rendered text carries no raw control or bidi characters and no CR. */
export function hasNoUnsafeCharacters(text: string): boolean {
  return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
    text,
  );
}
