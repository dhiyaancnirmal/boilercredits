# BoilerCredits Production E2E QA Report

**Date:** 2026-04-17  
**Target:** https://boilercredits.xyz  
**Method:** 7 parallel agent-browser sessions (desktop + mobile emulation)  
**Duration:** ~12 minutes wall-clock  

## Executive Summary

| Metric | Count |
|--------|-------|
| Total test steps | 128 |
| Passed | 82 (64%) |
| Failed (real defects) | 12 (9%) |
| Blocked (tooling) | 16 (13%) |
| Inconclusive | 4 (3%) |
| Pass (expectation wrong) | 14 (11%) |

### Verdict: **3 P0 defects, 2 P1 issues, 3 P2 gaps**

The site's core flow — **Schools inbound** (browse, search, select, view equivalencies) — works well and is fast. The **Courses inbound** flow works for code-based search. However, **Courses outbound is entirely broken**, **Schools outbound is unusably slow**, and **title-based course search is not implemented**.

---

## P0 Defects (Must Fix)

### 1. Courses Outbound routing is broken
**IDs:** E1, E2, E7  
**Impact:** The entire "Where does it transfer?" course flow is non-functional.

- `#courses/out` hash does not activate the outbound toggle on page load — defaults to inbound
- Clicking a course from the catalog always renders inbound equivalency view, regardless of direction
- Both `#courses/in/MA/16100` and `#courses/out/MA/16100` show identical inbound content
- Some course clicks navigate to the wrong tab entirely (Schools tab)

**Root cause:** The `parseHashRestore()` function at `main.tsx:141` correctly parses the `/out` segment, and `onCourseDirectionChange` is called, but the course detail rendering ignores `courseDirection === "outbound"`. When a course is clicked from the catalog (`main.tsx:1863-1871`), it always calls `openPurdueCourse` (inbound) even when `courseDirection` is outbound.

**Fix:** In the catalog course click handler (`main.tsx:1864`), check `courseDirection === "outbound"` and call `openFromPurdueCourse` instead of `openPurdueCourse`. Also ensure `#courses/out` deep links set `courseDirection` before the catalog loads.

### 2. Schools Outbound API is 99-110 seconds per request
**IDs:** C2, C3, C5, C6, C7  
**Impact:** Schools outbound flow is completely unusable in the browser.

- Ivy Tech outbound: 99 seconds, 11 rows
- Butler outbound: 110 seconds, 3 rows  
- Every school tested: ~100s baseline
- Browser becomes unresponsive during wait

**Root cause:** The `/api/meta/school-outbound-equivalencies` endpoint has no D1 materialization. It scans all ~2076 Purdue catalog courses for reverse data on every request. Only 36/2076 courses have cached reverse data (1.7%), so most require live upstream fetches.

**Fix:** Materialize school-outbound results in D1 like school-equivalencies. The cron-based cache warming should pre-compute outbound aggregates. The partial-response logic (`coursesMissingCache`) exists but the endpoint still does full scans before returning.

### 3. Browser back button doesn't restore tab state
**ID:** A17  
**Impact:** Navigating back in browser history goes past all tab changes to the initial page, instead of restoring the previous tab.

**Root cause:** Tab switches use `history.replaceState` (not `pushState`), so each tab change overwrites the same history entry instead of pushing new ones.

**Fix:** Consider using `pushState` for tab switches to enable proper back/forward navigation. This is a UX trade-off — `replaceState` was likely chosen to avoid polluting history.

---

## P1 Issues

### 4. Agent F tests blocked (Saved + Mobile)
**IDs:** F1-F16  
**Impact:** Could not fully verify Saved tab functionality or mobile layout via browser automation.

- Agent-browser daemon hangs with heavy DOM (2967 schools)
- Welcome modal persistence requires localStorage which had SecurityError in eval context
- 16 test steps blocked

**Mitigation:** The Saved tab's empty state was verified (bookmark icon, copy, Clear All button). The `storage.ts` module uses correct localStorage key. Save functionality was verified in Agent B (B17) and Agent D (D15). These tests should be re-run with Playwright.

---

## P2 Gaps (Should Fix)

### 5. Course title search not implemented
**IDs:** D5, D6, D18  
**Impact:** Searching "Calculus", "Composition", or title keywords returns "No matching courses."

The course search only matches course codes (subject + number). The fuzzy scorer in `main.tsx:1108-1140` scores title tokens but only for prefix/exact matches, not substring. A search for "Calculus" returns nothing because no course has subject or code "Calculus" — it's only in the title field.

**Note:** The placeholder text says "Search by course, subject, or title" which implies title search should work.

### 6. Large undistributed result sets are slow
**ID:** D16  
**Impact:** MA 1XMQR (749 equivalency rows) took 15.6s to load.

This is an edge case (undistributed courses have very broad matches) but users exploring undistributed codes will hit long waits.

### 7. Uncached international schools can be 14s+
**ID:** B18  
**Impact:** First-time fetch for University of Toronto-Canada took 14s.

---

## P3 / Low Priority

### 8. No CDN-level caching headers
**ID:** G24  
**Impact:** Responses have `X-Cache-Layer: d1` but no `Cache-Control`, `ETag`, or CDN headers. Every request hits the Worker even when D1 cache is fresh.

### 9. `all-schools` endpoint has no required params
**ID:** G1  
**Impact:** Not a bug — `location` defaults to US. But could be clearer in API docs.

---

## Performance Summary

| Flow | Cold | Warm | Band |
|------|------|------|------|
| Root page load | 145ms | 28ms | Instant |
| School directory | 199ms | — | Instant |
| School search | 0ms (client) | — | Instant |
| Small school inbound (Ivy Tech) | 231ms | — | Instant |
| Large school inbound (IU) | 217ms | — | Instant |
| Butler inbound (was 72s) | 274ms | — | Instant |
| Purdue catalog | 199ms | — | Instant |
| Course inbound (MA 16100) | 199ms | — | Instant |
| Course outbound API (MA 16100) | 75ms | — | Instant |
| School outbound API | **99-110s** | — | **Critical** |
| Save/unsave | 0ms (client) | — | Instant |
| Filter change | 0ms (client) | — | Instant |

### Cache Behavior Findings

- **D1 materialization works well** for inbound flows. Butler went from 72s to 274ms.
- **Schools outbound has NO materialization** — the only endpoint that does a full scan every request.
- **X-Cache-Layer: d1** confirmed on cached responses.
- Warm vs cold shows ~5x improvement (145ms → 28ms) on directory loads.

---

## Recommended Fixes (Ranked by Impact)

| Priority | Fix | Effort |
|----------|-----|--------|
| P0-1 | Fix Courses outbound routing (direction ignored on click and deep link) | Small |
| P0-2 | Materialize school-outbound-equivalencies in D1 with cron warming | Medium |
| P1-1 | Consider pushState for tab navigation (back button support) | Small |
| P2-1 | Implement course title search (update placeholder text or add title matching) | Medium |
| P2-2 | Add loading indicators for slow undistributed result sets | Small |
| P3-1 | Add Cache-Control / ETag headers for CDN-level caching | Small |

---

## Test Coverage Notes

- **Fully covered:** Shell/navigation, Schools inbound search matrix, Courses inbound code search, API negative tests, performance timing
- **Partially covered:** Schools outbound (API tested, browser blocked by perf), Courses outbound (routing broken), Saved (infrastructure blocked mobile)
- **Not covered:** Mobile layout verification, physical device testing, Saved persistence round-trip, dedupe behavior in browser
- **Re-run recommendation:** Agent F (Saved + Mobile) should be re-executed with Playwright once the P0 routing fix is deployed
