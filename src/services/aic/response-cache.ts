/**
 * @fileoverview In-process LRU cache for upstream response bodies, bounded by
 * entry count and total bytes, with a per-entry TTL and a per-entry size ceiling.
 * @module services/aic/response-cache
 */

interface CacheEntry {
  bytes: number;
  expiresAt: number;
  text: string;
}

export interface ResponseCacheOptions {
  maxEntries: number;
  /** Bodies larger than this are never cached. */
  maxEntryBytes: number;
  /** Total body bytes held across all entries. */
  maxTotalBytes: number;
  now: () => number;
}

/** LRU over response body text keyed by request URL. Map insertion order is recency order. */
export class ResponseCache {
  readonly #entries = new Map<string, CacheEntry>();
  #totalBytes = 0;

  constructor(private readonly options: ResponseCacheOptions) {}

  /** The cached body for `key`, or `undefined` when absent or expired. A hit becomes most recent. */
  get(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.options.now()) {
      this.#totalBytes -= entry.bytes;
      return;
    }
    this.#entries.set(key, entry);
    return entry.text;
  }

  /** Store a body for `ttlMs`, evicting least-recently-used entries past either bound. */
  set(key: string, text: string, bytes: number, ttlMs: number): void {
    if (bytes > this.options.maxEntryBytes) return;
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#totalBytes -= existing.bytes;
    }
    this.#entries.set(key, { text, bytes, expiresAt: this.options.now() + ttlMs });
    this.#totalBytes += bytes;
    for (const [oldestKey, oldest] of this.#entries) {
      if (
        this.#entries.size <= this.options.maxEntries &&
        this.#totalBytes <= this.options.maxTotalBytes
      ) {
        break;
      }
      this.#entries.delete(oldestKey);
      this.#totalBytes -= oldest.bytes;
    }
  }
}
