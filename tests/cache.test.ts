import { beforeEach, describe, expect, it } from "vitest";
import { __clearMemoryCacheForTests, getCachedWithMetadata } from "../src/lib/cache";
import { seedWarmMaterializations } from "../src/lib/refresh";

beforeEach(() => {
  __clearMemoryCacheForTests();
});

function createFakeD1() {
  const materialized = new Map<string, { payload_json: string; expires_at: number; updated_at: number }>();
  const refreshJobs = new Map<
    string,
    {
      cache_key: string;
      kind: string;
      payload_json: string;
      ttl_seconds: number;
      next_refresh_at: number;
      updated_at: number;
    }
  >();

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("SELECT payload_json, expires_at FROM materialized_responses")) {
                return (materialized.get(String(args[0])) ?? null) as T | null;
              }

              if (sql.includes("SELECT expires_at FROM materialized_responses")) {
                const row = materialized.get(String(args[0]));
                return (row ? { expires_at: row.expires_at } : null) as T | null;
              }

              return null as T | null;
            },
            async run() {
              if (sql.includes("INSERT INTO materialized_responses")) {
                materialized.set(String(args[0]), {
                  payload_json: String(args[1]),
                  expires_at: Number(args[2]),
                  updated_at: Number(args[3]),
                });
              }

              if (sql.includes("INSERT INTO refresh_jobs")) {
                refreshJobs.set(String(args[0]), {
                  cache_key: String(args[0]),
                  kind: String(args[1]),
                  payload_json: String(args[2]),
                  ttl_seconds: Number(args[3]),
                  next_refresh_at: Number(args[4]),
                  updated_at: Number(args[5]),
                });
              }

              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, materialized, refreshJobs };
}

describe("cache metadata", () => {
  it("returns stale D1 entries instead of forcing a miss", async () => {
    const { db, materialized } = createFakeD1();
    const now = Date.now();

    materialized.set("school-equivalencies:US:IN:001816", {
      payload_json: JSON.stringify({ rows: [{ id: 1 }] }),
      expires_at: now - 1_000,
      updated_at: now - 2_000,
    });

    const cached = await getCachedWithMetadata<{ rows: Array<{ id: number }> }>(
      undefined,
      db,
      "school-equivalencies:US:IN:001816"
    );

    expect(cached.stale).toBe(true);
    expect(cached.source).toBe("d1-stale");
    expect(cached.data).toEqual({ rows: [{ id: 1 }] });
  });

  it("does not let stale memory shadow a fresher D1 value", async () => {
    const { db, materialized } = createFakeD1();
    const key = "school-equivalencies:US:IN:001816";
    const now = Date.now();

    materialized.set(key, {
      payload_json: JSON.stringify({ rows: [{ id: 1 }] }),
      expires_at: now - 1_000,
      updated_at: now - 2_000,
    });

    const stale = await getCachedWithMetadata<{ rows: Array<{ id: number }> }>(
      undefined,
      db,
      key
    );

    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("d1-stale");

    materialized.set(key, {
      payload_json: JSON.stringify({ rows: [{ id: 2 }] }),
      expires_at: now + 60_000,
      updated_at: now,
    });

    const fresh = await getCachedWithMetadata<{ rows: Array<{ id: number }> }>(
      undefined,
      db,
      key
    );

    expect(fresh.stale).toBe(false);
    expect(fresh.source).toBe("d1");
    expect(fresh.data).toEqual({ rows: [{ id: 2 }] });
  });
});

describe("warm materialization seeding", () => {
  it("seeds the global targets (purdue-catalog + all-schools buckets) on a cold D1", async () => {
    const { db, refreshJobs } = createFakeD1();

    await seedWarmMaterializations({
      ENVIRONMENT: "production",
      DB: db,
    });

    expect(refreshJobs.has("purdue-catalog")).toBe(true);
    expect(refreshJobs.has("all-schools:US")).toBe(true);
    expect(refreshJobs.has("all-schools:Outside US")).toBe(true);
  });

  it("skips global targets that are still fresh and does not enqueue rotations without cached deps", async () => {
    const { db, materialized, refreshJobs } = createFakeD1();
    const now = Date.now();

    materialized.set("purdue-catalog", {
      payload_json: JSON.stringify({ courses: [] }),
      expires_at: now + 60_000,
      updated_at: now,
    });
    materialized.set("all-schools:US", {
      payload_json: JSON.stringify([]),
      expires_at: now + 60_000,
      updated_at: now,
    });
    materialized.set("all-schools:Outside US", {
      payload_json: JSON.stringify([]),
      expires_at: now + 60_000,
      updated_at: now,
    });

    await seedWarmMaterializations({
      ENVIRONMENT: "production",
      DB: db,
    });

    // purdue-catalog had empty courses and all-schools had empty lists, so no
    // rotations produce work; and the global targets were fresh so no re-seed.
    expect(refreshJobs.size).toBe(0);
  });

  it("rotates per-course and per-school jobs once the dependency caches are warm", async () => {
    const { db, materialized, refreshJobs } = createFakeD1();
    const now = Date.now();

    materialized.set("purdue-catalog", {
      payload_json: JSON.stringify({
        courses: [
          { subject: "MA", course: "16100", title: "Calculus I" },
          { subject: "ENG", course: "10600", title: "Composition" },
        ],
        subjects: [],
        counts: { totalCourses: 2 },
      }),
      expires_at: now + 60_000,
      updated_at: now,
    });
    materialized.set("all-schools:US", {
      payload_json: JSON.stringify([
        { id: "001073", state: "IN", name: "Butler Univ Indianapolis" },
      ]),
      expires_at: now + 60_000,
      updated_at: now,
    });
    materialized.set("all-schools:Outside US", {
      payload_json: JSON.stringify([]),
      expires_at: now + 60_000,
      updated_at: now,
    });

    await seedWarmMaterializations({
      ENVIRONMENT: "production",
      DB: db,
    });

    const kinds = new Set(Array.from(refreshJobs.values()).map((j) => j.kind));
    expect(kinds.has("purdue-course-equivalencies")).toBe(true);
    expect(kinds.has("purdue-course-destinations")).toBe(true);
    expect(kinds.has("school-equivalencies")).toBe(true);
  });
});
