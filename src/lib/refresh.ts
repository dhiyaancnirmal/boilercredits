import type { RefreshJob, RefreshKind, Env, PurdueCatalogResponse } from "../types";
import { createRefreshJob, enqueueRefreshJobNow } from "./refresh-job";
import {
  fetchCourses,
  fetchEquivalencyReport,
  fetchPurdueCourses,
  fetchPurdueEquivalencyReport,
  fetchPurdueLocations,
  fetchPurdueSchools,
  fetchPurdueSelectInfoPage,
  fetchPurdueStates,
  fetchSchools,
  fetchStates,
  fetchSubjects,
} from "../services/purdue-client";
import { parseCourses, parseEquivalencyReport, parseSchools, parseStates, parseSubjects } from "../services/purdue-parser";
import { getCached, makeCacheKey, setCache } from "./cache";
import { coercePayloadLocationToPurdue, PURDUE_INTL_SCHOOL_BUCKET } from "./purdue-location";
import {
  buildSchoolEquivalencies,
  buildSchoolOutboundEquivalencies,
  buildOutboundSchoolDirectory,
  buildPurdueCatalog,
  buildPurdueCourseDirectory,
  buildPurdueCourseEquivalencies,
  getPurdueCourseDestinations,
} from "../services/materialized-browse";

type RefreshPayload = Record<string, string>;

/**
 * These heavy rotating caches must stay valid longer than a full cron cycle.
 * With ~2967 schools and 15-minute ticks, the current seed slices need ~37h
 * to cycle inbound school results and ~49.5h to cycle outbound school results.
 * A 24h TTL guarantees cold misses even after the graph is "fully" warmed once.
 */
export const LONG_ROTATION_TTL_SECONDS = 72 * 60 * 60;
export const SCHOOL_EQUIVALENCIES_TTL_SECONDS = LONG_ROTATION_TTL_SECONDS;
export const PURDUE_COURSE_DESTINATIONS_TTL_SECONDS = LONG_ROTATION_TTL_SECONDS;
export const UI_DIRECTORY_TTL_SECONDS = LONG_ROTATION_TTL_SECONDS;

/**
 * Rotating cron-seed slice sizes per 15-min tick. Sized so the full
 * catalog + full school list cycle within ~1-2 days, keeping per-tick
 * upstream load moderate.
 */
const SEED_SLICE = {
  schoolInbound: 20,
  courseReverse: 25,
  schoolOutbound: 15,
  courseDestinations: 20,
} as const;

const CRON_TICK_MS = 15 * 60 * 1000;

type AllSchoolsEntry = { name: string; id: string; state: string };

function pick(value: RefreshPayload, key: string): string {
  const found = value[key];
  if (!found) {
    throw new Error(`Missing refresh payload field: ${key}`);
  }
  return found;
}

