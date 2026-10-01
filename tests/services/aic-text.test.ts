/**
 * @fileoverview Tests for the pure Art Institute text helpers: input
 * preprocessors, upstream value normalizers, HTML-to-text, markdown-safe
 * rendering, constructed URLs, vocabulary routing, and search-window paging.
 * @module tests/services/aic-text.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  artworkIdItem,
  artworkWebUrl,
  blankAsUnset,
  buildImage,
  containsPattern,
  definedOnly,
  FALLBACK_IIIF_URL,
  finiteNumber,
  galleryInput,
  htmlField,
  htmlToText,
  iiifImageUrl,
  iiifInfoUrl,
  inlineSafe,
  integerList,
  listInput,
  manifestUrl,
  nonEmpty,
  numericIdItem,
  pageInfo,
  plausibleYear,
  printableUrl,
  quoteBlock,
  SEARCH_WINDOW,
  stringList,
  VOCABULARY_FIELDS,
  vocabularyFilterClause,
  vocabularyInput,
  WINDOW_NOTICE,
} from '@/services/aic/aic-text.js';

const IIIF = 'https://www.artic.edu/iiif/2';

/** A string built from code points, keeping control characters out of the source text. */
const chars = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

describe('blankAsUnset', () => {
  const optionalText = blankAsUnset(z.string().max(5).optional());

  it.each(['', ' ', '   ', '\t\n', ' '.trim()])('reads %j as unset', (blank) => {
    expect(optionalText.parse(blank)).toBeUndefined();
  });

  it('passes a populated string through untouched', () => {
    expect(optionalText.parse(' ab ')).toBe(' ab ');
  });

  it('applies the field default when the input is blank', () => {
    expect(blankAsUnset(z.number().int().default(10)).parse('')).toBe(10);
    expect(blankAsUnset(z.number().int().default(10)).parse('   ')).toBe(10);
    expect(blankAsUnset(z.boolean().default(false)).parse('')).toBe(false);
  });

  it('reads a blank on an optional number or array as unset', () => {
    expect(blankAsUnset(z.number().int().optional()).parse('')).toBeUndefined();
    expect(blankAsUnset(z.array(z.string()).optional()).parse('')).toBeUndefined();
  });

  it('does not coerce non-blank values', () => {
    expect(blankAsUnset(z.number().optional()).safeParse('7').success).toBe(false);
    expect(blankAsUnset(z.number().optional()).parse(0)).toBe(0);
    expect(blankAsUnset(z.boolean().optional()).parse(false)).toBe(false);
  });

  it('still enforces the wrapped schema on populated input', () => {
    expect(optionalText.safeParse('toolong').success).toBe(false);
  });
});

