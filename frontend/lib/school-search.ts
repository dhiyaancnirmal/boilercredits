import { normalize, rankList } from "./fuzzy";

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", GU: "Guam", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VI: "Virgin Islands", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut",
  ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan",
  YT: "Yukon",
};

export type SchoolCatalogLocation = "US" | "International";

type SchoolLike = {
  name: string;
  state: string;
};

/** Merged US + international school list: each row knows which Purdue catalog bucket it belongs to. */
export type SchoolWithCatalog = SchoolLike & { catalog: SchoolCatalogLocation };

/** English country or region name for an ISO 3166-1 alpha-2 code (meaningful in the international school list only). */
export function intlRegionName(code: string): string | null {
  try {
    const d = new Intl.DisplayNames(["en"], { type: "region" });
    const n = d.of(code);
    if (!n || n === code) return null;
    return n;
  } catch {
    return null;
  }
}

export function formatSchoolListRegionLabel(stateCode: string, catalog: SchoolCatalogLocation): string {
  const code = stateCode.trim().toUpperCase();
  if (catalog === "US") {
    if (code in STATE_NAMES) return code;
    return "United States";
  }
  return intlRegionName(code) ?? code;
}

export function formatSchoolBrowseRegionLabel(stateCode: string): string {
  const code = stateCode.trim().toUpperCase();
  return code || "--";
}

export function resolveStateQuery(query: string): string | null {
  const normalized = normalize(query);
  if (!normalized) return null;

  const code = normalized.toUpperCase();
  if (code in STATE_NAMES) return code;

  for (const [stateCode, stateName] of Object.entries(STATE_NAMES)) {
    if (normalize(stateName) === normalized) return stateCode;
  }

  return null;
}

function resolveInternationalStateFilter<T extends SchoolLike>(schools: T[], query: string): string | null {
  const t = query.trim().toUpperCase();
  if (t.length === 2 && /^[A-Z]{2}$/.test(t) && schools.some((s) => s.state === t)) {
    return t;
  }
  const n = normalize(query);
  if (!n) return null;
  const seen = new Set<string>();
  for (const school of schools) {
    if (seen.has(school.state)) continue;
    seen.add(school.state);
    const intl = intlRegionName(school.state);
    if (intl && normalize(intl) === n) return school.state;
  }
  return null;
}

function schoolSearchText(school: SchoolLike, catalog: SchoolCatalogLocation): string {
  if (catalog === "US") {
    return `${school.name} ${school.state} ${STATE_NAMES[school.state] ?? ""}`;
  }
  const intl = intlRegionName(school.state) ?? "";
  return `${school.name} ${school.state} ${intl}`;
}

export function searchSchools<T extends SchoolLike>(
  schools: T[],
  query: string,
  catalog: SchoolCatalogLocation = "US"
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return schools;

  const stateCode =
    catalog === "US" ? resolveStateQuery(query) : resolveInternationalStateFilter(schools, query);
  // Pure state-code queries bypass the fuzzy scorer so all matching schools are
  // returned in the catalog's original (alphabetical) order, not re-ranked by a
  // query that happens to match some school names as substrings too.
  if (stateCode) return schools.filter((school) => school.state === stateCode);
  return rankList(
    schools,
    query,
    (school) => schoolSearchText(school, catalog),
    schools.length
  );
}

/** Search across a list that mixes US and international schools (one unified directory). */
export function searchSchoolsCombined<T extends SchoolWithCatalog>(schools: T[], query: string): T[] {
  const trimmed = query.trim();
  if (!trimmed) return schools;

  const usState = resolveStateQuery(query);
  if (usState) {
    const usMatch = schools.filter((s) => s.catalog === "US" && s.state === usState);
    if (usMatch.length) return usMatch;
  }

  const intlOnly = schools.filter((s) => s.catalog === "International");
  const intlState = resolveInternationalStateFilter(intlOnly, query);
  if (intlState) return intlOnly.filter((s) => s.state === intlState);

  return rankList(
    schools,
    query,
    (s) => schoolSearchText(s, s.catalog),
    schools.length
  );
}
