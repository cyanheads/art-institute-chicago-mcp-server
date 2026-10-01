/**
 * @fileoverview Pure helpers shared by the Art Institute service and the tool
 * definitions: input preprocessors for form-client blanks and comma lists,
 * HTML-to-text conversion, markdown-safe rendering of upstream text,
 * constructed IIIF and web URLs, vocabulary filter routing, placeholder-year
 * screening, and search-window paging.
 * @module services/aic/aic-text
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ArtworkImage, ImageRights, RawThumbnail } from './types.js';

// --- Input preprocessing -----------------------------------------------------

/** A blank (empty or whitespace-only) string from a form client means "unset". */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/**
 * Accepts an array or a comma-joined string. String elements are trimmed and
 * blanks dropped, `mapItem` canonicalizes each string element, duplicates are
 * dropped (first occurrence kept), and the list is cut to `max + 1` so an
 * oversized list fails with one bounded `.max()` issue instead of one per element.
 */
export function listInput<T extends z.ZodType>(
  schema: T,
  max: number,
  mapItem: (item: string) => unknown = (item) => item,
) {
  return z.preprocess((value) => {
    const items = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(items)) return value;
    const seen = new Set<unknown>();
    const out: unknown[] = [];
    for (const raw of items) {
      let item: unknown = raw;
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed === '') continue;
        item = mapItem(trimmed);
      }
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length > max) break;
    }
    return out;
  }, schema);
}

/** Maps an artwork id string, or an artic.edu artwork page URL, to its numeric id. */
export function artworkIdItem(item: string): unknown {
  if (/^\d+$/.test(item)) return Number(item);
  const match = /^https?:\/\/(?:www\.)?artic\.edu\/artworks\/(\d+)(?:[/?#].*)?$/i.exec(item);
  return match ? Number(match[1]) : item;
}

/** Maps a numeric id string to a number; anything else passes through to fail validation. */
export function numericIdItem(item: string): unknown {
  return /^\d+$/.test(item) ? Number(item) : item;
}

/**
 * Optional vocabulary filter (department, type, style, subject, classification,
 * place): trimmed, blank → unset, and a `pc-`/`tm-` id prefix upper-cased.
 */
export function vocabularyInput(maxLength: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return;
    return /^(pc|tm)-\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }, z.string().max(maxLength).optional());
}

/** Optional gallery filter: trimmed, blank → unset, a bare number (`240`, `211a`) → `Gallery 240`. */
export function galleryInput(maxLength: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return;
    return /^\d+[a-z]?$/i.test(trimmed) ? `Gallery ${trimmed}` : trimmed;
  }, z.string().max(maxLength).optional());
}

// --- Upstream value normalization --------------------------------------------

/** A string field the upstream left empty (`""`, whitespace) is absent. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** An HTML-bearing upstream field converted to plain text; absent when nothing remains. */
export function htmlField(value: unknown): string | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return;
  const text = htmlToText(raw);
  return text === '' ? undefined : text;
}

/** The non-empty strings of an upstream string array (absent or null → empty). */
export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
}

/** The integers of an upstream number array (absent or null → empty). */
export function integerList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];
}

export const YEAR_MIN = -8000;
export const YEAR_MAX = 2100;

/**
 * A year inside `[-8000, 2100]`, else absent. A handful of records carry
 * placeholder values (`-1824528578`, `5000001`) that would read as facts.
 */
export function plausibleYear(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= YEAR_MIN &&
    value <= YEAR_MAX
    ? value
    : undefined;
}

/** A finite number, else absent. */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keys of `T` whose value type admits `undefined`. */
type MaybeUndefinedKeys<T> = { [K in keyof T]: undefined extends T[K] ? K : never }[keyof T];

/**
 * Drops the keys whose value is `undefined`, typing them as optional — the shape
 * an absent upstream field takes under `exactOptionalPropertyTypes`.
 */
