/**
 * @fileoverview Pure helpers shared by the Art Institute service and the tool
 * definitions: input preprocessors for form-client blanks and comma lists,
 * HTML-to-text conversion, markdown-safe rendering of upstream text,
 * upstream URL and image-id screening, constructed IIIF and web URLs, search
 * ranking text, vocabulary filter routing, placeholder-year screening, and
 * search-window paging.
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
 * Optional vocabulary filter (every vocabulary but gallery): trimmed, blank →
 * unset, composed to NFC (every stored title is precomposed, so a decomposed
 * spelling matches nothing), and a `pc-`/`tm-` id prefix upper-cased.
 */
export function vocabularyInput(maxLength: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().normalize('NFC');
    if (trimmed === '') return;
    return /^(pc|tm)-\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }, z.string().max(maxLength).optional());
}

/**
 * Optional gallery filter: trimmed, blank → unset, composed to NFC as
 * `vocabularyInput` is, and a bare number (`240`, `211a`) → `Gallery 240`.
 */
export function galleryInput(maxLength: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().normalize('NFC');
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

/**
 * Invisible characters with no rendering role: ZERO WIDTH SPACE, WORD JOINER,
 * and BOM. ZWNJ, ZWJ, and the variation selectors carry meaning in scripts and
 * emoji, so they stay.
 */
const INVISIBLE = `${esc(0x200b)}${esc(0x2060)}${esc(0xfeff)}`;

/** Unicode tag characters (U+E0000–U+E007F), matched as their UTF-16 surrogate pairs. */
const TAG_CHARACTERS = `${esc(0xdb40)}[${esc(0xdc00)}-${esc(0xdc7f)}]`;

const LINE_BREAKS = new RegExp(`\\r\\n|[\\r\\n${EXTRA_LINE_BREAKS}]`, 'g');

/** C0 controls except tab (CR/LF are replaced before this runs), C1, bidi, invisible, tag characters. */
const UNSAFE_INLINE = new RegExp(
  `[${esc(0)}-${esc(8)}${esc(0xb)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}${INVISIBLE}]|${TAG_CHARACTERS}`,
  'g',
);

/** C0 controls except tab and LF, C1, bidi, invisible, tag characters. */
const UNSAFE_BLOCK = new RegExp(
  `[${esc(0)}-${esc(8)}${esc(0xb)}${esc(0xc)}${esc(0xe)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}${INVISIBLE}]|${TAG_CHARACTERS}`,
  'g',
);

/** Runs of spaces, tabs, and no-break spaces within one line. */
const INLINE_WHITESPACE = new RegExp(`[ \\t${esc(0xa0)}]+`, 'g');

/**
 * Characters a printed URL never carries raw: brackets, angle brackets, quotes,
 * backtick, whitespace and line breaks, C0, C1, bidi, invisible, tag characters.
 */
const URL_UNSAFE = new RegExp(
  `[\\[\\]<>"'\`\\s${esc(0)}-${esc(0x1f)}${C1_CONTROLS}${BIDI_CONTROLS}${INVISIBLE}]|${TAG_CHARACTERS}`,
  'g',
);

// --- HTML to text ------------------------------------------------------------

/** A `Map`, so an entity named for an `Object` member (`&constructor;`) finds nothing. */
const NAMED_ENTITIES = new Map<string, number>([
  ['aacute', 0xe1],
  ['acirc', 0xe2],
  ['agrave', 0xe0],
  ['amp', 0x26],
  ['apos', 0x27],
  ['aring', 0xe5],
  ['atilde', 0xe3],
  ['auml', 0xe4],
  ['bdquo', 0x201e],
  ['bull', 0x2022],
  ['ccedil', 0xe7],
  ['copy', 0xa9],
  ['deg', 0xb0],
  ['eacute', 0xe9],
  ['ecirc', 0xea],
  ['egrave', 0xe8],
  ['emsp', 0x2003],
  ['ensp', 0x2002],
  ['euml', 0xeb],
  ['frac12', 0xbd],
  ['gt', 0x3e],
  ['hellip', 0x2026],
  ['iacute', 0xed],
  ['icirc', 0xee],
  ['iexcl', 0xa1],
  ['iquest', 0xbf],
  ['iuml', 0xef],
  ['laquo', 0xab],
  ['ldquo', 0x201c],
  ['lsquo', 0x2018],
  ['lt', 0x3c],
  ['mdash', 0x2014],
  ['middot', 0xb7],
  ['nbsp', 0x20],
  ['ndash', 0x2013],
  ['ntilde', 0xf1],
  ['oacute', 0xf3],
  ['ocirc', 0xf4],
  ['oslash', 0xf8],
  ['ouml', 0xf6],
  ['quot', 0x22],
  ['raquo', 0xbb],
  ['rdquo', 0x201d],
  ['reg', 0xae],
  ['rsquo', 0x2019],
  ['sbquo', 0x201a],
  ['szlig', 0xdf],
  ['thinsp', 0x2009],
  ['times', 0xd7],
  ['trade', 0x2122],
  ['uacute', 0xfa],
  ['ucirc', 0xfb],
  ['ugrave', 0xf9],
  ['uuml', 0xfc],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    let codePoint: number | undefined;
    if (body[0] === '#') {
      codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
    } else {
      codePoint = NAMED_ENTITIES.get(body) ?? NAMED_ENTITIES.get(body.toLowerCase());
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
 * collapsed, and the result trimmed. Tags are stripped before entities are
 * decoded, so `&lt;b&gt;` stays the text `<b>`; the markdown sinks escape it.
 *
 * Every pattern runs in linear time on unterminated markup: an unclosed
 * comment runs to the end of the text, a tag ends at the first `<` or `>`, and
 * a whitespace run is matched once, then collapsed only when it holds a line break.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\s+/g, (run) => (/[\r\n]/.test(run) ? ' ' : run))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/?(?:li|ul|ol)\b[^<>]*>/gi, '\n')
    .replace(/<\/?[a-z][^<>]*>/gi, '');
  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(INLINE_WHITESPACE, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Rendering upstream text in format() -------------------------------------

/** A backslash run, or one of the characters that open link, image, and HTML syntax. */
const MARKUP = /\\+|[[\]<>]/g;

/**
 * Backslash-escapes `[`, `]`, `<`, and `>`, so link, image, and HTML syntax
 * renders as text. A backslash run directly in front of one is doubled, so it
 * cannot cancel the escape; other backslashes, and `(`, `)`, `!`, and
 * backticks, stay as written.
 */
function escapeMarkup(text: string): string {
  return text.replace(MARKUP, (match: string, offset: number) => {
    if (match[0] !== '\\') return `\\${match}`;
    return /[[\]<>]/.test(text.charAt(offset + match.length)) ? match + match : match;
  });
}

/**
 * Upstream text for an inline markdown slot (heading, bold label, list item):
 * line breaks flattened to spaces, C0/C1 control, bidi control, and invisible
 * characters stripped, and `[ ] < >` backslash-escaped.
 */
export function inlineSafe(text: string): string {
  return escapeMarkup(text.replace(LINE_BREAKS, ' ').replace(UNSAFE_INLINE, ''));
}

/**
 * Upstream free text as a markdown blockquote: line structure kept, control,
 * bidi, and invisible characters stripped, and `[ ] < >` backslash-escaped.
 */
export function quoteBlock(text: string): string {
  return escapeMarkup(text.replace(LINE_BREAKS, '\n').replace(UNSAFE_BLOCK, ''))
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * A URL for printing in an inline markdown slot: brackets, angle brackets,
 * quotes, backticks, whitespace, line breaks, and control, bidi, and invisible
 * characters percent-encoded, so an upstream URL cannot break out of its list
 * item or carry markup. Existing percent-escapes are untouched. Parentheses
 * stay: a printed URL never sits inside a markdown link target.
 */
export function printableUrl(url: string): string {
  return url.replace(URL_UNSAFE, (char) => (char === "'" ? '%27' : encodeURIComponent(char)));
}

// --- Constructed URLs --------------------------------------------------------

export const FALLBACK_IIIF_URL = 'https://www.artic.edu/iiif/2';
export const API_BASE_URL = 'https://api.artic.edu/api/v1';

/** The host the API's envelope reports for IIIF today, which the built-in base shares. */
const IIIF_HOST = new URL(FALLBACK_IIIF_URL).host;

/** The uuid shape of the API's `image_id` and `alt_image_ids` values. */
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An upstream URL kept as received when its scheme is `http:` or `https:`; anything else is absent. */
export function httpUrl(value: unknown): string | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return;
  const protocol = URL.parse(raw)?.protocol;
  return protocol === 'http:' || protocol === 'https:' ? raw : undefined;
}

/**
 * The envelope's IIIF base, kept as received when it is `https:` on the
 * museum's IIIF host; anything else, or no base, is the built-in base.
 */
export function iiifBaseUrl(value: unknown): string {
  const raw = nonEmpty(value);
  if (raw === undefined) return FALLBACK_IIIF_URL;
  const url = URL.parse(raw);
  return url?.protocol === 'https:' && url.host === IIIF_HOST ? raw : FALLBACK_IIIF_URL;
}

/** An upstream image id in the API's uuid shape; anything else is absent and builds no URL. */
export function iiifImageId(value: unknown): string | undefined {
  return typeof value === 'string' && IMAGE_ID.test(value) ? value : undefined;
}

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

// --- Search ranking text -----------------------------------------------------

/** Word breaks for `rankingText`: whitespace, and NUL, which the API trims from the ends of `q`. */
const WORD_BREAKS = new RegExp(`[\\s${esc(0)}]+`);

/** A `q` the API reads as a color search: `#` and exactly six hex digits. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The text a search sends as `q`, the API's ranking input, beside its must
 * clause; `''` means send no `q`. The API makes three things in `q` required
 * over fewer fields than the must clause searches, which would cut the total:
 * a `"`-quoted segment (an unterminated quote runs to the end), a
 * space-separated word whose first character is an ASCII digit, and a `q` that
 * is exactly `#` and six hex digits (a color search). So quotes become word
 * breaks, digit-led words are dropped, the remaining words are joined with
 * single spaces, and a color-shaped remainder sends nothing. Every other
 * operator in `q` only ranks and stays.
 */
export function rankingText(query: string): string {
  const text = query
    .replaceAll('"', ' ')
    .split(WORD_BREAKS)
    .filter((word) => word !== '' && !/^[0-9]/.test(word))
    .join(' ');
  return HEX_COLOR.test(text) ? '' : text;
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

/**
 * Every vocabulary, each also the `artic_search_artworks` filter of the same
 * name, in the field table's order (the order filter clauses are sent in).
 */
export const VOCABULARY_FILTERS = [
  'department',
  'artwork_type',
  'style',
  'subject',
  'classification',
  'material',
  'technique',
  'theme',
  'place_of_origin',
  'gallery',
] as const satisfies readonly Vocabulary[];

const ID_ROUTES: Partial<Record<Vocabulary, { field: string; numeric?: true; pattern: RegExp }>> = {
  department: { pattern: /^PC-\d+$/, field: 'department_id' },
  artwork_type: { pattern: /^\d+$/, field: 'artwork_type_id', numeric: true },
  style: { pattern: /^TM-\d+$/, field: 'style_ids' },
  subject: { pattern: /^TM-\d+$/, field: 'subject_ids' },
  classification: { pattern: /^TM-\d+$/, field: 'classification_ids' },
};

/**
 * The `[xX]` class of a letter with one-character lower and upper forms, plus
 * the letter itself when it is neither (a title-case letter such as `ǅ`), so
 * the class always matches the letter as written; `undefined` for any other
 * character.
 */
function casePairClass(char: string): string | undefined {
  const lower = char.toLowerCase();
  const upper = char.toUpperCase();
  if (lower === upper || lower.length !== 1 || upper.length !== 1) return;
  return `[${lower}${upper}${char === lower || char === upper ? '' : char}]`;
}

/** A character as a Lucene regex literal: letters, digits, and whitespace as-is, anything else backslash-escaped. */
function regexLiteral(char: string): string {
  return /^[\p{L}\p{N}\s]$/u.test(char) ? char : `\\${char}`;
}

/**
 * Query clause for one vocabulary filter value. An id (`PC-n`, `TM-n`, an
 * artwork type number) routes to the exact id field. A title matches the
 * keyword field whole, since the index stores every value as written, through
 * `term` with `case_insensitive`, which folds ASCII letters only; a title
 * holding a non-ASCII cased letter goes as a `regexp` instead, that letter as
 * its `[xX]` class and every other character literal. `place_of_origin` always
 * sends `term`: its index folds case and accents itself.
 */
export function vocabularyFilterClause(filter: Vocabulary, value: string): Record<string, unknown> {
  const idRoute = ID_ROUTES[filter];
  if (idRoute?.pattern.test(value)) {
    return { term: { [idRoute.field]: idRoute.numeric ? Number(value) : value } };
  }
  const field = VOCABULARY_FIELDS[filter];
  const chars = [...value];
  const pairs = chars.map((char) => (char.charCodeAt(0) > 0x7f ? casePairClass(char) : undefined));
  if (filter === 'place_of_origin' || pairs.every((pair) => pair === undefined)) {
    return { term: { [field]: { value, case_insensitive: true } } };
  }
  const pattern = chars.map((char, index) => pairs[index] ?? regexLiteral(char)).join('');
  return { regexp: { [field]: { value: pattern, case_insensitive: true } } };
}

/**
 * Each ASCII letter, in either case, mapped to its `contains` class: both cases
 * plus every precomposed letter in U+00C0–U+024F and U+1E00–U+1EFF whose
 * canonical decomposition is that letter with marks, runs of three or more
 * code points written as ranges. No two letters' classes share a character,
 * which keeps the include regex's automaton as small as the text: one accented
 * range shared by every class lets a 25-letter `contains` pass the search
 * backend's determinization limit.
 */
const FOLDED_LETTER_CLASSES: ReadonlyMap<string, string> = (() => {
  const members = new Map<string, number[]>();
  for (const [from, to] of [
    [0x41, 0x24f],
    [0x1e00, 0x1eff],
  ] as const) {
    for (let code = from; code <= to; code++) {
      const base = /^([A-Za-z])\p{M}*$/u.exec(String.fromCodePoint(code).normalize('NFD'))?.[1];
      if (base) members.set(base.toLowerCase(), [...(members.get(base.toLowerCase()) ?? []), code]);
    }
  }
  const classes = new Map<string, string>();
  for (const [letter, codes] of members) {
    let body = '';
    for (let start = 0; start < codes.length; ) {
      let end = start;
      while (codes[end + 1] === (codes[end] ?? 0) + 1) end++;
      const run = codes.slice(start, end + 1).map((code) => String.fromCodePoint(code));
      body += run.length >= 3 ? `${run[0]}-${run.at(-1)}` : run.join('');
      start = end + 1;
    }
    classes.set(letter, `[${body}]`).set(letter.toUpperCase(), `[${body}]`);
  }
  return classes;
})();

/** Combining marks following an ASCII letter: the accents `contains` ignores. */
const ASCII_LETTER_MARKS = /([A-Za-z])\p{M}+/gu;

/**
 * Lucene `include` regex matching values that contain `text`, ignoring case
 * and accents. Accents on ASCII letters are dropped (`côte` reads as `cote`),
 * and each ASCII letter becomes the class of its cases and accented forms, so
 * `e` also matches `é` or `Ẽ` in that position, never another letter. Any other
 * cased letter becomes its `[xX]` class, digits and whitespace stay literal,
 * and every other character is backslash-escaped.
 */
export function containsPattern(text: string): string {
  const folded = text.normalize('NFD').replace(ASCII_LETTER_MARKS, '$1').normalize('NFC');
  let pattern = '';
  for (const char of folded) {
    pattern += FOLDED_LETTER_CLASSES.get(char) ?? casePairClass(char) ?? regexLiteral(char);
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
