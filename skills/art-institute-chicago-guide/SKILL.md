---
name: art-institute-chicago-guide
description: Gates and workflows for the artic_* tools over the Art Institute of Chicago collection. Covers finding works by an artist or culture, a work's exhibition history, counts and breakdowns past the 1,000-match window, provenance research and acquisition years, audio-guide stops versus linked media, accent-exact filter values, and what each output allows you to reuse. Use when answering questions about the museum's artworks, artists, exhibitions, or audio guide.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
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

**Exhibition `status` does not mean current.** Shows that closed years ago can still read `Confirmed`. Use `when` (current, upcoming, past) or the date range instead. An exhibition row with no `end` has no recorded closing date, which is not the same as still open. `when` and the date filters read `status` only for those rows: one marked `Closed` counts as past (a window reads it as running on its opening date alone), and any other runs on from its opening. A row with no `start` is never current or upcoming, and a row with no dates at all matches no window, so a date search is not proof a show did not happen.

**Stop words are ignored in query text.** On artworks, exhibitions, and the audio guide, common English words such as `the`, `of`, and `a` are left out of `query`, so `The Old Guitarist` searches `Old Guitarist`. Words inside a quoted phrase stay. Artist search keeps every word.

**Acquisition years are fiscal years, and many works have none.** `acquisition_fiscal_year` is the fiscal year the museum acquired the work. It can differ by one from the year in `main_reference_number`, and it is absent when unrecorded. `acquired_from` and `acquired_to` never match a work without one, so a count under them is a floor, not the full set; the response notice says so. `sort: acquired_desc` lists recent acquisitions first and `acquired_asc` oldest first, both with unrecorded works last.

**Date sorts keep undated works.** `date_asc` and `date_desc` order by start year with works that have none last, and leave out only records with a placeholder start year. Year filters, unlike sorts, never match a work with no start year.

## Licensing by output

| What you pass on | Duty |
|:--|:--|
| Titles, dates, credits, facets, exhibition records | CC0, nothing owed |
| `description` or `short_description` text | Credit the Art Institute of Chicago with the record's `web_url` (the response carries `description_attribution`) |
| An image | Reusable only when `image.rights` is `public_domain`; only those records carry `url_large` (1686px) and `manifest_url`. The 843px `url` on an `in_copyright` work is for viewing, so don't offer it for download, print, or reuse |
| An audio-guide transcript or MP3 | Noncommercial educational or personal use only. Keep the response's `license_text` and `source_citation` with it |

## Workflows

**Counts and breakdowns.** A search with `limit` 0 and facets returns exact totals, even far past 1,000, with no rows. Each facet lists its top 15 values, and `facets` takes all eleven names in one call: department, artwork_type, style, subject, classification, material, technique, theme, place_of_origin, gallery, and artist. Department, artwork type, and place of origin hold at most one value per work, so their counts never overlap; they add up to the total only when the facet lists every value (it shows the top 15) and every work carries one. Style, subject, classification, material, technique, theme, and artist hold several values per work, so their counts overlap. In the Moche set, `ceramics`, `earthenware`, and `art of the americas` each cover nearly every work, so don't sum them or read them as shares. Gallery holds at most one value, but only works on view carry one, so its counts cover on-view works alone. To ask which galleries hold a set, filter `on_view_only` and facet `gallery`. To count a value that is not among the top 15, list candidates with artic_lookup_vocabulary, whose counts span the whole collection (or public-domain works only), then run one `limit` 0 search per value with your other filters.

**Listing more than 1,000 matches.** Paging stops at match 1,000, and a page holds up to 100 rows (the default is 10, so set `limit`; artic_get_artworks and artist `ids` also take 100 ids per call, with `deferred_ids` for the rest). Use a `limit` that divides 1,000 (10, 20, 25, 50, or 100): with any other, the last page ends short of match 1,000 (at `limit` 30, page 33 ends at match 990). Keep the same `limit` when following `next_page`. Split the set with filters until each slice holds under 1,000, and check each slice's total with `limit` 0 before listing it. Year windows, department, artwork type, or one facet value per slice all work. Year filters match by overlap: a work dated 1400–1599 falls into every window inside that span. Adjacent year slices therefore repeat broadly dated works, so dedupe by id and read `date_display` before calling a work "from" a window.

**Highlights.** With no query text, results come in the museum's popularity order. The themes `Art Institute Icons` and `Essentials` are curated highlight sets, and adding `on_view_only` gives the ones in the galleries now.

**Provenance research.** Query text searches provenance, so a dealer's or collector's name (`Durand-Ruel`) finds works whose ownership history names them. Narrow with `artist_id` or a year range, then read the `provenance` section (on by default) with artic_get_artworks, up to 100 ids per call. Request only the sections you will read: every section on 100 well-documented works comes to about 1.4 MB.

For a review keyed to when the museum acquired works (made before 1946 and acquired after 1932, say), `acquired_from` / `acquired_to` and `acquisition_fiscal_year` help but do not complete the set. Works with no recorded fiscal year never match the acquired filters and many works fall in that group, so also search them by year range alone and read their `provenance` text. Search rows carry `main_reference_number`, so a query for an accession number such as `1942.51` shows which row is the exact match.

**Audio.** There are two separate sources:
- artic_get_artworks `related_media` lists the media the museum links to that artwork id (lectures, podcasts, audio stops) as asset links, without transcripts.
- artic_search_audio_guide returns mobile-guide stops with full transcripts and MP3 links, but no artwork id.

To find stops for a work, search the guide with the work's title or the artist's surname and confirm each match from the transcript. A query can return stops about other works that only mention yours, and stop titles are often file codes. One work can have several stops, such as a commentary and a verbal-description track. A page holds 2 stops by default, each with its whole transcript, and up to 100 with `limit`, so raise `limit` to read up to 100 matching stops in one call.
