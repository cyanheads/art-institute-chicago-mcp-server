/**
 * @fileoverview Client for the Art Institute of Chicago public API
 * (`api.artic.edu/api/v1`). Builds every query from validated inputs, then sends
 * it through one request boundary: an in-process response cache, a process-wide
 * pacer under the anonymous rate limit, a retry loop inside a total deadline, a
 * byte-bounded body read, and status classification tuned to this API's error shapes.
 * @module services/aic/aic-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, isRecord, type Pacer, withRetry } from '@cyanheads/mcp-ts-core/utils';
import {
  artworkWebUrl,
  buildImage,
  definedOnly,
  FALLBACK_IIIF_URL,
  htmlField,
  iiifImageUrl,
  iiifInfoUrl,
  integerList,
  manifestUrl,
  nonEmpty,
  plausibleYear,
  stringList,
  VOCABULARY_FIELDS,
  type VocabularyFilter,
  vocabularyFilterClause,
  YEAR_MAX,
  YEAR_MIN,
} from './aic-text.js';
import { ResponseCache } from './response-cache.js';
import type {
  Agent,
  ArtistWorkStats,
  ArtworkDetail,
  ArtworkFacets,
  ArtworkSection,
  ArtworkSummary,
  AudioGuideStop,
  Exhibition,
  FacetName,
  RawAgent,
  RawAggregation,
  RawArtwork,
  RawEnvelope,
  RawExhibition,
  RawMobileSound,
  RawSound,
  RawTopHits,
  RelatedMedia,
  SampleWork,
} from './types.js';

const API_BASE_URL = 'https://api.artic.edu/api/v1';

/** Bodies past this are abandoned mid-stream; the largest observed is about 1.33 MB. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Per-attempt network budget, clipped to what remains of the total deadline. */
const ATTEMPT_TIMEOUT_MS = 10_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TTL_MS = { record: 6 * HOUR_MS, search: 15 * MINUTE_MS, vocabulary: 24 * HOUR_MS } as const;

/** The API's own 403 `error` strings for a page past the anonymous search window. */
const WINDOW_ERRORS = new Set(['Invalid limit', 'Invalid number of results']);

const ARTWORK_SEARCH_FIELDS = [
  'id',
  'title',
  'artist_display',
  'artist_id',
  'artist_title',
  'date_display',
  'date_start',
  'date_end',
  'medium_display',
  'artwork_type_title',
  'department_title',
  'place_of_origin',
  'is_public_domain',
  'is_on_view',
  'gallery_title',
  'image_id',
  'thumbnail',
].join(',');

const ARTWORK_DETAIL_FIELDS = [
  'id',
  'title',
  'alt_titles',
  'main_reference_number',
  'artist_display',
  'artist_id',
  'artist_ids',
  'date_display',
  'date_start',
  'date_end',
  'date_qualifier_title',
  'place_of_origin',
  'medium_display',
  'dimensions',
  'inscriptions',
  'credit_line',
  'copyright_notice',
  'edition',
  'artwork_type_title',
  'department_title',
  'classification_title',
  'style_title',
  'style_titles',
  'subject_titles',
  'material_titles',
  'technique_titles',
  'theme_titles',
  'is_public_domain',
  'is_on_view',
  'gallery_title',
  'on_loan_display',
  'image_id',
  'alt_image_ids',
  'thumbnail',
  'sound_ids',
];

/** Upstream fields each opt-in section adds, in canonical section order. */
const SECTION_FIELDS: Record<ArtworkSection, readonly string[]> = {
  description: ['description', 'short_description'],
  provenance: ['provenance_text'],
  exhibition_history: ['exhibition_history'],
  publication_history: ['publication_history'],
  catalogue: ['catalogue_display'],
};

const AGENT_FIELDS =
  'id,title,sort_title,alt_titles,is_artist,agent_type_title,birth_date,death_date,description';

const EXHIBITION_FIELDS =
  'id,title,status,aic_start_at,aic_end_at,gallery_id,gallery_title,short_description,web_url,image_id,image_url,artwork_ids,artwork_titles,artist_ids,is_featured';

const MOBILE_SOUND_FIELDS = 'id,title,web_url,transcript';

const SOUND_FIELDS = 'id,title,type,content';

const VOCABULARY_FILTERS: readonly VocabularyFilter[] = [
  'department',
  'artwork_type',
  'style',
  'subject',
  'classification',
  'place_of_origin',
  'gallery',
];

const FACET_SIZE = 15;

// --- Public parameter and result shapes ---------------------------------------

