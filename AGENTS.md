# Developer Protocol

**Server:** art-institute-chicago-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

The server wraps the Art Institute of Chicago public API (`https://api.artic.edu/api/v1`): keyless, read-only, Elasticsearch-backed. `docs/design.md` is the spec — tool contracts, the request boundary, resilience settings, numbered design decisions, and the verified API reference. Read the relevant section before changing a definition or the service.

- **One service, one host.** `AicService` (`src/services/aic/aic-service.ts`) makes every upstream call: a process-wide pacer (`AIC_REQUESTS_PER_MINUTE`, default 50, under the published 60/min anonymous limit), `withRetry` inside a 20 s deadline per request, an in-process LRU cache keyed by request URL, a 5 MiB body ceiling, and the `AIC-User-Agent` header built from `AIC_CONTACT`. Image URLs are constructed in `aic-text.ts`, never fetched.
- **Request boundary.** Plain `fetch`, not `fetchWithTimeout`: the API reports paging errors as 403 JSON, search-backend rejections as 400 text, and firewall blocks as a non-JSON 403, and each maps to its own reason (`page_beyond_window`, `upstream_rejected_query`, `request_blocked`). Only a 429 is `rate_limited`.
- **Search window.** Anonymous callers reach only `offset + limit ≤ 1000`. Every search tool keeps `page × limit` inside it and names the window in its notice.
- **Licensing is per surface.** Artwork metadata, agents, exhibitions, vocabulary terms, and `/sounds` assets are CC0; artwork `description` is CC BY 4.0 (`description_attribution`); images are reusable only when `is_public_domain`; audio-guide content is for noncommercial educational and personal use (`license_text` plus `source_citation`). An output that returns licensed text carries its terms.
- **Upstream text is data.** HTML becomes plain text once, at the service boundary, where upstream URLs also pass `httpUrl()`, the IIIF base `iiifBaseUrl()`, and image ids `iiifImageId()`, so a value that fails is absent. In `format()`, free text goes through `quoteBlock()`, inline slots through `inlineSafe()`, and URLs through `printableUrl()`; `structuredContent` keeps every string as received.
- **Secondary calls degrade.** When the second request fails in `artic_get_artworks` (related media) or `artic_search_artists` (artwork counts), the primary records return with a notice. Cancellation still rethrows.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Abridged from `src/mcp-server/tools/definitions/lookup-vocabulary.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAicService } from '@/services/aic/aic-service.js';
import {
  blankAsUnset,
  containsPattern,
  inlineSafe,
  VOCABULARY_FIELDS,
  VOCABULARY_FILTERS,
} from '@/services/aic/aic-text.js';

export const lookupVocabulary = tool('artic_lookup_vocabulary', {
  title: 'Look up collection vocabulary',
  description: 'List the values of an Art Institute of Chicago collection vocabulary with how many artworks carry each, …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    vocabulary: z.enum(VOCABULARIES).describe('Vocabulary to list. …'),
    // Every optional input is wrapped: a form client's "" becomes unset, or the default.
    contains: blankAsUnset(z.string().trim().max(60).optional()).describe('Case-insensitive substring …'),
    public_domain_only: blankAsUnset(z.boolean().default(false)).describe('Count only public-domain artworks.'),
    limit: blankAsUnset(z.number().int().min(1).max(100).default(25)).describe('Values to return, most common first (1-100).'),
  }),
  output: z.object({
    vocabulary: z.enum(VOCABULARIES).describe('The vocabulary listed.'),
    filter_param: z.enum(VOCABULARY_FILTERS).optional().describe('The artic_search_artworks parameter …'),
    values: z.array(/* { value, artwork_count } */).describe('Values, most common first.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more values exist beyond the limit.'),
    shown: z.number().describe('Values returned.'),
    cap: z.number().describe('The limit applied.'),
    notice: z.string().optional().describe('Guidance when no value matched or the list was capped.'),
  },
  errors: [
    // rate_limited and upstream_rejected_query are declared inline the same way
    {
      reason: 'request_blocked',
      code: JsonRpcErrorCode.Forbidden,
      when: "The Art Institute API's firewall blocked the request, as it does for markup or script-like text and for bursts of traffic.",
      retryable: false,
      recovery: 'Remove markup or script-like text, such as HTML tags, from contains, then call artic_lookup_vocabulary again; …',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Required enrichment fields are written first, before any branch or upstream call.
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    const result = await getAicService().aggregate(
      VOCABULARY_FIELDS[input.vocabulary],
      {
        size: input.limit,
        include: input.contains ? containsPattern(input.contains) : undefined,
        public_domain_only: input.public_domain_only,
      },
      ctx,
    );
    const values = result.buckets.map((b) => ({ value: b.key, artwork_count: b.doc_count }));
    ctx.enrich({ shown: values.length });
    if (result.sum_other_doc_count > 0) {
      ctx.enrich.truncated({ shown: values.length, cap: input.limit, guidance: 'More values exist: raise limit or narrow with contains.' });
    }
    // … zero-value notice
    return {
      vocabulary: input.vocabulary,
      ...(isFilterParam(input.vocabulary) ? { filter_param: input.vocabulary } : {}),
      values,
    };
  },

  // format() is the content[] twin of structuredContent: every output field appears,
  // and upstream values pass through inlineSafe() here, never in structuredContent.
  format: (result) => [{
    type: 'text',
    text: [
      `# ${result.vocabulary} values (${result.values.length})`,
      // … filter_param line
      ...result.values.map((v) => `- ${inlineSafe(v.value)} (${v.artwork_count} artworks)`),
    ].join('\n'),
  }],
});
```

The four search tools add the paging enrichment (`totalCount`, `truncated`, `shown`, `cap`, `notice`). Each handler writes it first (`ctx.enrich.total(0)`, then `ctx.enrich({ truncated: false, shown: 0, cap })`), pages with `pageInfo()` against the 1,000-match `SEARCH_WINDOW`, and composes one notice string that it writes once. `docs/design.md` § Shared conventions gives the order and the notice wording.

### Resource

Abridged from `src/mcp-server/resources/definitions/artwork.resource.ts`. The resource builds its record through the same `loadArtworkRecords()` path as `artic_get_artworks`, and embeds the license text, attribution, and notice in the payload, since resources carry no enrichment block:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DEFAULT_SECTIONS, jsonBytes, loadArtworkRecords } from '@/services/aic/artwork-records.js';

export const artworkResource = resource('artic://artworks/{id}', {
  name: 'artic-artwork',
  title: 'Artwork record',
  description: 'Read one Art Institute of Chicago artwork record by id as JSON: …',
  mimeType: 'application/json',
  params: z.object({
    id: z.string().regex(/^\d+$/).describe('Artwork id (digits), from artic_search_artworks.'),
  }),
  cacheHint: { ttlMs: 21_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'artwork_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No artwork has this id.',
      recovery: 'Find artwork ids with artic_search_artworks, then read artic://artworks/<id> again.',
    },
    // … rate_limited, request_blocked, upstream_rejected_query (thrownBy: 'service')
  ],

  async handler(params, ctx) {
    const id = Number(params.id);
    if (!Number.isSafeInteger(id)) {
      throw ctx.fail('artwork_not_found', `No artwork exists for id ${params.id}.`);
    }
    const { artworks, license_text, description_attribution, notices } = await loadArtworkRecords(
      { ids: [id], sections: DEFAULT_SECTIONS, include_related_media: true, wireBytes: jsonBytes },
      ctx,
    );
    const [artwork] = artworks;
    if (!artwork) throw ctx.fail('artwork_not_found', `No artwork exists for id ${params.id}.`);
    return {
      artwork,
      license_text,
      ...(description_attribution ? { description_attribution } : {}),
      ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
    };
  },
});
```

