import { Injectable } from '@nestjs/common';
import type { CachePort } from '../ports/cache.port';

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * Phase-1 cache: a Map with TTLs and a size cap, scoped to one process.
 *
 * Eviction is a simple insertion-order drop rather than true LRU. What lives here is small
 * and cheap to rebuild — the workflow config and per-user visibility scopes — so a wrong
 * eviction costs one extra query, and tracking recency would cost more than it saves.
 */
@Injectable()
export class MemoryCacheAdapter implements CachePort {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries = 5_000;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }

  async del(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k);
  }
}
