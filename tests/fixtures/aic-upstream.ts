/**
 * @fileoverview Synthetic upstream bodies shaped like the Art Institute API
 * Reference in `docs/design.md`: record builders, response envelopes,
 * aggregation envelopes, and the error bodies the API and its edge produce.
 * Titles and text are invented; ids and uuids are placeholders.
 * @module tests/fixtures/aic-upstream
 */

export const ARTWORK_LICENSE =
  'The `description` field in this response is licensed under a Creative Commons Attribution 4.0 Generic License (CC-By). All other data in this response is licensed under a Creative Commons Zero (CC0) 1.0 designation.';
export const AGENT_LICENSE = 'Synthetic CC0 license text for agents.';
export const MOBILE_SOUND_LICENSE =
  'Synthetic noncommercial educational and personal use notice for mobile sounds.';
export const IIIF_URL = 'https://www.artic.edu/iiif/2';

export const IMAGE_ID = '11111111-2222-3333-4444-555555555555';
export const ALT_IMAGE_ID = '66666666-7777-8888-9999-000000000000';

/** A deterministic uuid-shaped sound id; `n` distinguishes ids. */
export function soundUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// --- Envelopes ---------------------------------------------------------------

export interface EnvelopeOptions {
  aggregations?: Record<string, unknown>;
  /** `null` and `''` model an envelope whose config omits the IIIF base. */
  iiifUrl?: string | null;
  license?: string | null;
  /** Reported `pagination.total`; omit to leave `pagination` off the envelope (an `ids=` batch). */
  total?: number;
}

/** The API envelope around `data`. Search routes pass `total`; `ids=` batches do not. */
export function envelope(data: unknown, options: EnvelopeOptions = {}): Record<string, unknown> {
  const { aggregations, iiifUrl = IIIF_URL, license = ARTWORK_LICENSE, total } = options;
  return {
    ...(total !== undefined && {
      pagination: { total, limit: 10, offset: 0, total_pages: 1, current_page: 1 },
    }),
    data,
    ...(aggregations !== undefined && { aggregations }),
    info: { license_text: license, license_links: [], version: '1.13' },
    config: { iiif_url: iiifUrl, website_url: 'http://www.artic.edu' },
  };
}

/** A search response: pagination carries `total`. */
export function searchEnvelope(
  data: unknown[],
  total: number = data.length,
  options: Omit<EnvelopeOptions, 'total'> = {},
): Record<string, unknown> {
  return envelope(data, { ...options, total });
}

/** A terms-aggregation envelope: `{ aggregations: { <name>: { buckets, sum_other_doc_count } } }`. */
export function aggregationEnvelope(
  name: string,
  buckets: unknown[],
  sumOtherDocCount = 0,
  total = 0,
): Record<string, unknown> {
  return searchEnvelope([], total, {
    aggregations: { [name]: { buckets, sum_other_doc_count: sumOtherDocCount } },
  });
}

// --- Records -----------------------------------------------------------------

