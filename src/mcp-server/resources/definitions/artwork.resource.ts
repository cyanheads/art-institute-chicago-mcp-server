/**
 * @fileoverview `artic://artworks/{id}` — one artwork record as JSON, built
 * through the same path as `artic_get_artworks` with its default sections and
 * related media, alongside the license text and description attribution.
 * @module mcp-server/resources/definitions/artwork.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DEFAULT_SECTIONS, loadArtworkRecords } from '@/services/aic/artwork-records.js';

export const artworkResource = resource('artic://artworks/{id}', {
  name: 'artic-artwork',
  title: 'Artwork record',
  description:
    'Read one Art Institute of Chicago artwork record by id as JSON: the artic_get_artworks record with the description and provenance sections and related media, plus the API license text, the CC BY 4.0 attribution when description text is present, and a notice when related media was capped or could not load.',
  mimeType: 'application/json',
  params: z.object({
    id: z.string().regex(/^\d+$/).describe('Artwork id (digits), from artic_search_artworks.'),
  }),
  cacheHint: { ttlMs: 21_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'artwork_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No artwork has this id.',
      recovery:
        'Find artwork ids with artic_search_artworks, then read artic://artworks/<id> again.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Art Institute API throttled this server and retries ran out, or the shared request queue could not start the call in time.',
      retryable: true,
      recovery:
        'Wait about a minute and retry; the Art Institute API allows about 60 requests per minute from this server, so batch ids into one artic_get_artworks call.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Fetch the record with artic_get_artworks instead; the server built a request the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const id = Number(params.id);
    // Past 2^53 the id no longer survives as a number (a long enough one prints as Infinity).
    if (!Number.isSafeInteger(id)) {
      throw ctx.fail('artwork_not_found', `No artwork exists for id ${params.id}.`);
    }
    const { artworks, license_text, description_attribution, notices } = await loadArtworkRecords(
      { ids: [id], sections: DEFAULT_SECTIONS, include_related_media: true },
      ctx,
    );
    const [artwork] = artworks;
    if (!artwork) throw ctx.fail('artwork_not_found', `No artwork exists for id ${params.id}.`);
    return {
      artwork,
      license_text,
      ...(description_attribution ? { description_attribution } : {}),
      ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
    };
  },
});
