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
