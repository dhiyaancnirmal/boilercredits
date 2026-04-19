import type {
  PurdueState,
  PurdueSchool,
  PurdueSubject,
  PurdueCourse,
  EquivalencyRow,
} from "../types";

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&dagger;/g, "†")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePurdueText(raw: string): Array<{ label: string; value: string }> {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: Array<{ label: string; value: string }> = [];
  for (const line of lines.slice(1)) {
    const tildeIdx = line.lastIndexOf("~");
    if (tildeIdx === -1) continue;

    const label = line.slice(0, tildeIdx).trim();
    const value = line.slice(tildeIdx + 1).trim();
    if (!label || !value) continue;
    entries.push({ label, value });
  }

  return entries;
}

export function parseStates(raw: string): PurdueState[] {
  return parsePurdueText(raw).map((entry) => ({
    name: entry.label,
    code: entry.value,
  }));
}

export function parseSchools(raw: string): PurdueSchool[] {
  return parsePurdueText(raw).map((entry) => {
    const match = entry.label.match(/^(.+?)\s*-\s*([A-Z]{2})$/);
    return {
      name: match ? match[1].trim() : entry.label,
      id: entry.value,
      state: match ? match[2] : "",
    };
  });
}

export function parseSubjects(raw: string): PurdueSubject[] {
  return parsePurdueText(raw).map((entry) => ({
    code: entry.label,
    name: entry.value || entry.label,
  }));
}

export function parseCourses(raw: string): PurdueCourse[] {
  return parsePurdueText(raw).map((entry) => ({
    code: entry.label,
    name: entry.value || entry.label,
  }));
}

function extractReportTable(html: string): string | null {
  const patterns = [
    /<table[^>]*class=["']?(?:reportTable|datadisplaytable|displaytable)["']?[^>]*>([\s\S]*?)<\/table>/i,
    /<table[^>]*>([\s\S]*?)<\/table>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function parseRowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const openTags = [...rowHtml.matchAll(/<t[dh][^>]*>/gi)];

  for (let index = 0; index < openTags.length; index++) {
    const start = openTags[index].index! + openTags[index][0].length;
    const end = index + 1 < openTags.length ? openTags[index + 1].index! : rowHtml.length;
    const rawCell = rowHtml
      .slice(start, end)
      .replace(/<\/t[dh]>\s*$/i, "")
      .trim();

    cells.push(decodeHtml(rawCell));
  }

  return cells;
}

export function parseEquivalencyReport(html: string): EquivalencyRow[] {
  if (/internalservererror|problem\+json/i.test(html)) {
    throw new Error("Purdue report endpoint returned an error response");
  }

  const tableBody = extractReportTable(html);
  if (!tableBody) {
    if (/transfer\s+credit\s+search\s+results/i.test(html)) return [];
    throw new Error("Failed to parse Purdue equivalency report");
  }

  const rows: EquivalencyRow[] = [];
  const rowMatches = [...tableBody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const [rowIndex, rowMatch] of rowMatches.entries()) {
    if (rowIndex === 0) continue;

    const cells = parseRowCells(rowMatch[1]);
    if (cells.length < 9) continue;

    const transferInstitution = cells[0] || "";
    const transferSubject = cells[1] || "";
    const transferCourse = cells[2] || "";
    const transferTitle = cells[3] || "";
    const transferCredits = cells[4] || "";
    const purdueSubject = cells[5] || "";
    const purdueCourse = cells[6] || "";
    const purdueTitle = cells[7] || "";
    const purdueCredits = cells[8] || "";

    if (!transferInstitution && !transferSubject && !transferCourse && !transferTitle) {
      continue;
    }

    rows.push({
      transferInstitution,
      transferSubject,
      transferCourse,
      transferTitle,
      transferCredits,
      purdueSubject,
      purdueCourse,
      purdueTitle,
      purdueCredits,
    });
  }

  return rows;
}
