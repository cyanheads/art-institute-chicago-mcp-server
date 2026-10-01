/**
 * @fileoverview Tests for the response cache: entry cap, byte cap, per-entry
 * ceiling, LRU recency, and TTL expiry through the injected clock.
 * @module tests/services/response-cache.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ResponseCache, type ResponseCacheOptions } from '@/services/aic/response-cache.js';

describe('ResponseCache', () => {
  let clock: { now: number };
  const make = (overrides: Partial<ResponseCacheOptions> = {}) =>
    new ResponseCache({
      maxEntries: 3,
      maxEntryBytes: 100,
      maxTotalBytes: 250,
      now: () => clock.now,
      ...overrides,
    });

  beforeEach(() => {
    clock = { now: 1_000 };
  });

  describe('lookup and TTL', () => {
    it('returns the stored body and undefined for an absent key', () => {
      const cache = make();
      cache.set('a', 'alpha', 5, 1_000);
      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('missing')).toBeUndefined();
    });

    it('serves an entry until its TTL elapses, expiring exactly at the boundary', () => {
      const cache = make();
      cache.set('a', 'alpha', 5, 1_000);
      clock.now = 1_000 + 999;
      expect(cache.get('a')).toBe('alpha');
      clock.now = 1_000 + 1_000;
      expect(cache.get('a')).toBeUndefined();
    });

    it('gives each entry its own TTL', () => {
      const cache = make();
      cache.set('short', 's', 1, 100);
      cache.set('long', 'l', 1, 10_000);
      clock.now += 500;
      expect(cache.get('short')).toBeUndefined();
      expect(cache.get('long')).toBe('l');
    });

    it('does not extend an entry TTL on a hit', () => {
      const cache = make();
      cache.set('a', 'alpha', 5, 1_000);
      clock.now += 600;
      expect(cache.get('a')).toBe('alpha');
      clock.now += 600;
      expect(cache.get('a')).toBeUndefined();
    });

    it('drops an expired entry so a second lookup stays a miss', () => {
      const cache = make();
      cache.set('a', 'alpha', 5, 10);
      clock.now += 10;
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('a')).toBeUndefined();
    });

    it('overwriting a key replaces the body and restarts its TTL', () => {
      const cache = make();
      cache.set('a', 'old', 3, 1_000);
      clock.now += 900;
      cache.set('a', 'new', 3, 1_000);
      clock.now += 900;
      expect(cache.get('a')).toBe('new');
    });
  });

  describe('entry cap', () => {
    it('evicts the least recently used entry past maxEntries', () => {
      const cache = make();
      for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key, 1, 10_000);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
      expect(cache.get('d')).toBe('d');
    });

    it('treats a hit as recent use', () => {
      const cache = make();
      for (const key of ['a', 'b', 'c']) cache.set(key, key, 1, 10_000);
      expect(cache.get('a')).toBe('a');
      cache.set('d', 'd', 1, 10_000);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe('a');
    });

    it('treats an overwrite as recent use and does not count the key twice', () => {
      const cache = make();
      for (const key of ['a', 'b', 'c']) cache.set(key, key, 1, 10_000);
      cache.set('a', 'a2', 1, 10_000);
      expect(cache.get('b')).toBe('b');
      cache.set('d', 'd', 1, 10_000);
      expect(cache.get('c')).toBeUndefined();
      expect(cache.get('a')).toBe('a2');
      expect(cache.get('b')).toBe('b');
      expect(cache.get('d')).toBe('d');
    });
  });

  describe('byte cap', () => {
    it('evicts oldest entries until the total fits', () => {
      const cache = make();
      cache.set('a', 'a', 100, 10_000);
      cache.set('b', 'b', 100, 10_000);
      cache.set('c', 'c', 100, 10_000);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
    });

    it('evicts more than one entry when a larger body needs the room', () => {
      const cache = make({ maxEntries: 10 });
      cache.set('a', 'a', 80, 10_000);
      cache.set('b', 'b', 80, 10_000);
      cache.set('c', 'c', 80, 10_000);
      cache.set('d', 'd', 100, 10_000);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe('c');
      expect(cache.get('d')).toBe('d');
    });

    it('accepts a total exactly at the cap', () => {
      const cache = make({ maxEntries: 10 });
      cache.set('a', 'a', 100, 10_000);
      cache.set('b', 'b', 100, 10_000);
      cache.set('c', 'c', 50, 10_000);
      expect(cache.get('a')).toBe('a');
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
    });

    it('releases the bytes of an overwritten entry', () => {
      const cache = make({ maxEntries: 10 });
      cache.set('a', 'a', 100, 10_000);
      cache.set('b', 'b', 100, 10_000);
      cache.set('a', 'a2', 10, 10_000);
      cache.set('c', 'c', 100, 10_000);
      expect(cache.get('a')).toBe('a2');
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
    });

    it('releases the bytes of an expired entry once it is read', () => {
      const cache = make({ maxEntries: 10 });
      cache.set('a', 'a', 100, 10);
      cache.set('b', 'b', 100, 10_000);
      clock.now += 10;
      expect(cache.get('a')).toBeUndefined();
      cache.set('c', 'c', 100, 10_000);
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
    });
  });

  describe('per-entry ceiling', () => {
    it('does not store a body over maxEntryBytes', () => {
      const cache = make();
      cache.set('big', 'x', 101, 10_000);
      expect(cache.get('big')).toBeUndefined();
    });

    it('stores a body exactly at maxEntryBytes', () => {
      const cache = make();
      cache.set('edge', 'x', 100, 10_000);
      expect(cache.get('edge')).toBe('x');
    });

    it('does not evict other entries to make room for a refused body', () => {
      const cache = make();
      cache.set('a', 'a', 100, 10_000);
      cache.set('b', 'b', 100, 10_000);
      cache.set('big', 'x', 500, 10_000);
      expect(cache.get('a')).toBe('a');
      expect(cache.get('b')).toBe('b');
    });
  });
});
