# Timeline Viewport Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the story-mode viewport performance gates for 100 interactive items and a separate 10,000-record overview while preserving accessible editing and existing access rules.

**Architecture:** Add owner-scoped, version-pinned overview and editor-page reads alongside the existing full detail route, then move the Timeline editor to a bounded index/window model. Keep item drafts keyed by stable ID, make minimal writes explicit, reconcile committed appends without replay, and render markers/media with bounded work and mounts.

**Tech Stack:** TypeScript 6, Hono 4, Zod 4, React 19, Cloudflare Workers D1, Vitest 4, Playwright 1.63, Biome 2.5. Use existing browser APIs and dependencies only.

**Spec:** `docs/superpowers/specs/2026-10-08-timeline-performance-design.md`

## Global Constraints

- Keep the default `GET /api/timelines/:id` representation and default mutation responses compatible; the editor opts into the new reads and `Prefer: return=minimal` writes.
- Overview pages contain at most 1,000 `{id, position}` rows; editor detail pages contain at most 100 records with bounded joined asset summaries.
- Preserve authenticated owner scoping, private and unlisted behavior, and current moderation policy. Public Timeline routes do not change.
- Keep complete reorder payloads at or below the existing 1,000-ID cap. Above that cap, retain ordered navigation and item editing while making order read-only.
- Keep `Asset.captured_at`, `TimelineItem.event_at`, `TimelineItem.position`, and timeline version semantics distinct. Viewport actions do not mutate them; an explicit append assigns a position and increments version once.
- Preserve the 100-item keyboard/touch editing workflow. The 10,000-record case is a lightweight overview with bounded edit windows, not 10,000 interactive reorder cards.
- Add no dependency, migration, feed, extraction, or deployment. Keep chronological overview open and unimplemented.
- Record performance measurements on explicitly named hardware and browsers; report values without inventing FPS or latency targets. Synthetic Playwright runs are functional evidence, not named-device measurements.
- Run with Node.js 22 and the committed npm lockfile. Final verification is `npm run check`.

## Review Focus

- Invalid selector input: partial `from_position`/`from_id`, mixed cursor and lower bound, invalid limit, or missing pinned version must fail without returning rows. Pin this in Task 1 schema and route tests.
- Sparse positions and append boundaries: keyset reads across position gaps, an empty story, and a nonempty last-item anchor must not duplicate or omit records or misstate the count. Pin sparse-page cases in Task 1 and empty/nonempty append reconciliation in Task 4.
- Late page responses: a slow detail request arriving after a range or Timeline change must not replace the newer view. Pin this in Task 3 with a delayed-response browser case.
- Draft races: typing during a save, a dirty item moving windows after local or remote reorder, and remote removal must preserve values and focus or expose an unresolved draft. Pin this in Task 4 for both date and instant values and time zones.
- Media edge cases: unavailable `IntersectionObserver`, missing dimensions, and varied aspect ratios must keep offscreen media unmounted and preserve layout. Pin this in Task 5.

---

## Execution preflight

Wait until ContentNodes and ContentEdges integration is present in the selected base. At implementation time, create the isolated `feat/timeline-viewport-performance` branch from that base and record the actual `git rev-parse HEAD` as the baseline; do not choose a SHA while preparing or reviewing this plan. No branch, implementation, or test run is part of this planning task.

### Task 1: Add atomic, owner-scoped overview and editor reads

**Files:**
- Modify: `src/timeline/validation.ts`
- Modify: `src/routes/timelines.ts`
- Test: `tests/unit/timeline-validation.test.ts`
- Test: `tests/integration/timelines.test.ts`

**Interfaces:**
- Produce `timelineOverviewQuerySchema`: `limit` 1–1,000 (default 1,000), optional positive safe-integer `version` on a first-page request, and mutually exclusive `cursor` or paired `from_position`/`from_id` selectors. A cursor continuation requires `version`, is bound to the timeline, and continues exclusively after `(position, id)`; the pair is inclusive and also requires `version`.
- Produce `timelineItemsQuerySchema`: required positive safe-integer `version`, `limit` 1–100 (default 100), and the same timeline-bound exclusive-cursor/inclusive-lower-bound rule.
- `GET /api/timelines/:id/overview` returns `{ timeline: Summary, total_items, items: { id, position }[], next_cursor }`. `timeline.version` identifies the snapshot.
- `GET /api/timelines/:id/items` returns `{ version, items: { id, asset_id, position, caption, event_at, asset }[], next_cursor }`; `asset` is limited to `id`, `kind`, `original_name`, `width`, `height`, and `duration_ms`.

