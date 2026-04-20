import { render, type ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import "./styles.css";
import logoUrl from "./logo.svg";
import {
  type School,
  type Subject,
  type EquivalencyRow,
  type PurdueCatalogCourse,
  type InstitutionSubregion,
  getAllSchools,
  getPurdueCourseDirectory,
  getPurdueCourseEquivalencies,
  getSchoolEquivalencies,
} from "./lib/api";
import { loadSavedRows, rowKey, saveRows } from "./lib/storage";
import { normalize, scoreText } from "./lib/fuzzy";
import {
  searchSchoolsCombined,
  intlRegionName,
  formatSchoolBrowseRegionLabel,
  formatSchoolListRegionLabel,
  type SchoolCatalogLocation,
} from "./lib/school-search";
import {
  decodeUndistributedCourseCode,
  isUndistributedCourseCode,
  undistributedKicker,
  type DecodedUndistributed,
} from "./lib/undistributed-codes";

type Tab = "schools" | "courses" | "saved" | "changelog";

type ForwardSelection = {
  id: string;
  state: string;
  name: string;
  catalog: SchoolCatalogLocation;
};

/** One row in the merged Schools directory (US + international in a single list). */
type SchoolListRow = School & { catalog: SchoolCatalogLocation };
type SchoolDirectoryGroup = { key: SchoolCatalogLocation; label: string; schools: SchoolListRow[] };

type SubregionOption = { code: string; label: string; location: string };

/**
 * Subregion line without US vs international prefix (used inside formatSubregionDisplayLine).
 * International: if Purdue only gives a 2-letter code, expand with Intl when possible so "IN" is not ambiguous.
 */
function formatSubregionMenuLabel(code: string, label: string, purdueLocationBucket: string): string {
  if (purdueLocationBucket !== "US") {
    if (label === code && code.length === 2) {
      const intl = intlRegionName(code);
      if (intl) return intl;
    }
    return label;
  }
  if (label === code) return code;
  return `${label} (${code})`;
}

/** Filter options, badges, and destination rows (catalog bucket chooses US vs intl resolution in the menu label). */
function formatSubregionDisplayLine(code: string, label: string, purdueLocationBucket: string): string {
  return formatSubregionMenuLabel(code, label, purdueLocationBucket);
}

const STAR_FILLED =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
const STAR_EMPTY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';

const BACK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19 12H5" />
    <path d="M12 5l-7 7 7 7" />
  </svg>
);
const REPO_URL = "https://github.com/dhiyaancnirmal/boilercredits";
const PURDUE_SOURCE_URL =
  "https://selfservice.mypurdue.purdue.edu/prod/bzwtxcrd.p_select_info";
const DAGGER_NOTE =
  "† marks a course Purdue labels as part of the Transfer Indiana initiative.";
/** Shown when fetch to /api fails (often Wrangler not running on 8787 while Vite proxies there). */
const API_UNREACHABLE_HINT =
  "Couldn’t reach the API. On localhost, start the Worker on port 8787 (pnpm dev:api) or run pnpm dev for Vite + Worker together.";
const SCHOOL_SEARCH_HINTS = [
  "Search by name, state, or country",
  "Indiana University",
  "University of Waterloo",
  "IN",
  "Canada",
];
const SCHOOL_SEARCH_PLACEHOLDER =
  "Search by name, state, or country (e.g. Indiana University, IN, Canada)";
const PURDUE_SEARCH_HINTS = [
  "Search by course, subject, or title",
  "MA 16100",
  "CS",
  "Calculus",
];
const APP_VERSION = "v2.0.1";
const CHANGELOG_ENTRIES = [
  {
    version: APP_VERSION,
    date: "April 20, 2026",
    changes: [
      "Added credit sorting for course equivalencies.",
      "Removed outbound transfer lookup after confirming Purdue does not publish real outbound transfer data.",
      "Kept the Schools and Courses flows focused on the supported inbound-equivalency dataset.",
    ],
  },
  {
    version: "v2.0.0",
    date: "April 19, 2026",
    changes: [
      "Initial public launch of BoilerCredits.",
      "Added school-first and course-first browse flows backed by Purdue's transfer credit equivalency guide.",
      "Added saved equivalencies, mobile polish, and clearer transfer-credit browsing for Purdue students.",
    ],
  },
];

function starIcon(active: boolean): string {
  return active ? STAR_FILLED : STAR_EMPTY;
}

// ── URL hash routing ──────────────────────────────────────────────────────────
// Current format:
//   #schools | #schools/us/ID/STATE | #schools/intl/ID/STATE
//   #courses | #courses/SUBJECT/COURSE
//   #saved | #changelog
// Legacy still parsed on restore (sync effect migrates URL):
//   #forward, #reverse, #purdue-credit, #schools/in, #schools/out, #courses/in, #courses/out

function parseInitialTab(): Tab {
  const part = window.location.hash.slice(1).split("/")[0];
  if (part === "changelog") return "changelog";
  if (part === "saved") return "saved";
  if (part === "courses" || part === "reverse" || part === "purdue-credit") return "courses";
  if (part === "schools" || part === "forward") return "schools";
  return "schools";
}

type HashRestore =
  | { kind: "school"; id: string; state: string; catalog?: SchoolCatalogLocation }
  | { kind: "school-browse" }
  | { kind: "courses"; subject: string; course: string }
  | null;

function schoolCatalogToHashSegment(catalog: SchoolCatalogLocation): "us" | "intl" {
  return catalog === "US" ? "us" : "intl";
}

function hashSegmentToSchoolCatalog(segment: string | undefined): SchoolCatalogLocation | null {
  if (segment === "us") return "US";
  if (segment === "intl") return "International";
  return null;
}

function parseHashRestore(): HashRestore {
  const parts = window.location.hash.slice(1).split("/");
  const root = parts[0];
  if (root === "schools" || root === "forward") {
    // Legacy: strip in/out direction segment if present.
    const offset = parts[1] === "in" || parts[1] === "out" ? 1 : 0;
    const catalogSeg = parts[1 + offset];
    const catalog = hashSegmentToSchoolCatalog(catalogSeg);
    if (catalog && parts[2 + offset] && parts[3 + offset]) {
      return { kind: "school", id: parts[2 + offset], state: parts[3 + offset], catalog };
    }
    if (parts[1 + offset] && parts[2 + offset]) {
      return { kind: "school", id: parts[1 + offset], state: parts[2 + offset] };
    }
    return { kind: "school-browse" };
  }
  if (root === "reverse" && parts[1] && parts[2])
    return { kind: "courses", subject: parts[1], course: decodeURIComponent(parts[2]) };
  if (root === "purdue-credit" && parts[1] && parts[2])
    return { kind: "courses", subject: parts[1], course: decodeURIComponent(parts[2]) };
  if (root === "courses") {
    // Legacy: strip in/out direction segment if present.
    const offset = parts[1] === "in" || parts[1] === "out" ? 1 : 0;
    if (parts[1 + offset] && parts[2 + offset]) {
      return {
        kind: "courses",
        subject: parts[1 + offset],
        course: decodeURIComponent(parts[2 + offset]),
      };
    }
  }
  return null;
}

