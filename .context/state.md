# Project State

Last updated: 2026-04-18 — confirmed local D1 has only 9 `purdue-course-equivalencies:%` rows (prod has 2046). User's "only 9 courses" UI was local dev, not a bug.

## Status: Launched. Top-5 fixes verified on prod. Post-fix sanity pass clean — no real regressions. 3 new churn findings from fresh-eyes agent.

## Post-Launch Backlog (ranked by severity)

### P1 — mobile + accessibility
- [ ] Save/remove button touch target is 30×30px on mobile (fails 44×44 HIG minimum).
- [ ] Filter buttons (All / Direct credit / Undistributed) are 30px tall on mobile.
- [ ] Scroll-to-top button is 42×42px (borderline under 44 minimum).
- [ ] DOM virtualization for 1500+ equivalency cards — current Ivy Tech view has 30,971 DOM nodes and 426,682px body height.

### P1 — information design
- [ ] Undistributed codes are unexplained in the Schools tab (Courses tab already has the decoder + gold pills). Ivy Tech CSCI → `CS 1XUND` gives CS transfer students no signal.
- [ ] Saved tab rows don't display the school name — impossible to disambiguate rows saved from multiple schools.
- [ ] `purdue-courses` endpoint returns `{code, name}` instead of `{subject, course, title, credits}`; `name` duplicates the code and no cache headers.
- [ ] Browser back-history order is slightly off (Morgan Playwright test: entries exist but positions shifted — 1/5 matched).

### P1 — international UX (Priya walkthrough)
- [ ] "Undistributed credit. Not fully evaluated" copy has no inline explanation — most damaging ESL friction point.
- [ ] "IN" badge visually collides with Indiana state code on Indian school rows (URL disambiguation works; visual does not).
- [ ] No country/region filter on the school browse list.
- [ ] No Indian university equivalency data — Purdue's upstream database has 0 Indian schools. External, not fixable by us.

### P1 — new-user churn findings (2026-04-18 agent-browser audit)
- [ ] Course search for "CS 18000" returns zero exact matches — CS 11000, CNIT 18000, CS 15900 appear instead. A student looking for Purdue's most popular intro CS course gets no result and no explanation why. High churn risk.
- [ ] "Where can I take it?" / "Where does it transfer?" direction labels are opaque — a new user doesn't know which button answers their question until after clicking. No visual indicator of which direction is currently active or what "it" refers to.
- [ ] Welcome modal on first visit covers the entire interface and must be manually closed before any interaction — but closing it reveals a flat alphabetical list of 2,967 schools with no popular/recent schools surfaced. No obvious starting point for a first-time Purdue student.

### P2 — nice-to-have
- [ ] Framing content for incoming international students (transfer concept, US education system, graduate applicability).
- [ ] Course title fuzzy search is partially working; still not great for queries like "Calclus".
- [ ] Large undistributed result sets slow (MA 1XMQR, 749 rows → ~15.6s).
- [ ] Add CDN-level Cache-Control/ETag headers on static assets and cacheable API responses.
- [ ] Redirect dhiyaan.me/boilercredits → boilercredits.xyz (blocked on access to that repo).

## Recently Completed

- [x] **Cleanup sweep (2026-04-18):** Added `test-results/`, `.playwright-cli/`, `playwright-report/` to `.gitignore`; hardened `apiFetch` error rendering in `frontend/lib/api.ts` to prefer `body.error` string, fall back to `details[0].message` if present, instead of raw `body.details` array; pruned this state doc; committed `.context/e2e/` audit artifacts as a reference.
- [x] **Shipped top-5 audit action items to prod (2026-04-18, commit `4c98a98`):**
  1. **P0 security — Origin rate-limit bypass fixed** (`src/lib/rate-limit.ts`). Spoofed `Origin: http://localhost` no longer unlocks unlimited rate-limit budget on prod. Verified: `x-ratelimit-remaining: 59` instead of `9007199254740991`.
  2. **P1 welcome modal blocks deep links fixed** (`frontend/main.tsx:1006`). First-time visitors following a shared hash URL see the restored view directly instead of the modal.
  3. **P1 empty-equivalency cache poisoning fixed** (`src/services/materialized-browse.ts`, `src/routes/meta.ts`). Empty upstream responses now cache with a 300s TTL and self-heal, instead of sticking for 24h. Prod D1 rows verified: `ttl_ms: 300000`. CS 18000 and ENG 10600 poisoned rows were deleted; re-fetch confirmed Purdue genuinely has no data for those courses — external gap, not our bug.
  4. **P1 school search ranking fixed** (`frontend/lib/fuzzy.ts`, `frontend/lib/school-search.ts`). `startsWith` beats `includes` in the scorer (900 vs 800); strong matches drop the fuzzy tail; pure state-code queries bypass the scorer entirely so catalog order is preserved.
  5. **P2 popstate restores selectedCourse** (`frontend/main.tsx:1110-1145`). Back/forward from a course deep link now updates the detail view.
- [x] **Pre-launch 12-agent audit + meta-review (2026-04-18):** Full report at `.context/e2e/pre-launch-audit-2026-04-18.md`. Backend 58/60 pass; 6 persona walkthroughs (Alex/Jordan/Sam/Priya/Morgan/Chris). Meta-review caught the P0 Origin bypass all 12 agents missed.

## Architecture Summary

- **API** (`src/`): Hono on Cloudflare Workers. Routes under `/api/meta/*` and `/api/equivalency/*`. Proxies Purdue upstream, caches in D1 with background refresh via Cloudflare Queues + 15-min cron rotation.
- **Frontend** (`frontend/`): Single-page Preact app built by Vite. Three tabs: Schools, Courses, Saved. Hash routes `#schools/in|out/us|intl/<id>/<state>`, `#courses/in|out/<subject>/<course>`, `#saved`. Legacy hashes auto-migrate.
- **Database**: D1 with `materialized_responses` (cache_key PK, payload_json, expires_at, updated_at) and `refresh_jobs` tables. No KV binding in production despite optional `CACHE?: KVNamespace` in `Env`.
- **Dev**: `pnpm dev` runs Wrangler (:8787) + Vite (:5174). Deploy: GitHub Actions → `wrangler deploy` on push to `main`.
- **Tests**: Vitest unit tests (6 files / 37 tests). E2E via Playwright scripts in `.context/e2e/`.

## Notes

- Live at **boilercredits.xyz** and **www.boilercredits.xyz**.
- E2E audit artifacts committed at `.context/e2e/`.
- Data sourced from Purdue Self-Service Transfer Equivalency Guide.
- Not affiliated with Purdue University.