/** Fetch-compatible function the service sends requests through. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface AicServiceOptions {
  /** Contact named in the `AIC-User-Agent` header (an email or URL). */
  contact: string;
  /** Request function; tests inject a fake. Defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Clock for cache expiry; tests inject a fake. Defaults to `Date.now`. */
  now?: () => number;
  /** Outbound pacer; tests inject an unlimited one. Built from `requestsPerMinute` when absent. */
  pacer?: Pacer;
  /** Pacer budget when no `pacer` is supplied. Default 50. */
  requestsPerMinute?: number;
  retry?: { baseDelayMs?: number; deadlineMs?: number; maxRetries?: number };
  /** Server version named in the `AIC-User-Agent` header. */
  version: string;
}

export type ArtworkSort = 'relevance' | 'date_asc' | 'date_desc';
export type ArtworkSortApplied = 'relevance' | 'popularity' | 'date_asc' | 'date_desc';

export interface ArtworkSearchParams {
  artist?: string | undefined;
  artist_id?: number | undefined;
  artwork_type?: string | undefined;
  classification?: string | undefined;
  department?: string | undefined;
  facets?: readonly FacetName[] | undefined;
  gallery?: string | undefined;
  has_image: boolean;
  limit: number;
  on_view_only: boolean;
  page: number;
  place_of_origin?: string | undefined;
  public_domain_only: boolean;
  query?: string | undefined;
  sort: ArtworkSort;
  style?: string | undefined;
  subject?: string | undefined;
  year_from?: number | undefined;
  year_to?: number | undefined;
}

export interface ArtworkSearchResult {
  artworks: ArtworkSummary[];
  facets?: ArtworkFacets;
  license_text: string;
  sort_applied: ArtworkSortApplied;
  total: number;
}

/** One artwork from the `ids=` batch route, with the sound asset ids it links to. */
export interface ArtworkBatchEntry {
  detail: ArtworkDetail;
  sound_ids: string[];
}

export interface ArtworkBatchResult {
  /** Found records, in request order. */
  entries: ArtworkBatchEntry[];
  license_text: string;
  /** Requested ids the API did not return, in request order. */
  missing_ids: number[];
}

export interface SoundBatchResult {
  license_text: string;
  /** Found sound assets with a content URL, in request order. */
  sounds: RelatedMedia[];
}

export interface AgentSearchParams {
  artists_only: boolean;
  born_from?: number | undefined;
  born_to?: number | undefined;
  limit: number;
  page: number;
  query: string;
}

export interface AgentSearchResult {
  agents: Agent[];
  license_text: string;
  total: number;
}

export interface AgentBatchResult {
  /** Found agents, in request order. */
  agents: Agent[];
  license_text: string;
  missing_ids: number[];
}

export type ExhibitionWhen = 'any' | 'current' | 'upcoming' | 'past';
export type ExhibitionSort = 'relevance' | 'start_desc' | 'start_asc';

export interface ExhibitionSearchParams {
  date_from?: string | undefined;
  date_to?: string | undefined;
  limit: number;
  page: number;
  query?: string | undefined;
  /** `relevance` without `query` sorts as `start_desc`. */
  sort: ExhibitionSort;
  when: ExhibitionWhen;
}

export interface ExhibitionSearchResult {
  exhibitions: Exhibition[];
  license_text: string;
  sort_applied: ExhibitionSort;
  total: number;
}

export interface AudioGuideSearchParams {
  limit: number;
  page: number;
  query: string;
}

export interface AudioGuideSearchResult {
  license_text: string;
  stops: AudioGuideStop[];
  total: number;
}

export interface AggregateOptions {
  /** Lucene regex the bucket keys must match. */
  include?: string | undefined;
  /** Count over public-domain artworks only. */
  public_domain_only: boolean;
  size: number;
}

export interface AggregateResult {
  buckets: { doc_count: number; key: string }[];
  license_text: string;
  /** Artwork-value pairs outside the returned buckets; above 0 means more values exist. */
  sum_other_doc_count: number;
}

// --- Service ------------------------------------------------------------------

interface FetchedBody {
  body: RawEnvelope<unknown>;
  bytes: number;
  text: string;
}

export class AicService {
  readonly #cache: ResponseCache;
  readonly #fetch: FetchFn;
  readonly #pacer: Pacer;
  readonly #retry: { baseDelayMs: number; deadlineMs: number; maxRetries: number };
  readonly #userAgent: string;