### Prompt

None. The cross-tool workflow lives in the `createApp()` `instructions`.

### Server config

`src/config/server-config.ts` (descriptions abridged):

```ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  contact: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\x20-\x7E]*$/, 'Use printable ASCII only …') // a header value: anything else fails at startup
    .default('https://github.com/cyanheads/art-institute-chicago-mcp-server')
    .describe('Contact the museum can reach (an email or URL, printable ASCII), sent in the AIC-User-Agent header …'),
  requestsPerMinute: z.coerce.number().int().min(1).max(600).default(50).describe('Outbound request budget per minute …'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'AIC_CONTACT',
    requestsPerMinute: 'AIC_REQUESTS_PER_MINUTE',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`AIC_REQUESTS_PER_MINUTE`) not the path (`requestsPerMinute`), and reads an empty value as unset, so a blank from a bundle install falls through to the default. Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

A new variable lands in `.env.example`, both `server.json` packages, `manifest.json` (`user_config` plus `mcp_config.env`), both plugin manifests, and the README Configuration table together.

### Server identity, instructions, and lifecycle

`src/index.ts` (instructions abridged):

```ts
await createApp({
  name: 'art-institute-chicago-mcp-server',
  title: 'art-institute-chicago-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions: 'Art Institute of Chicago collection data: about 133,000 artworks, artists, exhibitions, and audio-guide stops. …',
  setup(core) {
    const { contact, requestsPerMinute } = getServerConfig();
    initAicService({ contact, requestsPerMinute, version: core.config.mcpServerVersion });
  },
  teardown() {
    disposeAicService();
  },
});
```

Identity is `name` + `title`, both the unscoped package name (`lint:packaging` enforces the match); `description` comes from `package.json`. `instructions` (under the 2,048-character limit) carries the cross-tool workflow and the licensing terms, so update it with the tool names whenever the surface changes. `teardown()` disposes the service's pacer. No `sessionMode` is set: no tool calls `ctx.requestInput`, so the default posture applies, and `.env.example` and the Dockerfile set `MCP_SESSION_MODE=stateless`.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. A degraded secondary call logs at `warning`. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.total()` / `.truncated()`. Every tool declares an `enrichment` block: the search tools carry `totalCount`, `truncated`, `shown`, `cap`, and `notice`; `artic_lookup_vocabulary` drops `totalCount`; `artic_get_artworks` carries `notice` only. Reaches `structuredContent` and `content[]`. |
| `ctx.fail` | Throws a declared error-contract reason, typed against the definition's `errors[]` (see Errors). |
| `ctx.signal` | `AbortSignal` for cancellation. The service hands it to `withRetry`, and a degraded secondary call rethrows when it is aborted. |

