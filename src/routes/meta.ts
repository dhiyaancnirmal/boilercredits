import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AppContext,
  SchoolEquivalenciesResponse,
  SchoolOutboundEquivalenciesResponse,
  PurdueCatalogResponse,
  PurdueCourseEquivalenciesResponse,
  PurdueDestination,
} from "../types";
import {
  fetchStates,
  fetchSchools,
  fetchSubjects,
  fetchCourses,
  fetchPurdueCourses,
  fetchPurdueLocations,
  fetchPurdueStates,
  fetchPurdueSchools,
  fetchPurdueSelectInfoPage,
  fetchPurdueEquivalencyReport,
  PurdueUpstreamError,
  PurdueTimeoutError,
} from "../services/purdue-client";
import {
  parseStates,
  parseSchools,
  parseSubjects,
  parseCourses,
  parseEquivalencyReport,
} from "../services/purdue-parser";
import { getCached, getCachedWithMetadata, setCache, makeCacheKey } from "../lib/cache";
import { toPurdueSchoolLocationParam } from "../lib/purdue-location";
import { checkRateLimit, rateLimitHeaders } from "../lib/rate-limit";
import {
  statesQuerySchema,
  schoolsQuerySchema,
  subjectsQuerySchema,
  coursesQuerySchema,
  purdueCoursesQuerySchema,
  purdueCourseListQuerySchema,
  purdueCourseDestinationsQuerySchema,
  purdueLocationsQuerySchema,
  purdueStatesQuerySchema,
  purdueSchoolsQuerySchema,
  allSchoolsQuerySchema,
  schoolEquivalenciesQuerySchema,
  schoolOutboundEquivalenciesQuerySchema,
  purdueCatalogQuerySchema,
  purdueCourseDirectoryQuerySchema,
  purdueCourseEquivalenciesQuerySchema,
} from "../lib/validators";
import { log } from "../lib/logger";
import { createRefreshJob, SCHOOL_EQUIVALENCIES_TTL_SECONDS } from "../lib/refresh";
import {
  buildSchoolEquivalencies,
  buildSchoolOutboundEquivalencies,
  buildOutboundSchoolDirectory,
  buildPurdueCourseDirectory,
  type OutboundSchoolDirectoryEntry,
  buildPurdueCatalog,
  buildPurdueCourseEquivalencies,
  coercePurdueCourseEquivalenciesResponse,
  getPurdueCourseDestinations,
} from "../services/materialized-browse";

const meta = new Hono<AppContext>();

interface PurdueCatalogCourse {
  subject: string;
  course: string;
  title: string;
  credits: string;
}

function upstreamErrorResponse(error: unknown): { message: string; status: 502 | 504 } {
  if (error instanceof PurdueTimeoutError) {
    return { message: error.message, status: 504 };
  }
  if (error instanceof PurdueUpstreamError) {
    return { message: error.message, status: 502 };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown upstream error",
    status: 502,
  };
}

function normalizeCachedDestinations(list: PurdueDestination[]): PurdueDestination[] {
  return list.map((d) => ({
    ...d,
    subregionName: d.subregionName ?? d.state,
  }));
}

function isCompleteSchoolOutboundResponse(
  data: SchoolOutboundEquivalenciesResponse | null
): data is SchoolOutboundEquivalenciesResponse {
  return !!data && data.counts.coursesMissingCache === 0;
}

async function getPurdueCourseSummary(
  subject: string,
  course: string
): Promise<PurdueCatalogCourse | null> {
  const destinations = await getPurdueCourseDestinations(subject, course);
  if (!destinations.length) return null;

  const first = destinations[0];
  const report = await fetchPurdueEquivalencyReport([
    {
      subject,
      course,
      location: first.location,
      state: first.state,
      school: first.id,
    },
  ]);
  const rows = parseEquivalencyReport(report);
  const row = rows[0];
  if (!row) return null;

  return {
    subject,
    course,
    title: row.purdueTitle || `${subject} ${course}`,
    credits: row.purdueCredits || "",
  };
}

