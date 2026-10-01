/**
 * @fileoverview Raw Art Institute of Chicago API payload types and the
 * normalized domain shapes the service returns. Raw fields are optional unless
 * the API guarantees them; normalized shapes omit what the upstream left empty.
 * @module services/aic/types
 */

// --- Raw upstream payloads ---------------------------------------------------

/** Response envelope shared by search, listing, and `ids=` batch routes. */
export interface RawEnvelope<T> {
  aggregations?: Record<string, RawAggregation>;
  config?: { iiif_url?: string | null; website_url?: string | null } | null;
  data?: T[] | null;
  info?: { license_text?: string | null } | null;
  pagination?: { total?: number | null } | null;
}

export interface RawBucket {
  doc_count: number;
  key: string | number;
  [subAggregation: string]: unknown;
}

export interface RawAggregation {
  buckets?: RawBucket[];
  sum_other_doc_count?: number;
}

export interface RawTopHits<S> {
  hits?: { hits?: { _source?: S }[] };
}

export interface RawThumbnail {
  alt_text?: string | null;
  height?: number | null;
  width?: number | null;
}

export interface RawArtwork {
  alt_image_ids?: string[] | null;
  alt_titles?: string[] | null;
  artist_display?: string | null;
  artist_id?: number | null;
  artist_ids?: number[] | null;
  artwork_type_title?: string | null;
  catalogue_display?: string | null;
  classification_title?: string | null;
  copyright_notice?: string | null;
  credit_line?: string | null;
  date_display?: string | null;
  date_end?: number | null;
  date_qualifier_title?: string | null;
  date_start?: number | null;
  department_title?: string | null;
  description?: string | null;
  dimensions?: string | null;
  edition?: string | null;
  exhibition_history?: string | null;
  gallery_title?: string | null;
  id: number;
  image_id?: string | null;
  inscriptions?: string | null;
  is_on_view?: boolean | null;
  is_public_domain?: boolean | null;
  main_reference_number?: string | null;
  material_titles?: string[] | null;
  medium_display?: string | null;
  on_loan_display?: string | null;
  place_of_origin?: string | null;
  provenance_text?: string | null;
  publication_history?: string | null;
  short_description?: string | null;
  sound_ids?: string[] | null;
  style_title?: string | null;
  style_titles?: string[] | null;
  subject_titles?: string[] | null;
  technique_titles?: string[] | null;
  theme_titles?: string[] | null;
  thumbnail?: RawThumbnail | null;
  title?: string | null;
}

export interface RawSound {
  content?: string | null;
  id: string;
  title?: string | null;
  type?: string | null;
}

export interface RawAgent {
  agent_type_title?: string | null;
  alt_titles?: string[] | null;
  birth_date?: number | null;
  death_date?: number | null;
  description?: string | null;
  id: number;
  is_artist?: boolean | null;
  sort_title?: string | null;
  title?: string | null;
}

export interface RawExhibition {
  aic_end_at?: string | null;
  aic_start_at?: string | null;
  artist_ids?: number[] | null;
  artwork_ids?: number[] | null;
  artwork_titles?: string[] | null;
  gallery_title?: string | null;
  id: number;
  image_id?: string | null;
  image_url?: string | null;
  is_featured?: boolean | null;
  short_description?: string | null;
  status?: string | null;
  title?: string | null;
  web_url?: string | null;
}

export interface RawMobileSound {
  id: number;
  title?: string | null;
  transcript?: string | null;
  web_url?: string | null;
}

// --- Normalized domain shapes ------------------------------------------------

/** Reuse status of an artwork image: only public-domain images are CC0. */
export type ImageRights = 'public_domain' | 'in_copyright';

export interface ArtworkImage {
  alt_text?: string;
  height?: number;
  iiif_info_url: string;
  rights: ImageRights;
  url: string;
  url_large?: string;
  width?: number;
}

export interface AltImage {
  iiif_info_url: string;
  url: string;
}

/** Compact artwork row returned by collection search. */
export interface ArtworkSummary {
  artist_display?: string;
  artist_id?: number;
  artwork_type?: string;
  date_display?: string;
  date_end?: number;
  date_start?: number;
  department?: string;
  gallery?: string;
  id: number;
  image?: ArtworkImage;
  is_on_view: boolean;
  is_public_domain: boolean;
  medium?: string;
  place_of_origin?: string;
  title: string;
  web_url: string;
}

/** An opt-in heavy-text section of an artwork record. */
export type ArtworkSection =
  | 'description'
  | 'provenance'
  | 'exhibition_history'
  | 'publication_history'
  | 'catalogue';

export interface RelatedMedia {
  id: string;
  title: string;
  type?: string;
  url: string;
}

/** Full artwork record returned by the `ids=` batch route. */
export interface ArtworkDetail extends ArtworkSummary {
  alt_images?: AltImage[];
  alt_titles?: string[];
  artist_ids: number[];
  catalogue?: string;
  classification?: string;
  copyright_notice?: string;
  credit_line?: string;
  date_qualifier?: string;
  description?: string;
  dimensions?: string;
  edition?: string;
  exhibition_history?: string;
  inscriptions?: string;
  main_reference_number: string;
  manifest_url?: string;
  materials: string[];
  on_loan?: string;
  provenance?: string;
  publication_history?: string;
  related_media?: RelatedMedia[];
  short_description?: string;
  style?: string;
  styles: string[];
  subjects: string[];
  techniques: string[];
  themes: string[];
}

export interface FacetValue {
  count: number;
  value: string;
}

export interface ArtistFacetValue {
  artist_id: number;
  count: number;
  name?: string;
}

/** Facet dimensions `artic_search_artworks` can count over the filtered set. */
export type FacetName =
  | 'department'
  | 'artwork_type'
  | 'style'
  | 'subject'
  | 'classification'
  | 'place_of_origin'
  | 'artist';

export interface ArtworkFacets {
  artist?: ArtistFacetValue[];
  artwork_type?: FacetValue[];
  classification?: FacetValue[];
  department?: FacetValue[];
  place_of_origin?: FacetValue[];
  style?: FacetValue[];
  subject?: FacetValue[];
}

export interface Agent {
  agent_type?: string;
  alt_names: string[];
  biography?: string;
  birth_year?: number;
  death_year?: number;
  id: number;
  is_artist: boolean;
  name: string;
  sort_name?: string;
}

export interface SampleWork {
  date_display?: string;
  id: number;
  title: string;
}

export interface ArtistWorkStats {
  artwork_count: number;
  sample_works: SampleWork[];
}

export interface Exhibition {
  artist_ids: number[];
  artwork_count: number;
  artworks: { id: number; title?: string }[];
  end?: string;
  gallery?: string;
  id: number;
  image_url?: string;
  is_featured?: boolean;
  start?: string;
  status?: string;
  summary?: string;
  title: string;
  web_url?: string;
}

export interface AudioGuideStop {
  audio_url?: string;
  id: number;
  title: string;
  transcript?: string;
}