- [ ] **Step 1: Create the 10,000-row D1 fixture, then write failing schema and integration cases.** Seed it in one `INSERT … SELECT` statement over four ten-value digit sets, assign sparse positions, and reuse one ready asset; do not seed in a per-item loop. Cover valid first, cursor, and inclusive-bound pages; reject partial/mixed selectors, an overview cursor or lower bound without a pinned version, a detail request without a version, and invalid limits. Apply an overview cursor to another Timeline and assert rejection. For overview continuations, inclusive overview reads, and detail reads, change the version between requests and assert 409 with no rows; verify each page's owner/version/projection statements use the same D1 batch. Add owner/other-owner and private/unlisted owner checks, detail projection safety, and a 10,000-item pagination case that asserts exact count, order across sparse positions, no duplicates, and no caption or asset payload in overview rows. Retain the existing public moderation behavior checks.
- [ ] **Step 2: Run the focused tests and confirm they fail for missing contracts.**

  Run: `npx vitest run tests/unit/timeline-validation.test.ts tests/integration/timelines.test.ts`

  Expected: new schema/route cases fail before implementation; existing Timeline tests remain green.
- [ ] **Step 3: Implement query schemas and both GET routes.** For every page, use one `DB.batch` containing the owner-scoped Timeline/version read, the page projection, and the count when returned. Compare the requested version to that same batch’s Timeline row and discard the page with `CONFLICT` on mismatch. Do not use a version precheck followed by an independent page query. Keep `GET /:id` unchanged and use the existing authenticated `timelines` router.
- [ ] **Step 4: Run the focused tests and confirm they pass.**

  Run: `npx vitest run tests/unit/timeline-validation.test.ts tests/integration/timelines.test.ts`

  Expected: all selector, cursor-binding, atomic-version, owner, projection, and 10,000-row paging cases pass, including the 1,000-row page ceiling.
- [ ] **Step 5: Run the full repository check before committing.**

  Run: `npm run check`

  Expected: the full check passes; a failure blocks this commit until fixed and rerun.
- [ ] **Step 6: Commit the read contract only after the full check passes.** `git add src/timeline/validation.ts src/routes/timelines.ts tests/unit/timeline-validation.test.ts tests/integration/timelines.test.ts && git commit -m "feat: add paged timeline reads"`

### Task 2: Add opt-in minimal mutation responses safely

**Files:**
- Modify: `src/timeline/mutations.ts`
- Modify: `src/routes/timelines.ts`
- Modify: `src/client/api.ts`
- Test: `tests/integration/timelines.test.ts`
- Create: `tests/unit/client-api.test.ts`

**Interfaces:**
- Extend `mutateTimeline(db, owner, id, expectedVersion, change, options?)` with `options?: { includeItems?: boolean }`, defaulting to `true`. `false` must skip the full item result query.
- When the request includes exactly `Prefer: return=minimal`, mutation routes call the bounded mode and return 204 only after the version-gated D1 batch succeeds. Without the preference, retain current status and JSON body.
- `api<void>(path, options)` handles 204 without JSON parsing. Existing JSON calls continue to decode JSON and existing error envelopes.

- [ ] **Step 1: Add failing integration and client helper tests.** Assert default append/edit/remove/order responses retain their full representation; preferred writes return an empty 204 and commit exactly one version increment; stale preferred writes return the usual 409 and do not commit. Spy on the D1 batch statements to ensure preferred success does not select the complete item array. Test that `api<void>` accepts 204 without calling `json()`, while JSON success and 409 error decoding remain unchanged.
- [ ] **Step 2: Run the focused tests and confirm they fail.**

  Run: `npx vitest run tests/integration/timelines.test.ts tests/unit/client-api.test.ts`

  Expected: current routes return JSON and the API helper attempts to parse an empty body.