/** Rewrite legacy hashes to the new format (idempotent for new URLs). */
function migrateHashToNewFormat(): void {
  const raw = window.location.hash.slice(1);
  if (!raw) return;
  const p = raw.split("/");
  let newHash: string | null = null;

  if (p[0] === "forward") {
    newHash = p.length > 1 ? `schools/${p.slice(1).join("/")}` : "schools";
  } else if (p[0] === "reverse" || p[0] === "purdue-credit") {
    newHash = p.length > 1 ? `courses/${p.slice(1).join("/")}` : "courses";
  } else if (p[0] === "schools" && (p[1] === "in" || p[1] === "out")) {
    newHash = p.length > 2 ? `schools/${p.slice(2).join("/")}` : "schools";
  } else if (p[0] === "courses" && (p[1] === "in" || p[1] === "out")) {
    newHash = p.length > 2 ? `courses/${p.slice(2).join("/")}` : "courses";
  } else if (
    p[0] === "schools" &&
    p[1] &&
    p[2] &&
    p[1] !== "us" &&
    p[1] !== "intl"
  ) {
    // Legacy #schools/ID/STATE[/out] → strip trailing direction.
    newHash = `schools/${p[1]}/${p[2]}`;
  }

  if (newHash !== null && `#${newHash}` !== window.location.hash) {
    history.replaceState(null, "", `#${newHash}`);
  }
}

function buildHash(
  tab: Tab,
  selectedSchool: ForwardSelection | null,
  selectedCourse: PurdueCatalogCourse | null
): string {
  if (tab === "changelog") return "#changelog";
  if (tab === "schools" && selectedSchool) {
    const catalog = schoolCatalogToHashSegment(selectedSchool.catalog);
    return `#schools/${catalog}/${selectedSchool.id}/${selectedSchool.state}`;
  }
  if (tab === "courses" && selectedCourse) {
    const enc = encodeURIComponent(selectedCourse.course);
    return `#courses/${selectedCourse.subject}/${enc}`;
  }
  if (tab === "courses") return "#courses";
  if (tab === "saved") return "#saved";
  return "";
}

function formatCredit(value: string | null | undefined): string {
  const credit = value?.trim() ?? "";
  if (!credit) return "-";
  if (/^\./.test(credit)) return `0${credit}`;
  if (/^-\./.test(credit)) return `-0${credit.slice(1)}`;
  return credit;
}

function parseMinCredits(value: string | null | undefined): number {
  const s = (value ?? "").trim();
  if (!s || s === "-") return Infinity;
  const parts = s.split("-");
  const first = parseFloat(parts[0]);
  return isNaN(first) ? Infinity : first;
}

