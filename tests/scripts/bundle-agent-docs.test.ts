/**
 * @fileoverview The bundle cleaner and packaging check strip dependency-shipped
 * agent docs from a `.mcpb` without touching runtime modules that live under a
 * nested `skills/` directory, such as the MCP SDK's `dist/ext/skills/`, which
 * the server imports at startup (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL: the shipped script's repo-only fallback import does not
 * resolve in this project, so a static import breaks the typecheck
 * (cyanheads/mcp-ts-core#797).
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/some-pkg/dist/framework-skills/index.js',
  'node_modules/some-pkg/dist/skills/guide/SKILL.md',
  'node_modules/@scope/skills/index.js',
  'node_modules/@scope/.claude/index.js',
  'skills/artic-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/@scope/some-pkg/skills/guide/references/notes.md',
  'node_modules/parent/node_modules/child/framework-skills/guide/SKILL.md',
  'node_modules/parent/node_modules/@scope/child/skills/guide/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/guide/SKILL.md',
  'node_modules/some-pkg/SKILL.md',
  'node_modules/@scope/some-pkg/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it('is the same literal in clean-mcpb.ts and lint-packaging.ts', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it.each(RUNTIME_ENTRIES)('keeps %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.checkBundleEntries([entry], 'test.mcpb')).toEqual([]);
  });

  it.each(AGENT_DOC_ENTRIES)('strips %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    const errors = lintPackaging.checkBundleEntries([entry], 'test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1 node_modules agent-doc entries');
  });
});
