export interface School {
  name: string;
  id: string;
  state: string;
}

export interface Subject {
  code: string;
  name: string;
}

export interface EquivalencyRow {
  transferInstitution: string;
  transferSubject: string;
  transferCourse: string;
  transferTitle: string;
  transferCredits: string;
  purdueSubject: string;
  purdueCourse: string;
  purdueTitle: string;
  purdueCredits: string;
}

export interface EquivalencySearchRow {
  location: string;
  state: string;
  school: string;
  subject: string;
  course: string;
}

export interface EquivalencySearchResponse {
  rows: EquivalencyRow[];
  query: EquivalencySearchRow;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = "Request failed";
    try {
      const body = await response.json();
      if (typeof body.error === "string" && body.error) {
        message = body.error;
      } else if (Array.isArray(body.details) && body.details.length) {
        const first = body.details[0];
        if (first && typeof first.message === "string") message = first.message;
      }
    } catch {
      message = await response.text().catch(() => message);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function getAllSchools(location = "US"): Promise<School[]> {
  return apiFetch<School[]>(`/api/meta/all-schools?location=${encodeURIComponent(location)}`);
}

export function getSubjects(schoolId: string, state: string, location = "US"): Promise<Subject[]> {
  const params = new URLSearchParams({ schoolId, state, location });
  return apiFetch<Subject[]>(`/api/meta/subjects?${params.toString()}`);
}

export interface PurdueCatalogCourse {
  subject: string;
  course: string;
  title: string;
}

export interface PurdueCatalogResponse {
  courses: PurdueCatalogCourse[];
  subjects: Subject[];
  counts: { totalCourses: number };
}

export interface InstitutionSubregion {
  code: string;
  label: string;
  location: string;
}

export interface PurdueCourseEquivalenciesResponse {
  course: { subject: string; course: string; title: string; credits: string };
  states: string[];
  institutionStates: Record<string, InstitutionSubregion>;
  rows: EquivalencyRow[];
  counts: Record<string, number>;
}

export interface SchoolEquivalenciesResponse {
  school: School;
  subjects: Subject[];
  rows: EquivalencyRow[];
  counts: Record<string, number>;
}

export function getPurdueCatalog(): Promise<PurdueCatalogResponse> {
  return apiFetch<PurdueCatalogResponse>("/api/meta/purdue-catalog");
}

export function getPurdueCourseDirectory(): Promise<PurdueCatalogCourse[]> {
  return apiFetch<PurdueCatalogCourse[]>("/api/meta/purdue-course-directory");
}

export function getPurdueCourseEquivalencies(subject: string, course: string): Promise<PurdueCourseEquivalenciesResponse> {
  const params = new URLSearchParams({ subject, course });
  return apiFetch<PurdueCourseEquivalenciesResponse>(`/api/meta/purdue-course-equivalencies?${params.toString()}`);
}

export function searchEquivalencies(rows: EquivalencySearchRow[]): Promise<EquivalencySearchResponse> {
  return apiFetch<EquivalencySearchResponse>("/api/equivalency/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rows }),
  });
}

export function getSchoolEquivalencies(schoolId: string, state: string, location = "US"): Promise<SchoolEquivalenciesResponse> {
  const params = new URLSearchParams({ schoolId, state, location });
  return apiFetch<SchoolEquivalenciesResponse>(`/api/meta/school-equivalencies?${params.toString()}`);
}
