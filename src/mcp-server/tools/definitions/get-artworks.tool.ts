/**
 * @fileoverview `artic_get_artworks` — full records for up to 10 artworks by
 * id in one upstream call: curatorial text, provenance, histories,
 * categorization, image URLs with rights status, and related multimedia.
 * @module mcp-server/tools/definitions/get-artworks.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  artworkIdItem,
  blankAsUnset,
  inlineSafe,
  listInput,
  printableUrl,
  quoteBlock,
} from '@/services/aic/aic-text.js';
import { DEFAULT_SECTIONS, jsonBytes, loadArtworkRecords } from '@/services/aic/artwork-records.js';
import { artworkSummaryShape, summaryLines, titleText } from '../artwork-output.js';

const SECTIONS = [
  'description',
  'provenance',
  'exhibition_history',
  'publication_history',
  'catalogue',
] as const;

const ArtworkRecordSchema = z
  .object({
    ...artworkSummaryShape,
    alt_titles: z.array(z.string()).optional().describe('Other titles the work is known by.'),
    main_reference_number: z
      .string()
      .describe('Museum reference (accession) number; empty when the museum lists none.'),
    artist_ids: z
      .array(z.number())
      .describe('Ids of every credited artist; pass one as artist_id to artic_search_artworks.'),
    date_qualifier: z.string().optional().describe('What the date marks, such as Made or Printed.'),
    dimensions: z.string().optional().describe('Dimensions as catalogued.'),
    inscriptions: z
      .string()
      .optional()
      .describe('Inscriptions, signatures, and marks as catalogued.'),
    credit_line: z
      .string()
      .optional()
      .describe('Credit line naming how the museum acquired the work.'),
    copyright_notice: z.string().optional().describe('Copyright notice for the work.'),
    edition: z.string().optional().describe('Edition statement for prints and multiples.'),
    classification: z.string().optional().describe('Preferred classification.'),
    style: z.string().optional().describe('Preferred style.'),
    styles: z.array(z.string()).describe('Every style the museum assigns.'),
    subjects: z.array(z.string()).describe('Subjects the museum assigns.'),
    materials: z.array(z.string()).describe('Materials the museum records.'),
    techniques: z.array(z.string()).describe('Techniques the museum records.'),
    themes: z.array(z.string()).describe('Themes the museum assigns.'),
    on_loan: z.string().optional().describe('Loan statement when the work is on loan.'),
    manifest_url: z
      .string()
      .optional()
      .describe('IIIF Presentation manifest URL; present for public-domain works.'),
    alt_images: z
      .array(
        z
          .object({
            url: z.string().describe('IIIF image 843 px wide.'),
            iiif_info_url: z.string().describe('IIIF info.json URL for the image.'),
          })
          .describe('One alternate image.'),
      )
      .optional()
      .describe('Alternate images (other views, details); same rights as the primary image.'),
    description: z
      .string()
      .optional()
      .describe(
        'Curatorial description, CC BY 4.0: credit the Art Institute of Chicago and cite web_url. Present when the description section was requested and the museum wrote one.',
      ),
    short_description: z
      .string()
      .optional()
      .describe(
        'Short curatorial description, attributed like description; returned with the description section.',
      ),
    provenance: z
      .string()
      .optional()
      .describe('Ownership history; returned with the provenance section.'),
    exhibition_history: z
      .string()
      .optional()
      .describe(
        'Exhibitions the work has appeared in; returned with the exhibition_history section.',
      ),
    publication_history: z
      .string()
      .optional()
      .describe('Publications citing the work; returned with the publication_history section.'),
    catalogue: z
      .string()
      .optional()
      .describe('Catalogue raisonne entries; returned with the catalogue section.'),
    related_media: z
      .array(
        z
          .object({
            id: z.string().describe('Multimedia asset id (uuid).'),
            title: z.string().describe('Asset title; empty when the museum lists none.'),
            url: z.string().describe('Asset URL on artic.edu.'),
            type: z.string().optional().describe('Asset type, such as sound.'),
          })
          .describe('One related multimedia asset.'),
      )
      .optional()
      .describe(
        'Related multimedia (lectures, audio stops) from the museum; present when requested and at least one linked item loaded, never an empty list.',
      ),
  })
  .describe('One full artwork record.');

type ArtworkRecord = z.infer<typeof ArtworkRecordSchema>;

/** `label: a; b; c` for a non-empty list of upstream strings, inline-safe. */
function listLine(label: string, values: readonly string[]): string[] {
  return values.length > 0 ? [`- **${label}:** ${values.map(inlineSafe).join('; ')}`] : [];
}

