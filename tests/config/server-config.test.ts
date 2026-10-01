/**
 * @fileoverview Tests for the server config: defaults, env parsing, blank
 * values reading as unset, bounds, and the process-wide cache.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULT_CONTACT = 'https://github.com/cyanheads/art-institute-chicago-mcp-server';

async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.stubEnv('AIC_CONTACT', undefined as unknown as string);
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults the contact to the repository URL and the budget to 50 per minute', async () => {
    const getServerConfig = await loadConfig();
    expect(getServerConfig()).toEqual({ contact: DEFAULT_CONTACT, requestsPerMinute: 50 });
  });

  it('reads both values from the environment', async () => {
    vi.stubEnv('AIC_CONTACT', 'ops@example.test');
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', '30');
    const getServerConfig = await loadConfig();
    expect(getServerConfig()).toEqual({ contact: 'ops@example.test', requestsPerMinute: 30 });
  });

  it('trims the contact', async () => {
    vi.stubEnv('AIC_CONTACT', '  ops@example.test  ');
    const getServerConfig = await loadConfig();
    expect(getServerConfig().contact).toBe('ops@example.test');
  });

  it('reads blank values as unset so a bundle install with empty options gets the defaults', async () => {
    vi.stubEnv('AIC_CONTACT', '');
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', '');
    const getServerConfig = await loadConfig();
    expect(getServerConfig()).toEqual({ contact: DEFAULT_CONTACT, requestsPerMinute: 50 });
  });

  it.each(['1', '600'])('accepts the budget bound %s', async (value) => {
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', value);
    const getServerConfig = await loadConfig();
    expect(getServerConfig().requestsPerMinute).toBe(Number(value));
  });

  it.each(['0', '601', '-5', '1.5', 'many'])(
    'rejects the budget %j and names the environment variable',
    async (value) => {
      vi.stubEnv('AIC_REQUESTS_PER_MINUTE', value);
      const getServerConfig = await loadConfig();
      expect(() => getServerConfig()).toThrow(/AIC_REQUESTS_PER_MINUTE/);
    },
  );

  it('rejects a contact over 200 characters and names the variable', async () => {
    vi.stubEnv('AIC_CONTACT', 'x'.repeat(201));
    const getServerConfig = await loadConfig();
    expect(() => getServerConfig()).toThrow(/AIC_CONTACT/);
  });

  it('accepts a contact in printable ASCII, spaces and punctuation included', async () => {
    vi.stubEnv('AIC_CONTACT', 'Ops Team <ops@example.test> (https://example.test/~ops?x=1)');
    const getServerConfig = await loadConfig();
    expect(getServerConfig().contact).toBe(
      'Ops Team <ops@example.test> (https://example.test/~ops?x=1)',
    );
  });

  it.each([
    ['an inner line feed', 'ops@example.test\nX-Injected: 1'],
    ['an inner carriage return', 'ops@example.test\rX-Injected: 1'],
    ['a tab', 'ops\t@example.test'],
    ['a DEL character', 'ops\u007f@example.test'],
    ['letters outside ASCII', 'ops 名前 <ops@example.jp>'],
    ['an accented letter', 'josé@example.test'],
  ])(
    'fails at startup on a contact with %s, naming the variable without echoing the value',
    async (_name, value) => {
      vi.stubEnv('AIC_CONTACT', value);
      const getServerConfig = await loadConfig();
      let message = '';
      try {
        getServerConfig();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/AIC_CONTACT/);
      expect(message).not.toContain(value.trim());
    },
  );

  it('parses once and returns the cached object afterwards', async () => {
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', '20');
    const getServerConfig = await loadConfig();
    const first = getServerConfig();
    vi.stubEnv('AIC_REQUESTS_PER_MINUTE', '40');
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().requestsPerMinute).toBe(20);
  });
});
