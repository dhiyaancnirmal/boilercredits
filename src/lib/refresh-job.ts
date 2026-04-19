import type { RefreshJob, RefreshKind } from "../types";

type RefreshPayload = Record<string, string>;

function refreshDelay(ttlSeconds: number): number {
  return Math.max(Date.now() + 5 * 60 * 1000, Date.now() + Math.floor(ttlSeconds * 0.75) * 1000);
}

export function createRefreshJob(
  kind: RefreshKind,
  cacheKey: string,
  payload: RefreshPayload,
  ttlSeconds: number
): RefreshJob {
  return {
    kind,
    cacheKey,
    payload,
    ttlSeconds,
    nextRefreshAt: refreshDelay(ttlSeconds),
  };
}

/** Insert or update a row so the hydration worker picks up the job soon. */
export async function enqueueRefreshJobNow(env: { DB?: D1Database }, job: RefreshJob): Promise<void> {
  if (!env.DB) return;

  await env.DB
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
      job.cacheKey,
      job.kind,
      JSON.stringify(job.payload),
      job.ttlSeconds,
      Date.now(),
      Date.now()
    )
    .run();
}

export async function dispatchRefreshJobsNow(
  env: { DB?: D1Database; HYDRATION_QUEUE?: Queue<RefreshJob> },
  jobs: RefreshJob[]
): Promise<void> {
  if (!jobs.length) return;

  await Promise.all(jobs.map((job) => enqueueRefreshJobNow(env, job)));

  if (!env.HYDRATION_QUEUE) return;

  await env.HYDRATION_QUEUE.sendBatch(
    jobs.map((job) => ({
      body: job,
      contentType: "json" as const,
    }))
  );
}
