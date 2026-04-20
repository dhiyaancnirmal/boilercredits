import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SchoolEquivalenciesResponse,
  PurdueCatalogResponse,
  PurdueCourseEquivalenciesResponse,
} from "../src/types";
import { __clearMemoryCacheForTests, getCached } from "../src/lib/cache";
import { makeCacheKey } from "../src/lib/cache";
import { createRefreshJob, materializeRefreshJob } from "../src/lib/refresh";
import { buildPurdueCourseDirectory } from "../src/services/materialized-browse";

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

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
      const queryWithArgs = (args: unknown[]) => ({
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
        async all<T>() {
          if (sql.includes("SELECT payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-equivalencies:%'")) {
            return {
              results: [...materialized.entries()]
                .filter(([key]) => key.startsWith("purdue-course-equivalencies:"))
                .map(([, row]) => ({ payload_json: row.payload_json })) as T[],
            };
          }

          if (sql.includes("SELECT cache_key, payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%'")) {
            return {
              results: [...materialized.entries()]
                .filter(([key]) => key.startsWith("purdue-course-destinations:"))
                .map(([cache_key, row]) => ({ cache_key, payload_json: row.payload_json })) as T[],
            };
          }

          if (sql.includes("SELECT cache_key FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%' AND payload_json LIKE")) {
            const needle = String(args[0]).replace(/%/g, "");
            return {
              results: [...materialized.entries()]
                .filter(([key, row]) => key.startsWith("purdue-course-destinations:") && row.payload_json.includes(needle))
                .map(([cache_key]) => ({ cache_key })) as T[],
            };
          }

          if (sql.includes("SELECT cache_key FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%'")) {
            return {
              results: [...materialized.keys()]
                .filter((key) => key.startsWith("purdue-course-destinations:"))
                .map((cache_key) => ({ cache_key })) as T[],
            };
          }

          return { results: [] as T[] };
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
      });

      return {
        bind(...args: unknown[]) {
          return queryWithArgs(args);
        },
        ...queryWithArgs([]),
      };
    },
  } as unknown as D1Database;

  return { db, materialized, refreshJobs };
}

beforeEach(() => {
  __clearMemoryCacheForTests();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? new URL(input) : new URL(input.toString());

    if (url.pathname.endsWith("bzwtxcrd.p_ajax")) {
      const requestType = url.searchParams.get("request_type");
      if (requestType === "states") return new Response("Header\nIndiana~IN\nMichigan~MI");
      if (requestType === "school") return new Response("Header\nIvy Tech Community College - IN~001816");
      if (requestType === "subject") return new Response("Header\nENG~English\nMATH~Mathematics");
      if (requestType === "course") return new Response("Header\n111~Composition I\n112~Composition II");
      if (requestType === "purdue_course") return new Response("Header\n101~Intro to Engineering");
      if (requestType === "location") return new Response("Header\nDomestic~DOM");
      if (requestType === "state") return new Response("Header\nIndiana~IN");
      if (requestType === "purdue_schools") return new Response("Header\nIvy Tech - IN~IVYTECH001");
    }

    if (url.pathname.endsWith("bzwtxcrd.p_select_info")) {
      return new Response(`
        <select name="purdue_subject_in">
          <option value="">Select a subject</option>
          <option value="ENG">English</option>
          <option value="MA">Mathematics</option>
        </select>
      `);
    }

    if (url.pathname.endsWith("bzwtxcrd.p_display_report")) {
      return new Response(`
        <table class="reportTable">
          <tr><th>Institution</th><th>Transfer Subject</th><th>Transfer Course</th><th>Transfer Title</th><th>Transfer Credits</th><th>Purdue Subject</th><th>Purdue Course</th><th>Purdue Title</th><th>Purdue Credits</th></tr>
          <tr>
            <td>Ivy Tech Community College</td>
            <td>ENG</td>
            <td>111</td>
            <td>Composition I</td>
            <td>3.00</td>
            <td>ENG</td>
            <td>101</td>
            <td>Intro to Engineering</td>
            <td>3.00</td>
          </tr>
        </table>
      `);
    }

    return new Response("not found", { status: 404 });
  });
});

