/**
 * @fileoverview Builds `artic_get_artworks` records: the `ids=` batch fetch
 * (primary — its failure fails the call) and related `/sounds` media
 * (secondary — its failure degrades to records without it). Shared by the
 * `artic_get_artworks` tool and the `artic://artworks/{id}` resource.
 * @module services/aic/artwork-records
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ArtworkBatchEntry, getAicService } from './aic-service.js';
import type { ArtworkDetail, ArtworkSection, RelatedMedia } from './types.js';

/** Sections returned when the caller names none. */
export const DEFAULT_SECTIONS: readonly ArtworkSection[] = ['description', 'provenance'];

/** Most artwork ids one call attempts: the `ids=` route's maximum (101 ids are refused). */
export const MAX_ARTWORK_IDS = 100;

/** Most `/sounds` ids loaded per call, across all records: the sounds search's page maximum. */
export const MAX_RELATED_MEDIA = 100;

export const DESCRIPTION_ATTRIBUTION =
  "Description text © Art Institute of Chicago, CC BY 4.0 — cite the record's web_url.";

const RELATED_MEDIA_DEGRADED =
  'Related media could not be loaded; the artwork records are complete. Call artic_get_artworks again to retry related media.';

export interface ArtworkRecordsRequest {
  ids: readonly number[];
  include_related_media: boolean;
  sections: readonly ArtworkSection[];
}

export interface ArtworkRecordsResult {
  /** Found records, in request order. */
  artworks: ArtworkDetail[];
  /** Unattempted ids past the first 100, in request order. */
  deferred_ids: number[];
  /** Present when any returned record carries description text (CC BY 4.0). */
  description_attribution?: string;
  license_text: string;
  /** Attempted ids the API does not have, in request order. */
  missing_ids: number[];
  /** Agent-facing notice fragments, in the order they apply; join with a space. */
  notices: string[];
}

/** Fetch the first 100 of `ids` whole and attach their related media. */
export async function loadArtworkRecords(
  request: ArtworkRecordsRequest,
  ctx: Context,
): Promise<ArtworkRecordsResult> {
  const attemptedIds = request.ids.slice(0, MAX_ARTWORK_IDS);
  const deferredIds = request.ids.slice(MAX_ARTWORK_IDS);
  const batch = await getAicService().getArtworks(attemptedIds, request.sections, ctx);
  const media = request.include_related_media
    ? await attachRelatedMedia(batch.entries, ctx)
    : undefined;
  const artworks = media?.artworks ?? batch.entries.map((entry) => entry.detail);

  const notices: string[] = [];
  if (batch.entries.length === 0) {
    notices.push('None of the attempted ids exist. Find ids with artic_search_artworks.');
  } else if (batch.missing_ids.length > 0) {
    notices.push(
      `No artwork exists for id ${batch.missing_ids.join(', ')}; find ids with artic_search_artworks.`,
    );
  }
  if (deferredIds.length > 0) {
    notices.push(
      `The first ${MAX_ARTWORK_IDS} ids were attempted; call artic_get_artworks again with deferred_ids for the rest.`,
    );
  }
  if (media?.degraded) notices.push(RELATED_MEDIA_DEGRADED);
  if (media && media.capped.length > 0) {
    notices.push(
      `Related media is capped at ${MAX_RELATED_MEDIA} items per call; artwork ${media.capped.join(', ')} is missing some or all of its related media. Call artic_get_artworks with fewer ids to load it.`,
    );
  }

  const hasDescription = artworks.some(
    (artwork) => artwork.description !== undefined || artwork.short_description !== undefined,
  );
  return {
    artworks,
    deferred_ids: deferredIds,
    ...(hasDescription ? { description_attribution: DESCRIPTION_ATTRIBUTION } : {}),
    license_text: batch.license_text,
    missing_ids: batch.missing_ids,
    notices,
  };
}

interface RelatedMediaResult {
  artworks: ArtworkDetail[];
  /** Ids of records missing some or all of their media past the cap, in request order. */
  capped: number[];
  /** The `/sounds` call failed, so no record carries media. */
  degraded: boolean;
}

/**
 * Loads the union of the records' sound ids (record order, capped at 100) in one
 * call and attaches each record's media. `related_media` is attached only when
 * at least one item loaded, never as an empty list: a record whose sound ids all
 * fell past the cap or came back without a usable asset URL carries none. A
 * failed load degrades to the records without media. Cancellation rethrows.
 */
async function attachRelatedMedia(
  entries: readonly ArtworkBatchEntry[],
  ctx: Context,
): Promise<RelatedMediaResult> {
  const details = entries.map((entry) => entry.detail);
  const union = [...new Set(entries.flatMap((entry) => entry.sound_ids))];
  if (union.length === 0) return { artworks: details, capped: [], degraded: false };

  const loadIds = union.slice(0, MAX_RELATED_MEDIA);
  let sounds: Map<string, RelatedMedia>;
  try {
    const result = await getAicService().getSounds(loadIds, ctx);
    sounds = new Map(result.sounds.map((sound) => [sound.id, sound]));
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Related media could not be loaded; returning records without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { artworks: details, capped: [], degraded: true };
  }

  const loaded = new Set(loadIds);
  const capped: number[] = [];
  const artworks = entries.map(({ detail, sound_ids }) => {
    const inLoad = sound_ids.filter((id) => loaded.has(id));
    if (inLoad.length < sound_ids.length) capped.push(detail.id);
    const media = inLoad.flatMap((id) => sounds.get(id) ?? []);
    return media.length > 0 ? { ...detail, related_media: media } : detail;
  });
  return { artworks, capped, degraded: false };
}