/** A fully populated artwork record, every allowlisted field present. */
export function artworkRecord(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Synthetic Work ${id}`,
    alt_titles: null,
    main_reference_number: `${id}.1900`,
    artist_display: 'Test Artist\nFrench, 1840-1900',
    artist_id: 900,
    artist_ids: [900],
    artist_title: 'Test Artist',
    date_display: '1890',
    date_start: 1890,
    date_end: 1890,
    date_qualifier_title: '',
    place_of_origin: 'France',
    medium_display: 'Oil on canvas',
    dimensions: '10 x 10 cm',
    inscriptions: null,
    credit_line: 'Gift of a synthetic donor',
    copyright_notice: null,
    edition: null,
    artwork_type_title: 'Painting',
    department_title: 'Painting and Sculpture of Europe',
    classification_title: 'oil on canvas',
    style_title: 'Impressionism',
    style_titles: ['Impressionism'],
    subject_titles: ['landscape'],
    material_titles: ['oil paint'],
    technique_titles: [],
    theme_titles: [],
    is_public_domain: true,
    is_on_view: false,
    gallery_title: null,
    on_loan_display: null,
    image_id: IMAGE_ID,
    alt_image_ids: [],
    thumbnail: {
      lqip: 'data:image/gif;base64,R0lGODlhBQAEAPQAAA==',
      width: 100,
      height: 80,
      alt_text: 'A synthetic landscape',
    },
    sound_ids: [],
    description: null,
    short_description: null,
    provenance_text: null,
    exhibition_history: null,
    publication_history: null,
    catalogue_display: null,
    ...overrides,
  };
}

/** The sparsest record the API sends: an id and nothing the record may omit. */
export function sparseArtworkRecord(id: number): Record<string, unknown> {
  return { id };
}

/** An in-copyright, on-view record carrying a gallery. */
export function inCopyrightArtworkRecord(id: number): Record<string, unknown> {
  return artworkRecord(id, {
    is_public_domain: false,
    is_on_view: true,
    gallery_title: 'Gallery 240',
    copyright_notice: '(c) Synthetic estate',
  });
}

/** A record whose dates are the placeholder values the museum's data carries. */
export function placeholderYearArtworkRecord(id: number): Record<string, unknown> {
  return artworkRecord(id, {
    date_display: 'Dates unknown',
    date_start: -1_824_528_578,
    date_end: 5_000_001,
  });
}

export function soundRecord(uuid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid,
    title: `Synthetic stop ${uuid.slice(-4)}`,
    type: 'sound',
    content: `https://www.artic.edu/assets/${uuid}`,
    ...overrides,
  };
}

export function agentRecord(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Synthetic Agent ${id}`,
    sort_title: `Agent, Synthetic ${id}`,
    alt_titles: null,
    is_artist: true,
    agent_type_title: 'Individual',
    birth_date: 1840,
    death_date: 1900,
    description: null,
    ...overrides,
  };
}

export function exhibitionRecord(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Synthetic Exhibition ${id}`,
    status: 'Closed',
    aic_start_at: '2020-01-01T00:00:00-06:00',
    aic_end_at: '2020-06-01T00:00:00-05:00',
    gallery_id: null,
    gallery_title: null,
    short_description: null,
    web_url: null,
    image_id: null,
    image_url: null,
    artwork_ids: [],
    artwork_titles: [],
    artist_ids: [],
    is_featured: null,
    ...overrides,
  };
}