/** `### heading` plus the upstream text as a blockquote, when present. */
function textSection(heading: string, text: string | undefined): string[] {
  return text ? ['', `### ${heading}`, quoteBlock(text)] : [];
}

function recordLines(artwork: ArtworkRecord): string[] {
  const lines = [`## ${titleText(artwork.title)} (id ${artwork.id})`, ...summaryLines(artwork)];
  lines.push(
    `- **Reference number:** ${inlineSafe(artwork.main_reference_number) || 'not recorded'}`,
  );
  lines.push(...listLine('Alternate titles', artwork.alt_titles ?? []));
  if (artwork.artist_ids.length > 0) {
    lines.push(`- **Artist ids:** ${artwork.artist_ids.join(', ')}`);
  }
  if (artwork.date_qualifier)
    lines.push(`- **Date qualifier:** ${inlineSafe(artwork.date_qualifier)}`);
  if (artwork.dimensions) lines.push(`- **Dimensions:** ${inlineSafe(artwork.dimensions)}`);
  if (artwork.credit_line) lines.push(`- **Credit line:** ${inlineSafe(artwork.credit_line)}`);
  if (artwork.copyright_notice) {
    lines.push(`- **Copyright notice:** ${inlineSafe(artwork.copyright_notice)}`);
  }
  if (artwork.edition) lines.push(`- **Edition:** ${inlineSafe(artwork.edition)}`);
  if (artwork.classification) {
    lines.push(`- **Classification:** ${inlineSafe(artwork.classification)}`);
  }
  if (artwork.style) lines.push(`- **Style:** ${inlineSafe(artwork.style)}`);
  lines.push(
    ...listLine('Styles', artwork.styles),
    ...listLine('Subjects', artwork.subjects),
    ...listLine('Materials', artwork.materials),
    ...listLine('Techniques', artwork.techniques),
    ...listLine('Themes', artwork.themes),
  );
  if (artwork.on_loan) lines.push(`- **On loan:** ${inlineSafe(artwork.on_loan)}`);
  if (artwork.manifest_url)
    lines.push(`- **IIIF manifest:** ${printableUrl(artwork.manifest_url)}`);
  for (const [index, image] of (artwork.alt_images ?? []).entries()) {
    lines.push(
      `- **Alternate image ${index + 1}:** display ${printableUrl(image.url)} · IIIF info ${printableUrl(image.iiif_info_url)}`,
    );
  }
  lines.push(
    ...textSection('Inscriptions', artwork.inscriptions),
    ...textSection('Short description', artwork.short_description),
    ...textSection('Description', artwork.description),
    ...textSection('Provenance', artwork.provenance),
    ...textSection('Exhibition history', artwork.exhibition_history),
    ...textSection('Publication history', artwork.publication_history),
    ...textSection('Catalogue', artwork.catalogue),
  );
  if (artwork.related_media && artwork.related_media.length > 0) {
    lines.push('', '### Related media');
    for (const media of artwork.related_media) {
      const kind = media.type ? ` (${inlineSafe(media.type)})` : '';
      lines.push(
        `- ${titleText(media.title)}${kind} · ${printableUrl(media.url)} · id ${inlineSafe(media.id)}`,
      );
    }
  }
  return lines;
}