  constructor(options: AicServiceOptions) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#pacer = options.pacer ?? buildPacer(options.requestsPerMinute ?? 50);
    this.#retry = {
      baseDelayMs: options.retry?.baseDelayMs ?? 1_500,
      deadlineMs: options.retry?.deadlineMs ?? 20_000,
      maxRetries: options.retry?.maxRetries ?? 2,
    };
    this.#cache = new ResponseCache({
      maxEntries: 500,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntryBytes: 2 * 1024 * 1024,
      now: options.now ?? Date.now,
    });
    this.#userAgent = `art-institute-chicago-mcp-server/${options.version} (${options.contact})`;
  }

  /** Release the pacer's timer and reject queued callers. */
  dispose(): void {
    this.#pacer.dispose();
  }

  /** Collection search with text, structured filters, optional facet counts, and sorting. */
  async searchArtworks(params: ArtworkSearchParams, ctx: Context): Promise<ArtworkSearchResult> {
    const must = params.query ? [simpleQuery(params.query)] : [];
    const filter = artworkFilters(params);
    const dateSort = params.sort !== 'relevance';
    if (dateSort) filter.push({ range: { date_start: { gte: YEAR_MIN, lte: YEAR_MAX } } });
    const facets = params.facets ?? [];
    const body = {
      ...(!dateSort && params.query ? { q: params.query } : {}),
      ...boolQuery(must, filter),
      ...(dateSort
        ? { sort: [{ date_start: { order: params.sort === 'date_asc' ? 'asc' : 'desc' } }] }
        : {}),
      page: params.page,
      limit: params.limit,
      fields: ARTWORK_SEARCH_FIELDS,
      ...(facets.length > 0 ? { aggs: facetAggregations(facets) } : {}),
    };
    const envelope = await this.#search<RawArtwork>('/artworks/search', body, TTL_MS.search, ctx);
    const iiifUrl = iiifBase(envelope);
    let sortApplied: ArtworkSortApplied = params.sort;
    if (!dateSort) sortApplied = params.query ? 'relevance' : 'popularity';
    return {
      artworks: records(envelope).map((raw) => toArtworkSummary(raw, iiifUrl)),
      ...(facets.length > 0 ? { facets: parseFacets(envelope.aggregations, facets) } : {}),
      license_text: licenseText(envelope),
      sort_applied: sortApplied,
      total: totalOf(envelope),
    };
  }

  /**
   * Full records for up to a page of artwork ids in one `ids=` call. The API
   * drops unknown ids and ignores request order, so records come back reordered
   * to `ids` with the misses listed.
   */
  async getArtworks(
    ids: readonly number[],
    sections: readonly ArtworkSection[],
    ctx: Context,
  ): Promise<ArtworkBatchResult> {
    const fields = [
      ...ARTWORK_DETAIL_FIELDS,
      ...(Object.keys(SECTION_FIELDS) as ArtworkSection[])
        .filter((section) => sections.includes(section))
        .flatMap((section) => SECTION_FIELDS[section]),
    ].join(',');
    const envelope = await this.#list<RawArtwork>(
      '/artworks',
      { ids: ids.join(','), fields },
      TTL_MS.record,
      ctx,
    );
    const iiifUrl = iiifBase(envelope);
    const byId = new Map(records(envelope).map((raw) => [raw.id, raw]));
    const entries: ArtworkBatchEntry[] = [];
    const missingIds: number[] = [];
    for (const id of ids) {
      const raw = byId.get(id);
      if (raw)
        entries.push({
          detail: toArtworkDetail(raw, iiifUrl),
          sound_ids: stringList(raw.sound_ids),
        });
      else missingIds.push(id);
    }
    return { entries, license_text: licenseText(envelope), missing_ids: missingIds };
  }

  /** `/sounds` multimedia assets by uuid, reordered to request order; unknown uuids are dropped. */
  async getSounds(ids: readonly string[], ctx: Context): Promise<SoundBatchResult> {
    const envelope = await this.#list<RawSound>(
      '/sounds',
      { ids: ids.join(','), fields: SOUND_FIELDS },
      TTL_MS.record,
      ctx,
    );
    const byId = new Map<string, RelatedMedia>();
    for (const raw of envelope.data ?? []) {
      const sound = toRelatedMedia(raw);
      if (sound) byId.set(sound.id, sound);
    }
    return {
      license_text: licenseText(envelope),
      sounds: ids.flatMap((id) => byId.get(id) ?? []),
    };
  }

  /** Name search over agents (artists, cultures, organizations); all words must match. */
  async searchAgents(params: AgentSearchParams, ctx: Context): Promise<AgentSearchResult> {
    const filter: unknown[] = [];
    if (params.artists_only) filter.push({ term: { is_artist: true } });
    if (params.born_from !== undefined || params.born_to !== undefined) {
      filter.push({
        range: {
          birth_date: definedOnly({ gte: params.born_from, lte: params.born_to }),
        },
      });
    }
    const body = {
      q: params.query,
      ...boolQuery([simpleQuery(params.query, ['title', 'alt_titles', 'sort_title'])], filter),
      page: params.page,
      limit: params.limit,
      fields: AGENT_FIELDS,
    };
    const envelope = await this.#search<RawAgent>('/agents/search', body, TTL_MS.search, ctx);
    return {
      agents: records(envelope).map(toAgent),
      license_text: licenseText(envelope),
      total: totalOf(envelope),
    };
  }

  /** Agents by id, reordered to request order; unknown ids are listed as missing. */
  async getAgents(ids: readonly number[], ctx: Context): Promise<AgentBatchResult> {
    const envelope = await this.#list<RawAgent>(
      '/agents',
      { ids: ids.join(','), fields: AGENT_FIELDS },
      TTL_MS.record,
      ctx,
    );
    const byId = new Map(records(envelope).map((raw) => [raw.id, raw]));
    const agents: Agent[] = [];
    const missingIds: number[] = [];
    for (const id of ids) {
      const raw = byId.get(id);
      if (raw) agents.push(toAgent(raw));
      else missingIds.push(id);
    }
    return { agents, license_text: licenseText(envelope), missing_ids: missingIds };
  }

  /**
   * How many artworks credit each agent and up to three of their works, the
   * museum's boosted highlights first, from one aggregation. Every requested id
   * gets an entry; an agent with no works counts 0.
   */
  async artistWorkStats(
    ids: readonly number[],
    ctx: Context,
  ): Promise<Map<number, ArtistWorkStats>> {
    const body = {
      limit: 0,
      query: { bool: { filter: [{ terms: { artist_ids: ids } }] } },
      aggs: {
        by_artist: {
          terms: { field: 'artist_ids', include: ids, size: ids.length },
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
    };
    const envelope = await this.#search<RawArtwork>('/artworks/search', body, TTL_MS.search, ctx);
    const stats = new Map<number, ArtistWorkStats>(
      ids.map((id) => [id, { artwork_count: 0, sample_works: [] }]),
    );
    for (const bucket of envelope.aggregations?.by_artist?.buckets ?? []) {
      const id = Number(bucket.key);
      if (!stats.has(id)) continue;
      const hits = (bucket.works as RawTopHits<Partial<RawArtwork>> | undefined)?.hits?.hits ?? [];
      stats.set(id, {
        artwork_count: bucket.doc_count,
        sample_works: hits.flatMap(({ _source }) => toSampleWork(_source)),
      });
    }
    return stats;
  }

  /** Exhibition search by text, currency (`when`), and an overlapping date window. */
  async searchExhibitions(
    params: ExhibitionSearchParams,
    ctx: Context,
  ): Promise<ExhibitionSearchResult> {
    const relevance = params.sort === 'relevance' && params.query !== undefined;
    const must = params.query ? [simpleQuery(params.query)] : [];
    const filter: unknown[] = [...whenFilters(params.when)];
    if (params.date_from) filter.push({ range: { aic_end_at: { gte: params.date_from } } });
    if (params.date_to) filter.push({ range: { aic_start_at: { lte: params.date_to } } });
    const sortApplied: ExhibitionSort = relevance
      ? 'relevance'
      : params.sort === 'start_asc'
        ? 'start_asc'
        : 'start_desc';
    const body = {
      ...(relevance ? { q: params.query } : {}),
      ...boolQuery(must, filter),
      ...(relevance
        ? {}
        : { sort: [{ aic_start_at: { order: sortApplied === 'start_asc' ? 'asc' : 'desc' } }] }),
      page: params.page,
      limit: params.limit,
      fields: EXHIBITION_FIELDS,
    };
    const envelope = await this.#search<RawExhibition>(
      '/exhibitions/search',
      body,
      TTL_MS.search,
      ctx,
    );
    const iiifUrl = iiifBase(envelope);
    return {
      exhibitions: records(envelope).map((raw) => toExhibition(raw, iiifUrl)),
      license_text: licenseText(envelope),
      sort_applied: sortApplied,
      total: totalOf(envelope),
    };
  }

  /** Text search over mobile audio-guide stops (titles and transcripts); all words must match. */
  async searchMobileSounds(
    params: AudioGuideSearchParams,
    ctx: Context,
  ): Promise<AudioGuideSearchResult> {
    const body = {
      q: params.query,
      ...boolQuery([simpleQuery(params.query)], []),
      page: params.page,
      limit: params.limit,
      fields: MOBILE_SOUND_FIELDS,
    };
    const envelope = await this.#search<RawMobileSound>(
      '/mobile-sounds/search',
      body,
      TTL_MS.search,
      ctx,
    );
    return {
      license_text: licenseText(envelope),
      stops: records(envelope).map(toAudioGuideStop),
      total: totalOf(envelope),
    };
  }

  /** Values of one artwork keyword field with artwork counts, most common first. */
  async aggregate(
    field: (typeof VOCABULARY_FIELDS)[keyof typeof VOCABULARY_FIELDS],
    options: AggregateOptions,
    ctx: Context,
  ): Promise<AggregateResult> {
    const body = {
      limit: 0,
      ...(options.public_domain_only
        ? { query: { bool: { filter: [{ term: { is_public_domain: true } }] } } }
        : {}),
      aggs: {
        v: {
          terms: {
            field,
            size: options.size,
            ...(options.include ? { include: options.include } : {}),
          },
        },
      },
    };
    const envelope = await this.#search<RawArtwork>(
      '/artworks/search',
      body,
      TTL_MS.vocabulary,
      ctx,
    );
    const aggregation: RawAggregation | undefined = envelope.aggregations?.v;
    return {
      buckets: (aggregation?.buckets ?? []).map((bucket) => ({
        key: String(bucket.key),
        doc_count: bucket.doc_count,
      })),
      license_text: licenseText(envelope),
      sum_other_doc_count: aggregation?.sum_other_doc_count ?? 0,
    };
  }

  // --- Request boundary -------------------------------------------------------

  /** `GET <path>?params=<minified JSON>`, the API's documented production query form. */
  #search<T>(
    path: string,
    body: Record<string, unknown>,
    ttlMs: number,
    ctx: Context,
  ): Promise<RawEnvelope<T>> {
    return this.#request<T>(path, { params: JSON.stringify(body) }, ttlMs, ctx);
  }

  /** `GET <path>?ids=…&fields=…` listing-by-ids. */
  #list<T>(
    path: string,
    params: Record<string, string>,
    ttlMs: number,
    ctx: Context,
  ): Promise<RawEnvelope<T>> {
    return this.#request<T>(path, params, ttlMs, ctx);
  }

  async #request<T>(
    path: string,
    params: Record<string, string>,
    ttlMs: number,
    ctx: Context,
  ): Promise<RawEnvelope<T>> {
    const url = new URL(`${API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const href = url.toString();

    const cached = this.#cache.get(href);
    if (cached !== undefined) {
      ctx.log.debug('Art Institute API cache hit', { path });
      return JSON.parse(cached) as RawEnvelope<T>;
    }

    const fetched = await this.#fetchResilient(href, path, ctx);
    this.#cache.set(href, fetched.text, fetched.bytes, ttlMs);
    return fetched.body as RawEnvelope<T>;
  }

  /**
   * Retry outside, pacer inside: every attempt is re-paced and its queue time is
   * charged to the deadline. A pacer shed (the call could not start in time) is
   * not retried and leaves as `rate_limited` so the calling tool's recovery applies.
   */
  async #fetchResilient(href: string, path: string, ctx: Context): Promise<FetchedBody> {
    try {
      return await withRetry(
        (attempt) =>
          this.#pacer.run((signal) => this.#attempt(href, signal, attempt.remainingMs, ctx), {
            signal: attempt.signal,
            ...(Number.isFinite(attempt.remainingMs) ? { maxWaitMs: attempt.remainingMs } : {}),
          }),
        {
          operation: `AicService ${path}`,
          context: ctx,
          signal: ctx.signal,
          maxRetries: this.#retry.maxRetries,
          baseDelayMs: this.#retry.baseDelayMs,
          maxDelayMs: 15_000,
          deadlineMs: this.#retry.deadlineMs,
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'pacer_shed') {
        const retryAfter = error.data.retryAfter;
        throw rateLimited(
          'Requests to the Art Institute API are queued behind its rate limit, and this call could not start within its time budget.',
          { reason: 'rate_limited', ...(retryAfter !== undefined ? { retryAfter } : {}) },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** One paced attempt: fetch, read the body under the byte ceiling, classify. */
  async #attempt(
    href: string,
    signal: AbortSignal,
    remainingMs: number,
    ctx: Context,
  ): Promise<FetchedBody> {
    const timeoutMs = Math.max(0, Math.min(ATTEMPT_TIMEOUT_MS, remainingMs));
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const response = await this.#fetch(href, {
        headers: { Accept: 'application/json', 'AIC-User-Agent': this.#userAgent },
        signal: AbortSignal.any([signal, timer.signal]),
      });
      const read = await readBounded(response, MAX_BODY_BYTES);
      return classify(response, read, ctx);
    } catch (error) {
      if (error instanceof McpError) throw error;
      // Caller cancellation or the retry deadline: withRetry owns that classification.
      if (signal.aborted) throw error;
      if (timer.signal.aborted) {
        throw timeout(`The Art Institute API did not respond within ${timeoutMs} ms.`, {
          timeoutMs,
        });
      }
      throw serviceUnavailable(
        `Could not reach the Art Institute API: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(handle);
    }
  }
}

