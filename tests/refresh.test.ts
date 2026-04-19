import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SchoolEquivalenciesResponse,
  SchoolOutboundEquivalenciesResponse,
  PurdueCatalogResponse,
  PurdueCourseEquivalenciesResponse,
} from "../src/types";
import { __clearMemoryCacheForTests, getCached } from "../src/lib/cache";
import { makeCacheKey } from "../src/lib/cache";
import { createRefreshJob, materializeRefreshJob } from "../src/lib/refresh";
import {
  buildOutboundSchoolDirectory,
  buildPurdueCourseDirectory,
  buildSchoolOutboundEquivalencies,
} from "../src/services/materialized-browse";
import { PurdueUpstreamError } from "../src/services/purdue-client";

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

function createFakeQueue() {
  const batches: Array<Array<{ body: unknown; contentType: string }>> = [];
  return {
    batches,
    queue: {
      async sendBatch(batch: Array<{ body: unknown; contentType: string }>) {
        batches.push(batch);
      },
    } as unknown as Queue,
  };
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

    it("materializeRefreshJob with kind school-outbound-equivalencies caches when all per-course reverse data is warm", async () => {
      const kv = createFakeKV();
      const now = Date.now();
      const ttlMs = 86400 * 1000;

      // Pre-populate the caches the outbound aggregation walks. buildPurdueCatalog
      // produces { subject: "ENG"|"MA", course: "101" } from the fake fetch, so
      // we seed a matching catalog + per-course reverse entry for each.
      await kv.put(
        "cache:purdue-catalog",
        JSON.stringify({
          data: {
            courses: [
              { subject: "ENG", course: "101", title: "Intro to Engineering" },
              { subject: "MA", course: "101", title: "Math 101" },
            ],
            subjects: [],
            counts: { totalCourses: 2 },
          },
          expiresAt: now + ttlMs,
        })
      );
      for (const subject of ["ENG", "MA"]) {
        await kv.put(
          `cache:purdue-course-equivalencies:${subject}:101`,
          JSON.stringify({
            data: {
              course: { subject, course: "101", title: "", credits: "" },
              states: [],
              institutionStates: {},
              rows: [],
              counts: { institutions: 0, equivalencies: 0 },
            },
            expiresAt: now + ttlMs,
          })
        );
      }

      const job = createRefreshJob(
        "school-outbound-equivalencies",
        "school-outbound-equivalencies:US:IN:001816",
        {
          schoolId: "001816",
          state: "IN",
          location: "US",
        },
        86400
      );

      await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

      const cached = await getCached<SchoolOutboundEquivalenciesResponse>(
        kv,
        undefined,
        "school-outbound-equivalencies:US:IN:001816"
      );
      expect(cached).not.toBeNull();
      expect(cached?.school).toEqual({ id: "001816", state: "IN", name: "Ivy Tech Community College" });
      expect(cached?.rows).toBeInstanceOf(Array);
      expect(cached?.counts.coursesMissingCache).toBe(0);
    });

    it("buildOutboundSchoolDirectory only includes schools backed by equivalency rows", async () => {
      const { db, materialized } = createFakeD1();
      const now = Date.now();
      const ttlMs = 86400 * 1000;

      materialized.set(makeCacheKey("all-schools", "US"), {
        payload_json: JSON.stringify([
          { name: "Ivy Tech Community College", id: "001816", state: "IN" },
          { name: "Lansing Community College", id: "002351", state: "MI" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set(makeCacheKey("all-schools", "Outside US"), {
        payload_json: JSON.stringify([]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

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
          counts: { institutions: 2, equivalencies: 1 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set(makeCacheKey("purdue-course-destinations", "ENG", "101"), {
        payload_json: JSON.stringify([
          { location: "US", state: "IN", subregionName: "Indiana", id: "001816", name: "Ivy Tech Community College" },
          { location: "US", state: "MI", subregionName: "Michigan", id: "002351", name: "Lansing Community College" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      const directory = await buildOutboundSchoolDirectory({ DB: db });

      expect(directory).toEqual([
        {
          name: "Ivy Tech Community College",
          id: "001816",
          state: "IN",
          catalog: "US",
        },
      ]);
    });

    it("buildPurdueCourseDirectory separates inbound and outbound browse lists by real cached data", async () => {
      const { db, materialized } = createFakeD1();
      const now = Date.now();
      const ttlMs = 86400 * 1000;

      materialized.set(makeCacheKey("purdue-catalog"), {
        payload_json: JSON.stringify({
          courses: [
            { subject: "ENG", course: "101", title: "Intro to Engineering" },
            { subject: "MA", course: "16100", title: "Calculus I" },
            { subject: "CS", course: "18000", title: "Problem Solving And Object-Oriented Programming" },
          ],
          subjects: [
            { code: "ENG", name: "English" },
            { code: "MA", name: "Mathematics" },
            { code: "CS", name: "Computer Science" },
          ],
          counts: { totalCourses: 3 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });

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

      materialized.set(makeCacheKey("purdue-course-destinations", "CS", "18000"), {
        payload_json: JSON.stringify([
          { location: "US", state: "IN", subregionName: "Indiana", id: "001816", name: "Ivy Tech Community College" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set(makeCacheKey("purdue-course-destinations", "MA", "16100"), {
        payload_json: JSON.stringify([]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      const inbound = await buildPurdueCourseDirectory({ DB: db }, "inbound");
      const outbound = await buildPurdueCourseDirectory({ DB: db }, "outbound");

      expect(inbound).toEqual([
        { subject: "ENG", course: "101", title: "Intro to Engineering" },
      ]);
      expect(outbound).toEqual([
        { subject: "CS", course: "18000", title: "Problem Solving And Object-Oriented Programming" },
      ]);
    });

    it("materializeRefreshJob with kind school-outbound-equivalencies does NOT cache when reverse data is incomplete", async () => {
      const kv = createFakeKV();

      const job = createRefreshJob(
        "school-outbound-equivalencies",
        "school-outbound-equivalencies:US:IN:001816",
        {
          schoolId: "001816",
          state: "IN",
          location: "US",
        },
        86400
      );

      await materializeRefreshJob({ ENVIRONMENT: "development", CACHE: kv }, job);

      const cached = await getCached<SchoolOutboundEquivalenciesResponse>(
        kv,
        undefined,
        "school-outbound-equivalencies:US:IN:001816"
      );
      expect(cached).toBeNull();
    });

    it("materializeRefreshJob with kind school-outbound-equivalencies can hydrate from D1 destination caches without a full catalog scan", async () => {
      const { db, materialized } = createFakeD1();
      const now = Date.now();
      const ttlMs = 86_400_000;

      materialized.set("purdue-catalog", {
        payload_json: JSON.stringify({
          courses: [
            { subject: "ENG", course: "101", title: "Intro to Engineering" },
            { subject: "MA", course: "101", title: "Math 101" },
          ],
          subjects: [],
          counts: { totalCourses: 2 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set("purdue-course-destinations:ENG:101", {
        payload_json: JSON.stringify([
          { id: "001816", name: "Ivy Tech Community College", state: "IN", location: "US", subregionName: "Indiana" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });
      materialized.set("purdue-course-destinations:MA:101", {
        payload_json: JSON.stringify([]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      materialized.set("purdue-course-equivalencies:ENG:101", {
        payload_json: JSON.stringify({
          course: { subject: "ENG", course: "101", title: "Intro to Engineering", credits: "3" },
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

      const job = createRefreshJob(
        "school-outbound-equivalencies",
        "school-outbound-equivalencies:US:IN:001816",
        {
          schoolId: "001816",
          state: "IN",
          location: "US",
        },
        86400
      );

      await materializeRefreshJob({ ENVIRONMENT: "development", DB: db }, job);

      const cached = await getCached<SchoolOutboundEquivalenciesResponse>(
        undefined,
        db,
        "school-outbound-equivalencies:US:IN:001816"
      );
      expect(cached).not.toBeNull();
      expect(cached?.counts.coursesMissingCache).toBe(0);
      expect(cached?.counts.coursesWithCache).toBe(1);
      expect(cached?.rows).toHaveLength(1);
      expect(cached?.rows[0]).toMatchObject({
        transferInstitution: "Ivy Tech Community College",
        purdueSubject: "ENG",
        purdueCourse: "101",
      });
    });

    it("buildSchoolOutboundEquivalencies uses cached all-schools before hitting Purdue school lookup", async () => {
      const { db, materialized } = createFakeD1();
      const now = Date.now();
      const ttlMs = 86_400_000;

      materialized.set("all-schools:US", {
        payload_json: JSON.stringify([
          { id: "001816", state: "IN", name: "Ivy Tech Community College" },
        ]),
        expires_at: now - 1_000,
        updated_at: now,
      });
      materialized.set("purdue-catalog", {
        payload_json: JSON.stringify({
          courses: [{ subject: "ENG", course: "101", title: "Intro to Engineering" }],
          subjects: [],
          counts: { totalCourses: 1 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });
      materialized.set("purdue-course-destinations:ENG:101", {
        payload_json: JSON.stringify([
          { id: "001816", name: "Ivy Tech Community College", state: "IN", location: "US", subregionName: "Indiana" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });
      materialized.set("purdue-course-equivalencies:ENG:101", {
        payload_json: JSON.stringify({
          course: { subject: "ENG", course: "101", title: "Intro to Engineering", credits: "3" },
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

      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
        if (url.pathname.endsWith("bzwtxcrd.p_ajax") && url.searchParams.get("request_type") === "school") {
          throw new PurdueUpstreamError("Purdue upstream returned 503", 503);
        }
        return new Response("not found", { status: 404 });
      });

      const data = await buildSchoolOutboundEquivalencies("001816", "IN", "US", { DB: db });

      expect(data.school).toEqual({ id: "001816", state: "IN", name: "Ivy Tech Community College" });
      expect(data.counts.coursesMissingCache).toBe(0);
      expect(data.rows).toHaveLength(1);
    });

    it("buildSchoolOutboundEquivalencies dispatches missing reverse-course jobs to the queue immediately", async () => {
      const { db, materialized, refreshJobs } = createFakeD1();
      const { queue, batches } = createFakeQueue();
      const now = Date.now();
      const ttlMs = 86_400_000;

      materialized.set("all-schools:US", {
        payload_json: JSON.stringify([
          { id: "001816", state: "IN", name: "Ivy Tech Community College" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });
      materialized.set("purdue-catalog", {
        payload_json: JSON.stringify({
          courses: [{ subject: "ENG", course: "101", title: "Intro to Engineering" }],
          subjects: [],
          counts: { totalCourses: 1 },
        }),
        expires_at: now + ttlMs,
        updated_at: now,
      });
      materialized.set("purdue-course-destinations:ENG:101", {
        payload_json: JSON.stringify([
          { id: "001816", name: "Ivy Tech Community College", state: "IN", location: "US", subregionName: "Indiana" },
        ]),
        expires_at: now + ttlMs,
        updated_at: now,
      });

      const data = await buildSchoolOutboundEquivalencies("001816", "IN", "US", {
        DB: db,
        HYDRATION_QUEUE: queue,
      });

      expect(data.counts.coursesMissingCache).toBe(1);
      expect(refreshJobs.has("purdue-course-equivalencies:ENG:101")).toBe(true);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        {
          body: expect.objectContaining({
            kind: "purdue-course-equivalencies",
            cacheKey: "purdue-course-equivalencies:ENG:101",
          }),
          contentType: "json",
        },
      ]);
    });
  });
});