export function definedOnly<T extends Record<string, unknown>>(
  fields: T,
): Omit<T, MaybeUndefinedKeys<T>> & {
  [K in MaybeUndefinedKeys<T>]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Omit<T, MaybeUndefinedKeys<T>> & { [K in MaybeUndefinedKeys<T>]?: Exclude<T[K], undefined> };
}

// --- Character classes built from code points --------------------------------

/** A code point as a regex `\uXXXX` escape, built at runtime so source stays ASCII. */
const esc = (codePoint: number) => `\\u${codePoint.toString(16).padStart(4, '0')}`;

/** Line terminators beyond CR/LF: NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
const EXTRA_LINE_BREAKS = `${esc(0x85)}${esc(0x2028)}${esc(0x2029)}`;

/** Bidi controls: ALM, LRM, RLM, LRE..RLO, LRI..PDI. */
const BIDI_CONTROLS = `${esc(0x61c)}${esc(0x200e)}${esc(0x200f)}${esc(0x202a)}-${esc(0x202e)}${esc(0x2066)}-${esc(0x2069)}`;

/** C1 controls (DEL through APC). */
const C1_CONTROLS = `${esc(0x7f)}-${esc(0x9f)}`;

const LINE_BREAKS = new RegExp(`\\r\\n|[\\r\\n${EXTRA_LINE_BREAKS}]`, 'g');

/** C0 controls except tab (CR/LF are replaced before this runs), C1, bidi. */
const UNSAFE_INLINE = new RegExp(
  `[${esc(0)}-${esc(8)}${esc(0xb)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}]`,
  'g',
);

/** C0 controls except tab and LF, C1, bidi. */
const UNSAFE_BLOCK = new RegExp(
  `[${esc(0)}-${esc(8)}${esc(0xb)}${esc(0xc)}${esc(0xe)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}]`,
  'g',
);

/** Runs of spaces, tabs, and no-break spaces within one line. */
const INLINE_WHITESPACE = new RegExp(`[ \\t${esc(0xa0)}]+`, 'g');

/** Characters a printed URL never carries raw: brackets, whitespace and line breaks, C0, C1, bidi. */
const URL_UNSAFE = new RegExp(
  `[\\[\\]\\s${esc(0)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}]`,
  'g',
);

// --- HTML to text ------------------------------------------------------------

