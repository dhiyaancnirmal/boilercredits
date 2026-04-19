const PURDUE_BASE = "https://selfservice.mypurdue.purdue.edu/prod";
const PURDUE_AJAX = `${PURDUE_BASE}/bzwtxcrd.p_ajax`;
const PURDUE_REPORT = `${PURDUE_BASE}/bzwtxcrd.p_display_report`;

const TIMEOUT_MS = 10000;
const REPORT_TIMEOUT_MS = 20000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class PurdueUpstreamError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PurdueUpstreamError";
  }
}

export class PurdueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurdueTimeoutError";
  }
}

async function purdueFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...options.headers,
        "User-Agent": BROWSER_UA,
      },
    });

    if (!res.ok) {
      throw new PurdueUpstreamError(`Purdue upstream returned ${res.status}`, res.status);
    }

    return res;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new PurdueTimeoutError(`Purdue upstream timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchStates(location: string): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=states&request_value=${encodeURIComponent(location)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchSchools(state: string, location: string): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=school&request_value=${encodeURIComponent(state)}&request_value2=${encodeURIComponent(location)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchSubjects(
  schoolId: string,
  state: string,
  location: string
): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=subject&request_value=${encodeURIComponent(schoolId)}&request_value2=${encodeURIComponent(state)}&request_value3=${encodeURIComponent(location)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchCourses(schoolId: string, subject: string): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=course&request_value=${encodeURIComponent(subject)}&request_value2=${encodeURIComponent(schoolId)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchPurdueCourses(subject: string): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=purdue_course&request_value=${encodeURIComponent(subject)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchPurdueLocations(course: string, subject: string): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=location&request_value=${encodeURIComponent(course)}&request_value2=${encodeURIComponent(subject)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchPurdueStates(
  location: string,
  subject: string,
  course: string
): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=state&request_value=${encodeURIComponent(location)}&request_value2=${encodeURIComponent(subject)}&request_value3=${encodeURIComponent(course)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchPurdueSchools(
  state: string,
  subject: string,
  course: string,
  location: string
): Promise<string> {
  const url = `${PURDUE_AJAX}?request_type=purdue_schools&request_value=${encodeURIComponent(state)}&request_value2=${encodeURIComponent(subject)}&request_value3=${encodeURIComponent(course)}&request_value4=${encodeURIComponent(location)}`;
  const res = await purdueFetch(url);
  return res.text();
}

export async function fetchPurdueSelectInfoPage(): Promise<string> {
  const url = `${PURDUE_BASE}/bzwtxcrd.p_select_info`;
  const res = await purdueFetch(url);
  return res.text();
}

interface SearchRow {
  location: string;
  state: string;
  school: string;
  subject: string;
  course: string;
}

export interface PurdueSearchRow {
  subject: string;
  course: string;
  location: string;
  state: string;
  school: string;
}

const SELECT_URL = `${PURDUE_BASE}/bzwtxcrd.p_select_info`;

export async function fetchReportSessionCookie(): Promise<string> {
  const sessionRes = await purdueFetch(SELECT_URL, {}, REPORT_TIMEOUT_MS);
  return (sessionRes.headers.get("set-cookie") ?? "").split(";")[0];
}

function appendBlankForwardRows(params: URLSearchParams): void {
  for (let i = 0; i < 5; i++) {
    params.append("location_in", "");
    params.append("state_in", "");
    params.append("school_in", "");
    params.append("subject_in", "");
    params.append("course_in", "");
  }
}

function appendBlankReverseRows(params: URLSearchParams): void {
  for (let i = 0; i < 5; i++) {
    params.append("purdue_subject_in", "");
    params.append("purdue_course_in", "");
    params.append("purdue_location_in", "");
    params.append("purdue_state_in", "");
    params.append("purdue_school_in", "");
  }
}

function appendForwardRows(params: URLSearchParams, rows: SearchRow[]): void {
  for (let i = 0; i < 5; i++) {
    const row = rows[i];
    params.append("location_in", row?.location ?? "");
    params.append("state_in", row?.state ?? "");
    params.append("school_in", row?.school ?? "");
    params.append("subject_in", row?.subject ?? "");
    params.append("course_in", row?.course ?? "");
  }
}

function appendReverseRows(params: URLSearchParams, rows: PurdueSearchRow[]): void {
  for (let i = 0; i < 5; i++) {
    const row = rows[i];
    params.append("purdue_subject_in", row?.subject ?? "");
    params.append("purdue_course_in", row?.course ?? "");
    params.append("purdue_location_in", row?.location ?? "");
    params.append("purdue_state_in", row?.state ?? "");
    params.append("purdue_school_in", row?.school ?? "");
  }
}

async function fetchReport(
  params: URLSearchParams,
  selectUrl: string,
  cookieHeader: string
): Promise<string> {
  const res = await purdueFetch(
    PURDUE_REPORT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: selectUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: params.toString(),
    },
    REPORT_TIMEOUT_MS
  );

  return res.text();
}

export async function fetchEquivalencyReport(rows: SearchRow[]): Promise<string> {
  const cookieHeader = await fetchReportSessionCookie();
  const params = new URLSearchParams();

  appendForwardRows(params, rows);
  appendBlankReverseRows(params);

  return fetchReport(params, SELECT_URL, cookieHeader);
}

export async function fetchPurdueEquivalencyReport(rows: PurdueSearchRow[]): Promise<string> {
  const cookieHeader = await fetchReportSessionCookie();
  const params = new URLSearchParams();

  appendBlankForwardRows(params);
  appendReverseRows(params, rows);

  return fetchReport(params, SELECT_URL, cookieHeader);
}

export async function fetchPurdueEquivalencyReportWithSession(
  rows: PurdueSearchRow[],
  cookieHeader: string
): Promise<string> {
  const params = new URLSearchParams();

  appendBlankForwardRows(params);
  appendReverseRows(params, rows);

  return fetchReport(params, SELECT_URL, cookieHeader);
}
