import type {
  EquivalencyRow,
  SchoolEquivalenciesResponse,
  SchoolOutboundEquivalenciesResponse,
  PurdueCatalogResponse,
  PurdueCourseEquivalenciesResponse,
  PurdueDestination,
  InstitutionSubregion,
  RefreshJob,
} from "../types";
import {
  fetchStates,
  fetchSchools,
  fetchSubjects,
  fetchCourses,
  fetchEquivalencyReport,
  fetchPurdueCourses,
  fetchPurdueLocations,
  fetchPurdueStates,
  fetchPurdueSchools,
  fetchPurdueSelectInfoPage,
  fetchReportSessionCookie,
  fetchPurdueEquivalencyReportWithSession,
} from "./purdue-client";
import {
  parseStates,
  parseSchools,
  parseSubjects,
  parseCourses,
  parseEquivalencyReport,
} from "./purdue-parser";
import { getCached, getCachedWithMetadata, setCache, makeCacheKey } from "../lib/cache";
import { createRefreshJob, dispatchRefreshJobsNow } from "../lib/refresh-job";
import { PURDUE_COURSE_DESTINATIONS_TTL_SECONDS } from "../lib/refresh";
import { toPurdueSchoolLocationParam } from "../lib/purdue-location";

function dedupeRows(rows: EquivalencyRow[]): EquivalencyRow[] {
  const seen = new Map<string, EquivalencyRow>();
  for (const row of rows) {
    const key = [
      row.transferInstitution,
      row.transferSubject,
      row.transferCourse,
      row.purdueSubject,
      row.purdueCourse,
    ].join("|");
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

async function resolveSchoolName(
  schoolId: string,
  state: string,
  location: string,
  env?: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<string> {
  if (env) {
    const allSchoolsKey = makeCacheKey("all-schools", location);
    const cachedSchools = await getCachedWithMetadata<Array<{ id: string; state: string; name: string }>>(
      env.CACHE,
      env.DB,
      allSchoolsKey
    );
    const cachedMatch = cachedSchools.data?.find((s) => s.id === schoolId && s.state === state);
    if (cachedMatch?.name) return cachedMatch.name;
  }

  const rawSchools = parseSchools(await fetchSchools(state, location));
  const match = rawSchools.find((s) => s.id === schoolId);
  return match?.name ?? schoolId;
}

export async function buildSchoolEquivalencies(
  schoolId: string,
  state: string,
  location: string
): Promise<SchoolEquivalenciesResponse> {
  const schoolName = await resolveSchoolName(schoolId, state, location);

  const loadedSubjects = parseSubjects(
    await fetchSubjects(schoolId, state, location)
  );

  const allRows: EquivalencyRow[] = [];

  for (let i = 0; i < loadedSubjects.length; i += 3) {
    const batch = loadedSubjects.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(async (subject) => {
        const courses = parseCourses(
          await fetchCourses(schoolId, subject.code)
        );
        const subjectRows: EquivalencyRow[] = [];
        for (let j = 0; j < courses.length; j += 5) {
          const courseBatch = courses.slice(j, j + 5);
          const searchRows = courseBatch.map((course) => ({
            location,
            state,
            school: schoolId,
            subject: subject.code,
            course: course.code,
          }));
          const html = await fetchEquivalencyReport(searchRows);
          const parsed = parseEquivalencyReport(html);
          subjectRows.push(...parsed);
        }
        return subjectRows;
      })
    );
    for (const rows of batchResults) {
      allRows.push(...rows);
    }
  }

  const rows = dedupeRows(allRows);

  return {
    school: { id: schoolId, state, name: schoolName },
    subjects: loadedSubjects.map((s) => ({ code: s.code, name: s.name })),
    rows,
    counts: {
      subjects: loadedSubjects.length,
      equivalencies: rows.length,
    },
  };
}

function normalizeInstitutionKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface OutboundSchoolDirectoryEntry {
  name: string;
  id: string;
  state: string;
  catalog: "US" | "International";
}

export type PurdueCourseDirectoryDirection = "inbound" | "outbound";

async function getCachedPurdueCatalogMap(
  env: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<Map<string, PurdueCatalogResponse["courses"][number]>> {
  const cacheKey = makeCacheKey("purdue-catalog");
  const cached = await getCachedWithMetadata<PurdueCatalogResponse>(env.CACHE, env.DB, cacheKey);
  const courses = cached.data?.courses?.length ? cached.data.courses : (await buildPurdueCatalog()).courses;
  return new Map(courses.map((course) => [`${course.subject}:${course.course}`, course]));
}

async function getCachedPurdueEquivalencyTitleMap(
  env: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<Map<string, string>> {
  if (!env.DB) return new Map();

  const eqRows = await runD1All<{ payload_json: string }>(
    env.DB,
    "SELECT payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-equivalencies:%'"
  );

  const titles = new Map<string, string>();
  for (const row of eqRows) {
    const payload = coercePurdueCourseEquivalenciesResponse(
      JSON.parse(row.payload_json) as PurdueCourseEquivalenciesResponse
    );
    if (!payload.course.title) continue;
    titles.set(`${payload.course.subject}:${payload.course.course}`, payload.course.title);
  }

  return titles;
}

async function getCachedSchoolDirectory(
  env: { CACHE?: KVNamespace; DB?: D1Database },
  catalog: "US" | "International"
): Promise<OutboundSchoolDirectoryEntry[]> {
  const cacheKey = makeCacheKey("all-schools", toPurdueSchoolLocationParam(catalog));
  const cached = await getCachedWithMetadata<Array<{ name: string; id: string; state: string }>>(
    env.CACHE,
    env.DB,
    cacheKey
  );

  return (cached.data ?? []).map((school) => ({ ...school, catalog }));
}

function buildSchoolLookupIndex(
  schools: OutboundSchoolDirectoryEntry[]
): Map<string, OutboundSchoolDirectoryEntry> {
  const index = new Map<string, OutboundSchoolDirectoryEntry>();

  for (const school of schools) {
    const stateKey = normalizeInstitutionKey(`${school.name} - ${school.state}`);
    const bareKey = normalizeInstitutionKey(school.name);

    if (!index.has(stateKey)) index.set(stateKey, school);
    if (!index.has(bareKey)) index.set(bareKey, school);
  }

  return index;
}

export async function buildOutboundSchoolDirectory(
  env: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<OutboundSchoolDirectoryEntry[]> {
  if (!env.DB) return [];

  const [usSchools, intlSchools, eqRows] = await Promise.all([
    getCachedSchoolDirectory(env, "US"),
    getCachedSchoolDirectory(env, "International"),
    runD1All<{ payload_json: string }>(
      env.DB,
      "SELECT payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-equivalencies:%'"
    ),
  ]);

  const schoolIndex = buildSchoolLookupIndex([...usSchools, ...intlSchools]);
  const deduped = new Map<string, OutboundSchoolDirectoryEntry>();

  for (const row of eqRows) {
    const payload = coercePurdueCourseEquivalenciesResponse(
      JSON.parse(row.payload_json) as PurdueCourseEquivalenciesResponse
    );

    for (const [institutionName, subregion] of Object.entries(payload.institutionStates)) {
      const school =
        schoolIndex.get(normalizeInstitutionKey(`${institutionName} - ${subregion.code}`)) ??
        schoolIndex.get(normalizeInstitutionKey(institutionName));

      if (!school) continue;

      const key = `${school.catalog}:${school.state}:${school.id}`;
      if (!deduped.has(key)) {
        deduped.set(key, school);
      }
    }
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.catalog !== b.catalog) return a.catalog === "US" ? -1 : 1;
    return a.name.localeCompare(b.name) || a.state.localeCompare(b.state);
  });
}

export async function buildPurdueCourseDirectory(
  env: { CACHE?: KVNamespace; DB?: D1Database },
  direction: PurdueCourseDirectoryDirection
): Promise<PurdueCatalogResponse["courses"]> {
  if (!env.DB) return [];

  if (direction === "inbound") {
    const eqRows = await runD1All<{ payload_json: string }>(
      env.DB,
      "SELECT payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-equivalencies:%'"
    );

    const deduped = new Map<string, PurdueCatalogResponse["courses"][number]>();
    for (const row of eqRows) {
      const payload = coercePurdueCourseEquivalenciesResponse(
        JSON.parse(row.payload_json) as PurdueCourseEquivalenciesResponse
      );
      if (!payload.rows.length) continue;
      const key = `${payload.course.subject}:${payload.course.course}`;
      if (!deduped.has(key)) {
        deduped.set(key, {
          subject: payload.course.subject,
          course: payload.course.course,
          title: payload.course.title,
        });
      }
    }

    return [...deduped.values()].sort((a, b) => {
      if (a.subject !== b.subject) return a.subject.localeCompare(b.subject);
      return a.course.localeCompare(b.course);
    });
  }

  const [equivalencyTitlesByKey, catalogByKey] = await Promise.all([
    getCachedPurdueEquivalencyTitleMap(env),
    getCachedPurdueCatalogMap(env),
  ]);
  const destRows = await runD1All<{ cache_key: string; payload_json: string }>(
    env.DB,
    "SELECT cache_key, payload_json FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%'"
  );

  const deduped = new Map<string, PurdueCatalogResponse["courses"][number]>();
  for (const row of destRows) {
    const destinations = JSON.parse(row.payload_json) as PurdueDestination[];
    if (!destinations.length) continue;

    const [, subject = "", course = ""] = row.cache_key.split(":");
    if (!subject || !course) continue;

    const key = `${subject}:${course}`;
    if (!deduped.has(key)) {
      const catalogCourse = catalogByKey.get(key);
      deduped.set(key, {
        subject,
        course,
        title: equivalencyTitlesByKey.get(key) ?? catalogCourse?.title ?? `${subject} ${course}`,
      });
    }
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject);
    return a.course.localeCompare(b.course);
  });
}

interface D1DestinationCacheIndex {
  existingDestinationKeys: Set<string>;
  matchingEquivalencyKeys: Set<string>;
}

async function runD1All<T>(
  db: D1Database,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  const statement = db.prepare(sql) as {
    bind?: (...params: unknown[]) => { all: <R>() => Promise<{ results?: R[] }> };
    all?: <R>() => Promise<{ results?: R[] }>;
  };

  if (args.length > 0 && statement.bind) {
    const bound = statement.bind(...args);
    const result = await bound.all<T>();
    return result.results ?? [];
  }

  if (statement.all) {
    const result = await statement.all<T>();
    return result.results ?? [];
  }

  if (statement.bind) {
    const result = await statement.bind().all<T>();
    return result.results ?? [];
  }

  return [];
}

function equivalencyCacheKeyFromDestinationKey(cacheKey: string): string {
  return cacheKey.replace(/^purdue-course-destinations:/, "purdue-course-equivalencies:");
}

async function getD1DestinationCacheIndex(
  db: D1Database,
  schoolId: string
): Promise<D1DestinationCacheIndex> {
  const existing = await runD1All<{ cache_key: string }>(
    db,
    "SELECT cache_key FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%'"
  );

  const matching = await runD1All<{ cache_key: string }>(
    db,
    "SELECT cache_key FROM materialized_responses WHERE cache_key LIKE 'purdue-course-destinations:%' AND payload_json LIKE ?1",
    `%\"id\":\"${schoolId}\"%`
  );

  return {
    existingDestinationKeys: new Set(existing.map((row) => row.cache_key)),
    matchingEquivalencyKeys: new Set(
      matching.map((row) => equivalencyCacheKeyFromDestinationKey(row.cache_key))
    ),
  };
}

/**
 * Aggregate reverse equivalency rows across the Purdue catalog where the destination
 * institution matches the selected school (cached per-course data only; missing
 * courses enqueue `purdue-course-equivalencies` refresh jobs).
 */
export async function buildSchoolOutboundEquivalencies(
  schoolId: string,
  state: string,
  location: string,
  env?: { CACHE?: KVNamespace; DB?: D1Database; HYDRATION_QUEUE?: Queue<RefreshJob> }
): Promise<SchoolOutboundEquivalenciesResponse> {
  const schoolName = await resolveSchoolName(schoolId, state, location, env);

  const targetKeys = new Set<string>([
    normalizeInstitutionKey(schoolName),
    normalizeInstitutionKey(`${schoolName} - ${state}`),
  ]);

  const catalogCacheKey = makeCacheKey("purdue-catalog");
  let catalog: PurdueCatalogResponse | null = null;
  if (env) {
    const catalogLookup = await getCachedWithMetadata<PurdueCatalogResponse>(
      env.CACHE,
      env.DB,
      catalogCacheKey
    );
    catalog = catalogLookup.data;
  }
  if (!catalog) {
    catalog = await buildPurdueCatalog();
  }

  const allRows: EquivalencyRow[] = [];
  let coursesWithCache = 0;
  let coursesMissingCache = 0;
  const pendingJobs = new Map<string, RefreshJob>();

  const cacheEnv = env?.DB ? env : null;
  const d1DestinationIndex = cacheEnv?.DB
    ? await getD1DestinationCacheIndex(cacheEnv.DB, schoolId)
    : null;

  if (cacheEnv && d1DestinationIndex) {
    for (const { subject, course } of catalog.courses) {
      const destKey = makeCacheKey("purdue-course-destinations", subject, course);
      if (d1DestinationIndex.existingDestinationKeys.has(destKey)) continue;

      coursesMissingCache++;
      pendingJobs.set(
        destKey,
        createRefreshJob(
          "purdue-course-destinations",
          destKey,
          { subject, course },
          PURDUE_COURSE_DESTINATIONS_TTL_SECONDS
        )
      );
    }

    for (const eqKey of d1DestinationIndex.matchingEquivalencyKeys) {
      const [, subject = "", course = ""] = eqKey.split(":");
      const lookup = await getCachedWithMetadata<PurdueCourseEquivalenciesResponse>(
        cacheEnv.CACHE,
        cacheEnv.DB,
        eqKey
      );

      if (!lookup.data) {
        coursesMissingCache++;
        pendingJobs.set(
          eqKey,
          createRefreshJob("purdue-course-equivalencies", eqKey, { subject, course }, 86400)
        );
        continue;
      }

      coursesWithCache++;
      for (const row of lookup.data.rows) {
        if (!row.transferInstitution) continue;
        if (targetKeys.has(normalizeInstitutionKey(row.transferInstitution))) {
          allRows.push(row);
        }
      }
    }

    const rows = dedupeRows(allRows);

    await dispatchRefreshJobsNow(cacheEnv, [...pendingJobs.values()]);

    return {
      school: { id: schoolId, state, name: schoolName },
      rows,
      counts: {
        equivalencies: rows.length,
        catalogCourses: catalog.courses.length,
        coursesWithCache,
        coursesMissingCache,
      },
    };
  }

  for (const { subject, course } of catalog.courses) {
    const eqKey = makeCacheKey("purdue-course-equivalencies", subject, course);

    if (!env) {
      coursesMissingCache++;
      continue;
    }

    const lookup = await getCachedWithMetadata<PurdueCourseEquivalenciesResponse>(
      env.CACHE,
      env.DB,
      eqKey
    );

    if (!lookup.data) {
      coursesMissingCache++;
      pendingJobs.set(
        eqKey,
        createRefreshJob("purdue-course-equivalencies", eqKey, { subject, course }, 86400)
      );
      continue;
    }

    coursesWithCache++;
    for (const row of lookup.data.rows) {
      if (!row.transferInstitution) continue;
      if (targetKeys.has(normalizeInstitutionKey(row.transferInstitution))) {
        allRows.push(row);
      }
    }
  }

  const rows = dedupeRows(allRows);

  await dispatchRefreshJobsNow(env ?? {}, [...pendingJobs.values()]);

  return {
    school: { id: schoolId, state, name: schoolName },
    rows,
    counts: {
      equivalencies: rows.length,
      catalogCourses: catalog.courses.length,
      coursesWithCache,
      coursesMissingCache,
    },
  };
}

export async function buildPurdueCatalog(): Promise<PurdueCatalogResponse> {
  const html = await fetchPurdueSelectInfoPage();
  const selectMatch = html.match(
    /<select name="purdue_subject_in"[^>]*>([\s\S]*?)<\/select>/i
  );
  if (!selectMatch) {
    return { courses: [], subjects: [], counts: { totalCourses: 0 } };
  }

  const subjectEntries = [
    ...selectMatch[1].matchAll(
      /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi
    ),
  ]
    .map((match) => ({
      code: match[1].trim(),
      name: match[2].replace(/<[^>]+>/g, "").trim() || match[1].trim(),
    }))
    .filter((s) => s.code.length > 0);

  const allCourses: Array<{ subject: string; course: string; title: string }> = [];

  for (let i = 0; i < subjectEntries.length; i += 5) {
    const batch = subjectEntries.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(async (subject) => {
        const rawCourses = parseCourses(
          await fetchPurdueCourses(subject.code)
        ).filter((c) => c.code !== "NC" && !c.code.includes("XXXX"));

        return rawCourses.map((c) => ({
          subject: subject.code,
          course: c.code,
          title: c.name,
        }));
      })
    );
    for (const rows of batchResults) {
      allCourses.push(...rows);
    }
  }

  allCourses.sort((a, b) => {
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject);
    return a.course.localeCompare(b.course);
  });

  return {
    courses: allCourses,
    subjects: subjectEntries,
    counts: { totalCourses: allCourses.length },
  };
}

