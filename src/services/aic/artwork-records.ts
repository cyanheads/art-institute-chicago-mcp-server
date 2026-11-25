/**
 * @fileoverview Builds `artic_get_artworks` records: the `ids=` batch fetch
 * (primary — its failure fails the call) and the records the artworks link to:
 * `/sounds` and `/texts` media and `/sections` publication links (secondary —
 * each kind's failure degrades to records without it). Shared by the
 * `artic_get_artworks` tool and the `artic://artworks/{id}` resource.
 * @module services/aic/artwork-records
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ArtworkBatchEntry, getAicService } from './aic-service.js';
import type { ArtworkDetail, ArtworkSection } from './types.js';

/** Sections returned when the caller names none. */
export const DEFAULT_SECTIONS: readonly ArtworkSection[] = ['description', 'provenance'];

/** Most artwork ids one call attempts: the `ids=` route's maximum (101 ids are refused). */
export const MAX_ARTWORK_IDS = 100;

/** Most linked ids of one kind loaded per call, across all records: the search page maximum. */
export const MAX_RELATED_MEDIA = 100;

export const DESCRIPTION_ATTRIBUTION =
  "Description text © Art Institute of Chicago, CC BY 4.0 — cite the record's web_url.";

/** Citation the `/sections` license asks for; its envelope's `info.license_text` travels beside it. */
export const PUBLICATION_CITATION =
  "Publication sections © Art Institute of Chicago and third parties, https://www.artic.edu/terms — cite the section's web_url.";

/** Joins kind names for a notice: `a`, `a and b`, `a, b, and c`. */
const KIND_LIST = new Intl.ListFormat('en');

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
  /** Present, with `publication_license_text`, when any returned record carries `publication_sections`. */
  publication_citation?: string;
  /** The `/sections` license statement, verbatim. */
  publication_license_text?: string;
}

/** Fetch the first 100 of `ids` whole and attach the records they link to. */
export async function loadArtworkRecords(
  request: ArtworkRecordsRequest,
  ctx: Context,
): Promise<ArtworkRecordsResult> {
  const attemptedIds = request.ids.slice(0, MAX_ARTWORK_IDS);
  const deferredIds = request.ids.slice(MAX_ARTWORK_IDS);
  const batch = await getAicService().getArtworks(attemptedIds, request.sections, ctx);
  const linked = request.include_related_media
    ? await attachLinkedRecords(batch.entries, ctx)
    : undefined;
  const artworks = linked?.artworks ?? batch.entries.map((entry) => entry.detail);

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
  if (linked) notices.push(...linked.notices);

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
    ...(linked?.publication_license_text !== undefined
      ? {
          publication_license_text: linked.publication_license_text,
          publication_citation: PUBLICATION_CITATION,
        }
      : {}),
  };
}

interface LinkedRecordsResult {
  artworks: ArtworkDetail[];
  /** Which kinds could not load, then which were capped and for which records. */
  notices: string[];
  /** Present when any record carries `publication_sections`. */
  publication_license_text?: string;
}

/**
 * Loads the records the artworks link to, one search per kind that has ids, and
 * attaches each artwork its own: sounds then texts as `related_media`, sections
 * as `publication_sections`. Each is attached only when at least one item
 * loaded, never as an empty list: an artwork whose ids all fell past the cap or
 * came back without a usable URL carries none. The kinds load concurrently, so
 * together they take no longer than one request's deadline; a failed kind
 * degrades alone, and a cancellation rethrows from whichever load meets it first.
 */