const NAMED_ENTITIES: Record<string, number> = {
  aacute: 0xe1,
  acirc: 0xe2,
  agrave: 0xe0,
  amp: 0x26,
  apos: 0x27,
  aring: 0xe5,
  atilde: 0xe3,
  auml: 0xe4,
  bdquo: 0x201e,
  bull: 0x2022,
  ccedil: 0xe7,
  copy: 0xa9,
  deg: 0xb0,
  eacute: 0xe9,
  ecirc: 0xea,
  egrave: 0xe8,
  emsp: 0x2003,
  ensp: 0x2002,
  euml: 0xeb,
  frac12: 0xbd,
  gt: 0x3e,
  hellip: 0x2026,
  iacute: 0xed,
  icirc: 0xee,
  iexcl: 0xa1,
  iquest: 0xbf,
  iuml: 0xef,
  laquo: 0xab,
  ldquo: 0x201c,
  lsquo: 0x2018,
  lt: 0x3c,
  mdash: 0x2014,
  middot: 0xb7,
  nbsp: 0x20,
  ndash: 0x2013,
  ntilde: 0xf1,
  oacute: 0xf3,
  ocirc: 0xf4,
  oslash: 0xf8,
  ouml: 0xf6,
  quot: 0x22,
  raquo: 0xbb,
  rdquo: 0x201d,
  reg: 0xae,
  rsquo: 0x2019,
  sbquo: 0x201a,
  szlig: 0xdf,
  thinsp: 0x2009,
  times: 0xd7,
  trade: 0x2122,
  uacute: 0xfa,
  ucirc: 0xfb,
  ugrave: 0xf9,
  uuml: 0xfc,
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    let codePoint: number | undefined;
    if (body[0] === '#') {
      codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
    } else {
      codePoint = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    }
    return codePoint !== undefined && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

/**
 * Converts upstream HTML (`<p>`, `<em>`, `<br>`, entities) to plain text:
 * source line breaks are whitespace, `<br>` and block closers become line
 * breaks, other tags are removed, entities decoded, runs of blank lines
 * collapsed, and the result trimmed.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/?(?:li|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '');
  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(INLINE_WHITESPACE, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Rendering upstream text in format() -------------------------------------

/**
 * Upstream text for an inline markdown slot (heading, bold label, list item):
 * line breaks flattened to spaces, `[ ] < >` backslash-escaped, C0/C1 control
 * and bidi control characters stripped.
 */
export function inlineSafe(text: string): string {
  return text
    .replace(LINE_BREAKS, ' ')
    .replace(UNSAFE_INLINE, '')
    .replace(/[[\]<>]/g, '\\$&');
}

/** Upstream free text as a markdown blockquote, line structure kept, controls stripped. */
export function quoteBlock(text: string): string {
  return text
    .replace(LINE_BREAKS, '\n')
    .replace(UNSAFE_BLOCK, '')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * A URL for printing in an inline markdown slot: `[`, `]`, whitespace, line
 * breaks, and control and bidi characters percent-encoded, so an upstream URL
 * cannot break out of its list item. Existing percent-escapes are untouched.
 */
export function printableUrl(url: string): string {
  return url.replace(URL_UNSAFE, (char) => encodeURIComponent(char));
}

// --- Constructed URLs --------------------------------------------------------

export const FALLBACK_IIIF_URL = 'https://www.artic.edu/iiif/2';
export const API_BASE_URL = 'https://api.artic.edu/api/v1';

/** The artwork's public page (301s to the slugged URL). */
export function artworkWebUrl(id: number): string {
  return `https://www.artic.edu/artworks/${id}`;
}

/** IIIF manifest URL; the museum publishes manifests for public-domain works. */
export function manifestUrl(id: number): string {
  return `${API_BASE_URL}/artworks/${id}/manifest.json`;
}

/** IIIF image URL scaled to `width` pixels wide. */
export function iiifImageUrl(iiifUrl: string, imageId: string, width: 843 | 1686): string {
  return `${iiifUrl}/${imageId}/full/${width},/0/default.jpg`;
}

/** IIIF `info.json` URL for an image. */
export function iiifInfoUrl(iiifUrl: string, imageId: string): string {
  return `${iiifUrl}/${imageId}/info.json`;
}

/**
 * The primary image of an artwork: the 843px display URL for any image, the
 * 1686px URL only for public-domain works (in-copyright requests redirect),
 * and the reuse status. The base64 `lqip` thumbnail is never carried.
 */
export function buildImage(
  iiifUrl: string,
  imageId: string | undefined,
  isPublicDomain: boolean,
  thumbnail: RawThumbnail | null | undefined,
): ArtworkImage | undefined {
  if (!imageId) return;
  const rights: ImageRights = isPublicDomain ? 'public_domain' : 'in_copyright';
  const altText = nonEmpty(thumbnail?.alt_text);
  const width = finiteNumber(thumbnail?.width);
  const height = finiteNumber(thumbnail?.height);
  return {
    url: iiifImageUrl(iiifUrl, imageId, 843),
    ...(isPublicDomain && { url_large: iiifImageUrl(iiifUrl, imageId, 1686) }),
    iiif_info_url: iiifInfoUrl(iiifUrl, imageId),
    ...(altText !== undefined && { alt_text: altText }),
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    rights,
  };
}

// --- Vocabulary routing ------------------------------------------------------

/** Vocabularies `artic_lookup_vocabulary` lists, and the keyword field each aggregates. */
export const VOCABULARY_FIELDS = {
  department: 'department_title.keyword',
  artwork_type: 'artwork_type_title.keyword',
  style: 'style_titles.keyword',
  subject: 'subject_titles.keyword',
  classification: 'classification_titles.keyword',
  material: 'material_titles.keyword',
  technique: 'technique_titles.keyword',
  theme: 'theme_titles.keyword',
  place_of_origin: 'place_of_origin.keyword',
  gallery: 'gallery_title.keyword',
} as const;

export type Vocabulary = keyof typeof VOCABULARY_FIELDS;

/** Vocabularies that are also `artic_search_artworks` filters (the parameter shares the name). */
export const VOCABULARY_FILTERS = [
  'department',
  'artwork_type',
  'style',
  'subject',
  'classification',
  'place_of_origin',
  'gallery',
] as const satisfies readonly Vocabulary[];

export type VocabularyFilter = (typeof VOCABULARY_FILTERS)[number];

const ID_ROUTES: Partial<
  Record<VocabularyFilter, { field: string; numeric?: true; pattern: RegExp }>
> = {
  department: { pattern: /^PC-\d+$/, field: 'department_id' },
  artwork_type: { pattern: /^\d+$/, field: 'artwork_type_id', numeric: true },
  style: { pattern: /^TM-\d+$/, field: 'style_ids' },
  subject: { pattern: /^TM-\d+$/, field: 'subject_ids' },
  classification: { pattern: /^TM-\d+$/, field: 'classification_ids' },
};

/**
 * Query clause for one vocabulary filter value. An id (`PC-n`, `TM-n`, an
 * artwork type number) routes to the exact id field; a title matches the
 * keyword field whole, case-insensitively, since the index stores every value
 * as written.
 */
export function vocabularyFilterClause(
  filter: VocabularyFilter,
  value: string,
): Record<string, unknown> {
  const idRoute = ID_ROUTES[filter];
  if (idRoute?.pattern.test(value)) {
    return { term: { [idRoute.field]: idRoute.numeric ? Number(value) : value } };
  }
  return { term: { [VOCABULARY_FIELDS[filter]]: { value, case_insensitive: true } } };
}

/**
 * Lucene `include` regex matching values that contain `text`, ignoring case:
 * each cased letter becomes a `[xX]` class, digits and whitespace stay literal,
 * and every other character is backslash-escaped.
 */
export function containsPattern(text: string): string {
  let pattern = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower !== upper && lower.length === 1 && upper.length === 1) {
      pattern += `[${lower}${upper}]`;
    } else if (/^[\p{L}\p{N}\s]$/u.test(char)) {
      pattern += char;
    } else {
      pattern += `\\${char}`;
    }
  }
  return `.*${pattern}.*`;
}

// --- Paging ------------------------------------------------------------------

/** Anonymous callers reach only `offset + limit <= 1000` of any search. */
export const SEARCH_WINDOW = 1000;

export const WINDOW_NOTICE =
  'Only the first 1,000 matches are reachable; narrow the search with filters to see the rest.';

export interface PageInfo {
  has_more: boolean;
  next_page?: number;
  /** True when matches remain but the next page would cross the 1,000-match window. */
  windowExhausted: boolean;
}

/**
 * Paging state for a page-based search. `next_page` is present only when more
 * matches exist and the next page stays inside the search window. `limit: 0`
 * (counts only) reports `has_more` whenever anything matched.
 */
export function pageInfo(total: number, page: number, limit: number): PageInfo {
  if (limit === 0) return { has_more: total > 0, windowExhausted: false };
  const hasMore = page * limit < total;
  if (!hasMore) return { has_more: false, windowExhausted: false };
  return (page + 1) * limit <= SEARCH_WINDOW
    ? { has_more: true, next_page: page + 1, windowExhausted: false }
    : { has_more: true, windowExhausted: true };
}
