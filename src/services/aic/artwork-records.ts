/**
 * @fileoverview Builds `artic_get_artworks` records: the `ids=` batch fetch
 * (primary — its failure fails the call), the response budget, and related
 * `/sounds` media (secondary — its failure degrades to records without it).
 * Shared by the `artic_get_artworks` tool and the `artic://artworks/{id}` resource.
 * @module services/aic/artwork-records
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ArtworkBatchEntry, getAicService } from './aic-service.js';
import type { ArtworkDetail, ArtworkSection, RelatedMedia } from './types.js';

/** Sections returned when the caller names none. */
export const DEFAULT_SECTIONS: readonly ArtworkSection[] = ['description', 'provenance'];

/** Most `/sounds` ids loaded per call, across all records. */
const MAX_RELATED_MEDIA = 20;

/** Records past this much cumulative serialized text are deferred to a follow-up call. */
const RESPONSE_BUDGET_CHARS = 200_000;

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
  /** Records in request order, cut at the response budget. */
  artworks: ArtworkDetail[];
  /** Found ids left out by the response budget, in request order. */
  deferred_ids: number[];
  /** Present when any returned record carries description text (CC BY 4.0). */
  description_attribution?: string;
  license_text: string;
  /** Requested ids the API does not have, in request order. */
  missing_ids: number[];
  /** Agent-facing notice fragments, in the order they apply; join with a space. */
  notices: string[];
}

/** Fetch, budget, and enrich artwork records for `ids`. */
export async function loadArtworkRecords(
  request: ArtworkRecordsRequest,
  ctx: Context,
): Promise<ArtworkRecordsResult> {
  const batch = await getAicService().getArtworks(request.ids, request.sections, ctx);

  const kept: ArtworkBatchEntry[] = [];
  const deferredIds: number[] = [];
  let chars = 0;
  for (const entry of batch.entries) {
    if (chars > RESPONSE_BUDGET_CHARS) {
      deferredIds.push(entry.detail.id);
      continue;
    }
    kept.push(entry);
    chars += JSON.stringify(entry.detail).length;
  }

  const notices: string[] = [];
  if (batch.entries.length === 0) {
    notices.push('None of these ids exist. Find ids with artic_search_artworks.');
  } else if (batch.missing_ids.length > 0) {
    notices.push(
      `No artwork exists for id ${batch.missing_ids.join(', ')}; find ids with artic_search_artworks.`,
    );
  }
  if (deferredIds.length > 0) {
    notices.push(
      `The response budget was reached; call artic_get_artworks again with ids ${deferredIds.join(', ')} (or fewer sections) for the rest.`,
    );
  }

  const artworks = request.include_related_media
    ? await attachRelatedMedia(kept, notices, ctx)
    : kept.map((entry) => entry.detail);

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

/**
 * Loads the union of the records' sound ids (record order, capped at 20) in one
 * call and attaches each record's media. `related_media` is attached only when
 * at least one item loaded, never as an empty list: a record whose sound ids all
 * fell past the cap (named in a notice) or came back without a usable asset URL
 * carries none. A failed load degrades: no record carries related media, and a
 * notice says how to retry. Cancellation rethrows.
 */
async function attachRelatedMedia(
  entries: readonly ArtworkBatchEntry[],
  notices: string[],
  ctx: Context,
): Promise<ArtworkDetail[]> {
  const union = [...new Set(entries.flatMap((entry) => entry.sound_ids))];
  if (union.length === 0) return entries.map((entry) => entry.detail);

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
    notices.push(RELATED_MEDIA_DEGRADED);
    return entries.map((entry) => entry.detail);
  }

  const loaded = new Set(loadIds);
  const capped: number[] = [];
  const artworks = entries.map(({ detail, sound_ids }) => {
    if (sound_ids.length === 0) return detail;
    const inLoad = sound_ids.filter((id) => loaded.has(id));
    if (inLoad.length < sound_ids.length) capped.push(detail.id);
    const media = inLoad.flatMap((id) => sounds.get(id) ?? []);
    return media.length > 0 ? { ...detail, related_media: media } : detail;
  });
  if (capped.length > 0) {
    notices.push(
      `Related media is capped at ${MAX_RELATED_MEDIA} items per call; artwork ${capped.join(', ')} is missing some or all of its related media. Call artic_get_artworks with fewer ids to load it.`,
    );
  }
  return artworks;
}