export const getArtworks = tool('artic_get_artworks', {
  title: 'Get artworks',
  description:
    'Fetch full Art Institute of Chicago records for up to 10 artworks by id: description, provenance, exhibition and publication history, dimensions, inscriptions, credit line, categorization, gallery, image URLs with rights status, and related multimedia. Long histories are opt-in through sections. Ids come from artic_search_artworks, artic_search_exhibitions, or artic_search_artists.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: listInput(z.array(z.number().int().positive()).min(1).max(10), 10, artworkIdItem).describe(
      'Artwork ids, 1 to 10, as an array or a comma-separated string; https://www.artic.edu/artworks/<id> page URLs are read as their id. Duplicates are dropped.',
    ),
    sections: blankAsUnset(
      listInput(
        z
          .array(z.enum(SECTIONS))
          .max(5)
          .default([...DEFAULT_SECTIONS]),
        5,
      ),
    ).describe(
      'Heavy text sections to include: description (also short_description), provenance, exhibition_history, publication_history, catalogue. Defaults to description and provenance; pass an empty array for none.',
    ),
    include_related_media: blankAsUnset(z.boolean().default(true)).describe(
      'Load related multimedia (lectures, audio stops) for the records, up to 20 items per call.',
    ),
  }),
  output: z.object({
    artworks: z
      .array(ArtworkRecordSchema)
      .describe('Records in request order; ids the museum does not have are left out.'),
    missing_ids: z.array(z.number()).describe('Requested ids with no artwork, in request order.'),
    deferred_ids: z
      .array(z.number())
      .describe(
        'Found ids left out because the response budget was reached; request them in a follow-up call.',
      ),
    license_text: z.string().describe('License statement from the API for this data, verbatim.'),
    description_attribution: z
      .string()
      .optional()
      .describe('Attribution owed for description text (CC BY 4.0); present when any is returned.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when ids are missing or deferred, or related media was capped or could not load.',
      ),
  },
  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Art Institute API throttled this server and retries ran out, or the shared request queue could not start the call in time.',
      retryable: true,
      recovery:
        'Wait about a minute and retry; the Art Institute API allows about 60 requests per minute from this server, so batch ids into one artic_get_artworks call.',
      thrownBy: 'service',
    },
    {
      reason: 'request_blocked',
      code: JsonRpcErrorCode.Forbidden,
      when: "The Art Institute API's firewall blocked the request, as it does for markup or script-like text and for bursts of traffic.",
      retryable: false,
      recovery:
        'Wait about a minute, then call artic_get_artworks again with the same ids; ids carry no text the firewall could object to.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_query',
      code: JsonRpcErrorCode.InternalError,
      when: 'The Art Institute API rejected a request this server built from valid inputs.',
      retryable: false,
      recovery:
        'Retry artic_get_artworks with fewer ids, or with sections set to an empty array; the server built a request the API rejected.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { notices, ...records } = await loadArtworkRecords(
      {
        ids: input.ids,
        sections: input.sections,
        include_related_media: input.include_related_media,
        // format() puts each record on the wire a second time, as markdown.
        wireBytes: (record) => jsonBytes(record) + jsonBytes(recordLines(record).join('\n')),
      },
      ctx,
    );
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return records;
  },

  format: (result) => {
    const lines = [`# Artworks (${result.artworks.length} records)`];
    for (const artwork of result.artworks) lines.push('', ...recordLines(artwork));
    lines.push('');
    if (result.artworks.length === 0) lines.push('No records.');
    lines.push(
      `**Missing ids:** ${result.missing_ids.length > 0 ? result.missing_ids.join(', ') : 'none'}`,
      `**Deferred ids:** ${result.deferred_ids.length > 0 ? result.deferred_ids.join(', ') : 'none'}`,
    );
    if (result.description_attribution) {
      lines.push(`**Description attribution:** ${result.description_attribution}`);
    }
    lines.push('', '## License', quoteBlock(result.license_text));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