export function mobileSoundRecord(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Synthetic audio stop ${id}`,
    web_url: 'https://www.artic.edu/iiif/audio/970%20fixed.mp3',
    transcript: '<p>First paragraph.</p><p>Second paragraph.</p>',
    ...overrides,
  };
}

// --- Response-size worst case -----------------------------------------------------

/**
 * The twelve artwork rows that put the most bytes on the `artic_search_artworks`
 * wire, measured over the whole collection (Design Decision 45), heaviest first:
 * the length of each upstream text field, the line count of `artist_display`,
 * and whether the row has an image and is public domain. The text is synthetic.
 */
const HEAVIEST_ROWS = [
  [22, 3567, 7, 4, 144, 4, 19, 6, 160, true, true],
  [7, 5, 1, 35, 1420, 7, 8, 5, 1436, true, true],
  [23, 2007, 11, 4, 332, 4, 19, 7, 348, true, false],
  [73, 20, 1, 9, 1235, 22, 8, 7, 1251, true, true],
  [23, 1966, 9, 4, 291, 4, 19, 6, 307, true, false],
  [23, 17, 2, 35, 1158, 23, 8, 5, 1174, true, true],
  [46, 13, 1, 35, 1135, 23, 8, 5, 1151, true, true],
  [18, 5, 1, 31, 1073, 7, 8, 5, 1089, true, true],
  [33, 1831, 6, 7, 138, 4, 19, 6, 154, true, true],
  [33, 1811, 6, 4, 140, 4, 19, 6, 156, true, true],
  [10, 33, 2, 26, 2399, 9, 0, 0, 0, false, false],
  [10, 33, 2, 26, 2399, 0, 0, 0, 0, false, false],
] as const;

/** Synthetic text of exactly `length` characters. */
function filler(length: number): string {
  return 'Synthetic catalog text '.repeat(Math.ceil(length / 23)).slice(0, length);
}

/** `length` characters of synthetic text over `lines` lines. */
function multiline(length: number, lines: number): string {
  const text = filler(length).split('');
  const step = Math.floor(length / lines);
  for (let line = 1; line < lines; line++) text[line * step] = '\n';
  return text.join('');
}

/** `count` search rows shaped like the heaviest in the collection, heaviest first; past twelve the list repeats. */
export function heaviestArtworkRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const [title, artist, lines, date, medium, type, department, place, alt, image, publicDomain] =
      HEAVIEST_ROWS[index % HEAVIEST_ROWS.length] ?? HEAVIEST_ROWS[0];
    return artworkRecord(500_001 + index, {
      title: filler(title),
      artist_display: multiline(artist, lines),
      date_display: filler(date),
      medium_display: filler(medium),
      artwork_type_title: filler(type),
      department_title: filler(department),
      place_of_origin: filler(place),
      is_public_domain: publicDomain,
      image_id: image ? IMAGE_ID : null,
      thumbnail: image ? { width: 3000, height: 2400, alt_text: filler(alt) } : null,
    });
  });
}

/** The longest value each artwork facet holds in the collection; `artist` is the longest artist name. */
const LONGEST_FACET_VALUES = {
  department: 49,
  artwork_type: 23,
  style: 40,
  subject: 44,
  classification: 48,
  place_of_origin: 74,
} as const;
const LONGEST_ARTIST_NAME = 97;

/** Aggregations for all seven artwork facets, 15 values each, every value as long as the longest the collection holds. */
export function longestFacetAggregations(): Record<string, unknown> {
  const buckets = <T>(build: (index: number) => T) => ({
    buckets: Array.from({ length: 15 }, (_, index) => build(index)),
    sum_other_doc_count: 0,
  });
  return {
    ...Object.fromEntries(
      Object.entries(LONGEST_FACET_VALUES).map(([name, length]) => [
        name,
        buckets((index) => ({
          key: `${filler(length - 2)}${String(index).padStart(2, '0')}`,
          doc_count: 133_118,
        })),
      ]),
    ),
    artist: buckets((index) => ({
      key: 100_001 + index,
      doc_count: 133_118,
      label: { hits: { hits: [{ _source: { artist_title: filler(LONGEST_ARTIST_NAME) } }] } },
    })),
  };
}

// --- Error bodies ---------------------------------------------------------------

export const API_NOT_FOUND_BODY = {
  status: 404,
  error: 'Not found',
  detail: 'The item you requested cannot be found.',
};
export const API_INVALID_SYNTAX_BODY = {
  status: 400,
  error: 'Invalid syntax',
  detail: 'The identifier syntax is invalid.',
};
export const API_INVALID_LIMIT_BODY = {
  status: 403,
  error: 'Invalid limit',
  detail: 'You have requested too many resources per page.',
};
export const API_INVALID_RESULTS_BODY = {
  status: 403,
  error: 'Invalid number of results',
  detail: 'You have requested too many results.',
};
export const API_OTHER_403_BODY = {
  status: 403,
  error: 'Forbidden',
  detail: 'Synthetic refusal unrelated to paging.',
};

/** The search backend's 400: plain text, served with a JSON content type, naming internals. */
export const ES_BAD_REQUEST_TEXT =
  '400 Bad Request: {"error":{"root_cause":[{"type":"parsing_exception","reason":"unknown query [synthetic] in index artic-test-index"}],"type":"search_phase_execution_exception"},"status":400}';

/** An edge or WAF block page. */
export const EDGE_BLOCK_HTML =
  '<html><head><title>403 Forbidden</title></head><body>Request blocked.</body></html>';
