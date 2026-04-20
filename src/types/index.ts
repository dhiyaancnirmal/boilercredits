export interface PurdueState {
  name: string;
  code: string;
}

export interface PurdueSchool {
  name: string;
  id: string;
  state: string;
}

export interface PurdueSubject {
  code: string;
  name: string;
}

export interface PurdueCourse {
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

export interface EquivalencySearchResult {
  rows: EquivalencyRow[];
  query: {
    location: string;
    state: string;
    school: string;
    subject: string;
    course: string;
  };
}

export type RefreshKind =
  | "outbound-schools"
  | "all-schools"
  | "states"
  | "schools"
  | "subjects"
  | "courses"
  | "purdue-course-directory"
  | "purdue-courses"
  | "purdue-subjects"
  | "purdue-course-list"
  | "purdue-course-destinations"
  | "purdue-locations"
  | "purdue-states"
  | "purdue-schools"
  | "search"
  | "reverse-search"
  | "school-equivalencies"
  | "school-outbound-equivalencies"
  | "purdue-catalog"
  | "purdue-course-equivalencies";

export interface RefreshJob {
  kind: RefreshKind;
  cacheKey: string;
  payload: Record<string, string>;
  ttlSeconds: number;
  nextRefreshAt?: number;
}

export interface Env {
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string;
  CACHE?: KVNamespace;
  DB?: D1Database;
  HYDRATION_QUEUE?: Queue<RefreshJob>;
}

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface AppVariables {
  requestId: string;
}

export interface SchoolEquivalenciesResponse {
  school: { id: string; state: string; name: string };
  subjects: Array<{ code: string; name: string }>;
  rows: EquivalencyRow[];
  counts: { subjects: number; equivalencies: number };
}

/** Reverse-report rows aggregated for a destination school (Purdue → this school). */
export interface SchoolOutboundEquivalenciesResponse {
  school: { id: string; state: string; name: string };
  rows: EquivalencyRow[];
  counts: {
    equivalencies: number;
    catalogCourses: number;
    coursesWithCache: number;
    coursesMissingCache: number;
  };
}

export interface PurdueCatalogResponse {
  courses: Array<{ subject: string; course: string; title: string }>;
  subjects: Array<{ code: string; name: string }>;
  counts: { totalCourses: number };
}

/** Purdue transfer UI: school sits under a location and a subregion (code + human label). */
export interface PurdueDestination {
  location: string;
  /** Subregion code used in equivalency requests (not always a US state). */
  state: string;
  /** Human-readable subregion label from Purdue (e.g. province name). */
  subregionName: string;
  id: string;
  name: string;
}

/** Maps transfer institution name to subregion code, label, and Purdue location bucket. */
export interface InstitutionSubregion {
  code: string;
  label: string;
  /** Purdue top-level location (e.g. US). Non-US rows use full labels in the UI without code suffixes. */
  location: string;
}

export interface PurdueCourseEquivalenciesResponse {
  course: { subject: string; course: string; title: string; credits: string };
  states: string[];
  institutionStates: Record<string, InstitutionSubregion>;
  rows: EquivalencyRow[];
  counts: { institutions: number; equivalencies: number };
}

export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}