function UndistributedPill({ decoded }: { decoded: DecodedUndistributed }) {
  const uid = useId();
  const popoverId = `undist-${uid}`;
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kicker = undistributedKicker(decoded.kind);
  const ariaSummary = `${kicker}. ${decoded.headline}`;

  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 220);
  };

  const revealPopover = () => {
    cancelScheduledClose();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setPopoverPos(null);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const maxW = Math.min(320, vw - margin * 2);
    let left = r.left;
    if (left + maxW > vw - margin) left = Math.max(margin, vw - margin - maxW);
    setPopoverPos({ top: r.bottom + 6, left });
  }, [open]);

  useEffect(() => () => cancelScheduledClose(), []);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <span
      class="undistributed-pill-wrap"
      ref={wrapRef}
      onMouseEnter={revealPopover}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={btnRef}
        type="button"
        class={`undistributed-pill${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`${decoded.raw}. ${ariaSummary}`}
        onClick={(e) => {
          e.stopPropagation();
          cancelScheduledClose();
          setOpen((o) => !o);
        }}
      >
        {decoded.raw}
      </button>
      {open && popoverPos && (
        <div
          id={popoverId}
          class="undistributed-popover popover-panel"
          role="region"
          aria-label={ariaSummary}
          style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
          onMouseEnter={revealPopover}
          onMouseLeave={scheduleClose}
        >
          <p class="undistributed-popover-kicker">{kicker}</p>
          <p class="undistributed-popover-title">{decoded.headline}</p>
          <p class="undistributed-popover-body">{decoded.detail}</p>
          <p class="undistributed-popover-level">{decoded.levelHint}</p>
        </div>
      )}
    </span>
  );
}

function HoverTooltip({
  children,
  tip,
  kicker,
  align = "center",
  class: className = "",
}: {
  children: ComponentChildren;
  tip: ComponentChildren;
  kicker?: string;
  align?: "center" | "start" | "end";
  class?: string;
}) {
  const uid = useId();
  const tipId = `site-tt-${uid}`;
  return (
    <div
      class={`hover-tooltip hover-tooltip--${align} ${className}`.trim()}
      aria-describedby={tipId}
    >
      {children}
      <div id={tipId} class="popover-panel hover-tooltip-panel" role="tooltip">
        {kicker ? <p class="undistributed-popover-kicker">{kicker}</p> : null}
        {tip}
      </div>
    </div>
  );
}

function renderCourseCode(subject: string, course: string) {
  const code = `${subject || ""} ${course || ""}`.trim();
  if (!code) return "—";
  const decoded = course && isUndistributedCourseCode(course) ? decodeUndistributedCourseCode(course) : null;

  const inner = (
    <strong class="course-code-line">
      {decoded ? (
        <>
          {subject ? <span class="course-code-subj">{subject}</span> : null}
          <UndistributedPill decoded={decoded} />
        </>
      ) : (
        code
      )}
    </strong>
  );

  return inner;
}

function hasDagger(rows: EquivalencyRow[]): boolean {
  return rows.some((row) =>
    `${row.transferSubject} ${row.transferCourse} ${row.purdueSubject} ${row.purdueCourse}`.includes("†")
  );
}

function renderSingleLineText(value: string | null | undefined, fallback = "—") {
  return <span class="single-line-text">{value || fallback}</span>;
}

async function timedFetch<T>(fn: () => Promise<T>): Promise<{ data: T; ms: number }> {
  const start = performance.now();
  const data = await fn();
  return { data, ms: Math.round(performance.now() - start) };
}

function splitStatus(status: string): { label: string; time: string | null } {
  const match = status.match(/^(.*)\s+\(([^)]+)\)$/);
  if (!match) return { label: status, time: null };
  return { label: match[1], time: match[2] };
}

function formatCountStatus(label: string, count: number, time: string | null = null): string {
  return time ? `${label}: ${count} (${time})` : `${label}: ${count}`;
}

function StatusPill({
  status,
  loading,
}: {
  status: string;
  loading?: boolean;
}) {
  if (!status.trim() && !loading) return null;

  const { label, time } = splitStatus(status);

  return (
    <span class={`browse-loading${loading ? " is-loading" : ""}`} aria-busy={loading || undefined}>
      <span class="status-pill-label">{label}</span>
      {loading ? <span class="status-pill-spinner" aria-hidden="true" /> : null}
      {time && <span class="status-pill-time">({time})</span>}
    </span>
  );
}

function useIsMobile(breakpoint = 640): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return mobile;
}

function courseDisplayCode(subject: string, course: string): string {
  return `${subject} ${course}`;
}

function SearchHintTicker({
  hints,
  active,
}: {
  hints: string[];
  active: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [shift, setShift] = useState(0);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!active || hints.length <= 1) {
      setIndex(0);
      return;
    }

    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % hints.length);
    }, 3600);

    return () => window.clearInterval(interval);
  }, [active, hints]);

  useEffect(() => {
    if (!active) {
      setShift(0);
      return;
    }

    const measure = () => {
      const outer = outerRef.current;
      const text = textRef.current;
      if (!outer || !text) return;
      setShift(Math.max(0, text.scrollWidth - outer.clientWidth));
    };

    const frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [active, index]);

  if (!active) return null;

  return (
    <div
      ref={outerRef}
      class="search-hint-ticker"
      aria-hidden="true"
      style={{ "--ticker-shift": `${shift}px` } as any}
    >
      <span
        ref={textRef}
        key={`${index}-${hints[index]}`}
        class={`search-hint-ticker-text${shift > 0 ? " scrolling" : ""}`}
      >
        {hints[index]}
      </span>
    </div>
  );
}

function ChangelogView() {
  return (
    <section class="changelog-page" aria-labelledby="changelog-title">
      <h1 id="changelog-title" class="changelog-title">Changelog</h1>
      <div class="changelog-list">
        {CHANGELOG_ENTRIES.map((entry) => (
          <section key={entry.version} class="changelog-entry">
            <div class="changelog-entry-head">
              <span class="changelog-version">{entry.version}</span>
              <span class="changelog-date">{entry.date}</span>
            </div>
            <ul class="changelog-changes">
              {entry.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function Table({
  rows,
  savedKeys,
  onToggleSave,
  loading,
  isMobile,
  preserveOrder = false,
}: {
  rows: EquivalencyRow[];
  savedKeys: Set<string>;
  onToggleSave: (row: EquivalencyRow) => void;
  loading?: boolean;
  isMobile?: boolean;
  preserveOrder?: boolean;
}) {
  if (!rows.length) {
    if (loading) return null;
    return (
      <div class="results-empty">
        <p>No equivalencies found.</p>
      </div>
    );
  }

  const sorted = preserveOrder ? rows : [...rows].sort((a, b) => {
    const aCode = `${a.transferSubject ?? ""} ${a.transferCourse ?? ""}`;
    const bCode = `${b.transferSubject ?? ""} ${b.transferCourse ?? ""}`;
    return aCode.localeCompare(bCode);
  });
  const showDaggerNote = hasDagger(sorted);

  if (isMobile) {
    return (
      <>
        <div class="card-list">
          {sorted.map((row) => {
            const key = rowKey(row);
            const active = savedKeys.has(key);
            return (
              <div class="eq-card eq-card-flow-inbound" key={key}>
                <div class="eq-card-header">
                  <span class="eq-card-label">Transfer</span>
                  <button
                    class={`icon-btn${active ? " active" : ""}`}
                    type="button"
                    aria-label={active ? "Remove" : "Save"}
                    onClick={() => onToggleSave(row)}
                    dangerouslySetInnerHTML={{ __html: starIcon(active) }}
                  />
                </div>
                <div class="eq-card-value">
                  {row.transferSubject || row.transferCourse
                    ? renderCourseCode(row.transferSubject, row.transferCourse)
                    : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{row.transferInstitution || "—"}</span>}
                </div>
                {row.transferTitle && <div class="eq-card-detail">{row.transferTitle}</div>}
                {(row.transferSubject || row.transferCourse) && <div class="eq-card-detail">{formatCredit(row.transferCredits)} credits</div>}
                <div class="eq-card-arrow">↓</div>
                <div class="eq-card-purdue">
                  <span class="eq-card-label">Purdue</span>
                  <div class="eq-card-value">{renderCourseCode(row.purdueSubject, row.purdueCourse)}</div>
                  {row.purdueTitle && <div class="eq-card-detail">{row.purdueTitle}</div>}
                  <div class="eq-card-detail">{formatCredit(row.purdueCredits)} credits</div>
                </div>
              </div>
            );
          })}
        </div>
        {showDaggerNote && <p class="results-note">{DAGGER_NOTE}</p>}
      </>
    );
  }

  return (
    <>
      <div class="results-table-wrap">
        <table class="results-table">
          <thead>
            <tr>
              <th class="results-col-transfer-course">Transfer Course</th>
              <th class="results-col-transfer-title">Transfer Title</th>
              <th class="results-col-credits">Credits</th>
              <th class="arrow-col" />
              <th class="results-col-purdue-course">Purdue Course</th>
              <th class="results-col-purdue-title">Purdue Title</th>
              <th class="results-col-credits">Credits</th>
              <th class="action-col" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = rowKey(row);
              const active = savedKeys.has(key);
              return (
                <tr key={key}>
                  <td class="results-col-transfer-course">
                    {row.transferSubject || row.transferCourse
                      ? renderCourseCode(row.transferSubject, row.transferCourse)
                      : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{row.transferInstitution || "—"}</span>}
                  </td>
                  <td class="results-col-transfer-title">{renderSingleLineText(row.transferTitle)}</td>
                  <td class="results-col-credits">{row.transferSubject || row.transferCourse ? formatCredit(row.transferCredits) : "—"}</td>
                  <td class="arrow-col">→</td>
                  <td class="results-col-purdue-course">{renderCourseCode(row.purdueSubject, row.purdueCourse)}</td>
                  <td class="results-col-purdue-title">{renderSingleLineText(row.purdueTitle)}</td>
                  <td class="results-col-credits">{formatCredit(row.purdueCredits)}</td>
                  <td class="action-col">
                    <button
                      class={`icon-btn${active ? " active" : ""}`}
                      type="button"
                      aria-label={active ? "Remove" : "Save"}
                      onClick={() => onToggleSave(row)}
                      dangerouslySetInnerHTML={{ __html: starIcon(active) }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showDaggerNote && <p class="results-note">{DAGGER_NOTE}</p>}
    </>
  );
}

function ReverseTable({
  rows,
  savedKeys,
  onToggleSave,
  loading,
  error,
  isMobile,
  preserveOrder = false,
}: {
  rows: EquivalencyRow[];
  savedKeys: Set<string>;
  onToggleSave: (row: EquivalencyRow) => void;
  loading?: boolean;
  error?: string | null;
  isMobile?: boolean;
  preserveOrder?: boolean;
}) {
  if (loading) return null;
  if (error) {
    return (
      <div class="results-empty">
        <p style={{ color: "var(--error)" }}>{error}</p>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div class="results-empty">
        <p>No equivalencies found for this course.</p>
        <p class="results-empty-hint">Try a different subject or check the Direct credit / Undistributed filter above.</p>
      </div>
    );
  }

  const sorted = preserveOrder ? rows : [...rows].sort((a, b) => {
    const aInst = (a.transferInstitution ?? "").toLowerCase();
    const bInst = (b.transferInstitution ?? "").toLowerCase();
    if (aInst !== bInst) return aInst.localeCompare(bInst);
    const aCode = `${a.transferSubject ?? ""} ${a.transferCourse ?? ""}`;
    const bCode = `${b.transferSubject ?? ""} ${b.transferCourse ?? ""}`;
    return aCode.localeCompare(bCode);
  });
  const showDaggerNote = hasDagger(sorted);

  if (isMobile) {
    return (
      <>
        <div class="card-list">
          {sorted.map((row) => {
            const key = rowKey(row);
            const active = savedKeys.has(key);
            return (
              <div class="eq-card eq-card-flow-inbound" key={key}>
                <div class="eq-card-header">
                  <span class="eq-card-institution">{row.transferInstitution || "—"}</span>
                  <button
                    class={`icon-btn${active ? " active" : ""}`}
                    type="button"
                    aria-label={active ? "Remove" : "Save"}
                    onClick={() => onToggleSave(row)}
                    dangerouslySetInnerHTML={{ __html: starIcon(active) }}
                  />
                </div>
                <span class="eq-card-label">Equivalent</span>
                <div class="eq-card-value">
                  {row.transferSubject || row.transferCourse
                    ? renderCourseCode(row.transferSubject, row.transferCourse)
                    : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>—</span>}
                </div>
                {row.transferTitle && <div class="eq-card-detail">{renderSingleLineText(row.transferTitle)}</div>}
                {(row.transferSubject || row.transferCourse) && <div class="eq-card-detail">{formatCredit(row.transferCredits)} credits</div>}
              </div>
            );
          })}
        </div>
        {showDaggerNote && <p class="results-note">{DAGGER_NOTE}</p>}
      </>
    );
  }

  return (
    <>
      <div class="results-table-wrap">
        <table class="results-table reverse-table">
          <thead>
            <tr>
              <th>University</th>
              <th class="results-col-equiv-course">Equivalent Course</th>
              <th class="results-col-row-title">Title</th>
              <th class="results-col-credits">Credits</th>
              <th class="action-col" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = rowKey(row);
              const active = savedKeys.has(key);
              return (
                <tr key={key}>
                  <td>
                    <HoverTooltip
                      class="hover-tooltip--clamp"
                      align="start"
                      tip={<p class="undistributed-popover-body">{row.transferInstitution || "—"}</p>}
                    >
                      <strong>{row.transferInstitution || "—"}</strong>
                    </HoverTooltip>
                  </td>
                  <td class="results-col-equiv-course">
                    {row.transferSubject || row.transferCourse
                      ? renderCourseCode(row.transferSubject, row.transferCourse)
                      : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>—</span>}
                  </td>
                  <td class="results-col-row-title">{renderSingleLineText(row.transferTitle)}</td>
                  <td class="results-col-credits">{row.transferSubject || row.transferCourse ? formatCredit(row.transferCredits) : "—"}</td>
                  <td class="action-col">
                    <button
                      class={`icon-btn${active ? " active" : ""}`}
                      type="button"
                      aria-label={active ? "Remove" : "Save"}
                      onClick={() => onToggleSave(row)}
                      dangerouslySetInnerHTML={{ __html: starIcon(active) }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showDaggerNote && <p class="results-note">{DAGGER_NOTE}</p>}
    </>
  );
}

function WelcomeModal({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div class="welcome-overlay" onClick={onClose}>
      <div
        class="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button class="welcome-close" type="button" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
        <div class="welcome-brand">
          <img src={logoUrl} alt="" class="welcome-logo" />
          <div class="welcome-brand-copy">
            <h2 class="welcome-title" id="welcome-title">BoilerCredits</h2>
          </div>
        </div>
        <div class="welcome-body">
          <p>
            BoilerCredits helps you answer two questions quickly: what transfers to Purdue, and which classes elsewhere count for a Purdue course.
          </p>
          <ul class="welcome-list">
            <li>
              <strong>Schools</strong> — Start with a school to see what transfers{" "}
              <a class="welcome-link" href="#schools" onClick={(e) => { e.preventDefault(); onClose(); onNavigate("schools"); }}>into Purdue</a>.
            </li>
            <li>
              <strong>Courses</strong> — Start with a Purdue course to see{" "}
              <a
                class="welcome-link"
                href="#courses"
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                  onNavigate("courses");
                }}
              >
                matching classes at other schools
              </a>.
            </li>
            <li>
              <strong>Saved</strong> — Star any row to{" "}
              <span class="welcome-link" onClick={() => { onClose(); onNavigate("saved"); }}>keep it handy</span>.
            </li>
          </ul>
          <p class="welcome-footnote">
            Data comes from Purdue&apos;s Self Service{" "}
            <a class="welcome-link" href={PURDUE_SOURCE_URL} target="_blank" rel="noopener">Transfer Equivalency Guide</a>
            . BoilerCredits is an independent tool for browsing that data more cleanly.{" "}
            <a class="welcome-link" href={REPO_URL} target="_blank" rel="noopener">Source code on GitHub</a>.
          </p>
        </div>
      </div>
    </div>
  );
}

function App() {
  const isMobile = useIsMobile();
  const [showWelcome, setShowWelcome] = useState(
    () => !localStorage.getItem("bc-welcome-dismissed") && !window.location.hash
  );
  const [tab, setTab] = useState<Tab>(parseInitialTab);

  // — Schools tab state —
  const [allSchools, setAllSchools] = useState<SchoolListRow[]>([]);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [selectedSchool, setSelectedSchool] = useState<ForwardSelection | null>(null);
  const [forwardSubjectFilter, setForwardSubjectFilter] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [forwardResults, setForwardResults] = useState<EquivalencyRow[]>([]);
  const [forwardStatus, setForwardStatus] = useState("Fetching universities");
  const [forwardStatusDone, setForwardStatusDone] = useState(false);
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [forwardTiming, setForwardTiming] = useState<string>("");

  // — Courses browse directories —
  const [purdueCourses, setPurdueCourses] = useState<PurdueCatalogCourse[]>([]);
  const [purdueQuery, setPurdueQuery] = useState("");
  const [reverseSubjectFilter, setReverseSubjectFilter] = useState("");
  const [xcodeFilter, setXcodeFilter] = useState<"all" | "hide" | "only">("hide");
  const [courseStatus, setCourseStatus] = useState("Fetching Purdue courses");
  const [courseStatusDone, setCourseStatusDone] = useState(false);

  // — Courses tab: one selected catalog row —
  const [selectedCourse, setSelectedCourse] = useState<PurdueCatalogCourse | null>(null);

  const [purdueCreditRowsByCourse, setPurdueCreditRowsByCourse] = useState<Record<string, EquivalencyRow[]>>({});
  const [purdueCreditInstitutionStates, setPurdueCreditInstitutionStates] = useState<
    Record<string, Record<string, InstitutionSubregion>>
  >({});
  const [purdueCreditDetailStatus, setPurdueCreditDetailStatus] = useState("");
  const [purdueCreditDetailDone, setPurdueCreditDetailDone] = useState(true);
  const [purdueCreditDetailError, setPurdueCreditDetailError] = useState<string | null>(null);
  const [purdueCreditStateFilter, setPurdueCreditStateFilter] = useState("");
  const [courseSortOrder, setCourseSortOrder] = useState<"none" | "credits-asc" | "credits-desc">("none");

  // — Saved state —
  const [savedRows, setSavedRows] = useState<EquivalencyRow[]>(() => loadSavedRows());
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [schoolSearchFocused, setSchoolSearchFocused] = useState(false);
  const [purdueSearchFocused, setPurdueSearchFocused] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const forwardAbort = useRef<AbortController | null>(null);
  const reverseLoadStarted = useRef(false);
  const hashRestore = useRef<HashRestore>(parseHashRestore());
  const initialHashSynced = useRef(false);
  const suppressNextHashPush = useRef(false);

  const savedKeys = useMemo(() => new Set(savedRows.map(rowKey)), [savedRows]);

  useLayoutEffect(() => {
    migrateHashToNewFormat();
    hashRestore.current = parseHashRestore();
  }, []);

  useEffect(() => {
    saveRows(savedRows);
  }, [savedRows]);

  // Keep URL hash in sync with current tab + selection. pushState for user-driven
  // changes (so browser back/forward restore previous tab); replaceState for the
  // initial sync and for state changes caused by a popstate event.
  useEffect(() => {
    const hash = buildHash(tab, selectedSchool, selectedCourse);
    const target = hash || `${window.location.pathname}${window.location.search}`;
    const hashMatches = window.location.hash === hash;

    if (!hashMatches) {
      const usePush = initialHashSynced.current && !suppressNextHashPush.current;
      if (usePush) {
        history.pushState(null, "", target);
      } else {
        history.replaceState(null, "", target);
      }
    }
    initialHashSynced.current = true;
    suppressNextHashPush.current = false;
  }, [tab, selectedSchool, selectedCourse]);

  // Browser back/forward: restore tab + selection from the new URL hash. Set the
  // suppression flag so the sync effect that runs from our setState calls below
  // uses replaceState instead of pushing yet another history entry.
  useEffect(() => {
    const onPopState = () => {
      suppressNextHashPush.current = true;
      const restore = parseHashRestore();
      const parts = window.location.hash.slice(1).split("/");
      const root = parts[0];
      if (root === "changelog") {
        setTab("changelog");
      } else if (root === "saved") {
        setTab("saved");
      } else if (root === "courses") {
        setTab("courses");
        if (restore?.kind !== "courses") setSelectedCourse(null);
      } else if (root === "schools" || root === "" || !root) {
        setTab("schools");
        if (restore?.kind !== "school") setSelectedSchool(null);
      }
      if (restore?.kind === "school") {
        setSelectedSchool((prev) =>
          prev &&
          prev.id === restore.id &&
          prev.state === restore.state &&
          (!restore.catalog || prev.catalog === restore.catalog)
            ? prev
            : {
                id: restore.id,
                state: restore.state,
                name: prev?.name ?? `${restore.id}`,
                catalog: restore.catalog ?? prev?.catalog ?? "US",
              }
        );
      }
      if (restore?.kind === "courses") {
        setSelectedCourse((prev) =>
          prev && prev.subject === restore.subject && prev.course === restore.course
            ? prev
            : {
                subject: restore.subject,
                course: restore.course,
                title: prev?.title ?? `${restore.subject} ${restore.course}`,
              }
        );
        setPurdueCreditStateFilter("");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Load merged school catalog (US + international Purdue buckets, single directory)
  useEffect(() => {
    let cancelled = false;
    const slowTimer = window.setTimeout(() => {
      setForwardStatus((prev) => (prev.includes("Still working") ? prev : "Still working — large list"));
    }, 5000);
    setForwardStatusDone(false);
    setForwardStatus("Fetching universities");

    void (async () => {
      try {
        const [usResult, intlResult] = await Promise.allSettled([
          timedFetch(() => getAllSchools("US")),
          timedFetch(() => getAllSchools("International")),
        ]);
        if (usResult.status !== "fulfilled" || intlResult.status !== "fulfilled") {
          throw new Error("Failed to load school directory");
        }
        const usRes = usResult.value;
        const intlRes = intlResult.value;
        window.clearTimeout(slowTimer);
        if (cancelled) return;

        const seen = new Set<string>();
        const schools: SchoolListRow[] = [];
        for (const s of usRes.data.map((x) => ({ ...x, catalog: "US" as const }))) {
          const k = `${s.state}:${s.id}`;
          if (!seen.has(k)) {
            seen.add(k);
            schools.push(s);
          }
        }
        for (const s of intlRes.data.map((x) => ({ ...x, catalog: "International" as const }))) {
          const k = `${s.state}:${s.id}`;
          if (!seen.has(k)) {
            seen.add(k);
            schools.push(s);
          }
        }
        schools.sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state));

        setAllSchools(schools);
        const ms = Math.max(usRes.ms, intlRes.ms);
        const timeLabel = `${ms}ms`;
        setForwardTiming(timeLabel);
        setForwardStatus(formatCountStatus("Universities loaded", schools.length, timeLabel));
        setForwardStatusDone(true);
        const restore = hashRestore.current;
        if (restore?.kind === "school-browse") hashRestore.current = null;
        if (restore?.kind === "school") {
          hashRestore.current = null;
          const match = schools.find(
            (s) =>
              s.id === restore.id &&
              s.state === restore.state &&
              (!restore.catalog || s.catalog === restore.catalog)
          );
          if (match)
            void loadSchoolEquivalencies(
              {
                id: match.id,
                state: match.state,
                name: match.name,
                catalog: match.catalog,
              }
            );
        }
      } catch {
        window.clearTimeout(slowTimer);
        if (!cancelled) {
          setForwardStatus(API_UNREACHABLE_HINT);
          setForwardStatusDone(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, []);

  // Filtered + ranked school list
  const filteredSchools = useMemo(() => {
    return searchSchoolsCombined(allSchools, schoolQuery);
  }, [allSchools, schoolQuery]);

  const groupedSchools = useMemo<SchoolDirectoryGroup[]>(() => {
    const us = filteredSchools
      .filter((school) => school.catalog === "US")
      .sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state));
    const intl = filteredSchools
      .filter((school) => school.catalog === "International")
      .sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state));

    return [
      { key: "US", label: "United States", schools: us },
      { key: "International", label: "International", schools: intl },
    ].filter((group) => group.schools.length);
  }, [filteredSchools]);

  // Purdue course directories — load when first visiting Courses tab
  useEffect(() => {
    if (tab !== "courses" || reverseLoadStarted.current) return;
    reverseLoadStarted.current = true;
    void (async () => {
      const slowTimer = window.setTimeout(() => {
        setCourseStatus((prev) => (prev.includes("Still working") ? prev : "Still working — large catalog"));
      }, 5000);
      try {
        setCourseStatusDone(false);
        setCourseStatus("Fetching Purdue courses");
        const { data, ms } = await timedFetch(() => getPurdueCourseDirectory());
        window.clearTimeout(slowTimer);
        setPurdueCourses(data);
        const timeLabel = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        setCourseStatus(formatCountStatus("Courses loaded", data.length, timeLabel));
        setCourseStatusDone(true);

        const restore = hashRestore.current;
        if (restore?.kind === "courses") {
          hashRestore.current = null;
          const match = data.find((c) => c.subject === restore.subject && c.course === restore.course);
          const course = match ?? {
            subject: restore.subject,
            course: restore.course,
            title: `${restore.subject} ${restore.course}`,
          };
          setSelectedCourse(course);
          setPurdueCreditStateFilter("");
          void ensurePurdueCourseEquivalenciesLoaded(course.subject, course.course);
        }
      } catch {
        window.clearTimeout(slowTimer);
        setCourseStatus(API_UNREACHABLE_HINT);
        setCourseStatusDone(true);
      }
    })();
  }, [tab]);

  // Filtered Purdue course list — custom scorer to avoid substring matches in titles
  // (e.g. "cs" matching "Physics" because "physics".includes("cs"))
  const filteredPurdueCourses = useMemo(() => {
    const q = normalize(purdueQuery);
    if (!q) return purdueCourses;

    const qTokens = q.split(/\s+/).filter(Boolean);

    const scored = purdueCourses.map((course) => {
      // Score the subject+code with full substring matching (strong signal)
      const codeCandidate = `${course.subject} ${course.course}`;
      const codeScore = scoreText(q, codeCandidate);

      // Score the title using token matching only — no substring
      // This prevents "cs" from matching "Physics", "Genetics", etc.
      const titleTokens = normalize(course.title).split(/\s+/).filter(Boolean);
      let titleScore = 0;
      for (const qt of qTokens) {
        if (titleTokens.some((t) => t === qt)) titleScore += 40;
        else if (titleTokens.some((t) => t.startsWith(qt))) titleScore += 24;
      }

      const total = codeScore > 0 ? codeScore * 2 + titleScore : titleScore;
      return { course, score: total };
    });

    return scored
      .filter((e) => e.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          `${a.course.subject} ${a.course.course}`.localeCompare(`${b.course.subject} ${b.course.course}`)
      )
      .map((e) => e.course);
  }, [purdueCourses, purdueQuery]);

  const displayCourses = useMemo(() => {
    return filteredPurdueCourses.filter((c) => {
      if (reverseSubjectFilter && c.subject !== reverseSubjectFilter) return false;
      const isXcode = c.course.length >= 2 && c.course[1] === "X";
      if (xcodeFilter === "hide" && isXcode) return false;
      if (xcodeFilter === "only" && !isXcode) return false;
      return true;
    });
  }, [filteredPurdueCourses, reverseSubjectFilter, xcodeFilter]);

  const reverseCatalogDisplayStatus = useMemo(() => {
    if (!courseStatusDone) return courseStatus;
    const timeMatch = courseStatus.match(/\(([^)]+)\)$/);
    const timeLabel = timeMatch ? timeMatch[1] : "";
    const visible = displayCourses.length;
    const total = purdueCourses.length;
    if (visible !== total) {
      return `Courses shown: ${visible} of ${total} (${timeLabel})`;
    }
    return `Courses loaded: ${total} (${timeLabel})`;
  }, [courseStatus, courseStatusDone, displayCourses.length, purdueCourses.length]);

  const forwardSubjects = useMemo(() => {
    return [...new Set(forwardResults.map((row) => row.transferSubject).filter(Boolean))].sort();
  }, [forwardResults]);

  const displayForwardRows = useMemo(() => {
    if (!forwardSubjectFilter) return forwardResults;
    return forwardResults.filter((row) => row.transferSubject === forwardSubjectFilter);
  }, [forwardResults, forwardSubjectFilter]);

  const forwardDisplayStatus = useMemo(() => {
    if (!forwardStatusDone) return forwardStatus;
    if (forwardStatus.toLowerCase().includes("no equivalencies found")) return forwardStatus;
    if (forwardSubjectFilter && displayForwardRows.length !== forwardResults.length) {
      return `Equivalencies shown: ${displayForwardRows.length} of ${forwardResults.length} (${forwardTiming})`;
    }
    return forwardStatus;
  }, [forwardStatus, forwardStatusDone, forwardSubjectFilter, displayForwardRows.length, forwardResults.length, forwardTiming]);

  async function loadSchoolEquivalencies(selection: ForwardSelection) {
    forwardAbort.current?.abort();
    const controller = new AbortController();
    forwardAbort.current = controller;

    setSelectedSchool(selection);
    setForwardResults([]);
    setSubjects([]);
    setSchoolLoading(true);
    setForwardStatus("Fetching equivalencies");
    setForwardStatusDone(false);
    const slowTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setForwardStatus((prev) => (prev.includes("Still working") ? prev : "Still working — large school"));
      }
    }, 5000);

    try {
      const { data, ms } = await timedFetch(() =>
        getSchoolEquivalencies(selection.id, selection.state, selection.catalog)
      );
      window.clearTimeout(slowTimer);
      if (controller.signal.aborted) return;

      setSubjects(data.subjects);
      setForwardResults(data.rows);

      const timeLabel = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
      setForwardTiming(timeLabel);
      setForwardStatus(
        data.rows.length
          ? formatCountStatus("Equivalencies found", data.rows.length, timeLabel)
          : `No equivalencies found (${timeLabel})`
      );
      setForwardStatusDone(true);
    } catch (error) {
      window.clearTimeout(slowTimer);
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setForwardStatus(API_UNREACHABLE_HINT);
        setForwardStatusDone(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        setSchoolLoading(false);
      }
    }
  }

  function toggleSave(row: EquivalencyRow) {
    const key = rowKey(row);
    setSavedRows((current) => {
      const exists = current.some((saved) => rowKey(saved) === key);
      return exists ? current.filter((saved) => rowKey(saved) !== key) : [...current, row];
    });
  }

  async function ensurePurdueCourseEquivalenciesLoaded(subject: string, course: string) {
    const key = `${subject}:${course}`;
    const cacheStart = performance.now();

    const cached = purdueCreditRowsByCourse[key];
    if (cached) {
      const cachedMs = Math.max(1, Math.round(performance.now() - cacheStart));
      setPurdueCreditDetailError(null);
      setPurdueCreditDetailStatus(
        formatCountStatus("Equivalencies found", cached.length, `${cachedMs}ms`)
      );
      setPurdueCreditDetailDone(true);
      return;
    }

    try {
      setPurdueCreditDetailStatus("Fetching equivalencies");
      setPurdueCreditDetailError(null);
      setPurdueCreditDetailDone(false);
      const { data, ms } = await timedFetch(() =>
        getPurdueCourseEquivalencies(subject, course)
      );

      setPurdueCreditRowsByCourse((current) => ({ ...current, [key]: data.rows }));
      setPurdueCreditInstitutionStates((current) => ({ ...current, [key]: data.institutionStates }));

      const timeLabel = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
      setPurdueCreditDetailStatus(formatCountStatus("Equivalencies found", data.rows.length, timeLabel));
      setPurdueCreditDetailDone(true);
    } catch (error) {
      console.warn("Course equivalency fetch failed", key, error);
      setPurdueCreditDetailError(API_UNREACHABLE_HINT);
      setPurdueCreditDetailStatus(API_UNREACHABLE_HINT);
      setPurdueCreditDetailDone(true);
    }
  }

  const selectedCourseKey = selectedCourse ? `${selectedCourse.subject}:${selectedCourse.course}` : null;

  const currentReverseRows = selectedCourseKey ? (purdueCreditRowsByCourse[selectedCourseKey] ?? null) : null;
  const currentInstitutionStates = selectedCourseKey
    ? (purdueCreditInstitutionStates[selectedCourseKey] ?? null)
    : null;

  const availablePurdueCreditSubregions = useMemo((): SubregionOption[] => {
    if (!currentInstitutionStates) return [];
    const byCode = new Map<string, { label: string; location: string }>();
    for (const v of Object.values(currentInstitutionStates)) {
      if (!byCode.has(v.code)) {
        byCode.set(v.code, { label: v.label, location: v.location });
      }
    }
    return [...byCode.entries()]
      .map(([code, meta]) => ({ code, label: meta.label, location: meta.location }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [currentInstitutionStates]);

  const filteredReverseRows = useMemo(() => {
    if (!currentReverseRows) return [];
    if (!purdueCreditStateFilter) return currentReverseRows;
    return currentReverseRows.filter(
      (row) => currentInstitutionStates?.[row.transferInstitution]?.code === purdueCreditStateFilter
    );
  }, [currentReverseRows, purdueCreditStateFilter, currentInstitutionStates]);

  const sortedReverseRows = useMemo(() => {
    if (courseSortOrder === "none" || filteredReverseRows.length <= 1) return filteredReverseRows;
    return [...filteredReverseRows].sort((a, b) => {
      const aC = parseMinCredits(a.transferCredits);
      const bC = parseMinCredits(b.transferCredits);
      return courseSortOrder === "credits-asc" ? aC - bC : bC - aC;
    });
  }, [filteredReverseRows, courseSortOrder]);

  function handleBackForward() {
    forwardAbort.current?.abort();
    setSelectedSchool(null);
    setForwardResults([]);
    setForwardSubjectFilter("");
    setSchoolQuery("");
    setForwardStatus(formatCountStatus("Universities loaded", allSchools.length, forwardTiming || null));
    setForwardStatusDone(true);
    setSchoolLoading(false);
  }

  function handleBackCourses() {
    setSelectedCourse(null);
    setPurdueCreditStateFilter("");
    setPurdueCreditDetailStatus("");
    setPurdueCreditDetailError(null);
    setPurdueCreditDetailDone(true);
  }

  function dismissWelcome() {
    localStorage.setItem("bc-welcome-dismissed", "1");
    setShowWelcome(false);
  }

  return (
    <div id="app">
      <WelcomeModal
        open={showWelcome}
        onClose={dismissWelcome}
        onNavigate={(t) => setTab(t)}
      />
      <header class="header" role="banner">
        <div class="container header-inner">
          <a href="/" class="logo" aria-label="BoilerCredits home">
            <img src={logoUrl} alt="" class="logo-icon" />
            <span class="logo-text">BoilerCredits</span>
          </a>
          <div class="header-actions">
            <button class="help-btn" type="button" aria-label="About BoilerCredits" onClick={() => setShowWelcome(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
            </button>
            <a
              href={REPO_URL}
              class="github-link"
              target="_blank"
              rel="noopener"
              aria-label="GitHub Repository"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "20px", height: "20px" }}>
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </a>
          </div>
        </div>
      </header>

      <main class="main">
        <div class="container">
          {tab !== "changelog" && (
            <div class="direction-toggle" role="tablist" aria-label="Browse mode">
              <button id="tab-schools" class={`direction-btn${tab === "schools" ? " active" : ""}`} type="button" onClick={() => setTab("schools")} role="tab" aria-selected={tab === "schools"} aria-controls="panel-schools">
                Schools
              </button>
              <button id="tab-courses" class={`direction-btn${tab === "courses" ? " active" : ""}`} type="button" onClick={() => setTab("courses")} role="tab" aria-selected={tab === "courses"} aria-controls="panel-courses">
                Courses
              </button>
              <button id="tab-saved" class={`direction-btn${tab === "saved" ? " active" : ""}`} type="button" onClick={() => setTab("saved")} role="tab" aria-selected={tab === "saved"} aria-controls="panel-saved">
                Saved
              </button>
            </div>
          )}

          {tab === "changelog" && <ChangelogView />}

          {/* ── SCHOOLS ── */}
          {tab === "schools" && (
            <section id="panel-schools" class="browse-panel" role="tabpanel" aria-labelledby="tab-schools">
              {selectedSchool ? (
                <>
                  <div class="selected-school course-flow-inbound">
                    <button class="back-btn" type="button" aria-label="Back" onClick={handleBackForward}>
                      {BACK_ICON}
                    </button>
                    <div>
                      <div class="selected-name">{selectedSchool.name}</div>
                      <div class="course-title" style={{ marginTop: "4px" }}>
                        {formatSchoolListRegionLabel(selectedSchool.state, selectedSchool.catalog)}
                      </div>
                    </div>
                  </div>
                  <div class="browse-meta">
                    <StatusPill status={forwardDisplayStatus} loading={!forwardStatusDone} />
                    <select
                      class="filter-select filter-select--compact"
                      aria-label="Filter transfer equivalencies by subject"
                      value={forwardSubjectFilter}
                      onChange={(e) => setForwardSubjectFilter((e.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">All subjects</option>
                      {forwardSubjects.map((subject) => (
                        <option key={subject} value={subject}>{subject}</option>
                      ))}
                    </select>
                  </div>
                  <Table
                    rows={displayForwardRows}
                    savedKeys={savedKeys}
                    onToggleSave={toggleSave}
                    loading={schoolLoading}
                    isMobile={isMobile}
                  />
                </>
              ) : (
                <>
                  <div class="browse-search-wrap">
                    <svg class="browse-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <SearchHintTicker
                      hints={SCHOOL_SEARCH_HINTS}
                      active={isMobile && !schoolQuery && !schoolSearchFocused}
                    />
                    <input
                      class="browse-search-input"
                      type="text"
                      name="school-search"
                      aria-label="Search transfer schools"
                      placeholder={SCHOOL_SEARCH_PLACEHOLDER}
                      autocomplete="off"
                      spellCheck={false}
                      value={schoolQuery}
                      onFocus={() => setSchoolSearchFocused(true)}
                      onBlur={() => setSchoolSearchFocused(false)}
                      onInput={(event) => setSchoolQuery((event.currentTarget as HTMLInputElement).value)}
                    />
                  </div>

                  <div class="browse-meta">
                    <StatusPill
                      status={
                        schoolQuery
                          ? `Universities shown: ${filteredSchools.length} of ${allSchools.length}`
                          : forwardStatus
                      }
                      loading={!forwardStatusDone && !schoolQuery}
                    />
                  </div>

                  <p class="courses-outbound-hint">
                    Pick a school to see which of its classes transfer to Purdue for credit.
                  </p>

                  <div class="browse-school-list" role="listbox">
                    {groupedSchools.length ? (
                      groupedSchools.map((group) => (
                        <div class="school-group" key={group.key}>
                          <div class="school-group-divider">
                            <span>{group.label}</span>
                          </div>
                          {group.schools.map((school, index) => (
                            <div
                              class="school-item"
                              key={`${group.key}:${school.state}:${school.id}`}
                              style={{ "--stagger": Math.min(index, 20) } as any}
                            >
                              <button
                                class="school-button"
                                type="button"
                                onClick={() =>
                                  void loadSchoolEquivalencies(
                                    {
                                      id: school.id,
                                      state: school.state,
                                      name: school.name,
                                      catalog: school.catalog,
                                    }
                                  )
                                }
                              >
                                <span class="school-name">{school.name}</span>
                                <span class="school-state">
                                  {formatSchoolBrowseRegionLabel(school.state)}
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                      ))
                    ) : (
                      <div class="course-item" style={{ padding: "16px 4px", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                        No matching universities found.
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {/* ── COURSES ── */}
          {tab === "courses" && (
            <section id="panel-courses" class="browse-panel" role="tabpanel" aria-labelledby="tab-courses">
              {selectedCourse ? (
                <>
                  <div class="selected-school course-flow-inbound">
                    <button class="back-btn" type="button" aria-label="Back" onClick={handleBackCourses}>
                      {BACK_ICON}
                    </button>
                    <div>
                      <div class="selected-name">
                        {renderCourseCode(selectedCourse.subject, selectedCourse.course)}
                      </div>
                      {selectedCourse.title !== courseDisplayCode(selectedCourse.subject, selectedCourse.course) && (
                        <div class="course-title" style={{ marginTop: "4px" }}>{selectedCourse.title}</div>
                      )}
                    </div>
                  </div>

                  <div class="browse-meta">
                    <StatusPill status={purdueCreditDetailStatus} loading={!purdueCreditDetailDone} />
                    <div class="browse-controls">
                      {availablePurdueCreditSubregions.length > 1 && (
                        <select
                          class="filter-select filter-select--compact"
                          aria-label="Filter institutions by subregion"
                          value={purdueCreditStateFilter}
                          onChange={(e) => setPurdueCreditStateFilter((e.currentTarget as HTMLSelectElement).value)}
                        >
                          <option value="">All locations</option>
                          {availablePurdueCreditSubregions.map(({ code, label, location }) => (
                            <option key={code} value={code}>
                              {formatSubregionDisplayLine(code, label, location)}
                            </option>
                          ))}
                        </select>
                      )}
                      {availablePurdueCreditSubregions.length === 1 && (
                        <span class="filter-badge">
                          {formatSubregionDisplayLine(
                            availablePurdueCreditSubregions[0].code,
                            availablePurdueCreditSubregions[0].label,
                            availablePurdueCreditSubregions[0].location
                          )}
                        </span>
                      )}
                      {sortedReverseRows.length > 1 && (
                        <select
                          class="filter-select filter-select--compact"
                          aria-label="Sort equivalencies"
                          value={courseSortOrder}
                          onChange={(e) => setCourseSortOrder((e.currentTarget as HTMLSelectElement).value as "none" | "credits-asc" | "credits-desc")}
                        >
                          <option value="none">Sort by</option>
                          <option value="credits-asc">Credits: low to high</option>
                          <option value="credits-desc">Credits: high to low</option>
                        </select>
                      )}
                    </div>
                  </div>
                  <div class="course-detail">
                    <ReverseTable
                      rows={sortedReverseRows}
                      savedKeys={savedKeys}
                      onToggleSave={toggleSave}
                      loading={!purdueCreditDetailDone}
                      error={purdueCreditDetailError}
                      isMobile={isMobile}
                      preserveOrder={courseSortOrder !== "none"}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div class="browse-search-wrap">
                    <svg class="browse-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <SearchHintTicker
                      hints={PURDUE_SEARCH_HINTS}
                      active={isMobile && !purdueQuery && !purdueSearchFocused}
                    />
                    <input
                      class="browse-search-input"
                      type="text"
                      name="purdue-course-search"
                      aria-label="Search Purdue courses"
                      placeholder="Search by course, subject, or title (e.g. MA 16100, CS, Calculus)"
                      autocomplete="off"
                      spellCheck={false}
                      value={purdueQuery}
                      onFocus={() => setPurdueSearchFocused(true)}
                      onBlur={() => setPurdueSearchFocused(false)}
                      onInput={(event) => setPurdueQuery((event.currentTarget as HTMLInputElement).value)}
                    />
                  </div>

                  <div class="browse-meta">
                    <StatusPill status={reverseCatalogDisplayStatus} loading={!courseStatusDone} />
                    <div class="browse-controls">
                      <HoverTooltip
                        class="hover-tooltip--block"
                        align="end"
                        kicker="Filter by course type"
                        tip={
                          <p class="undistributed-popover-body">
                            {
                              "'Undistributed' courses are unevaluated or core curriculum equivalencies that don't map to a specific Purdue course."
                            }
                          </p>
                        }
                      >
                        <div class="xcodes-toggle" role="group" aria-label="Filter Purdue courses by credit type">
                          <button
                            type="button"
                            class={xcodeFilter === "all" ? "active" : ""}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setXcodeFilter("all")}
                          >All</button>
                          <button
                            type="button"
                            class={xcodeFilter === "hide" ? "active" : ""}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setXcodeFilter("hide")}
                          >Direct credit</button>
                          <button
                            type="button"
                            class={xcodeFilter === "only" ? "active" : ""}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setXcodeFilter("only")}
                          >Undistributed</button>
                        </div>
                      </HoverTooltip>
                    </div>
                  </div>

                  <p class="courses-outbound-hint">
                    Pick a Purdue course to see classes elsewhere that transfer in for credit.
                  </p>

                  <div class="purdue-course-list">
                    {displayCourses.length ? (
                      displayCourses.map((course, index) => {
                        const key = `${course.subject}:${course.course}`;
                        return (
                          <div
                            class="course-item"
                            key={key}
                            style={{ "--stagger": Math.min(index, 20) } as any}
                          >
                            <button
                              class="course-toggle"
                              type="button"
                              onClick={() => {
                                setSelectedCourse(course);
                                setPurdueCreditStateFilter("");
                                void ensurePurdueCourseEquivalenciesLoaded(course.subject, course.course);
                              }}
                            >
                              <div>
                                <div class="course-code">
                                  {renderCourseCode(course.subject, course.course)}
                                </div>
                                <div class="course-title">{course.title}</div>
                              </div>
                              <span class="course-credits" />
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: "16px 4px", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                        {purdueCourses.length ? "No matching courses." : "Fetching Purdue courses"}
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {/* ── SAVED ── */}
          {tab === "saved" && (
            <section id="panel-saved" class="browse-panel" role="tabpanel" aria-labelledby="tab-saved">
              <div class="browse-meta">
                <StatusPill status={`Saved equivalencies: ${savedRows.length}`} />
                <button class="secondary-btn" type="button" onClick={() => setSavedRows([])}>
                  Clear All
                </button>
              </div>
              {savedRows.length ? (
                <Table rows={savedRows} savedKeys={savedKeys} onToggleSave={toggleSave} isMobile={isMobile} />
              ) : (
                <div class="results-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "64px 20px", gap: "16px" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "48px", height: "48px", color: "var(--border-hover)" }}>
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  <div style={{ color: "var(--text)", fontSize: "1.05rem", fontWeight: 500 }}>No saved equivalencies yet</div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.9rem", maxWidth: "400px", margin: "0 auto" }}>
                    Star any row from Schools or Courses to keep it here for quick reference.
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      <footer class="footer">
        <div class="container footer-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <p class="footer-text" style={{ margin: 0 }}>
              Not affiliated with Purdue University. Data sourced from{" "}
              <a href={PURDUE_SOURCE_URL} target="_blank" rel="noopener">
                Purdue Self-Service
              </a>
              .
            </p>
          </div>
          <div class="footer-links">
            <a href="https://dhiyaan.me" target="_blank" rel="noopener">
              dhiyaan.me
            </a>
            <a
              href="#changelog"
              class="footer-version"
              onClick={(e) => {
                e.preventDefault();
                setTab("changelog");
              }}
            >
              {APP_VERSION}
            </a>
            <a href="https://www.purdue.edu/registrar/currentStudents/Transfer%20Credit.html" target="_blank" rel="noopener">
              Transfer Credit Guide
            </a>
            <a href="https://admissions.purdue.edu/become-student/transfer/credit/evaluation-report/" target="_blank" rel="noopener">
              Evaluation Report
            </a>
          </div>
        </div>
      </footer>

      <button
        class={`scroll-top-btn${showScrollTop ? " visible" : ""}`}
        type="button"
        aria-label="Scroll to top"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
    </div>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
