import type {
  EquivalencyRow,
  SchoolEquivalenciesResponse,
  PurdueCatalogResponse,
  PurdueCourseEquivalenciesResponse,
  PurdueDestination,
  InstitutionSubregion,
} from "../types";
import {
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
import { PURDUE_COURSE_DESTINATIONS_TTL_SECONDS } from "../lib/refresh";

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

export async function buildPurdueCourseDirectory(
  env: { CACHE?: KVNamespace; DB?: D1Database }
): Promise<PurdueCatalogResponse["courses"]> {
  if (!env.DB) return [];

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
