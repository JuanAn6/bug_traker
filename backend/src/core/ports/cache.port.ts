export const CACHE_PORT = Symbol('CACHE_PORT');

/**
 * Minimal cache contract. The memory adapter is per-process; swapping in Redis makes
 * invalidation cross-instance, which is what the workflow `revision` key is designed for.
 */
export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string | string[]): Promise<void>;
  /** Drops every key beginning with `prefix`. Used when a whole scope goes stale. */
  delByPrefix(prefix: string): Promise<void>;
}