async function handleMetaRequest<T>(
  c: Context<AppContext>,
  endpoint: string,
  run: (headers: Record<string, string>) => Promise<Response>
): Promise<Response> {
  const rl = await checkRateLimit(c.req.raw, c.env.CACHE, "meta");
  if (!rl.allowed) {
    return c.json(
      { error: "Rate limit exceeded" },
      429,
      rateLimitHeaders(rl.remaining, rl.resetAt)
    );
  }

  try {
    return await run(rateLimitHeaders(rl.remaining, rl.resetAt));
  } catch (error) {
    const requestId = c.get("requestId");
    const upstream = upstreamErrorResponse(error);
    log(requestId, "error", "Meta route failed", {
      endpoint,
      error: upstream.message,
      path: c.req.path,
      method: c.req.method,
    });
    return c.json({ error: upstream.message, requestId }, upstream.status);
  }
}

async function refreshStaleJob(
  c: Context<AppContext>,
  job: ReturnType<typeof createRefreshJob>
): Promise<void> {
  if (!c.env.HYDRATION_QUEUE) return;
  await c.env.HYDRATION_QUEUE.send(job);
}

meta.get("/states", async (c) =>
  handleMetaRequest(c, "states", async (headers) => {
    const query = statesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("states", purdueLocation);
    const cached = await getCached<ReturnType<typeof parseStates>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseStates(await fetchStates(purdueLocation));
    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      data,
      86400,
      createRefreshJob("states", cacheKey, { location: purdueLocation }, 86400)
    );
    return c.json(data, 200, headers);
  })
);

meta.get("/schools", async (c) =>
  handleMetaRequest(c, "schools", async (headers) => {
    const query = schoolsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { state } = query.data;
    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("schools", state, purdueLocation);
    const cached = await getCached<ReturnType<typeof parseSchools>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseSchools(await fetchSchools(state, purdueLocation));
    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      data,
      3600,
      createRefreshJob("schools", cacheKey, { state, location: purdueLocation }, 3600)
    );
    return c.json(data, 200, headers);
  })
);

meta.get("/all-schools", async (c) =>
  handleMetaRequest(c, "all-schools", async (headers) => {
    const query = allSchoolsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("all-schools", purdueLocation);
    const cached = await getCached<Array<{ name: string; id: string; state: string }>>(
      c.env.CACHE,
      c.env.DB,
      cacheKey
    );
    if (cached) return c.json(cached, 200, headers);

    const states = parseStates(await fetchStates(purdueLocation));
    const schoolLists = await Promise.all(
      states.map(async (state) => ({
        stateCode: state.code,
        schools: parseSchools(await fetchSchools(state.code, purdueLocation)),
      }))
    );

    const deduped = new Map<string, { name: string; id: string; state: string }>();
    for (const entry of schoolLists) {
      for (const school of entry.schools) {
        const schoolState = school.state || entry.stateCode;
        deduped.set(`${schoolState}:${school.id}`, {
          name: school.name,
          id: school.id,
          state: schoolState,
        });
      }
    }

    const result = [...deduped.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.state.localeCompare(b.state)
    );
    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      result,
      86400,
      createRefreshJob("all-schools", cacheKey, { location: purdueLocation }, 86400)
    );
    return c.json(result, 200, headers);
  })
);

meta.get("/outbound-schools", async (c) =>
  handleMetaRequest(c, "outbound-schools", async (headers) => {
    const cacheKey = makeCacheKey("outbound-schools");
    const cached = await getCached<OutboundSchoolDirectoryEntry[]>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = await buildOutboundSchoolDirectory(c.env);
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 900);
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-course-directory", async (c) =>
  handleMetaRequest(c, "purdue-course-directory", async (headers) => {
    const query = purdueCourseDirectoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { direction } = query.data;
    const cacheKey = makeCacheKey("purdue-course-directory", direction, "v4");
    const cached = await getCached<PurdueCatalogResponse["courses"]>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = await buildPurdueCourseDirectory(c.env, direction);
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 900);
    return c.json(data, 200, headers);
  })
);