function normalizePurdueDestination(d: PurdueDestination): PurdueDestination {
  return {
    ...d,
    location: d.location || "US",
    subregionName: d.subregionName || d.state,
  };
}

/** Older cache entries used institutionStates values as plain subregion codes. */
export function coercePurdueCourseEquivalenciesResponse(
  data: PurdueCourseEquivalenciesResponse
): PurdueCourseEquivalenciesResponse {
  const institutionStates: Record<string, InstitutionSubregion> = {};
  for (const [inst, val] of Object.entries(data.institutionStates as Record<string, unknown>)) {
    if (typeof val === "string") {
      institutionStates[inst] = { code: val, label: val, location: "US" };
    } else if (val && typeof val === "object" && "code" in val) {
      const o = val as { code: string; label?: string; location?: string };
      institutionStates[inst] = {
        code: o.code,
        label: o.label ?? o.code,
        location: o.location ?? "US",
      };
    }
  }
  const states = [...new Set(Object.values(institutionStates).map((s) => s.code))].sort();
  return { ...data, institutionStates, states };
}

async function discoverDestinations(
  subject: string,
  course: string
): Promise<PurdueDestination[]> {
  const locations = parseStates(await fetchPurdueLocations(course, subject));
  const destinations = new Map<string, PurdueDestination>();

  for (const loc of locations) {
    const locStates = parseStates(
      await fetchPurdueStates(loc.code, subject, course)
    );
    for (const st of locStates) {
      const schools = parseSchools(
        await fetchPurdueSchools(st.code, subject, course, loc.code)
      );
      for (const school of schools) {
        const schoolState = school.state || st.code;
        destinations.set(`${loc.code}:${schoolState}:${school.id}`, {
          location: loc.code,
          state: schoolState,
          subregionName: st.name,
          id: school.id,
          name: school.name,
        });
      }
    }
  }

  return [...destinations.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.state.localeCompare(b.state)
  );
}

