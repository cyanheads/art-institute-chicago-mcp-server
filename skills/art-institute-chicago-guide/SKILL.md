---
name: art-institute-chicago-guide
description: Gates and workflows for the artic_* tools over the Art Institute of Chicago collection. Covers finding works by an artist or culture, a work's exhibition history, counts and breakdowns past the 1,000-match window, provenance research, audio-guide stops versus linked media, accent-exact filter values, and what each output allows you to reuse. Use when answering questions about the museum's artworks, artists, exhibitions, or audio guide.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The Art Institute of Chicago's own public API, keyless: its artworks, the artists and cultures credited on them, its exhibition records, and its mobile audio-guide stops. It covers this one museum's holdings and shows. To compare with another museum, pair this server with that museum's server and join on artist name, title, and date. No shared authority id exists: `ulan_id` is present on almost no agent. Image URLs are built from the record without being fetched, so one can fail after the museum replaces an image. This is not a bulk export: every list goes through searches that can reach only the first 1,000 matches.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| Artwork id (integer) | artic_search_artworks rows, exhibition `artworks[]`, artist `sample_works`; an `artic.edu/artworks/<id>` URL also works | artic_get_artworks; artic_search_exhibitions `artwork_id` |
| Agent id (integer: person, culture, or organization) | artic_search_artists; an artwork's `artist_id` / `artist_ids`; artist facet rows | artic_search_artworks `artist_id`; artic_search_exhibitions `artist_id`; artic_search_artists `ids` |
| Exhibition id, audio-guide stop id, related-media uuid | their own results | No tool takes them. Use the row's `web_url`, `audio_url`, or `url` |
| `ulan_id` | artist records, rarely | Getty ULAN outside this server, never a museum id |

## Gates

**Works by someone: filter by `artist_id`, not `query`.** Query text also matches descriptions and provenance, so a name as query returns every work that mentions the artist. `monet` as query matches about three times as many works as Monet's own `artist_id`. Resolve the name with artic_search_artists, then filter artic_search_artworks by the id.

**Cultures are agents.** Ancient and unattributed works credit a culture as their artist: "Moche" is an agent with type Culture. Resolve it with artic_search_artists and filter by `artist_id`. That is more complete than `place_of_origin`, and more precise than query text, which also returns works that only mention the culture.

**`place_of_origin` is not hierarchical.** Values mix countries, regions, and cities. Most Moche works are tagged `peruvian north coast`, not `peru`. Seurat's *La Grande Jatte* is `france` and Caillebotte's *Paris Street; Rainy Day* is `paris`. A country value excludes its own cities and regions. Facet `place_of_origin` over your set first to see which values to include.

**Copy filter values exactly, accents included.** Filters ignore case but not accents: style `chimu` matches nothing and `chimú` matches. Only `place_of_origin` folds accents. Some titles are stored cut at 40 characters (`gelatin silver (developing-out-paper) pr`), and the full natural title matches nothing. Take values from artic_lookup_vocabulary, whose `contains` ignores accents, or from a facet row, and pass them verbatim.

**A work's exhibition history is in its record, not in the exhibition links.** The `artwork_id` and `artist_id` filters on artic_search_exhibitions see only shows whose record lists artworks, which is a small share. For *La Grande Jatte*, `artwork_id` returns nothing, yet its `exhibition_history` section lists shows from 1886 on. The museum's own 2004 Seurat exhibition exists in the exhibition records but lists no artworks. To answer "where has this work been shown", request the `exhibition_history` section from artic_get_artworks. To get a show's dates, gallery, and web page, search artic_search_exhibitions by query text.

**Missing text means unrecorded.** Most records carry no description and most carry no provenance; the field is simply absent. Say "the museum's record has no provenance text", never "no known provenance".

**Exhibition `status` does not mean current.** Shows that closed years ago can still read `Confirmed`. Use `when` (current, upcoming, past) or the date range instead.

## Licensing by output

| What you pass on | Duty |
|:--|:--|
| Titles, dates, credits, facets, exhibition records | CC0, nothing owed |
| `description` or `short_description` text | Credit the Art Institute of Chicago with the record's `web_url` (the response carries `description_attribution`) |
| An image | Reusable only when `image.rights` is `public_domain`; only those records carry `url_large` (1686px) and `manifest_url`. The 843px `url` on an `in_copyright` work is for viewing, so don't offer it for download, print, or reuse |
| An audio-guide transcript or MP3 | Noncommercial educational or personal use only. Keep the response's `license_text` and `source_citation` with it |

## Workflows

**Counts and breakdowns.** A search with `limit` 0 and facets returns exact totals, even far past 1,000, with no rows. Each facet lists its top 15 values. Department, artwork type, and place of origin hold at most one value per work, so their counts never overlap; they add up to the total only when the facet lists every value (it shows the top 15) and every work carries one. Style, subject, classification, and artist hold several values per work, so their counts overlap. In the Moche set, `ceramics`, `earthenware`, and `art of the americas` each cover nearly every work, so don't sum them or read them as shares. Material, technique, theme, and gallery have no facet. For those, list candidate values with artic_lookup_vocabulary, whose counts span the whole collection (or public-domain works only), then run one `limit` 0 search per value with your other filters.

**Listing more than 1,000 matches.** Paging stops at match 1,000. Split the set with filters until each slice holds under 1,000, and check each slice's total with `limit` 0 before listing it. Year windows, department, artwork type, or one facet value per slice all work. Year filters match by overlap: a work dated 1400–1599 falls into every window inside that span. Adjacent year slices therefore repeat broadly dated works, so dedupe by id and read `date_display` before calling a work "from" a window.

**Highlights.** With no query text, results come in the museum's popularity order. The themes `Art Institute Icons` and `Essentials` are curated highlight sets, and adding `on_view_only` gives the ones in the galleries now.

**Provenance research.** Query text searches provenance, so a dealer's or collector's name (`Durand-Ruel`) finds works whose ownership history names them. Narrow with `artist_id` or a year range, then read the `provenance` section (on by default) with artic_get_artworks, ten ids per call.

**Audio.** There are two separate sources:
- artic_get_artworks `related_media` lists the media the museum links to that artwork id (lectures, podcasts, audio stops) as asset links, without transcripts.
- artic_search_audio_guide returns mobile-guide stops with full transcripts and MP3 links, but no artwork id.

To find stops for a work, search the guide with the work's title or the artist's surname and confirm each match from the transcript. A query can return stops about other works that only mention yours, and stop titles are often file codes. One work can have several stops, such as a commentary and a verbal-description track. Each page holds two whole stops, so stop paging once you have the stop you need.