describe('listInput', () => {
  const ids = listInput(z.array(z.number().int().positive()).min(1).max(10), 10, artworkIdItem);
  const tags = listInput(z.array(z.string()).max(3), 3);

  it('splits a comma string, trims, and drops blanks', () => {
    expect(tags.parse(' a , b,, ,c')).toEqual(['a', 'b', 'c']);
  });

  it('accepts an array and trims and de-blanks its string elements', () => {
    expect(tags.parse([' a', '', '  ', 'b '])).toEqual(['a', 'b']);
  });

  it('drops duplicates, keeping the first occurrence', () => {
    expect(tags.parse('b,a,b,a')).toEqual(['b', 'a']);
  });

  it('dedupes after mapping, so equivalent spellings collapse', () => {
    expect(ids.parse('7,07,007')).toEqual([7]);
    expect(ids.parse(['7', 7])).toEqual([7]);
    expect(ids.parse('7,https://www.artic.edu/artworks/7/some-slug')).toEqual([7]);
  });

  it('cuts to max + 1 so an oversized list fails with one bounded issue', () => {
    const result = ids.safeParse(Array.from({ length: 500 }, (_, i) => String(i + 1)));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it('keeps a list of exactly max items valid', () => {
    expect(ids.parse(Array.from({ length: 10 }, (_, i) => i + 1))).toHaveLength(10);
  });

  it('cuts after deduplication, so duplicates do not count toward the cap', () => {
    const many = [
      ...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array.from({ length: 10 }, (_, i) => i + 1),
    ];
    expect(ids.parse(many)).toHaveLength(10);
  });

  it('an empty list fails the min constraint rather than reading as unset', () => {
    expect(ids.safeParse('').success).toBe(false);
    expect(ids.safeParse([' ', '']).success).toBe(false);
  });

  it('lets non-list input reach the schema unchanged', () => {
    expect(ids.safeParse(5).success).toBe(false);
    expect(ids.safeParse(undefined).success).toBe(false);
    expect(listInput(z.array(z.string()).optional(), 3).parse(undefined)).toBeUndefined();
  });

  it('leaves non-string elements to the schema', () => {
    expect(ids.parse([3, '4'])).toEqual([3, 4]);
    expect(ids.safeParse([null, 4]).success).toBe(false);
  });

  it('fails validation for ids that are neither numeric nor an artwork URL', () => {
    expect(ids.safeParse('abc').success).toBe(false);
    expect(ids.safeParse('12abc').success).toBe(false);
    expect(ids.safeParse('-5').success).toBe(false);
    expect(ids.safeParse('0').success).toBe(false);
  });
});

describe('artworkIdItem', () => {
  it.each([
    ['27992', 27992],
    ['007', 7],
    ['https://www.artic.edu/artworks/27992', 27992],
    ['https://www.artic.edu/artworks/27992/a-sunday-on-la-grande-jatte', 27992],
    ['http://artic.edu/artworks/27992/slug?x=1#frag', 27992],
    ['HTTPS://WWW.ARTIC.EDU/artworks/5', 5],
  ])('maps %s to %s', (input, expected) => {
    expect(artworkIdItem(input)).toBe(expected);
  });

  it.each([
    'https://www.artic.edu/artists/27992',
    'https://example.com/artworks/27992',
    'https://www.artic.edu/artworks/',
    'https://www.artic.edu/artworks/abc',
    'https://www.artic.edu.evil.test/artworks/5',
    '1.5',
    '',
  ])('passes %j through to fail validation', (input) => {
    expect(artworkIdItem(input)).toBe(input);
  });
});

describe('numericIdItem', () => {
  it('maps digit strings to numbers and leaves the rest', () => {
    expect(numericIdItem('42')).toBe(42);
    expect(numericIdItem('42x')).toBe('42x');
    expect(numericIdItem('-1')).toBe('-1');
  });
});

describe('vocabularyInput', () => {
  const field = vocabularyInput(20);

  it.each([
    ['pc-10', 'PC-10'],
    ['PC-10', 'PC-10'],
    ['Pc-10', 'PC-10'],
    ['tm-123', 'TM-123'],
    ['  tm-123  ', 'TM-123'],
  ])('upper-cases the id prefix: %j -> %j', (input, expected) => {
    expect(field.parse(input)).toBe(expected);
  });

  it.each(['pc-', 'pc-10x', 'tm10', 'pcx-10', 'Prints and Drawings', 'xtm-5'])(
    'leaves %j alone',
    (input) => {
      expect(field.parse(input)).toBe(input);
    },
  );

  it('trims titles', () => {
    expect(field.parse('  Prints  ')).toBe('Prints');
  });

  it('reads blank as unset and absent as unset', () => {
    expect(field.parse('')).toBeUndefined();
    expect(field.parse('   ')).toBeUndefined();
    expect(field.parse(undefined)).toBeUndefined();
  });

  it('enforces the max length after trimming', () => {
    expect(field.safeParse('x'.repeat(20)).success).toBe(true);
    expect(field.safeParse(`  ${'x'.repeat(20)}  `).success).toBe(true);
    expect(field.safeParse('x'.repeat(21)).success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(field.safeParse(5).success).toBe(false);
  });
});

describe('galleryInput', () => {
  const field = galleryInput(30);

  it.each([
    ['240', 'Gallery 240'],
    ['211a', 'Gallery 211a'],
    ['211A', 'Gallery 211A'],
    [' 7 ', 'Gallery 7'],
  ])('expands a bare number: %j -> %j', (input, expected) => {
    expect(field.parse(input)).toBe(expected);
  });

  it.each(['Gallery 240', 'gallery 240', '2a3', '12ab', 'Ryerson Library'])(
    'leaves %j alone',
    (input) => {
      expect(field.parse(input)).toBe(input);
    },
  );

  it('reads blank as unset', () => {
    expect(field.parse('')).toBeUndefined();
    expect(field.parse('  ')).toBeUndefined();
  });

  it('enforces the max length on the expanded value', () => {
    expect(galleryInput(13).safeParse('12345').success).toBe(true);
    expect(galleryInput(13).safeParse('123456').success).toBe(false);
  });
});

describe('upstream value normalizers', () => {
  it('nonEmpty maps empty and whitespace-only strings and non-strings to absent', () => {
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty('  \n')).toBeUndefined();
    expect(nonEmpty(null)).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty(5)).toBeUndefined();
    expect(nonEmpty(' kept as received ')).toBe(' kept as received ');
  });

  it('htmlField converts markup and is absent when nothing remains', () => {
    expect(htmlField('<p>Hello <em>there</em></p>')).toBe('Hello there');
    expect(htmlField('<p></p>')).toBeUndefined();
    expect(htmlField('<br/>')).toBeUndefined();
    expect(htmlField('&nbsp;')).toBeUndefined();
    expect(htmlField('')).toBeUndefined();
    expect(htmlField(null)).toBeUndefined();
  });

  it('stringList keeps non-empty strings and tolerates absent or null', () => {
    expect(stringList(['a', '', '  ', 'b', 3, null])).toEqual(['a', 'b']);
    expect(stringList(null)).toEqual([]);
    expect(stringList(undefined)).toEqual([]);
    expect(stringList('a')).toEqual([]);
  });

  it('integerList keeps integers only', () => {
    expect(integerList([1, 2.5, '3', null, Number.NaN, -4, 0])).toEqual([1, -4, 0]);
    expect(integerList(null)).toEqual([]);
    expect(integerList({})).toEqual([]);
  });

  it('finiteNumber rejects NaN, infinities, and non-numbers', () => {
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-1.5)).toBe(-1.5);
    expect(finiteNumber(Number.NaN)).toBeUndefined();
    expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(finiteNumber('5')).toBeUndefined();
    expect(finiteNumber(null)).toBeUndefined();
  });

  it('definedOnly drops undefined and keeps every other falsy value', () => {
    const out = definedOnly({ a: undefined, b: null, c: 0, d: '', e: false, f: 'x' });
    expect(out).toEqual({ b: null, c: 0, d: '', e: false, f: 'x' });
    expect(Object.keys(out)).not.toContain('a');
  });
});