Unused here: `ctx.state` (the response cache is in-process and shared across tenants, since the data is public), `ctx.requestInput` / `ctx.inputs`, and `ctx.content`. See the framework CLAUDE.md for the full `ctx` surface.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

**This server's contracts.** Every tool and the resource declare `rate_limited` (`RateLimited`, retryable), `request_blocked` (`Forbidden`), and `upstream_rejected_query` (`InternalError`) inline with `thrownBy: 'service'`; `code` and `when` match across definitions, and each `recovery` names that tool's own levers. Caller-input reasons (`page_beyond_window`, `invalid_year_range`, `invalid_date_range`, `query_or_ids_required`, `query_and_ids_conflict`) are `ValidationError` with `severity: 'notice'`. Upstream 5xx, timeouts, and unreadable bodies bubble as baseline `ServiceUnavailable` / `Timeout`. `docs/design.md` § Request boundary maps each upstream response to its reason.

---

## Structure

```text
src/
  index.ts                              # createApp(): identity, instructions, service setup/teardown
  config/
    server-config.ts                    # AIC_CONTACT, AIC_REQUESTS_PER_MINUTE (Zod schema)
  services/
    aic/
      aic-service.ts                    # AicService: request boundary, pacer, retry, cache (init/accessor pattern)
      aic-text.ts                       # Pure helpers: HTML to text, inlineSafe, URL builders, input preprocessors, paging
      artwork-records.ts                # artic_get_artworks records: response budget, related media
      artist-records.ts                 # Artwork counts and sample works for artic_search_artists
      response-cache.ts                 # LRU bounded by entries and bytes
      types.ts                          # Domain types
  mcp-server/
    tools/
      artwork-output.ts                 # Artwork output schema and markdown shared by the artwork tools
      definitions/
        index.ts                        # allToolDefinitions barrel
        search-artworks.tool.ts         # artic_search_artworks
        get-artworks.tool.ts            # artic_get_artworks
        search-artists.tool.ts          # artic_search_artists
        search-exhibitions.tool.ts      # artic_search_exhibitions
        search-audio-guide.tool.ts      # artic_search_audio_guide
        lookup-vocabulary.tool.ts       # artic_lookup_vocabulary
    resources/definitions/
      index.ts                          # allResourceDefinitions barrel
      artwork.resource.ts               # artic://artworks/{id}
tests/
  fixtures/                             # Upstream payloads, service and tool kits
  config/ services/ tools/ resources/   # Tests mirroring src/
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-artworks.tool.ts` |
| Tool names | snake_case, `artic_` prefix | `artic_search_artworks` |
| Resource URIs | `artic://` scheme | `artic://artworks/{id}` |
| Directories | kebab-case | `src/services/aic/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start` | Run the built server (`node dist/index.js`, transport from env) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from the pushed tag (release step) |
| `bun run publish-mcp` | Publish `server.json` to the MCP Registry (release step) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getAicService } from '@/services/aic/aic-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Optional inputs wrapped in `blankAsUnset()`; array inputs go through `listInput()` with a `.max()` cap
- [ ] Upstream strings in `format()` pass through `inlineSafe()` (inline slots), `quoteBlock()` (free text), or `printableUrl()` (URLs); `structuredContent` keeps them as received
- [ ] Every definition that calls the service declares `rate_limited`, `request_blocked`, and `upstream_rejected_query` (`thrownBy: 'service'`), each `recovery` naming that tool's own levers
- [ ] Licensed text carries its terms: `license_text` on every artwork, artist, exhibition, and audio-guide result, `description_attribution` with description text, `source_citation` with audio-guide content
- [ ] A new or renamed tool is reflected in the `createApp()` `instructions` (under 2,048 characters), the README, and `docs/design.md`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