/** Same destination list as used by the meta route and refresh jobs. */
export async function getPurdueCourseDestinations(
  subject: string,
  course: string
): Promise<PurdueDestination[]> {
  const list = await discoverDestinations(subject, course);
  return list.map(normalizePurdueDestination);
}

export async function buildPurdueCourseEquivalencies(
  subject: string,
  course: string,
  env?: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<PurdueCourseEquivalenciesResponse> {
  const destCacheKey = makeCacheKey("purdue-course-destinations", subject, course);

  // Try cached destinations first
  const destStart = Date.now();
  let destList: PurdueDestination[];
  let destSource: "cache" | "crawl";

  const cached = env
    ? await getCached<PurdueDestination[]>(env.CACHE, env.DB, destCacheKey)
    : null;

  if (cached) {
    destList = cached.map((d) => normalizePurdueDestination(d as PurdueDestination));
    destSource = "cache";
  } else {
    destList = await discoverDestinations(subject, course);
    destSource = "crawl";
    // Don't promote an empty destination list for a full day — Purdue upstream
    // may be flaky. A short TTL lets the next request re-crawl quickly.
    if (env) {
      const ttl = destList.length > 0 ? PURDUE_COURSE_DESTINATIONS_TTL_SECONDS : 300;
      await setCache(env.CACHE, env.DB, destCacheKey, destList, ttl);
    }
  }

  console.log(JSON.stringify({
    event: "reverse-destinations",
    subject,
    course,
    source: destSource,
    count: destList.length,
    duration_ms: Date.now() - destStart,
  }));

  if (!destList.length) {
    return {
      course: { subject, course, title: `${subject} ${course}`, credits: "" },
      states: [],
      institutionStates: {},
      rows: [],
      counts: { institutions: 0, equivalencies: 0 },
    };
  }

  // Build institution→subregion mapping from destinations
  const destByName = new Map<string, PurdueDestination>();
  const destNamesNormalized = new Map<string, PurdueDestination>();
  for (const dest of destList) {
    destByName.set(dest.name, dest);
    destNamesNormalized.set(normalizeInstitutionKey(dest.name), dest);
    destNamesNormalized.set(normalizeInstitutionKey(`${dest.name} - ${dest.state}`), dest);
  }

  // Get one session cookie for all report batches
  const cookie = await fetchReportSessionCookie();

  let courseTitle = `${subject} ${course}`;
  let courseCredits = "";

  const allRows: EquivalencyRow[] = [];
  const institutionStates: Record<string, InstitutionSubregion> = {};
  let batchCount = 0;

  // Build all batches upfront, then run with limited concurrency
  const REPORT_CONCURRENCY = 5;
  const batches: PurdueDestination[][] = [];
  for (let i = 0; i < destList.length; i += 5) {
    batches.push(destList.slice(i, i + 5));
  }

  const reportStart = Date.now();
  try {
    for (let i = 0; i < batches.length; i += REPORT_CONCURRENCY) {
      const concurrent = batches.slice(i, i + REPORT_CONCURRENCY);
      const results = await Promise.all(
        concurrent.map(async (chunk) => {
          const rows = chunk.map((dest) => ({
            subject,
            course,
            location: dest.location,
            state: dest.state,
            school: dest.id,
          }));
          const html = await fetchPurdueEquivalencyReportWithSession(rows, cookie);
          return { parsed: parseEquivalencyReport(html), chunk };
        })
      );
      for (const { parsed, chunk } of results) {
        batchCount++;
        for (const row of parsed) {
          if (row.transferInstitution) {
            const matchedDest =
              destByName.get(row.transferInstitution) ??
              chunk.find((d) => d.name === row.transferInstitution) ??
              destNamesNormalized.get(normalizeInstitutionKey(row.transferInstitution));
            if (matchedDest) {
              institutionStates[row.transferInstitution] = {
                code: matchedDest.state,
                label: matchedDest.subregionName || matchedDest.state,
                location: matchedDest.location,
              };
            }
          }
        }
        allRows.push(...parsed);
      }
    }
  } catch (error) {
    console.log(JSON.stringify({
      event: "reverse-reports-failed",
      subject,
      course,
      destination_count: destList.length,
      batches_completed: batchCount,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }

  const deduped = dedupeRows(allRows);

  if (deduped.length > 0) {
    const first = deduped[0];
    if (first.purdueTitle) courseTitle = first.purdueTitle;
    if (first.purdueCredits) courseCredits = first.purdueCredits;
  }

  const states = [...new Set(Object.values(institutionStates).map((s) => s.code))].sort();

  console.log(JSON.stringify({
    event: "reverse-reports-complete",
    subject,
    course,
    destination_count: destList.length,
    batch_count: batchCount,
    equivalency_count: deduped.length,
    duration_ms: Date.now() - reportStart,
  }));

  return {
    course: { subject, course, title: courseTitle, credits: courseCredits },
    states,
    institutionStates,
    rows: deduped,
    counts: {
      institutions: destList.length,
      equivalencies: deduped.length,
    },
  };
}