async function attachLinkedRecords(
  entries: readonly ArtworkBatchEntry[],
  ctx: Context,
): Promise<LinkedRecordsResult> {
  const service = getAicService();
  const [sounds, sections, texts] = await Promise.all([
    loadLinked(entries, ctx, {
      kind: 'sound recordings',
      idsOf: (entry) => entry.sound_ids,
      load: async (ids) => {
        const { license_text, sounds: items } = await service.getSounds(ids, ctx);
        return { items, license_text };
      },
    }),
    loadLinked(entries, ctx, {
      kind: 'publication sections',
      idsOf: (entry) => entry.section_ids,
      load: async (ids) => {
        const { license_text, sections: items } = await service.getSections(ids, ctx);
        return { items, license_text };
      },
    }),
    loadLinked(entries, ctx, {
      kind: 'text documents',
      idsOf: (entry) => entry.text_ids,
      load: async (ids) => {
        const { license_text, texts: items } = await service.getTexts(ids, ctx);
        return { items, license_text };
      },
    }),
  ]);

  const artworks = entries.map((entry) => {
    const media = [...sounds.itemsOf(entry), ...texts.itemsOf(entry)];
    const publicationSections = sections.itemsOf(entry);
    return {
      ...entry.detail,
      ...(media.length > 0 ? { related_media: media } : {}),
      ...(publicationSections.length > 0 ? { publication_sections: publicationSections } : {}),
    };
  });

  const kinds = [sounds, sections, texts];
  const failed = kinds.filter((kind) => kind.failed).map((kind) => kind.kind);
  const notices: string[] = [];
  if (failed.length > 0) {
    notices.push(
      `The linked ${KIND_LIST.format(failed)} could not be loaded; the artwork records themselves are complete. Call artic_get_artworks again to retry.`,
    );
  }
  for (const { kind, capped } of kinds) {
    if (capped.length === 0) continue;
    notices.push(
      `Linked ${kind} are capped at ${MAX_RELATED_MEDIA} per call; artwork ${capped.join(', ')} is missing some or all of them. Call artic_get_artworks with fewer ids to load them.`,
    );
  }
  return {
    artworks,
    notices,
    ...(artworks.some((artwork) => artwork.publication_sections !== undefined)
      ? { publication_license_text: sections.license_text }
      : {}),
  };
}

/** One kind of record the artworks link to by id. */
interface LinkedKind<Id, Item> {
  idsOf: (entry: ArtworkBatchEntry) => readonly Id[];
  /** The kind as notices name it: a plural noun. */
  kind: string;
  load: (ids: readonly Id[]) => Promise<{ items: readonly Item[]; license_text: string }>;
}

interface LinkedItems<Item> {
  /** Ids of records missing some or all of their items past the cap, in request order. */
  capped: number[];
  /** The load failed, so no record has items of this kind. */
  failed: boolean;
  /** An entry's loaded items, in the order its ids list them. */
  itemsOf: (entry: ArtworkBatchEntry) => Item[];
  kind: string;
  /** The kind's license statement; empty when nothing was loaded. */
  license_text: string;
}

/**
 * Loads the union of the entries' ids of one kind (record order, capped at 100)
 * in one search, or sends nothing when there are none. A failed load is logged
 * and reported as `failed`; cancellation rethrows.
 */
async function loadLinked<Id extends number | string, Item extends { id: Id }>(
  entries: readonly ArtworkBatchEntry[],
  ctx: Context,
  { kind, idsOf, load }: LinkedKind<Id, Item>,
): Promise<LinkedItems<Item>> {
  const union = [...new Set(entries.flatMap(idsOf))];
  const none: LinkedItems<Item> = {
    capped: [],
    failed: false,
    itemsOf: () => [],
    kind,
    license_text: '',
  };
  if (union.length === 0) return none;

  let batch: Awaited<ReturnType<typeof load>>;
  try {
    batch = await load(union.slice(0, MAX_RELATED_MEDIA));
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning(`Linked ${kind} could not be loaded; returning records without them`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...none, failed: true };
  }

  const pastCap = new Set(union.slice(MAX_RELATED_MEDIA));
  const byId = new Map(batch.items.map((item) => [item.id, item]));
  return {
    ...none,
    capped: entries
      .filter((entry) => idsOf(entry).some((id) => pastCap.has(id)))
      .map((entry) => entry.detail.id),
    itemsOf: (entry) => idsOf(entry).flatMap((id) => byId.get(id) ?? []),
    license_text: batch.license_text,
  };
}