async function getPurdueCourseSummary(subject: string, course: string) {
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

export { createRefreshJob };

export async function materializeRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  const ttl = job.ttlSeconds;
  const payload = job.payload;

  switch (job.kind) {
    case "outbound-schools": {
      const data = await buildOutboundSchoolDirectory(env);
      await setCache(
        env.CACHE,
        env.DB,
        job.cacheKey,
        data,
        ttl,
        createRefreshJob("outbound-schools", job.cacheKey, payload, ttl)
      );
      return;
    }
    case "all-schools": {
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      const states = parseStates(await fetchStates(location));
      const schoolLists = await Promise.all(
        states.map(async (state) => ({
          stateCode: state.code,
          schools: parseSchools(await fetchSchools(state.code, location)),
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
      await setCache(env.CACHE, env.DB, job.cacheKey, [...deduped.values()], ttl, createRefreshJob("all-schools", job.cacheKey, payload, ttl));
      return;
    }
    case "states": {
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      await setCache(env.CACHE, env.DB, job.cacheKey, parseStates(await fetchStates(location)), ttl, createRefreshJob("states", job.cacheKey, payload, ttl));
      return;
    }
    case "schools": {
      const state = pick(payload, "state");
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      await setCache(env.CACHE, env.DB, job.cacheKey, parseSchools(await fetchSchools(state, location)), ttl, createRefreshJob("schools", job.cacheKey, payload, ttl));
      return;
    }
    case "subjects": {
      const schoolId = pick(payload, "schoolId");
      const state = pick(payload, "state");
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      await setCache(env.CACHE, env.DB, job.cacheKey, parseSubjects(await fetchSubjects(schoolId, state, location)), ttl, createRefreshJob("subjects", job.cacheKey, payload, ttl));
      return;
    }
    case "courses": {
      const schoolId = pick(payload, "schoolId");
      const subject = pick(payload, "subject");
      await setCache(env.CACHE, env.DB, job.cacheKey, parseCourses(await fetchCourses(schoolId, subject)), ttl, createRefreshJob("courses", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-course-directory": {
      const direction = pick(payload, "direction") as "inbound" | "outbound";
      const data = await buildPurdueCourseDirectory(env, direction);
      await setCache(
        env.CACHE,
        env.DB,
        job.cacheKey,
        data,
        ttl,
        createRefreshJob("purdue-course-directory", job.cacheKey, { direction }, ttl)
      );
      return;
    }
    case "purdue-courses": {
      const subject = pick(payload, "subject");
      await setCache(env.CACHE, env.DB, job.cacheKey, parseCourses(await fetchPurdueCourses(subject)), ttl, createRefreshJob("purdue-courses", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-subjects": {
      const html = await fetchPurdueSelectInfoPage();
      const selectMatch = html.match(/<select name="purdue_subject_in"[^>]*>([\s\S]*?)<\/select>/i);
      if (!selectMatch) throw new Error("Failed to parse Purdue subjects list");
      const subjects = [...selectMatch[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
        .map((match) => ({
          code: match[1].trim(),
          name: match[2].replace(/<[^>]+>/g, "").trim() || match[1].trim(),
        }))
        .filter((subject) => subject.code.length > 0);
      await setCache(env.CACHE, env.DB, job.cacheKey, subjects, ttl, createRefreshJob("purdue-subjects", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-course-list": {
      const subject = pick(payload, "subject");
      const courses = parseCourses(await fetchPurdueCourses(subject)).filter(
        (course) => course.code !== "NC" && !course.code.includes("XXXX")
      );
      const summaries = (await Promise.all(courses.map((course) => getPurdueCourseSummary(subject, course.code))))
        .filter((course): course is NonNullable<typeof course> => Boolean(course))
        .sort((a, b) => a.course.localeCompare(b.course));
      await setCache(env.CACHE, env.DB, job.cacheKey, summaries, ttl, createRefreshJob("purdue-course-list", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-course-destinations": {
      const subject = pick(payload, "subject");
      const course = pick(payload, "course");
      await setCache(env.CACHE, env.DB, job.cacheKey, await getPurdueCourseDestinations(subject, course), ttl, createRefreshJob("purdue-course-destinations", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-locations": {
      const subject = pick(payload, "subject");
      const course = pick(payload, "course");
      await setCache(env.CACHE, env.DB, job.cacheKey, parseStates(await fetchPurdueLocations(course, subject)), ttl, createRefreshJob("purdue-locations", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-states": {
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      const subject = pick(payload, "subject");
      const course = pick(payload, "course");
      await setCache(env.CACHE, env.DB, job.cacheKey, parseStates(await fetchPurdueStates(location, subject, course)), ttl, createRefreshJob("purdue-states", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-schools": {
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      const state = pick(payload, "state");
      const subject = pick(payload, "subject");
      const course = pick(payload, "course");
      await setCache(env.CACHE, env.DB, job.cacheKey, parseSchools(await fetchPurdueSchools(state, subject, course, location)), ttl, createRefreshJob("purdue-schools", job.cacheKey, payload, ttl));
      return;
    }
    case "search": {
      const rows = JSON.parse(pick(payload, "rows")) as Array<{ location: string; state: string; school: string; subject: string; course: string }>;
      const html = await fetchEquivalencyReport(rows);
      const result = { rows: parseEquivalencyReport(html), query: rows[0] };
      await setCache(env.CACHE, env.DB, job.cacheKey, result, ttl);
      return;
    }
    case "reverse-search": {
      const rows = JSON.parse(pick(payload, "rows")) as Array<{ subject: string; course: string; location: string; state: string; school: string }>;
      const html = await fetchPurdueEquivalencyReport(rows);
      const result = {
        rows: parseEquivalencyReport(html),
        query: {
          location: rows[0].location,
          state: rows[0].state,
          school: rows[0].school,
          subject: rows[0].subject,
          course: rows[0].course,
        },
      };
      await setCache(env.CACHE, env.DB, job.cacheKey, result, ttl);
      return;
    }
    case "school-equivalencies": {
      const schoolId = pick(payload, "schoolId");
      const state = pick(payload, "state");
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      const data = await buildSchoolEquivalencies(schoolId, state, location);
      await setCache(env.CACHE, env.DB, job.cacheKey, data, ttl, createRefreshJob("school-equivalencies", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-catalog": {
      const data = await buildPurdueCatalog();
      await setCache(env.CACHE, env.DB, job.cacheKey, data, ttl, createRefreshJob("purdue-catalog", job.cacheKey, payload, ttl));
      return;
    }
    case "purdue-course-equivalencies": {
      const subject = pick(payload, "subject");
      const course = pick(payload, "course");
      const data = await buildPurdueCourseEquivalencies(subject, course, { CACHE: env.CACHE, DB: env.DB });
      await setCache(env.CACHE, env.DB, job.cacheKey, data, ttl, createRefreshJob("purdue-course-equivalencies", job.cacheKey, payload, ttl));
      return;
    }
    case "school-outbound-equivalencies": {
      const schoolId = pick(payload, "schoolId");
      const state = pick(payload, "state");
      const location = coercePayloadLocationToPurdue(pick(payload, "location"));
      const data = await buildSchoolOutboundEquivalencies(schoolId, state, location, {
        CACHE: env.CACHE,
        DB: env.DB,
        HYDRATION_QUEUE: env.HYDRATION_QUEUE,
      });
      if (data.counts.coursesMissingCache !== 0) {
        return;
      }
      await setCache(
        env.CACHE,
        env.DB,
        job.cacheKey,
        data,
        ttl,
        createRefreshJob("school-outbound-equivalencies", job.cacheKey, payload, ttl)
      );
      return;
    }
    default:
      throw new Error(`Unsupported refresh kind: ${(job as RefreshJob).kind}`);
  }
}

async function scheduleRefreshNow(env: Env, job: RefreshJob): Promise<void> {
  await enqueueRefreshJobNow(env, job);
}

async function enqueueIfStale(env: Env, job: RefreshJob): Promise<boolean> {
  if (!env.DB) return false;

  const cached = await env.DB
    .prepare("SELECT expires_at FROM materialized_responses WHERE cache_key = ?1")
    .bind(job.cacheKey)
    .first<{ expires_at: number }>();

  if (cached && cached.expires_at > Date.now()) return false;

  await scheduleRefreshNow(env, job);
  return true;
}

function rotatingSlice<T>(items: readonly T[], tick: number, size: number): T[] {
  if (items.length === 0 || size <= 0) return [];
  const start = ((tick * size) % items.length + items.length) % items.length;
  const end = start + size;
  if (end <= items.length) return items.slice(start, end);
  return [...items.slice(start), ...items.slice(0, end - items.length)];
}

/**
 * Every 15-min cron tick seeds a rotating slice of each heavy endpoint so
 * the full catalog + full school list stays warm in D1 without any user
 * ever having to pay a cold miss. Slice sizes in SEED_SLICE are tuned so
 * the full graph cycles within 1-2 days.
 */
export async function seedWarmMaterializations(env: Env): Promise<void> {
  if (!env.DB) return;

  const tick = Math.floor(Date.now() / CRON_TICK_MS);
  const enqueued = {
    catalog: 0,
    allSchools: 0,
    outboundSchools: 0,
    courseDirectories: 0,
    schoolInbound: 0,
    courseReverse: 0,
    schoolOutbound: 0,
    courseDestinations: 0,
  };

  // 1. Purdue catalog — global, cheap, must be warm for all other course rotations.
  if (
    await enqueueIfStale(
      env,
      createRefreshJob("purdue-catalog", makeCacheKey("purdue-catalog"), {}, 86400)
    )
  ) {
    enqueued.catalog++;
  }

  // 2. all-schools caches for US + International — needed for the school rotation.
  for (const publicLocation of ["US", PURDUE_INTL_SCHOOL_BUCKET]) {
    const cacheKey = makeCacheKey("all-schools", publicLocation);
    if (
      await enqueueIfStale(
        env,
        createRefreshJob("all-schools", cacheKey, { location: publicLocation }, 86400)
      )
    ) {
      enqueued.allSchools++;
    }
  }

  if (
    await enqueueIfStale(
      env,
      createRefreshJob("outbound-schools", makeCacheKey("outbound-schools"), {}, UI_DIRECTORY_TTL_SECONDS)
    )
  ) {
    enqueued.outboundSchools++;
  }

  // 3. Rotating slice of the full catalog for reverse destinations (cheap — feeds step 4).
  const catalog = await getCached<PurdueCatalogResponse>(
    env.CACHE,
    env.DB,
    makeCacheKey("purdue-catalog")
  );

  if (catalog && catalog.courses.length > 0) {
    for (const direction of ["inbound", "outbound"] as const) {
      const cacheKey = makeCacheKey("purdue-course-directory", direction, "v4");
      if (
        await enqueueIfStale(
          env,
          createRefreshJob(
            "purdue-course-directory",
            cacheKey,
            { direction },
            UI_DIRECTORY_TTL_SECONDS
          )
        )
      ) {
        enqueued.courseDirectories++;
      }
    }

    const destSlice = rotatingSlice(catalog.courses, tick, SEED_SLICE.courseDestinations);
    for (const { subject, course } of destSlice) {
      const destCacheKey = makeCacheKey("purdue-course-destinations", subject, course);
      if (
        await enqueueIfStale(
          env,
          createRefreshJob(
            "purdue-course-destinations",
            destCacheKey,
            { subject, course },
            PURDUE_COURSE_DESTINATIONS_TTL_SECONDS
          )
        )
      ) {
        enqueued.courseDestinations++;
      }
    }

    // 4. Rotating slice for purdue-course-equivalencies — the building block for
    // school-outbound aggregation. This is the most important new seed.
    const reverseSlice = rotatingSlice(catalog.courses, tick, SEED_SLICE.courseReverse);
    for (const { subject, course } of reverseSlice) {
      const cacheKey = makeCacheKey("purdue-course-equivalencies", subject, course);
      if (
        await enqueueIfStale(
          env,
          createRefreshJob("purdue-course-equivalencies", cacheKey, { subject, course }, 86400)
        )
      ) {
        enqueued.courseReverse++;
      }
    }
  }

  // 5. Rotating slice of all schools for school-equivalencies (inbound).
  // 6. Rotating slice for school-outbound (offset by half the list so outbound
  //    starts on schools whose course-equivalency dependencies had more time to warm).
  const schools = await getAllSchoolsForSeeding(env);
  if (schools.length > 0) {
    const inboundSlice = rotatingSlice(schools, tick, SEED_SLICE.schoolInbound);
    for (const school of inboundSlice) {
      const cacheKey = makeCacheKey("school-equivalencies", school.location, school.state, school.id);
      if (
        await enqueueIfStale(
          env,
          createRefreshJob(
            "school-equivalencies",
            cacheKey,
            { schoolId: school.id, state: school.state, location: school.location },
            SCHOOL_EQUIVALENCIES_TTL_SECONDS
          )
        )
      ) {
        enqueued.schoolInbound++;
      }
    }

    const outboundOffset = tick + Math.floor(schools.length / 2);
    const outboundSlice = rotatingSlice(schools, outboundOffset, SEED_SLICE.schoolOutbound);
    for (const school of outboundSlice) {
      const cacheKey = makeCacheKey(
        "school-outbound-equivalencies",
        school.location,
        school.state,
        school.id
      );
      if (
        await enqueueIfStale(
          env,
          createRefreshJob(
            "school-outbound-equivalencies",
            cacheKey,
            { schoolId: school.id, state: school.state, location: school.location },
            SCHOOL_EQUIVALENCIES_TTL_SECONDS
          )
        )
      ) {
        enqueued.schoolOutbound++;
      }
    }
  }

  console.log(
    JSON.stringify({
      event: "seed-warm-materializations",
      tick,
      enqueued,
      catalogSize: catalog?.courses.length ?? 0,
      schoolsSize: schools.length,
    })
  );
}

/**
 * Return the union of US and International schools from cache, each tagged with
 * the Purdue location bucket expected by refresh-job payloads. Returns empty if
 * neither bucket is cached yet (the current tick will seed those buckets via step 2).
 */
async function getAllSchoolsForSeeding(
  env: Env
): Promise<Array<AllSchoolsEntry & { location: string }>> {
  const buckets: Array<Array<AllSchoolsEntry & { location: string }>> = [];
  for (const publicLocation of ["US", PURDUE_INTL_SCHOOL_BUCKET]) {
    const cached = await getCached<AllSchoolsEntry[]>(
      env.CACHE,
      env.DB,
      makeCacheKey("all-schools", publicLocation)
    );
    if (cached && cached.length > 0) {
      buckets.push(cached.map((s) => ({ ...s, location: publicLocation })));
    }
  }
  return buckets.flat();
}

export async function refreshDueJobs(env: Env, limit = 75): Promise<RefreshJob[]> {
  if (!env.DB || !env.HYDRATION_QUEUE) return [];

  const rows = await env.DB
    .prepare(
      `SELECT cache_key, kind, payload_json, ttl_seconds, next_refresh_at
       FROM refresh_jobs
       WHERE next_refresh_at <= ?1
       ORDER BY next_refresh_at ASC
       LIMIT ?2`
    )
    .bind(Date.now(), limit)
    .all<{ cache_key: string; kind: RefreshKind; payload_json: string; ttl_seconds: number; next_refresh_at: number }>();

  const jobs = (rows.results ?? []).map((row) => ({
    kind: row.kind,
    cacheKey: row.cache_key,
    payload: JSON.parse(row.payload_json) as RefreshPayload,
    ttlSeconds: row.ttl_seconds,
    nextRefreshAt: row.next_refresh_at,
  }));

  if (!jobs.length) return [];

  await env.HYDRATION_QUEUE.sendBatch(
    jobs.map((job) => ({
      body: job,
      contentType: "json",
    }))
  );

  return jobs;
}
