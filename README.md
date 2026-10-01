<div align="center">
  <h1>art-institute-chicago-mcp-server</h1>
  <p><b>Search the Art Institute of Chicago collection: artworks, artists, exhibitions, and audio guides via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/art-institute-chicago-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/art-institute-chicago-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/art-institute-chicago-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/art-institute-chicago-mcp-server/releases/latest/download/art-institute-chicago-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=art-institute-chicago-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXJ0LWluc3RpdHV0ZS1jaGljYWdvLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22art-institute-chicago-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fart-institute-chicago-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The Art Institute of Chicago's collection through the museum's public API: about 133,000 artworks, plus artists, exhibitions, and audio-guide stops. Search artworks with text, structured filters, and facet counts; read full records with provenance, exhibition history, and rights-aware IIIF image URLs; resolve artists to ids; find exhibitions by topic or date; and search audio-guide transcripts. Runs as a stdio process or a local Streamable HTTP server, with no API key.

### Tools

| Tool | Description |
|:---|:---|
| `artic_search_artworks` | Search artworks by text and filters (artist, department, type, style, subject, classification, place, gallery, years, public domain, on view, has image), with facet counts and date sorting |
| `artic_get_artworks` | Fetch full records for up to 10 artworks: description, provenance, exhibition and publication history, image URLs with rights status, related media |
| `artic_search_artists` | Find artists, cultures, and organizations by name or id, with life dates, artwork counts, and sample works |
| `artic_search_exhibitions` | Search past, current, and upcoming exhibitions by text and date, with the artworks shown when the museum lists them |
| `artic_search_audio_guide` | Search the museum's audio-guide stops by text: stop title, MP3 URL, and transcript |
| `artic_lookup_vocabulary` | List the values a search filter accepts (departments, types, styles, subjects, places, galleries, and more) with artwork counts |

### Resources

| Resource | Description |
|:---|:---|
| `artic://artworks/{id}` | One artwork record as JSON, with the API license text and description attribution |

The same record is available from `artic_get_artworks` for clients that don't surface resources.

## Capability reference

### `artic_search_artworks` <sub>tool</sub>

- `query` (every word must match; `"exact phrase"`, `-exclude`, and `a | b` work) plus filters `artist`, `artist_id`, `department`, `artwork_type`, `style`, `subject`, `classification`, `place_of_origin`, `gallery`, `year_from` / `year_to` (date-span overlap, negative for BCE), `public_domain_only`, `on_view_only`, and `has_image`, combined with AND
- Up to 12 rows per page (default 10), so a page of long catalog records stays within common tool-output limits, within the first 1,000 matches; `sort` is `relevance`, `date_asc`, or `date_desc`, and `sort_applied` reports `popularity` when relevance had no query text
- `facets` adds the top 15 values for up to seven fields (`artist` rows carry `artist_id`); `limit: 0` returns counts only

---

### `artic_get_artworks` <sub>tool</sub>

- 1–10 `ids` per call (artwork page URLs are read as their id); `sections` picks the heavy text: `description` and `provenance` by default, plus `exhibition_history`, `publication_history`, and `catalogue`
- Records return in request order, with `missing_ids` for ids the museum doesn't have and `deferred_ids` for records past a 100,000-byte response budget
- `include_related_media` (default on) loads up to 20 linked lectures and audio stops per call; `description_attribution` appears whenever CC BY description text is returned

---

### `artic_search_artists` <sub>tool</sub>