describe("refresh materialization", () => {
  it("hydrates and stores refreshed metadata responses", async () => {
    const kv = createFakeKV();
    const job = createRefreshJob("states", "states:US", { location: "US" }, 86400);

    await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

    const cached = await getCached<Array<{ name: string; code: string }>>(kv, undefined, "states:US");
    expect(cached).toEqual([
      { name: "Indiana", code: "IN" },
      { name: "Michigan", code: "MI" },
    ]);
  });

  describe("materialized browse", () => {
    it("materializeRefreshJob with kind purdue-catalog stores a payload retrievable from cache", async () => {
      const kv = createFakeKV();
      const job = createRefreshJob("purdue-catalog", "purdue-catalog", {}, 86400);

      await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

      const cached = await getCached<PurdueCatalogResponse>(kv, undefined, "purdue-catalog");
      expect(cached).not.toBeNull();
      expect(cached?.subjects).toHaveLength(2);
      expect(cached?.subjects).toContainEqual({ code: "ENG", name: "English" });
      expect(cached?.subjects).toContainEqual({ code: "MA", name: "Mathematics" });
      expect(cached?.courses).toBeInstanceOf(Array);
      expect(cached?.counts).toHaveProperty("totalCourses");
    });

    it("materializeRefreshJob with kind school-equivalencies stores a payload retrievable from cache", async () => {
      const kv = createFakeKV();
      const job = createRefreshJob("school-equivalencies", "school-equivalencies:IN:001816", {
        schoolId: "001816",
        state: "IN",
        location: "DOM",
      }, 86400);

      await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

      const cached = await getCached<SchoolEquivalenciesResponse>(kv, undefined, "school-equivalencies:IN:001816");
      expect(cached).not.toBeNull();
      expect(cached?.school).toEqual({ id: "001816", state: "IN", name: "Ivy Tech Community College" });
      expect(cached?.subjects).toBeInstanceOf(Array);
      expect(cached?.rows).toBeInstanceOf(Array);
      expect(cached?.counts).toHaveProperty("subjects");
      expect(cached?.counts).toHaveProperty("equivalencies");
    });

    it("materializeRefreshJob with kind purdue-course-equivalencies stores a payload retrievable from cache", async () => {
      const kv = createFakeKV();
      const job = createRefreshJob("purdue-course-equivalencies", "purdue-course-equivalencies:MA:101", {
        subject: "MA",
        course: "101",
      }, 86400);

      await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

      const cached = await getCached<PurdueCourseEquivalenciesResponse>(kv, undefined, "purdue-course-equivalencies:MA:101");
      expect(cached).not.toBeNull();
      expect(cached?.course).toMatchObject({ subject: "MA", course: "101" });
      expect(cached?.course).toHaveProperty("title");
      expect(cached?.course).toHaveProperty("credits");
      expect(cached?.states).toBeInstanceOf(Array);
      expect(cached?.institutionStates).toBeInstanceOf(Object);
      expect(cached?.rows).toBeInstanceOf(Array);
      expect(cached?.counts).toHaveProperty("institutions");
      expect(cached?.counts).toHaveProperty("equivalencies");
    });

    it("buildPurdueCourseDirectory only includes courses backed by non-empty equivalencies", async () => {
      const { db, materialized } = createFakeD1();
      const now = Date.now();
      const ttlMs = 86400 * 1000;

      materialized.set(makeCacheKey("purdue-course-equivalencies", "ENG", "101"), {
        payload_json: JSON.stringify({
          course: { subject: "ENG", course: "101", title: "Intro to Engineering", credits: "3.00" },
          states: ["IN"],
          institutionStates: {
            "Ivy Tech Community College": { code: "IN", label: "Indiana", location: "US" },
          },
          rows: [
            {
              transferInstitution: "Ivy Tech Community College",
              transferSubject: "ENG",
              transferCourse: "111",
              transferTitle: "Composition I",
              transferCredits: "3.00",
              purdueSubject: "ENG",
              purdueCourse: "101",
              purdueTitle: "Intro to Engineering",
              purdueCredits: "3.00",
            },
          ],
          counts: { institutions: 1, equivalencies: 1 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set(makeCacheKey("purdue-course-equivalencies", "MA", "16100"), {
        payload_json: JSON.stringify({
          course: { subject: "MA", course: "16100", title: "Calculus I", credits: "5.00" },
          states: [],
          institutionStates: {},
          rows: [],
          counts: { institutions: 0, equivalencies: 0 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      const directory = await buildPurdueCourseDirectory({ DB: db });

      expect(directory).toEqual([
        { subject: "ENG", course: "101", title: "Intro to Engineering" },
      ]);
    });
  });
});
