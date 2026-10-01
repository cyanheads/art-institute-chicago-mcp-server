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

/**
 * Records, related media included, stop before their summed wire bytes would pass this: a
 * 100,000-byte response ceiling (about 25k tokens, the default tool-output limit of common
 * clients) less 15,000 held back for the license text, attribution, and notices.
 */
const RECORD_BUDGET_BYTES = 85_000;

const utf8 = new TextEncoder();

/** UTF-8 bytes of `value` serialized as JSON, the form both MCP result surfaces travel in. */
export function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

export const DESCRIPTION_ATTRIBUTION =
  "Description text © Art Institute of Chicago, CC BY 4.0 — cite the record's web_url.";

const RELATED_MEDIA_DEGRADED =
  'Related media could not be loaded; the artwork records are complete. Call artic_get_artworks again to retry related media.';

export interface ArtworkRecordsRequest {
  ids: readonly number[];
  include_related_media: boolean;
  sections: readonly ArtworkSection[];
  /** Bytes one record puts on the caller's wire; the response budget sums it per record. */
  wireBytes: (record: ArtworkDetail) => number;
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

/** Fetch, budget by the caller's wire size, and enrich artwork records for `ids`. */
export async function loadArtworkRecords(
  request: ArtworkRecordsRequest,
  ctx: Context,
): Promise<ArtworkRecordsResult> {
  const batch = await getAicService().getArtworks(request.ids, request.sections, ctx);

  // Media only adds bytes, so the records that fit without it bound those that fit with it:
  // load media for those alone, then cut again with it counted.
  const fitting = withinBudget(batch.entries, (entry) => request.wireBytes(entry.detail));
  const media = request.include_related_media ? await attachRelatedMedia(fitting, ctx) : undefined;
  const artworks = media
    ? withinBudget(media.artworks, request.wireBytes)
    : fitting.map((entry) => entry.detail);
  const deferredIds = batch.entries.slice(artworks.length).map((entry) => entry.detail.id);

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
  if (media?.degraded) notices.push(RELATED_MEDIA_DEGRADED);
  const cappedIds = artworks.filter((artwork) => media?.capped.has(artwork.id)).map((a) => a.id);
  if (cappedIds.length > 0) {
    notices.push(
      `Related media is capped at ${MAX_RELATED_MEDIA} items per call; artwork ${cappedIds.join(', ')} is missing some or all of its related media. Call artic_get_artworks with fewer ids to load it.`,
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

/** The leading items whose summed size stays within the record budget; the first always stays. */
function withinBudget<T>(items: readonly T[], size: (item: T) => number): T[] {
  let bytes = 0;
  const cut = items.findIndex((item, index) => {
    bytes += size(item);
    return index > 0 && bytes > RECORD_BUDGET_BYTES;
  });
  return items.slice(0, cut === -1 ? items.length : cut);
}

interface RelatedMediaResult {
  artworks: ArtworkDetail[];
  /** Records missing some or all of their media past the cap. */
  capped: Set<number>;
  /** The `/sounds` call failed, so no record carries media. */
  degraded: boolean;
}

/**
 * Loads the union of the records' sound ids (record order, capped at 20) in one
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
  if (union.length === 0) return { artworks: details, capped: new Set(), degraded: false };

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
    return { artworks: details, capped: new Set(), degraded: true };
  }

  const loaded = new Set(loadIds);
  const capped = new Set<number>();
  const artworks = entries.map(({ detail, sound_ids }) => {
    const inLoad = sound_ids.filter((id) => loaded.has(id));
    if (inLoad.length < sound_ids.length) capped.add(detail.id);
    const media = inLoad.flatMap((id) => sounds.get(id) ?? []);
    return media.length > 0 ? { ...detail, related_media: media } : detail;
  });
  return { artworks, capped, degraded: false };
}
