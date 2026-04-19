import type { EquivalencyRow } from "./api";

const STORAGE_KEY = "boilercredits_saved";

export function rowKey(row: EquivalencyRow): string {
  return [
    row.transferInstitution,
    row.transferSubject,
    row.transferCourse,
    row.purdueSubject,
    row.purdueCourse,
  ].join("|");
}

export function loadSavedRows(): EquivalencyRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EquivalencyRow[]) : [];
  } catch {
    return [];
  }
}

export function saveRows(rows: EquivalencyRow[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}