- `query` (all name words must match) or up to 25 `ids`, not both; query mode adds `artists_only` (default `true`), `born_from` / `born_to`, and up to 25 agents per page
- Each agent carries `artwork_count`, up to three `sample_works` (the museum's highlights first), life years, and `alt_names`; ids mode reports `missing_ids`

---

### `artic_search_exhibitions` <sub>tool</sub>

- `query`, `when` (`current`, `upcoming`, `past`, or the default `any`), and `date_from` / `date_to` (`YYYY-MM-DD`, matched by run overlap); up to 25 per page, pages 1–40
- `sort` is `relevance`, `start_desc`, or `start_asc`, defaulting to relevance with a query and `start_desc` without; `status` is the museum's label and doesn't say whether a show is open (`when` does)
- Rows carry dates, gallery, summary, web page, image, `artist_ids`, and the `artworks` shown when the museum lists them

---

### `artic_search_audio_guide` <sub>tool</sub>

- `query` is required and matches stop titles and transcripts (every word); up to 20 stops per page (default 5)
- Each stop has `title`, `audio_url` (MP3), and `transcript` but no artwork id; every response carries `license_text` and `source_citation`, since the content is for noncommercial educational and personal use

---

### `artic_lookup_vocabulary` <sub>tool</sub>

- `vocabulary` is one of `department`, `artwork_type`, `style`, `subject`, `classification`, `place_of_origin`, `gallery`, `material`, `technique`, or `theme`; optional `contains` substring (case-insensitive), `public_domain_only`, and up to 100 values (default 25)
- Values come back most common first with `artwork_count`, in the exact form the matching `artic_search_artworks` filter accepts; `filter_param` names that filter and is absent for `material`, `technique`, and `theme`, which work as query text

---

### `artic://artworks/{id}` <sub>resource</sub>

- `{ artwork, license_text, description_attribution?, notice? }` as `application/json`, where `artwork` is the `artic_get_artworks` record with its default sections and related media
- An unknown id fails as `artwork_not_found`; ids come from `artic_search_artworks`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Art Institute-specific:

- Keyless access to the Art Institute of Chicago public API (`api.artic.edu/api/v1`); IIIF image URLs are built from each record (843 px for every image, 1686 px and a IIIF manifest for public-domain works), never fetched
- One shared request pacer under the API's published limit of 60 requests a minute, retries for transient failures inside a 20-second deadline, and an in-process response cache (records 6 hours, searches 15 minutes, vocabularies 24 hours), so a repeated call spends no rate budget
- Text search requires every word to match, so totals are real and a miss reads as zero hits, while results keep the museum's own relevance order
- Placeholder years in the museum's data (outside −8000 to 2100) are left out of output, year filters, and date sorts; `date_display` stays the authority

Agent-friendly output:

- Rights travel with the data: `image.rights` (`public_domain` / `in_copyright`) on every image, with the 1686 px URL only where reuse is allowed; the API's `license_text` verbatim; `description_attribution` when CC BY text is returned; and `source_citation` on audio-guide results
- Partial results instead of failures: `artic_get_artworks` reports `missing_ids` and `deferred_ids`, and when a secondary lookup (related media, artist counts) fails, the primary records still return with a `notice` naming what is missing
- Paging that names the next move: `totalCount`, `has_more`, `next_page`, and a `notice` with the next page, the 1,000-match ceiling, or the filter to loosen after zero hits; facet and vocabulary values come back in the exact form the filters accept

## Data and licensing

The Art Institute of Chicago licenses its API data by surface, and the server passes the API's own `license_text` through with every artwork, artist, exhibition, and audio-guide result:

| Content | Terms |
|:---|:---|
| Artwork metadata, artists, exhibitions, vocabulary terms, related media | CC0 |
| Artwork `description` text | CC BY 4.0: credit the Art Institute of Chicago and cite the record's `web_url` |
| Artwork images | Reusable only for public-domain works (`image.rights: "public_domain"`, CC0); other images need a rights check |
| Audio-guide content | Noncommercial educational and personal use, with copyright notices kept and the source cited |

This server is an independent project and is not affiliated with or endorsed by the Art Institute of Chicago.

## Known limitations

- Only the first 1,000 matches of any search are reachable without an authenticated key. Broad questions need filters or facets.
- The API's limit of 60 requests a minute is per egress IP, so every client behind one IP shares it. Bursts queue behind the pacer, and a call that cannot start within its 20-second budget fails as `rate_limited`.
- Curatorial text is sparse: about 10% of artworks have a `description`, and in a general sample 94% lack provenance. About 1% of artists have a biography, and there is no nationality field, only `artist_display` prose.
- About 15 artworks carry placeholder years and about 4,900 carry no dates; neither matches a year filter.
- Some vocabulary titles are stored cut at 40 characters in the museum's own data (`gelatin silver (developing-out-paper) pr`). Filters match them only as stored, so pass values as `artic_lookup_vocabulary` lists them.
- The API's firewall refuses any request whose text contains markup such as `<script>`; the call fails as `request_blocked`.
- About 4% of exhibitions list their artworks, and `status` doesn't indicate whether a show is open.
- Audio-guide stops have no artwork link. Some titles are file names, and some transcripts are in Spanish.
- Image URLs can stop resolving when the museum unpublishes or replaces an image, and relevance order follows the museum's own ranking, which may shift as its models change.

## Getting started

Add the following to your MCP client configuration file. No API key is needed; `AIC_CONTACT` tells the museum how to reach you (see [Configuration](#configuration)).

```json
{
  "mcpServers": {
    "art-institute-chicago-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/art-institute-chicago-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "AIC_CONTACT": "you@example.com"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "art-institute-chicago-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/art-institute-chicago-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "AIC_CONTACT": "you@example.com"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "art-institute-chicago-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "AIC_CONTACT=you@example.com", "ghcr.io/cyanheads/art-institute-chicago-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account. The Art Institute API asks clients to identify themselves with a contact; set `AIC_CONTACT` to an email or URL.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/art-institute-chicago-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd art-institute-chicago-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set AIC_CONTACT
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `AIC_CONTACT` | Contact the museum can reach (an email or URL), sent in the `AIC-User-Agent` header the Art Institute API asks clients to include. Printable ASCII only; the server refuses to start on any other character. The default points at this repository; set your own contact for any deployment. | `https://github.com/cyanheads/art-institute-chicago-mcp-server` |
| `AIC_REQUESTS_PER_MINUTE` | Outbound requests per minute to `api.artic.edu`, 1–600. The default stays under the API's published limit of 60 a minute; raise it only if the museum grants a higher one. | `50` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and resource, sets the server instructions, and starts and stops the API service. |
| `src/config` | `AIC_CONTACT` and `AIC_REQUESTS_PER_MINUTE` parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and the artwork output schema they share. |
| `src/mcp-server/resources` | The `artic://artworks/{id}` resource. |
| `src/services/aic` | Art Institute API client: pacing, retries, response cache, HTML-to-text, IIIF URL construction, and the artwork and artist record builders. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.enrich` for paging and notices
- Register new tools and resources in the barrels under `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