describe('plausibleYear', () => {
  it.each([
    [-8000, -8000],
    [-7999, -7999],
    [0, 0],
    [1890, 1890],
    [2100, 2100],
  ])('keeps %s', (input, expected) => {
    expect(plausibleYear(input)).toBe(expected);
  });

  it.each([
    -8001,
    2101,
    -1_824_528_578,
    5_000_001,
    1_486_490,
    1.5,
    Number.NaN,
    '1890',
    null,
    undefined,
  ])('treats %s as absent', (input) => {
    expect(plausibleYear(input)).toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('turns paragraph closers into one blank line and trims', () => {
    expect(htmlToText('<p>First.</p><p>Second.</p>')).toBe('First.\n\nSecond.');
  });

  it.each(['<br>', '<br/>', '<br />', '<BR>', '<Br/>'])('turns %s into a line break', (tag) => {
    expect(htmlToText(`a${tag}b`)).toBe('a\nb');
  });

  it('removes other tags, attributes included', () => {
    expect(
      htmlToText(
        '<a href="https://x.test/?q=1&amp;r=2" class="y">link</a> <em>and</em> <i>more</i>',
      ),
    ).toBe('link and more');
  });

  it('treats source line breaks as whitespace', () => {
    expect(htmlToText('one\ntwo\r\nthree\rfour')).toBe('one two three four');
    expect(htmlToText('<p>one\n   two</p>')).toBe('one two');
  });

  it('collapses runs of blank lines to one and runs of spaces to one', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
    expect(htmlToText('a   \t b')).toBe('a b');
  });

  it('breaks list items onto their own lines', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one\n\ntwo');
  });

  it('strips comments', () => {
    expect(htmlToText('a<!-- hidden <b>note</b> -->b')).toBe('ab');
  });

  it('decodes named, decimal, and hex entities', () => {
    expect(htmlToText('&quot;Hi&quot; &amp; &lt;bye&gt; &mdash; &eacute;&#233;&#xe9; &copy;')).toBe(
      '"Hi" & <bye> — ééé ©',
    );
  });

  it('decodes a non-breaking space to a plain space', () => {
    expect(htmlToText('a&nbsp;b')).toBe('a b');
    expect(htmlToText('a  b')).toBe('a b');
  });

  it('leaves unknown, malformed, and out-of-range entities as written', () => {
    expect(htmlToText('&notanentity; &#0; &#x110000; &amp')).toBe(
      '&notanentity; &#0; &#x110000; &amp',
    );
  });

  it('decodes once, never twice', () => {
    expect(htmlToText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('keeps decoded angle brackets as text rather than treating them as tags', () => {
    expect(htmlToText('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
  });

  it('leaves a bare less-than that does not open a tag', () => {
    expect(htmlToText('5 < 7 and x<3')).toBe('5 < 7 and x<3');
  });

  it('returns an empty string for markup with no text', () => {
    expect(htmlToText('<p> </p><br>')).toBe('');
    expect(htmlToText('')).toBe('');
  });
});

describe('inlineSafe', () => {
  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['NEL', chars(0x85)],
    ['LINE SEPARATOR', chars(0x2028)],
    ['PARAGRAPH SEPARATOR', chars(0x2029)],
  ])('flattens %s to a single space', (_name, brk) => {
    const out = inlineSafe(`Title${brk}continued`);
    expect(out).toBe('Title continued');
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('keeps a lone CRLF as one space, not two', () => {
    expect(inlineSafe('a\r\nb')).toBe('a b');
    expect(inlineSafe('a\n\nb')).toBe('a  b');
  });

  it('cannot be used to start a new markdown block after a flattened break', () => {
    const out = inlineSafe('Safe title\r\n# Injected heading\r\n- item');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out.startsWith('Safe title')).toBe(true);
  });

  it('backslash-escapes brackets and angle brackets', () => {
    expect(inlineSafe('[link](https://x.test) <script>')).toBe(
      '\\[link\\](https://x.test) \\<script\\>',
    );
  });

  it('strips C0 controls other than tab', () => {
    expect(inlineSafe(`a${chars(0)}b${chars(7)}c${chars(0x1b)}d${chars(0xb)}e${chars(0xc)}f`)).toBe(
      'abcdef',
    );
    expect(inlineSafe('a\tb')).toBe('a\tb');
  });

  it('strips DEL and C1 controls', () => {
    expect(inlineSafe(`a${chars(0x7f)}b${chars(0x80)}c${chars(0x9f)}d`)).toBe('abcd');
  });

  it.each([
    0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ])('strips bidi control U+%s', (codePoint) => {
    expect(inlineSafe(`a${chars(codePoint)}b`)).toBe('ab');
  });

  it('keeps ordinary unicode, including accents and emoji', () => {
    expect(inlineSafe('Café 漢字 \u{1f3a8}')).toBe('Café 漢字 \u{1f3a8}');
  });

  it('leaves safe text unchanged', () => {
    expect(inlineSafe('Plain title, 1890 (oil)')).toBe('Plain title, 1890 (oil)');
    expect(inlineSafe('')).toBe('');
  });
});

describe('quoteBlock', () => {
  it('prefixes each line and keeps blank lines as a bare marker', () => {
    expect(quoteBlock('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('normalizes CRLF, CR, and Unicode line breaks to newlines', () => {
    expect(quoteBlock('a\r\nb\rc')).toBe('> a\n> b\n> c');
    expect(quoteBlock(`a${chars(0x2028)}b${chars(0x2029)}c${chars(0x85)}d`)).toBe(
      '> a\n> b\n> c\n> d',
    );
  });

  it('keeps every line of injected markup inside the quote', () => {
    const out = quoteBlock('text\r\n# Heading\r\n```\r\ncode');
    for (const line of out.split('\n')) expect(line.startsWith('>')).toBe(true);
  });

  it('strips controls and bidi characters but keeps tabs', () => {
    expect(quoteBlock(`a${chars(0)}b${chars(0x1b)}c${chars(0x202e)}d${chars(0x80)}e\tf`)).toBe(
      '> abcde\tf',
    );
    expect(quoteBlock(`a${chars(0xb)}b${chars(0xc)}c`)).toBe('> abc');
  });

  it('marks a trailing newline as an empty quoted line', () => {
    expect(quoteBlock('a\n')).toBe('> a\n>');
  });

  it('renders an empty string as one empty quote line', () => {
    expect(quoteBlock('')).toBe('>');
  });
});

describe('printableUrl', () => {
  it('percent-encodes square brackets and leaves other URL characters alone', () => {
    expect(printableUrl('https://x.test/a[1]/b%20c?q=[x]&r=(y)')).toBe(
      'https://x.test/a%5B1%5D/b%20c?q=%5Bx%5D&r=(y)',
    );
  });

  it('percent-encodes whitespace, line breaks, and control and bidi characters', () => {
    expect(printableUrl('https://x.test/a b\r\n# Injected\u0007\u0085 ‮')).toBe(
      'https://x.test/a%20b%0D%0A#%20Injected%07%C2%85%E2%80%A8%E2%80%AE',
    );
  });

  it('leaves an already-encoded url as it was', () => {
    const url = 'https://www.artic.edu/iiif/audio/970%20fixed.mp3';
    expect(printableUrl(url)).toBe(url);
  });
});

describe('constructed URLs', () => {
  it('builds web, manifest, image, and info URLs', () => {
    expect(artworkWebUrl(27992)).toBe('https://www.artic.edu/artworks/27992');
    expect(manifestUrl(27992)).toBe('https://api.artic.edu/api/v1/artworks/27992/manifest.json');
    expect(iiifImageUrl(IIIF, 'abc', 843)).toBe(`${IIIF}/abc/full/843,/0/default.jpg`);
    expect(iiifImageUrl(IIIF, 'abc', 1686)).toBe(`${IIIF}/abc/full/1686,/0/default.jpg`);
    expect(iiifInfoUrl(IIIF, 'abc')).toBe(`${IIIF}/abc/info.json`);
  });

  it('exposes the fallback IIIF base', () => {
    expect(FALLBACK_IIIF_URL).toBe(IIIF);
  });
});

describe('buildImage', () => {
  const thumbnail = { alt_text: 'A picture', width: 100, height: 80 };

  it('is absent without an image id', () => {
    expect(buildImage(IIIF, undefined, true, thumbnail)).toBeUndefined();
    expect(buildImage(IIIF, '', true, thumbnail)).toBeUndefined();
  });

  it('gives a public-domain image the large URL and public_domain rights', () => {
    expect(buildImage(IIIF, 'img', true, thumbnail)).toEqual({
      url: `${IIIF}/img/full/843,/0/default.jpg`,
      url_large: `${IIIF}/img/full/1686,/0/default.jpg`,
      iiif_info_url: `${IIIF}/img/info.json`,
      alt_text: 'A picture',
      width: 100,
      height: 80,
      rights: 'public_domain',
    });
  });

  it('withholds the large URL from an in-copyright image', () => {
    const image = buildImage(IIIF, 'img', false, thumbnail);
    expect(image?.rights).toBe('in_copyright');
    expect(image?.url).toBe(`${IIIF}/img/full/843,/0/default.jpg`);
    expect(image).not.toHaveProperty('url_large');
  });

  it('omits what the thumbnail lacks and never carries lqip', () => {
    const sparse = buildImage(IIIF, 'img', true, null);
    expect(sparse).toEqual({
      url: `${IIIF}/img/full/843,/0/default.jpg`,
      url_large: `${IIIF}/img/full/1686,/0/default.jpg`,
      iiif_info_url: `${IIIF}/img/info.json`,
      rights: 'public_domain',
    });
    const withLqip = buildImage(IIIF, 'img', true, {
      lqip: 'data:image/gif;base64,AAAA',
      alt_text: '',
      width: Number.NaN,
      height: null,
    } as never);
    expect(withLqip).not.toHaveProperty('alt_text');
    expect(withLqip).not.toHaveProperty('width');
    expect(withLqip).not.toHaveProperty('height');
    expect(JSON.stringify(withLqip)).not.toContain('lqip');
  });

  it('keeps a zero width as a real value', () => {
    expect(buildImage(IIIF, 'img', true, { width: 0, height: 0 })).toMatchObject({
      width: 0,
      height: 0,
    });
  });
});

describe('vocabularyFilterClause', () => {
  it('routes a department id to department_id', () => {
    expect(vocabularyFilterClause('department', 'PC-10')).toEqual({
      term: { department_id: 'PC-10' },
    });
  });

  it('routes an artwork type number to a numeric artwork_type_id', () => {
    expect(vocabularyFilterClause('artwork_type', '9')).toEqual({ term: { artwork_type_id: 9 } });
  });

  it.each([
    ['style', 'style_ids'],
    ['subject', 'subject_ids'],
    ['classification', 'classification_ids'],
  ] as const)('routes a TM id for %s to %s', (filter, field) => {
    expect(vocabularyFilterClause(filter, 'TM-123')).toEqual({ term: { [field]: 'TM-123' } });
  });

  it('routes a title to the keyword field, case-insensitively', () => {
    expect(vocabularyFilterClause('department', 'Prints and Drawings')).toEqual({
      term: {
        'department_title.keyword': { value: 'Prints and Drawings', case_insensitive: true },
      },
    });
    expect(vocabularyFilterClause('place_of_origin', 'France')).toEqual({
      term: { 'place_of_origin.keyword': { value: 'France', case_insensitive: true } },
    });
  });

  /** Values past 40 characters the index stores whole (probed against the live API). */
  it.each([
    ['department', 'department_title.keyword', 'Ryerson and Burnham Libraries Special Collections'],
    [
      'classification',
      'classification_titles.keyword',
      'personal grooming / hygiene / cosmetic container',
    ],
    ['subject', 'subject_titles.keyword', 'devil/satan/lucifer/beezelbub/mephistopheles'],
    [
      'place_of_origin',
      'place_of_origin.keyword',
      'confederated salish and kootenai tribes of the flathead reservation',
    ],
    ['style', 'style_titles.keyword', `${'x'.repeat(60)} style`],
    ['artwork_type', 'artwork_type_title.keyword', `${'x'.repeat(60)} type`],
    ['gallery', 'gallery_title.keyword', `${'x'.repeat(60)} gallery`],
  ] as const)('sends a long %s title whole to %s', (filter, field, value) => {
    expect(vocabularyFilterClause(filter, value)).toEqual({
      term: { [field]: { value, case_insensitive: true } },
    });
  });

  it('sends a title the museum stores at 40 characters exactly as listed', () => {
    expect(
      vocabularyFilterClause('classification', 'gelatin silver (developing-out-paper) pr'),
    ).toEqual({
      term: {
        'classification_titles.keyword': {
          value: 'gelatin silver (developing-out-paper) pr',
          case_insensitive: true,
        },
      },
    });
  });

  it('does not treat a mismatched id shape as an id', () => {
    expect(vocabularyFilterClause('artwork_type', 'TM-5')).toEqual({
      term: { 'artwork_type_title.keyword': { value: 'TM-5', case_insensitive: true } },
    });
    expect(vocabularyFilterClause('department', 'TM-5')).toEqual({
      term: { 'department_title.keyword': { value: 'TM-5', case_insensitive: true } },
    });
    expect(vocabularyFilterClause('style', 'PC-5')).toEqual({
      term: { 'style_titles.keyword': { value: 'PC-5', case_insensitive: true } },
    });
  });

  it('has no id route for place_of_origin or gallery', () => {
    expect(vocabularyFilterClause('place_of_origin', 'TM-5')).toEqual({
      term: { 'place_of_origin.keyword': { value: 'TM-5', case_insensitive: true } },
    });
    expect(vocabularyFilterClause('gallery', 'Gallery 240')).toEqual({
      term: { 'gallery_title.keyword': { value: 'Gallery 240', case_insensitive: true } },
    });
  });

  it('keeps the vocabulary field table aligned with the design', () => {
    expect(VOCABULARY_FIELDS).toEqual({
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
    });
  });
});

describe('containsPattern', () => {
  const matches = (text: string, value: string) =>
    new RegExp(`^${containsPattern(text)}$`).test(value);

  it('compiles per-letter case classes', () => {
    expect(containsPattern('impress')).toBe('.*[iI][mM][pP][rR][eE][sS][sS].*');
  });

  it('matches the substring anywhere, in any case', () => {
    for (const value of ['Impressionism', 'Post-Impressionism', 'American IMPRESSIONISM']) {
      expect(matches('impress', value)).toBe(true);
    }
    expect(matches('impress', 'Cubism')).toBe(false);
  });

  it('keeps digits and whitespace literal', () => {
    expect(containsPattern('a 1')).toBe('.*[aA] 1.*');
    expect(matches('gallery 2', 'Gallery 240')).toBe(true);
  });

  it('escapes every regex metacharacter', () => {
    expect(containsPattern('a.b')).toBe('.*[aA]\\.[bB].*');
    for (const meta of [
      '.',
      '*',
      '+',
      '?',
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      '|',
      '\\',
      '^',
      '$',
      '-',
      '/',
      '"',
      '#',
      '@',
      '&',
      '<',
      '>',
      '~',
    ]) {
      expect(containsPattern(meta)).toBe(`.*\\${meta}.*`);
    }
  });

  it('does not let a metacharacter act as a regex operator', () => {
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a|b', 'a')).toBe(false);
    expect(matches('a*', 'aaa')).toBe(false);
    expect(matches('(x)', '(x)')).toBe(true);
  });

  it('handles accented letters and uncased scripts', () => {
    expect(containsPattern('é')).toBe('.*[éÉ].*');
    expect(containsPattern('漢')).toBe('.*漢.*');
  });

  it('keeps a letter whose uppercase is longer literal', () => {
    expect(containsPattern('ß')).toBe('.*ß.*');
  });

  it('wraps an empty needle as match-anything', () => {
    expect(containsPattern('')).toBe('.*.*');
  });
});

describe('pageInfo', () => {
  it('reports no more when the page reaches the total', () => {
    expect(pageInfo(0, 1, 10)).toEqual({ has_more: false, windowExhausted: false });
    expect(pageInfo(10, 1, 10)).toEqual({ has_more: false, windowExhausted: false });
    expect(pageInfo(25, 3, 10)).toEqual({ has_more: false, windowExhausted: false });
  });

  it('points at the next page while it stays inside the window', () => {
    expect(pageInfo(11, 1, 10)).toEqual({ has_more: true, next_page: 2, windowExhausted: false });
    expect(pageInfo(5000, 9, 100)).toEqual({
      has_more: true,
      next_page: 10,
      windowExhausted: false,
    });
  });

  it('flags the window as exhausted when the next page would cross it', () => {
    const info = pageInfo(5000, 10, 100);
    expect(info).toEqual({ has_more: true, windowExhausted: true });
    expect(info).not.toHaveProperty('next_page');
    expect(pageInfo(2000, 100, 10)).toEqual({ has_more: true, windowExhausted: true });
    expect(pageInfo(1001, 1000, 1)).toEqual({ has_more: true, windowExhausted: true });
  });

  it('allows the last page that ends exactly at the window edge', () => {
    expect(pageInfo(5000, 99, 10)).toEqual({
      has_more: true,
      next_page: 100,
      windowExhausted: false,
    });
    expect(pageInfo(5000, 999, 1)).toEqual({
      has_more: true,
      next_page: 1000,
      windowExhausted: false,
    });
  });

  it('is not exhausted when the total fits inside the window', () => {
    expect(pageInfo(1000, 10, 100)).toEqual({ has_more: false, windowExhausted: false });
  });

  it('reports has_more for a counts-only request whenever anything matched', () => {
    expect(pageInfo(0, 1, 0)).toEqual({ has_more: false, windowExhausted: false });
    const info = pageInfo(42, 1, 0);
    expect(info).toEqual({ has_more: true, windowExhausted: false });
    expect(info).not.toHaveProperty('next_page');
  });

  it('exposes the window constants', () => {
    expect(SEARCH_WINDOW).toBe(1000);
    expect(WINDOW_NOTICE).toContain('1,000');
  });
});