- [ ] **Step 3: Implement the optional mutation result and 204 branch.** Preserve the current full response by default. Keep the minimal path’s version/error handling inside the same mutation batch; do not return success before commit.
- [ ] **Step 4: Teach `api()` to return `undefined` for 204 before attempting JSON parsing; call it as `api<void>` only for preferred mutation writes.**
- [ ] **Step 5: Run the focused tests and confirm they pass.**

  Run: `npx vitest run tests/integration/timelines.test.ts tests/unit/client-api.test.ts`

  Expected: default callers remain compatible; preferred writes are bounded and 204-safe.
- [ ] **Step 6: Run the full repository check before committing.**

  Run: `npm run check`

  Expected: the full check passes; a failure blocks this commit until fixed and rerun.
- [ ] **Step 7: Commit the optional response path only after the full check passes.** `git add src/timeline/mutations.ts src/routes/timelines.ts src/client/api.ts tests/integration/timelines.test.ts tests/unit/client-api.test.ts && git commit -m "feat: support minimal timeline writes"`

### Task 3: Move the editor to versioned index and accessible detail windows

**Files:**
- Modify: `src/client/timelines.tsx`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/timeline.spec.ts`

**Interfaces:**
- In `timelines.tsx`, maintain `OverviewItem = { id: string; position: number }`, `indexItems: OverviewItem[]`, the current at-most-100 `itemDetails` window, `total_items`, and the snapshot version.
- Maintain `TimelineDraft = { caption, eventKind, eventValue, timeZone, dirty }` in the editor keyed by item ID; `eventKind` distinguishes date from instant. `Moment` receives these values and change/save callbacks instead of owning persistent form state.
- A range request uses the row at its first ordinal as inclusive `from_position`/`from_id` and the pinned version. A 1-based “go to moment” input and previous/next controls navigate windows.
- A monotonic request-generation token and `AbortController` guard overview and detail requests; only the current generation and version may update editor state.

- [ ] **Step 1: Add the browser fixture and failing read/window tests.** Add `seedLargeTimeline(owner, assetId, count = 10_000)` in `tests/e2e/fixtures.ts` using one local-D1 set-based insert. Add a test that opens a 10,000-item story, reaches the first, middle, and last 100-item windows, verifies ordinal/count labels, and records that the editor does not call the full-detail route or fan out one asset lookup per item. Add a delayed detail response case proving a prior range/timeline response cannot overwrite the current view. Add a draft leave-window/return case.
- [ ] **Step 2: Run the focused browser case and confirm the new page contract is missing.**

  Run: `npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop`

  Expected: the new paged-editor cases fail against the current full-array editor.
- [ ] **Step 3: Implement the index/window state in `TimelineEditor`.** Fetch overview pages sequentially, pin continuations to the first response version, show loading progress, and restart from a fresh first page after stale-version 409. Fetch no more than 100 detail records for the selected range. Keep the editor as a semantic ordered list; expose each item ordinal and total size, move focus to the named range heading after navigation, and keep focus in the field after save. Keep item ordering and range controls keyboard/touch usable; retain the existing complete order controls through 1,000 IDs and omit them above that limit.
- [ ] **Step 4: Move caption/date form ownership into the editor’s item-ID-keyed draft map.** Overlay drafts on fetched details; keep each item’s dirty fields through range changes. Use the request-generation token on both successful and failed async completion paths.
- [ ] **Step 5: Keep these changes in the working tree for Task 4; do not commit the intermediate editor state.** Task 4 adapts the existing mutation and conflict-refresh paths to this index/window model. Run the Task 3 and Task 4 browser regressions together there, then make one source commit after their combined tests and full check pass.

### Task 4: Preserve editor writes, drafts, and append commitment through reconciliation

**Files:**
- Modify: `src/client/timelines.tsx`
- Modify: `tests/e2e/timeline.spec.ts`

**Consumes:** Task 2’s `api<void>` minimal response and Task 3’s `indexItems`, `itemDetails`, `total_items`, pinned read version, item-ID-keyed drafts, and request-generation guard.

**Produces:** A write state that distinguishes committed version from displayed snapshot version and a `writePaused` reconciliation state. A received 204 commits the submitted `expected_version + 1`; a write-level 409 does not commit.

- [ ] **Step 1: Add failing browser cases for draft and commit behavior.** Cover date and instant drafts with caption/value/time zone across a window change, local reorder, and a 409 caused by remote reorder; type a newer value while a save is pending and assert it remains dirty after the older value commits. Assert focus returns to the same item field after reorder/conflict. Cover a remotely removed dirty item remaining in an unresolved area until deliberate discard. For append, cover successful empty-story and nonempty sparse-position tail reads, then inject a failed tail read and separately a concurrent title mutation that makes the tail read return 409; assert the append is present exactly once, the committed picker selection is cleared, later uncommitted selections and drafts remain pending, and writes pause.
- [ ] **Step 2: Run those focused browser cases and confirm the current flow loses or misclassifies state.**

  Run: `npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop`

  Expected: new reconciliation and dirty-draft assertions fail before implementation.
- [ ] **Step 3: Send all editor mutations with `Prefer: return=minimal` and capture the submitted expected version.** On 204, update local edit/remove/order state by item ID; preserve only drafts whose submitted values have not been saved. Keep complete reorder requests at or below 1,000 IDs and restore focus by item ID after an order change.
- [ ] **Step 4: Implement append reconciliation.** Immediately mark a received 204 as committed at `expected_version + 1`, remove that asset from pending selection, and query overview with the pinned new version, limit 2, and inclusive last-item anchor (or the first row for an empty story). Verify/deduplicate the anchor and replace the cached count; an empty-story result must contain the new row and count 1. If the tail read fails or returns 409, never replay the append; stop the picker loop with later selections unsent, pause writes, retain unrelated selections/drafts, reload all overview pages at a fresh version, fetch the active detail window, and resume only after both reconcile.
- [ ] **Step 5: Implement dirty-removal handling.** Preserve a remotely removed item’s dirty values in an accessible unresolved area with copy/discard actions and disabled save. Require explicit confirmation before a local removal discards dirty fields. After conflict/reorder, find dirty and focused items by stable ID, load the range containing the focused item, and restore field focus.
- [ ] **Step 6: Run the combined Tasks 3–4 browser tests, including the existing 100-item keyboard/touch reorder flow, and verify the no-duplicate and draft assertions pass.**

  Run: `npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop --project=mobile`

  Expected: paged editing, stale-response protection, drafts/focus, the existing 100-item reorder workflow, and append commitment all pass; the append remains committed exactly once after both read-failure modes, and writes stay disabled until current-version overview/detail reconciliation succeeds.
- [ ] **Step 7: Run the full repository check for the combined editor state before committing.**

  Run: `npm run check`

  Expected: the full check passes; a failure blocks the combined editor commit until fixed and rerun.
- [ ] **Step 8: Commit Tasks 3–4 together only after the combined tests and full check pass.** `git add src/client/timelines.tsx tests/e2e/fixtures.ts tests/e2e/timeline.spec.ts && git commit -m "feat: page and reconcile large timeline editors"`

### Task 5: Bound marker grouping and unmount offscreen media

**Files:**
- Modify: `src/timeline/viewport.ts`
- Modify: `src/client/story-viewport.tsx`
- Modify: `src/client/timelines.tsx`
- Modify: `src/client/styles.css`
- Test: `tests/unit/viewport.test.ts`
- Modify: `tests/e2e/timeline.spec.ts`

**Interfaces:**
- Add pure `groupPositionsByScreenBin(positions: readonly number[], view: Viewport, extent: number, binWidth?: number): MarkerGroup[]` to `src/timeline/viewport.ts`. Each marker group reports its occupied bin, first/last 1-based ordinal, and count. Find each screen-bin’s world range with binary search; do not iterate every position on each viewport render.
- `StoryViewport` consumes the complete sorted lightweight position index and derives SVG groups through that helper. `Moment` mounts `<img>`/`<video>` only while its media placeholder intersects the document viewport plus one viewport of vertical overscan.

- [ ] **Step 1: Add failing unit and browser cases.** A 10,000-position fixture must preserve the total count while drawing no more than the occupied 48-pixel bins; count indexed reads for a narrow visible range to catch a full-array scan on each render. Assert Fit all, pan, zoom, resize, page loading, and range navigation leave saved `position`, `event_at`, and `version` unchanged; assert a manual frame survives resize, paging, detail-window changes, and append, while navigation to another Timeline resets it. Assert append uses the server-assigned next position and increments version once. A deterministic 100-card fixture must show mounted media only in the visible/overscan band and unmount it after scrolling away. Test absent dimensions, varied aspect ratios, and an environment without `IntersectionObserver`; the fallback begins with media unmounted and exposes the accessible load action.
- [ ] **Step 2: Run the focused tests and confirm the current full-position scan and media mounts fail the intended behavior.**

  Run: `npx vitest run tests/unit/viewport.test.ts`

  Run: `npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop`

  Expected: new grouping and mount-count cases fail before implementation.
- [ ] **Step 3: Implement screen-bin grouping with binary search in `src/timeline/viewport.ts`; use it from `StoryViewport`.** Keep the 48-pixel grouping, marker labels, fit bounds, and viewport controls. Unit tests assert visible counts and grouping, not an invented frame-rate threshold.
- [ ] **Step 4: Add a sized media placeholder and `IntersectionObserver` mount lifecycle.** Use one viewport height as vertical overscan, unmount media outside the band, and keep browser lazy/preload attributes only as secondary network controls. If the observer is unavailable, leave media unmounted until the focused explicit load action is used.
- [ ] **Step 5: Run focused unit and desktop/mobile browser tests.**

  Run: `npx vitest run tests/unit/viewport.test.ts`

  Run: `npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop --project=mobile`

  Expected: grouping remains bounded by occupied bins, offscreen media elements are absent, and existing touch, focus, reduced-motion, page-zoom, and manual-framing checks pass.
- [ ] **Step 6: Run the full repository check before committing.**

  Run: `npm run check`

  Expected: the full check passes; a failure blocks this commit until fixed and rerun.
- [ ] **Step 7: Commit the bounded viewport rendering only after the full check passes.** `git add src/timeline/viewport.ts src/client/story-viewport.tsx src/client/timelines.tsx src/client/styles.css tests/unit/viewport.test.ts tests/e2e/timeline.spec.ts && git commit -m "feat: virtualize timeline viewport media"`

### Task 6: Run the full checks and record separate hardware evidence

**Files:**
- Verify: `src/routes/timelines.ts`, `src/timeline/mutations.ts`, `src/client/api.ts`, `src/client/timelines.tsx`, `src/client/story-viewport.tsx`, `src/timeline/viewport.ts`
- Verify: `tests/unit/timeline-validation.test.ts`, `tests/unit/client-api.test.ts`, `tests/unit/viewport.test.ts`, `tests/integration/timelines.test.ts`, `tests/e2e/timeline.spec.ts`

- [ ] **Step 1: Confirm the final source state has a passing full check.** Reuse the passing `npm run check` from immediately before the Task 5 commit when no source changed afterward; otherwise run it now and require a pass. Do not rerun the exact check on an identical source tree just to duplicate Task 5 verification.

  Run when required by the source-state condition above: `npm run check`

  Expected: the full configured check passes, including builds, lint, typecheck, unit/integration tests, and Playwright. This command does not deploy to Cloudflare.
- [ ] **Step 2: Measure both the 100-item interactive case and 10,000-record overview on one explicitly named desktop device/browser and one explicitly named phone/browser.** Record actual hardware model/chip and memory, OS build, browser name/version, viewport, device scale factor, display refresh, fixture revision, and cache state. Do not use the emulated iPhone Playwright project as proof of phone hardware performance.
- [ ] **Step 3: For the same open, Fit all, pan, zoom, resize, append, and scroll scenarios, retain raw traces and report p50/p95 input-to-next-paint and frame intervals plus mounted image/video counts before and after scrolling.** Include the measurement method and environment with each result. Report measurements only; do not set or imply a universal FPS or latency target. Missing named-device measurements leaves that acceptance gate open.
- [ ] **Step 4: Attach the reproducible scenario, measurement table, and raw trace artifacts to the implementation review.** Keep synthetic browser results labeled as functional fixture evidence, separate from hardware measurements. Do not deploy or publish from this plan.
