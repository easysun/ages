# Manual Timeline Open Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Produce privacy-preserving diagnostic markers from an exact trusted list activation until the complete Timeline story projection is stably rendered on a manually operated phone.

**Architecture:** A self-contained browser function, serializable for the already-authorized native DevTools workflow, binds one existing Timeline list anchor and observes the existing app DOM without modifying product code. It emits fixed timestamp labels, checks complete contiguous ordinal coverage and two-frame stability, and exposes bounded sanitized status and cleanup. Formal source identity, modality, trace integrity and presentation qualification remain separate.

**Tech Stack:** Node.js 22, native browser DOM APIs, existing Playwright and `node:test`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-manual-open-observer-design.md`

## Global Constraints

- Scope the helper to a synthetic localhost `http://127.0.0.1` or `http://localhost` document and an exact connected `a.timeline-tile` in `main#main.timeline-page .timeline-list`; never return target/path/title/cookies/IDs.
- Expected item count is exactly 100 or 10000; timeout is 120000 ms from `arm()`; marker names and fixed reasons are exactly those in the spec.
- One exact trusted unmodified primary click; no prevention, propagation stopping, history/fetch patching, DOM mutation, persistent storage or network output. Physical modality is independently established.
- A 100/10000 contiguous non-overlapping group sequence must remain valid across two animation frames on the exact declared destination at every observation, same document/time origin and visible page; passive checks do not prove uninterrupted route history; incomplete/error/timeout states fail closed.
- Completion is an observer upper bound on rendered projection, not a compositor presentation, exact render timestamp, trace-loss proof, formal INP, or formal matrix qualification.
- No phone operation during this task. The pre-existing `HANDOFF.md` modification must remain untouched and unstaged.

## Review Focus

- Replacement of the `main` element during SPA navigation must not detach the observer; test stable `#root` observation and cleanup.
- Keyboard-generated trusted click and separately recorded physical modality must not be conflated; test allowed unmodified click while never reporting modality.
- Mutation bursts, detached root, changed time origin and visibility loss must not leak listeners or yield completion; test each outcome.
- A failed marker call, exception from accessors, frame cancellation or stale group after the first frame must fail closed without exposing thrown data.
- Adjacent groups with equal total but missing/overlapping ordinals must be rejected, as must malformed or oversized inputs.

### Task 1: Add a bounded manual open observer

**Files:**
- Create `scripts/manual-timeline-open-observer.mjs`.
- Create `tests/tools/manual-timeline-open-observer.test.mjs`.
- Modify `package.json` to include that test in `test:trace-metrics`.
- Commit the spec and plan with the change; no production UI or dependencies.

**Interfaces:**
- Export `createTimelineOpenObserver({ target, expectedPath, expectedItems, timeoutMs = 120000 })`; return `{ arm(), status(), cancel(), dispose() }` as specified.
- Export `manualTimelineOpenObserverFunctionDeclaration()` returning a self-contained function declaration suitable for the native CDP flow, without depending on module imports or leaking bound arguments.
- `status()` returns only the allowlisted schema, workload, state/reason, counts and boolean flags in the spec; emitted markers are fixed strings.

- [x] **Step 1: Write failing tests.** Added behavior-focused synthetic-browser coverage for 100 and 10000 exact contiguous group coverage; missing/duplicate/overlap/zero and malformed groups; nested child exact-target click and wrong target; untrusted/modified/duplicate clicks; SPA route with stable root; waiting/invalid/timeout/cancel/dispose; visibility, navigation, errors, detached root and time-origin changes; coalescing, two-frame revalidation and marker exceptions; exception/output sanitization; cleanup including on failed setup. The browser test asserts the actual trusted click still reaches an application listener and changes the route; synthetic JS `.click()` remains untrusted. The serialized function is self-contained. Fixtures are synthetic only.
- [x] **Step 2: Observe RED.** `node --test tests/tools/manual-timeline-open-observer.test.mjs` failed before implementation with `ERR_MODULE_NOT_FOUND` for the new helper import. Full output: `.superpowers/sdd/2026-10-31-manual-open-observer/task-1-red.log`.
- [x] **Step 3: Implement.** Added the source-bound passive helper with owned listener/observer/timer/frame cleanup, fixed reasons/markers, bounded status, and no claim that marker emission proves trace capture.
- [x] **Step 4: Observe GREEN.** Focused browser tests: 30 passed, 0 failed, 0 skipped. `npm run test:trace-metrics`: 502 passed, 0 failed, 0 skipped. `npm run check` completed all non-Playwright stages, then Playwright reported 324 passed, 1 skipped, 1 failed in 22.2 minutes: desktop `stale_pagination_cannot_restore_previous_tag` failed during fixture seeding because local `wrangler r2 object put` reported `Network connection lost`. The exact desktop case was rerun alone and passed (1/1). The full-check result remains a failure and is recorded in `.superpowers/sdd/2026-10-31-manual-open-observer/task-1-check.log`; focused rerun output is `.superpowers/sdd/2026-10-31-manual-open-observer/task-1-desktop-recheck.log`.
- [x] **Step 5: Review and commit.** `git diff --check` passed and implementation/tests were self-reviewed. Stage and commit only the spec, this plan, new observer, new test and `package.json`; preserve the pre-existing `HANDOFF.md` modification unstaged. Independent task/branch review and CI remain future PR/merge gates; no PR or merge is part of this task. Detailed results and concerns are in `.superpowers/sdd/2026-10-31-manual-open-observer/task-1-report.md`.
