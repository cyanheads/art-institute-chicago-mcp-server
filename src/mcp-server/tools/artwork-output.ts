/**
 * @fileoverview Output schema and markdown rendering shared by the artwork
 * tools: the image object and the compact artwork fields that
 * `artic_search_artworks` rows and `artic_get_artworks` records both carry.
 * @module mcp-server/tools/artwork-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import { inlineSafe, printableUrl } from '@/services/aic/aic-text.js';

export const ArtworkImageSchema = z
  .object({
    url: z
      .string()
      .describe(
        'IIIF image 843 px wide, the museum display size; available for every image, public domain or not.',
      ),
    url_large: z
      .string()
      .optional()
      .describe('IIIF image 1686 px wide; present only for public-domain works.'),
    iiif_info_url: z
      .string()
      .describe('IIIF info.json URL listing the image dimensions, sizes, and tiles.'),
    alt_text: z.string().optional().describe('Alt text the museum wrote for the image.'),
    width: z.number().optional().describe('Full image width in pixels.'),
    height: z.number().optional().describe('Full image height in pixels.'),
    rights: z
      .enum(['public_domain', 'in_copyright'])
      .describe(
        'Reuse status: public_domain images are CC0; in_copyright images need a rights check before reuse.',
      ),
  })
  .describe('Primary image with constructed IIIF URLs and its reuse status.');

/** Fields every artwork row and record carries; spread into a `z.object`. */
export const artworkSummaryShape = {
  id: z.number().describe('Artwork id; pass to artic_get_artworks.'),
  title: z.string().describe('Title as catalogued; empty when the museum lists none.'),
  artist_display: z
    .string()
    .optional()
    .describe('Artist, nationality, and life dates as the museum displays them.'),
  artist_id: z
    .number()
    .optional()
    .describe('Id of the preferred credited artist; pass as artist_id to artic_search_artworks.'),
  date_display: z
    .string()
    .optional()
    .describe('Date as the museum displays it; the authority when the years are absent.'),
  date_start: z
    .number()
    .optional()
    .describe(
      'Earliest year of the date span, negative for BCE; omitted when absent or implausible.',
    ),
  date_end: z
    .number()
    .optional()
    .describe(
      'Latest year of the date span, negative for BCE; omitted when absent or implausible.',
    ),
  medium: z.string().optional().describe('Medium and support as displayed.'),
  artwork_type: z.string().optional().describe('Artwork type, such as Painting or Print.'),
  department: z.string().optional().describe('Curatorial department.'),
  place_of_origin: z.string().optional().describe('Place the work was made.'),
  is_public_domain: z
    .boolean()
    .describe('True when the work is public domain, so its images are CC0.'),
  is_on_view: z.boolean().describe('True when the work is on view at the museum now.'),
  gallery: z
    .string()
    .optional()
    .describe('Gallery where the work is on view, such as Gallery 240.'),
  web_url: z.string().describe('Public page for the artwork on artic.edu.'),
  image: ArtworkImageSchema.optional().describe(
    'Primary image with constructed IIIF URLs and its reuse status; absent when the work has no image.',
  ),
};

type ArtworkImage = z.infer<typeof ArtworkImageSchema>;
type ArtworkSummary = z.infer<z.ZodObject<typeof artworkSummaryShape>>;

/** An upstream title for a heading; a placeholder when the museum lists none. */
export function titleText(title: string): string {
  return title === '' ? '(untitled)' : inlineSafe(title);
}

export function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Markdown lines for the primary image: URLs, size, rights, and alt text. */
export function imageLines(image: ArtworkImage): string[] {
  const urls = [`display ${printableUrl(image.url)}`];
  if (image.url_large) urls.push(`large ${printableUrl(image.url_large)}`);
  urls.push(`IIIF info ${printableUrl(image.iiif_info_url)}`);
  const size: string[] = [];
  if (image.width !== undefined) size.push(`width ${image.width} px`);
  if (image.height !== undefined) size.push(`height ${image.height} px`);
  const lines = [
    `- **Image (${image.rights}):** ${urls.join(' · ')}${size.length > 0 ? ` · ${size.join(', ')}` : ''}`,
  ];
  if (image.alt_text) lines.push(`- **Image alt text:** ${inlineSafe(image.alt_text)}`);
  return lines;
}

/** Markdown lines for the fields an artwork row and record share, after its heading. */
export function summaryLines(artwork: ArtworkSummary): string[] {
  const lines: string[] = [];
  const artist: string[] = [];
  if (artwork.artist_display) artist.push(inlineSafe(artwork.artist_display));
  if (artwork.artist_id !== undefined) artist.push(`artist_id ${artwork.artist_id}`);
  if (artist.length > 0) lines.push(`- **Artist:** ${artist.join(' · ')}`);

  const date: string[] = [];
  if (artwork.date_display) date.push(inlineSafe(artwork.date_display));
  if (artwork.date_start !== undefined) date.push(`start ${artwork.date_start}`);
  if (artwork.date_end !== undefined) date.push(`end ${artwork.date_end}`);
  if (date.length > 0) lines.push(`- **Date:** ${date.join(' · ')}`);

  if (artwork.medium) lines.push(`- **Medium:** ${inlineSafe(artwork.medium)}`);
  if (artwork.artwork_type) lines.push(`- **Type:** ${inlineSafe(artwork.artwork_type)}`);
  if (artwork.department) lines.push(`- **Department:** ${inlineSafe(artwork.department)}`);
  if (artwork.place_of_origin) {
    lines.push(`- **Place of origin:** ${inlineSafe(artwork.place_of_origin)}`);
  }
  const status = [
    `**Public domain:** ${yesNo(artwork.is_public_domain)}`,
    `**On view:** ${yesNo(artwork.is_on_view)}`,
  ];
  if (artwork.gallery) status.push(`**Gallery:** ${inlineSafe(artwork.gallery)}`);
  lines.push(`- ${status.join(' · ')}`);
  lines.push(`- **Web:** ${printableUrl(artwork.web_url)}`);
  if (artwork.image) lines.push(...imageLines(artwork.image));
  return lines;
}
