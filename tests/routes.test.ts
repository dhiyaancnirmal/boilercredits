import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import app from "../src/index";

const statesFixture = "Header\nIndiana~IN\nMichigan~MI";
const schoolsFixture = "Header\nIvy Tech Community College - IN~001816\nLansing Community College - MI~002351";
const subjectsFixture = "Header\nENG~English\nMATH~Mathematics";
const coursesFixture = "Header\n111~Composition I\n16100~Plane Analytic Geometry and Calculus I";
const reportFixture = readFileSync(new URL("./fixtures/purdue-report.html", import.meta.url), "utf8");

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

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? new URL(input) : new URL(input.toString());

    if (url.pathname.endsWith("bzwtxcrd.p_ajax")) {
      const requestType = url.searchParams.get("request_type");
      if (requestType === "states") return new Response(statesFixture);
      if (requestType === "school") return new Response(schoolsFixture);
      if (requestType === "subject") return new Response(subjectsFixture);
      if (requestType === "course" || requestType === "purdue_course") return new Response(coursesFixture);
      if (requestType === "location" || requestType === "state") {
        return new Response("Header\nUS~US");
      }
      if (requestType === "purdue_schools") {
        return new Response("Header\nIvy Tech Community College - IN~001816");
      }
    }

    if (url.pathname.endsWith("bzwtxcrd.p_select_info")) {
      return new Response('<select name="purdue_subject_in"><option value="ENG">English</option><option value="MATH">Mathematics</option></select>');
    }

    if (url.pathname.endsWith("bzwtxcrd.p_display_report")) {
      return new Response(reportFixture);
    }

    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker routes", () => {
  it("serves health checks", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("adds production security headers to API responses", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"), {});

    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain("https://fonts.googleapis.com");
    expect(res.headers.get("Content-Security-Policy")).toContain("https://fonts.gstatic.com");
    expect(res.headers.get("Permissions-Policy")).toContain("geolocation=()");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("serves forward equivalencies", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/meta/all-schools?location=US"),
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "Ivy Tech Community College", id: "001816", state: "IN" },
      { name: "Lansing Community College", id: "002351", state: "MI" },
    ]);
  });

  it("serves equivalency search results", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/equivalency/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
        body: JSON.stringify({
          rows: [
            {
              location: "US",
              state: "IN",
              school: "001816",
              subject: "ENG",
              course: "111",
            },
          ],
        }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      transferSubject: "ENG",
      transferCourse: "111",
      purdueSubject: "ENGL",
      purdueCourse: "10600",
    });
  });

  describe("aggregated meta endpoints", () => {
    it("GET /api/meta/purdue-catalog returns 200 with courses and counts", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/meta/purdue-catalog"),
        {}
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("courses");
      expect(body).toHaveProperty("counts");
      expect(body.counts).toHaveProperty("totalCourses");
      if (body.subjects) {
        expect(Array.isArray(body.subjects)).toBe(true);
      }
    });

    it("GET /api/meta/purdue-course-equivalencies returns 200 with course, states, institutionStates, rows, and counts", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/meta/purdue-course-equivalencies?subject=ENG&course=111"),
        {}
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("course");
      expect(body).toHaveProperty("states");
      expect(body).toHaveProperty("institutionStates");
      expect(body).toHaveProperty("rows");
      expect(body).toHaveProperty("counts");
      expect(body.course).toMatchObject({
        subject: "ENG",
        course: "111",
      });
      // Assert at least one concrete institutionStates key/value pair from the fixture
      expect(Object.keys(body.institutionStates).length).toBeGreaterThan(0);
      const [firstInstitution, firstSubregion] = Object.entries(body.institutionStates)[0];
      expect(typeof firstInstitution).toBe("string");
      expect(firstSubregion).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          label: expect.any(String),
          location: expect.any(String),
        })
      );
    });

    it("GET /api/meta/school-equivalencies returns 200 with school, subjects, rows, and counts", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/meta/school-equivalencies?schoolId=001816&state=IN&location=US"),
        {}
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("school");
      expect(body).toHaveProperty("subjects");
      expect(body).toHaveProperty("rows");
      expect(body).toHaveProperty("counts");
      expect(body.school).toMatchObject({
        id: "001816",
        state: "IN",
      });
    });

    it("does not cache incomplete school-outbound aggregates as fresh hits", async () => {
      const kv = createFakeKV();
      const request = new Request(
        "http://localhost/api/meta/school-outbound-equivalencies?schoolId=001816&state=IN&location=US"
      );

      const first = await app.fetch(request, { CACHE: kv });
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache-Layer")).toBe("miss");

      const firstBody = await first.json();
      expect(firstBody.counts.coursesMissingCache).toBeGreaterThan(0);

      const second = await app.fetch(
        new Request("http://localhost/api/meta/school-outbound-equivalencies?schoolId=001816&state=IN&location=US"),
        { CACHE: kv }
      );
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache-Layer")).toBe("miss");
    });

    it("returns X-Cache-Layer and X-Cache-Key headers on aggregated endpoints", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/meta/purdue-catalog"),
        {}
      );
      expect(res.status).toBe(200);
      expect(res.headers.has("X-Cache-Layer")).toBe(true);
      expect(res.headers.has("X-Cache-Key")).toBe(true);
    });
  });
});