meta.get("/subjects", async (c) =>
  handleMetaRequest(c, "subjects", async (headers) => {
    const query = subjectsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { schoolId, state } = query.data;
    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("subjects", schoolId, state, purdueLocation);
    const cached = await getCached<ReturnType<typeof parseSubjects>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseSubjects(await fetchSubjects(schoolId, state, purdueLocation));
    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      data,
      1800,
      createRefreshJob("subjects", cacheKey, { schoolId, state, location: purdueLocation }, 1800)
    );
    return c.json(data, 200, headers);
  })
);

meta.get("/courses", async (c) =>
  handleMetaRequest(c, "courses", async (headers) => {
    const query = coursesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { schoolId, subject } = query.data;
    const cacheKey = makeCacheKey("courses", schoolId, subject);
    const cached = await getCached<ReturnType<typeof parseCourses>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseCourses(await fetchCourses(schoolId, subject));
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 1800, createRefreshJob("courses", cacheKey, { schoolId, subject }, 1800));
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-courses", async (c) =>
  handleMetaRequest(c, "purdue-courses", async (headers) => {
    const query = purdueCoursesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { subject } = query.data;
    const cacheKey = makeCacheKey("purdue-courses", subject);
    const cached = await getCached<ReturnType<typeof parseCourses>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseCourses(await fetchPurdueCourses(subject));
    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      data,
      1800,
      createRefreshJob("purdue-courses", cacheKey, { subject }, 1800)
    );
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-course-list", async (c) =>
  handleMetaRequest(c, "purdue-course-list", async (headers) => {
    const query = purdueCourseListQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { subject } = query.data;
    const cacheKey = makeCacheKey("purdue-course-list", subject);
    const cached = await getCached<PurdueCatalogCourse[]>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const courses = parseCourses(await fetchPurdueCourses(subject))
      .filter((course) => course.code !== "NC" && !course.code.includes("XXXX"));

    const summaries = (
      await Promise.all(courses.map((course) => getPurdueCourseSummary(subject, course.code)))
    )
      .filter((course): course is PurdueCatalogCourse => Boolean(course))
      .sort((a, b) => a.course.localeCompare(b.course));

    await setCache(
      c.env.CACHE,
      c.env.DB,
      cacheKey,
      summaries,
      86400,
      createRefreshJob("purdue-course-list", cacheKey, { subject }, 86400)
    );
    return c.json(summaries, 200, headers);
  })
);

meta.get("/purdue-course-destinations", async (c) =>
  handleMetaRequest(c, "purdue-course-destinations", async (headers) => {
    const query = purdueCourseDestinationsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { subject, course } = query.data;
    const cacheKey = makeCacheKey("purdue-course-destinations", subject, course);
    const refreshJob = createRefreshJob("purdue-course-destinations", cacheKey, { subject, course }, 86400);
    const cached = await getCachedWithMetadata<PurdueDestination[]>(c.env.CACHE, c.env.DB, cacheKey);
    const cacheHeaders = { ...headers, "X-Cache-Layer": cached.source, "X-Cache-Key": cacheKey };
    if (cached.data && !cached.stale) {
      return c.json(normalizeCachedDestinations(cached.data), 200, cacheHeaders);
    }
    if (cached.data && cached.stale && c.env.HYDRATION_QUEUE) {
      await refreshStaleJob(c, refreshJob);
      return c.json(normalizeCachedDestinations(cached.data), 200, cacheHeaders);
    }

    const destinations = await getPurdueCourseDestinations(subject, course);
    await setCache(c.env.CACHE, c.env.DB, cacheKey, destinations, 86400, refreshJob);
    return c.json(destinations, 200, { ...cacheHeaders, "X-Cache-Layer": "miss" });
  })
);

meta.get("/purdue-locations", async (c) =>
  handleMetaRequest(c, "purdue-locations", async (headers) => {
    const query = purdueLocationsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { subject, course } = query.data;
    const cacheKey = makeCacheKey("purdue-locations", subject, course);
    const cached = await getCached<ReturnType<typeof parseStates>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseStates(await fetchPurdueLocations(course, subject));
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 1800, createRefreshJob("purdue-locations", cacheKey, { subject, course }, 1800));
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-states", async (c) =>
  handleMetaRequest(c, "purdue-states", async (headers) => {
    const query = purdueStatesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { location, subject, course } = query.data;
    const cacheKey = makeCacheKey("purdue-states", location, subject, course);
    const cached = await getCached<ReturnType<typeof parseStates>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseStates(await fetchPurdueStates(location, subject, course));
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 1800, createRefreshJob("purdue-states", cacheKey, { location, subject, course }, 1800));
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-schools", async (c) =>
  handleMetaRequest(c, "purdue-schools", async (headers) => {
    const query = purdueSchoolsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { location, state, subject, course } = query.data;
    const cacheKey = makeCacheKey("purdue-schools", location, state, subject, course);
    const cached = await getCached<ReturnType<typeof parseSchools>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const data = parseSchools(await fetchPurdueSchools(state, subject, course, location));
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 1800, createRefreshJob("purdue-schools", cacheKey, { location, state, subject, course }, 1800));
    return c.json(data, 200, headers);
  })
);

meta.get("/purdue-subjects", async (c) =>
  handleMetaRequest(c, "purdue-subjects", async (headers) => {
    const cacheKey = makeCacheKey("purdue-subjects");
    const cached = await getCached<Array<{ code: string; name: string }>>(c.env.CACHE, c.env.DB, cacheKey);
    if (cached) return c.json(cached, 200, headers);

    const html = await fetchPurdueSelectInfoPage();
    const selectMatch = html.match(/<select name="purdue_subject_in"[^>]*>([\s\S]*?)<\/select>/i);
    if (!selectMatch) {
      return c.json({ error: "Failed to parse Purdue subjects list" }, 502);
    }

    const subjects = [...selectMatch[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
      .map((match) => ({
        code: match[1].trim(),
        name: match[2].replace(/<[^>]+>/g, "").trim() || match[1].trim(),
      }))
      .filter((subject) => subject.code.length > 0);

    await setCache(c.env.CACHE, c.env.DB, cacheKey, subjects, 86400, createRefreshJob("purdue-subjects", cacheKey, {}, 86400));
    return c.json(subjects, 200, headers);
  })
);

meta.get("/school-equivalencies", async (c) =>
  handleMetaRequest(c, "school-equivalencies", async (headers) => {
    const query = schoolEquivalenciesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { schoolId, state } = query.data;
    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("school-equivalencies", purdueLocation, state, schoolId);
    const refreshJob = createRefreshJob(
      "school-equivalencies",
      cacheKey,
      { schoolId, state, location: purdueLocation },
      SCHOOL_EQUIVALENCIES_TTL_SECONDS
    );
    const cached = await getCachedWithMetadata<SchoolEquivalenciesResponse>(c.env.CACHE, c.env.DB, cacheKey);
    const cacheHeaders = { ...headers, "X-Cache-Layer": cached.source, "X-Cache-Key": cacheKey };
    if (cached.data && !cached.stale) return c.json(cached.data, 200, cacheHeaders);
    if (cached.data && cached.stale && c.env.HYDRATION_QUEUE) {
      await refreshStaleJob(c, refreshJob);
      return c.json(cached.data, 200, cacheHeaders);
    }

    const data = await buildSchoolEquivalencies(schoolId, state, purdueLocation);
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, SCHOOL_EQUIVALENCIES_TTL_SECONDS, refreshJob);
    return c.json(data, 200, { ...cacheHeaders, "X-Cache-Layer": "miss" });
  })
);

meta.get("/school-outbound-equivalencies", async (c) =>
  handleMetaRequest(c, "school-outbound-equivalencies", async (headers) => {
    const query = schoolOutboundEquivalenciesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { schoolId, state } = query.data;
    const purdueLocation = toPurdueSchoolLocationParam(query.data.location);
    const cacheKey = makeCacheKey("school-outbound-equivalencies", purdueLocation, state, schoolId);
    const refreshJob = createRefreshJob(
      "school-outbound-equivalencies",
      cacheKey,
      { schoolId, state, location: purdueLocation },
      SCHOOL_EQUIVALENCIES_TTL_SECONDS
    );
    const cached = await getCachedWithMetadata<SchoolOutboundEquivalenciesResponse>(c.env.CACHE, c.env.DB, cacheKey);
    const cacheHeaders = { ...headers, "X-Cache-Layer": cached.source, "X-Cache-Key": cacheKey };
    if (isCompleteSchoolOutboundResponse(cached.data) && !cached.stale) {
      return c.json(cached.data, 200, cacheHeaders);
    }
    if (isCompleteSchoolOutboundResponse(cached.data) && cached.stale && c.env.HYDRATION_QUEUE) {
      await refreshStaleJob(c, refreshJob);
      return c.json(cached.data, 200, cacheHeaders);
    }

    const data = await buildSchoolOutboundEquivalencies(schoolId, state, purdueLocation, {
      CACHE: c.env.CACHE,
      DB: c.env.DB,
      HYDRATION_QUEUE: c.env.HYDRATION_QUEUE,
    });
    if (data.counts.coursesMissingCache === 0) {
      await setCache(c.env.CACHE, c.env.DB, cacheKey, data, SCHOOL_EQUIVALENCIES_TTL_SECONDS, refreshJob);
    }
    return c.json(data, 200, { ...cacheHeaders, "X-Cache-Layer": "miss" });
  })
);

meta.get("/purdue-catalog", async (c) =>
  handleMetaRequest(c, "purdue-catalog", async (headers) => {
    const cacheKey = makeCacheKey("purdue-catalog");
    const refreshJob = createRefreshJob("purdue-catalog", cacheKey, {}, 86400);
    const cached = await getCachedWithMetadata<PurdueCatalogResponse>(c.env.CACHE, c.env.DB, cacheKey);
    const cacheHeaders = { ...headers, "X-Cache-Layer": cached.source, "X-Cache-Key": cacheKey };
    if (cached.data && !cached.stale) return c.json(cached.data, 200, cacheHeaders);
    if (cached.data && cached.stale && c.env.HYDRATION_QUEUE) {
      await refreshStaleJob(c, refreshJob);
      return c.json(cached.data, 200, cacheHeaders);
    }

    const data = await buildPurdueCatalog();
    await setCache(c.env.CACHE, c.env.DB, cacheKey, data, 86400, refreshJob);
    return c.json(data, 200, { ...cacheHeaders, "X-Cache-Layer": "miss" });
  })
);

meta.get("/purdue-course-equivalencies", async (c) =>
  handleMetaRequest(c, "purdue-course-equivalencies", async (headers) => {
    const query = purdueCourseEquivalenciesQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query", details: query.error.issues }, 400);

    const { subject, course } = query.data;
    const cacheKey = makeCacheKey("purdue-course-equivalencies", subject, course);
    const refreshJob = createRefreshJob("purdue-course-equivalencies", cacheKey, { subject, course }, 86400);
    const cached = await getCachedWithMetadata<PurdueCourseEquivalenciesResponse>(c.env.CACHE, c.env.DB, cacheKey);
    const cacheHeaders = { ...headers, "X-Cache-Layer": cached.source, "X-Cache-Key": cacheKey };
    if (cached.data && !cached.stale) {
      return c.json(coercePurdueCourseEquivalenciesResponse(cached.data), 200, cacheHeaders);
    }
    if (cached.data && cached.stale && c.env.HYDRATION_QUEUE) {
      await refreshStaleJob(c, refreshJob);
      return c.json(coercePurdueCourseEquivalenciesResponse(cached.data), 200, cacheHeaders);
    }

    const data = await buildPurdueCourseEquivalencies(subject, course, { CACHE: c.env.CACHE, DB: c.env.DB });
    const body = coercePurdueCourseEquivalenciesResponse(data);
    // Don't promote empty responses — Purdue upstream may be flaky. Short TTL
    // lets the next request retry instead of freezing empty data for a day.
    const ttl = body.rows.length > 0 || body.counts.institutions > 0 ? 86400 : 300;
    await setCache(c.env.CACHE, c.env.DB, cacheKey, body, ttl, refreshJob);
    return c.json(body, 200, { ...cacheHeaders, "X-Cache-Layer": "miss" });
  })
);

export default meta;