// --- Request helpers -----------------------------------------------------------

function buildPacer(requestsPerMinute: number): Pacer {
  return createPacer({
    name: 'aic',
    minStartGapMs: Math.ceil(MINUTE_MS / requestsPerMinute),
    limits: [{ requests: requestsPerMinute, perMs: MINUTE_MS }],
    cooldown: { baseMs: 10_000, maxMs: 60_000 },
  });
}

/** The body as text, or `undefined` when it passed `maxBytes` (the stream is cancelled). */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: number; text: string } | undefined> {
  if (!response.body) return { bytes: 0, text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { bytes, text };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

/** The API's own error body: `{ status: number, error: string, detail?: string }`. */
function isApiErrorBody(body: unknown): body is { error: string; status: number } {
  return isRecord(body) && typeof body.status === 'number' && typeof body.error === 'string';
}

function retryAfterOf(response: Response): { retryAfter?: number | string } {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return {};
  return { retryAfter: /^\d+$/.test(header) ? Number(header) : header };
}

/**
 * Classifies a response by status and body, never by `content-type` (the search
 * backend's 400 is plain text served as `application/json`).
 */
function classify(
  response: Response,
  read: { bytes: number; text: string } | undefined,
  ctx: Context,
): FetchedBody {
  const { status } = response;
  if (read === undefined) {
    throw serviceUnavailable(
      `The Art Institute API sent an unreadable response (HTTP ${status}, larger than ${MAX_BODY_BYTES} bytes).`,
      { status },
    );
  }
  const body = parseJson(read.text);

  if (status >= 200 && status < 300) {
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw serviceUnavailable(
        `The Art Institute API sent an unreadable response (HTTP ${status}, not the expected JSON envelope).`,
        { status },
      );
    }
    return { body: body as RawEnvelope<unknown>, bytes: read.bytes, text: read.text };
  }

  if (status === 429) {
    throw rateLimited('The Art Institute API is rate limiting this server (HTTP 429).', {
      reason: 'rate_limited',
      status,
      ...retryAfterOf(response),
    });
  }

  if (status === 403) {
    if (!isApiErrorBody(body)) {
      throw rateLimited(
        'The Art Institute API edge refused the request (HTTP 403 without the API error body), which indicates throttling.',
        { reason: 'rate_limited', status, ...retryAfterOf(response) },
      );
    }
    if (WINDOW_ERRORS.has(body.error)) {
      throw validationError(
        `The Art Institute API refused the page ("${body.error}"): only the first 1,000 matches of a search are reachable.`,
        { reason: 'page_beyond_window', retryable: false },
      );
    }
    throw internalError(
      `The Art Institute API rejected the request this server built (HTTP 403, "${body.error}").`,
      { reason: 'upstream_rejected_query', retryable: false, status },
    );
  }

  if (status >= 500) {
    throw serviceUnavailable(`The Art Institute API returned HTTP ${status}.`, { status });
  }

  // 400 from the search backend names internal index names: log it, never put it on the wire.
  ctx.log.debug('Art Institute API rejected a request', {
    status,
    body: read.text.slice(0, 2_000),
  });
  throw internalError(
    `The Art Institute API rejected the request this server built (HTTP ${status}).`,
    {
      reason: 'upstream_rejected_query',
      retryable: false,
      status,
    },
  );
}

// --- Query building ------------------------------------------------------------

function simpleQuery(query: string, fields?: readonly string[]): Record<string, unknown> {
  return {
    simple_query_string: { query, ...(fields ? { fields } : {}), default_operator: 'and' },
  };
}

/** `{ query: { bool: { must?, filter? } } }`, or nothing when there are no clauses. */
function boolQuery(must: readonly unknown[], filter: readonly unknown[]): Record<string, unknown> {
  if (must.length === 0 && filter.length === 0) return {};
  return {
    query: {
      bool: {
        ...(must.length > 0 ? { must } : {}),
        ...(filter.length > 0 ? { filter } : {}),
      },
    },
  };
}

function artworkFilters(params: ArtworkSearchParams): unknown[] {
  const filter: unknown[] = [];
  if (params.artist) {
    filter.push({ match: { artist_titles: { query: params.artist, operator: 'and' } } });
  }
  if (params.artist_id !== undefined) filter.push({ term: { artist_ids: params.artist_id } });
  for (const name of VOCABULARY_FILTERS) {
    const value = params[name];
    if (value) filter.push(vocabularyFilterClause(name, value));
  }
  if (params.year_from !== undefined || params.year_to !== undefined) {
    if (params.year_from !== undefined) {
      filter.push({ range: { date_end: { gte: params.year_from } } });
    }
    if (params.year_to !== undefined) {
      filter.push({ range: { date_start: { lte: params.year_to } } });
    }
    // Keep placeholder-year records from overlapping every range.
    filter.push({ range: { date_start: { gte: YEAR_MIN } } });
    filter.push({ range: { date_end: { lte: YEAR_MAX } } });
  }
  if (params.public_domain_only) filter.push({ term: { is_public_domain: true } });
  if (params.on_view_only) filter.push({ term: { is_on_view: true } });
  if (params.has_image) filter.push({ exists: { field: 'image_id' } });
  return filter;
}

function facetAggregations(facets: readonly FacetName[]): Record<string, unknown> {
  return Object.fromEntries(
    facets.map((name) => [
      name,
      name === 'artist'
        ? {
            terms: { field: 'artist_id', size: FACET_SIZE },
            aggs: { label: { top_hits: { size: 1, _source: ['artist_title'] } } },
          }
        : { terms: { field: VOCABULARY_FIELDS[name], size: FACET_SIZE } },
    ]),
  );
}

function whenFilters(when: ExhibitionWhen): unknown[] {
  switch (when) {
    case 'current':
      return [
        { range: { aic_start_at: { lte: 'now' } } },
        { range: { aic_end_at: { gte: 'now' } } },
      ];
    case 'upcoming':
      return [{ range: { aic_start_at: { gt: 'now' } } }];
    case 'past':
      return [{ range: { aic_end_at: { lt: 'now' } } }];
    case 'any':
      return [];
  }
}

// --- Envelope readers ----------------------------------------------------------

/** Records with a usable integer id; anything else in `data` is skipped. */
function records<T extends { id: unknown }>(envelope: RawEnvelope<T>): T[] {
  return (envelope.data ?? []).filter((raw): raw is T => isRecord(raw) && Number.isInteger(raw.id));
}

function totalOf(envelope: RawEnvelope<unknown>): number {
  const total = envelope.pagination?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : (envelope.data?.length ?? 0);
}

function licenseText(envelope: RawEnvelope<unknown>): string {
  return nonEmpty(envelope.info?.license_text) ?? '';
}

function iiifBase(envelope: RawEnvelope<unknown>): string {
  return nonEmpty(envelope.config?.iiif_url) ?? FALLBACK_IIIF_URL;
}

// --- Normalization -------------------------------------------------------------

function toArtworkSummary(raw: RawArtwork, iiifUrl: string): ArtworkSummary {
  const isPublicDomain = raw.is_public_domain === true;
  return {
    id: raw.id,
    title: htmlField(raw.title) ?? '',
    ...definedOnly({
      artist_display: nonEmpty(raw.artist_display),
      artist_id: Number.isInteger(raw.artist_id) ? (raw.artist_id as number) : undefined,
      date_display: nonEmpty(raw.date_display),
      date_start: plausibleYear(raw.date_start),
      date_end: plausibleYear(raw.date_end),
      medium: nonEmpty(raw.medium_display),
      artwork_type: nonEmpty(raw.artwork_type_title),
      department: nonEmpty(raw.department_title),
      place_of_origin: nonEmpty(raw.place_of_origin),
    }),
    is_public_domain: isPublicDomain,
    is_on_view: raw.is_on_view === true,
    ...definedOnly({
      gallery: nonEmpty(raw.gallery_title),
      image: buildImage(iiifUrl, nonEmpty(raw.image_id), isPublicDomain, raw.thumbnail),
    }),
    web_url: artworkWebUrl(raw.id),
  };
}

function toArtworkDetail(raw: RawArtwork, iiifUrl: string): ArtworkDetail {
  const summary = toArtworkSummary(raw, iiifUrl);
  const altTitles = stringList(raw.alt_titles).map((title) => htmlField(title) ?? title);
  const altImages = stringList(raw.alt_image_ids).map((imageId) => ({
    url: iiifImageUrl(iiifUrl, imageId, 843),
    iiif_info_url: iiifInfoUrl(iiifUrl, imageId),
  }));
  return {
    ...summary,
    ...definedOnly({
      alt_titles: altTitles.length > 0 ? altTitles : undefined,
      date_qualifier: nonEmpty(raw.date_qualifier_title),
      dimensions: nonEmpty(raw.dimensions),
      inscriptions: nonEmpty(raw.inscriptions),
      credit_line: nonEmpty(raw.credit_line),
      copyright_notice: nonEmpty(raw.copyright_notice),
      edition: nonEmpty(raw.edition),
      classification: nonEmpty(raw.classification_title),
      style: nonEmpty(raw.style_title),
      on_loan: nonEmpty(raw.on_loan_display),
      manifest_url: summary.is_public_domain ? manifestUrl(raw.id) : undefined,
      alt_images: altImages.length > 0 ? altImages : undefined,
      description: htmlField(raw.description),
      short_description: htmlField(raw.short_description),
      provenance: nonEmpty(raw.provenance_text),
      exhibition_history: nonEmpty(raw.exhibition_history),
      publication_history: nonEmpty(raw.publication_history),
      catalogue: htmlField(raw.catalogue_display),
    }),
    main_reference_number: nonEmpty(raw.main_reference_number) ?? '',
    artist_ids: integerList(raw.artist_ids),
    styles: stringList(raw.style_titles),
    subjects: stringList(raw.subject_titles),
    materials: stringList(raw.material_titles),
    techniques: stringList(raw.technique_titles),
    themes: stringList(raw.theme_titles),
  };
}

function toRelatedMedia(raw: RawSound): RelatedMedia | undefined {
  const url = nonEmpty(raw?.content);
  if (typeof raw?.id !== 'string' || url === undefined) return;
  return {
    id: raw.id,
    title: htmlField(raw.title) ?? '',
    url,
    ...definedOnly({ type: nonEmpty(raw.type) }),
  };
}

function toAgent(raw: RawAgent): Agent {
  return {
    id: raw.id,
    name: htmlField(raw.title) ?? '',
    ...definedOnly({
      sort_name: nonEmpty(raw.sort_title),
      agent_type: nonEmpty(raw.agent_type_title),
      birth_year: plausibleYear(raw.birth_date),
      death_year: plausibleYear(raw.death_date),
      biography: htmlField(raw.description),
    }),
    alt_names: stringList(raw.alt_titles),
    is_artist: raw.is_artist === true,
  };
}

function toSampleWork(source: Partial<RawArtwork> | undefined): SampleWork[] {
  if (!source || !Number.isInteger(source.id)) return [];
  return [
    {
      id: source.id as number,
      title: htmlField(source.title) ?? '',
      ...definedOnly({ date_display: nonEmpty(source.date_display) }),
    },
  ];
}

function toExhibition(raw: RawExhibition, iiifUrl: string): Exhibition {
  const artworkIds = integerList(raw.artwork_ids);
  const artworkTitles = Array.isArray(raw.artwork_titles) ? raw.artwork_titles : [];
  const paired = artworkTitles.length === artworkIds.length;
  const imageId = nonEmpty(raw.image_id);
  return {
    id: raw.id,
    title: htmlField(raw.title) ?? '',
    ...definedOnly({
      status: nonEmpty(raw.status),
      start: nonEmpty(raw.aic_start_at),
      end: nonEmpty(raw.aic_end_at),
      gallery: nonEmpty(raw.gallery_title),
      summary: htmlField(raw.short_description),
      web_url: nonEmpty(raw.web_url),
      image_url: imageId ? iiifImageUrl(iiifUrl, imageId, 843) : nonEmpty(raw.image_url),
      is_featured: typeof raw.is_featured === 'boolean' ? raw.is_featured : undefined,
    }),
    artwork_count: artworkIds.length,
    artworks: artworkIds.map((id, index) => {
      const title = paired ? htmlField(artworkTitles[index]) : undefined;
      return title === undefined ? { id } : { id, title };
    }),
    artist_ids: integerList(raw.artist_ids),
  };
}

function toAudioGuideStop(raw: RawMobileSound): AudioGuideStop {
  return {
    id: raw.id,
    title: htmlField(raw.title) ?? '',
    ...definedOnly({
      audio_url: nonEmpty(raw.web_url),
      transcript: htmlField(raw.transcript),
    }),
  };
}

function parseFacets(
  aggregations: Record<string, RawAggregation> | undefined,
  facets: readonly FacetName[],
): ArtworkFacets {
  const out: ArtworkFacets = {};
  for (const name of facets) {
    const buckets = aggregations?.[name]?.buckets ?? [];
    if (name === 'artist') {
      out.artist = buckets.map((bucket) => {
        const label = (bucket.label as RawTopHits<{ artist_title?: string | null }> | undefined)
          ?.hits?.hits?.[0]?._source?.artist_title;
        return {
          artist_id: Number(bucket.key),
          count: bucket.doc_count,
          ...definedOnly({ name: nonEmpty(label) }),
        };
      });
    } else {
      out[name] = buckets.map((bucket) => ({ value: String(bucket.key), count: bucket.doc_count }));
    }
  }
  return out;
}

// --- Init / accessor -----------------------------------------------------------

let _service: AicService | undefined;

/** Construct the process-wide service; called from `createApp({ setup })`. */
export function initAicService(options: AicServiceOptions): void {
  _service = new AicService(options);
}

/** The process-wide service; throws when `initAicService()` has not run. */
export function getAicService(): AicService {
  if (!_service) {
    throw new Error('AicService not initialized — call initAicService() in setup()');
  }
  return _service;
}

/** Dispose the process-wide service's pacer; called from `createApp({ teardown })`. */
export function disposeAicService(): void {
  _service?.dispose();
  _service = undefined;
}
