import type { CacheEntry, RefreshJob } from "../types";

const memoryCache = new Map<string, CacheEntry<unknown>>();

/** Clear the module-level memory cache. For test isolation only. */
export function __clearMemoryCacheForTests(): void {
  memoryCache.clear();
}

export type CacheSource =
  | "memory"
  | "kv"
  | "d1"
  | "memory-stale"
  | "kv-stale"
  | "d1-stale"
  | "miss";

export interface CacheResult<T> {
  data: T | null;
  source: CacheSource;
}

export interface CacheLookup<T> extends CacheResult<T> {
  expiresAt: number | null;
  stale: boolean;
}

function cacheState<T>(
  data: T,
  expiresAt: number,
  source: "memory" | "kv" | "d1"
): CacheLookup<T> {
  if (Date.now() < expiresAt) {
    return { data, expiresAt, source, stale: false };
  }

  return {
    data,
    expiresAt,
    source: `${source}-stale`,
    stale: true,
  };
}

export async function getCached<T>(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  key: string
): Promise<T | null> {
  const lookup = await getCachedWithMetadata<T>(kv, db, key);
  return lookup.stale ? null : lookup.data;
}

export async function setCache<T>(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  key: string,
  data: T,
  ttlSeconds: number,
  refreshJob?: RefreshJob
): Promise<void> {
  const entry: CacheEntry<T> = {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };

  memoryCache.set(key, entry as CacheEntry<unknown>);

  if (kv) {
    await kv.put(`cache:${key}`, JSON.stringify(entry), {
      expirationTtl: ttlSeconds,
    });
  }

  if (db) {
    await db
      .prepare(
        `INSERT INTO materialized_responses (cache_key, payload_json, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(key, JSON.stringify(data), entry.expiresAt, Date.now())
      .run();

    if (refreshJob) {
      const nextRefreshAt = refreshJob.nextRefreshAt ?? Math.max(
        Date.now() + 5 * 60 * 1000,
        entry.expiresAt - 15 * 60 * 1000
      );
      await db
        .prepare(
          `INSERT INTO refresh_jobs (cache_key, kind, payload_json, ttl_seconds, next_refresh_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(cache_key) DO UPDATE SET
             kind = excluded.kind,
             payload_json = excluded.payload_json,
             ttl_seconds = excluded.ttl_seconds,
             next_refresh_at = excluded.next_refresh_at,
             updated_at = excluded.updated_at`
        )
        .bind(
          refreshJob.cacheKey,
          refreshJob.kind,
          JSON.stringify(refreshJob.payload),
          refreshJob.ttlSeconds,
          nextRefreshAt,
          Date.now()
        )
        .run();
    }
  }
}

export async function getCachedWithMetadata<T>(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  key: string
): Promise<CacheLookup<T>> {
  const inMemory = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (inMemory) {
    return cacheState(inMemory.data, inMemory.expiresAt, "memory");
  }

  if (kv) {
    const raw = await kv.get(`cache:${key}`);
    if (raw) {
      const entry: CacheEntry<T> = JSON.parse(raw);
      return cacheState(entry.data, entry.expiresAt, "kv");
    }
  }

  if (db) {
    const row = await db
      .prepare(
        "SELECT payload_json, expires_at FROM materialized_responses WHERE cache_key = ?1"
      )
      .bind(key)
      .first<{ payload_json: string; expires_at: number }>();

    if (row) {
      const data = JSON.parse(row.payload_json) as T;
      memoryCache.set(key, {
        data,
        expiresAt: row.expires_at,
      });
      return cacheState(data, row.expires_at, "d1");
    }
  }

  return { data: null, expiresAt: null, source: "miss", stale: false };
}

export async function getCachedWithSource<T>(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  key: string
): Promise<CacheResult<T>> {
  const lookup = await getCachedWithMetadata<T>(kv, db, key);
  if (lookup.stale) {
    return { data: null, source: "miss" };
  }
  return { data: lookup.data, source: lookup.source };
}

export function makeCacheKey(...parts: string[]): string {
  return parts.join(":");
}
