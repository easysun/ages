# Administrator Moderation Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators review reports and reversibly moderate their exact targets with reasons.

**Architecture:** Extend the existing React application with an administrator screen. Add a minimal authoritative state read to the existing administrator API; reuse report pagination and atomic moderation writes.

**Tech Stack:** TypeScript, React, Hono, Zod, D1, Vitest Workers runtime, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-moderation-console-design.md` (approved October 4, 2026).

## Global Constraints

- No new dependency is required; Node.js 22 and the committed npm lockfile remain mandatory.
- All source, documentation, identifiers, and user-facing copy in this slice are English.
- No account provisioning, role assignment, cloud deployment, public media bypass, or database migration is included.
- Reports remain append-only events; moderation does not resolve or delete a report.
- Initial report page size is 20; mutation reason is required, trimmed, and at most 500 characters.
- Full `npm run check` and `git diff --check` pass before the implementation commit.

## Review Focus

- A revoked operator must not retain report data when a later request fails with 401/403.
- A slow response must not replace another target's current state or restore data after logout.
- A failed older-page fetch must preserve loaded reports and its retry cursor.
- A confirmed mutation followed by a failed state refresh must remain visibly confirmed without enabling an unsafe follow-up action.
- Long untrusted details/IDs must remain text, wrap on mobile, and stay keyboard accessible.

### Task 1: Authoritative administrator content-state read

**Files:** Modify `src/routes/moderation.ts`; test `tests/integration/moderation.test.ts`.

**Interfaces:** Consumes existing `requireUser`, `ApiError`, `moderationTables`, and real D1 bindings. Produces `GET /api/admin/content?kind=<kind>&id=<id>` returning `{ moderation: { target: { kind: "asset" | "timeline" | "link", id: string }, blocked: boolean } }`.

- [ ] Write real-binding tests named `reads authoritative moderation state without mutation`, `rejects malformed content-state queries`, and `rejects revoked operator access`. Seed all three target kinds using existing moderation helpers. Assert both false/true states, no change in audit/report/quota counts, `private, no-store`, 401 without session, 403 for ordinary users, 403 when the database role changes during the read, and 404 for a missing target.
- [ ] Parameterize invalid queries: absent/empty ID, ID longer than 100 characters, unknown kind, duplicate kind/ID, and extra query key. Each must return standardized 400 without a write.
- [ ] Run `npm run test -- tests/integration/moderation.test.ts`; confirm new state-read tests fail before implementation because the route is absent.
- [ ] Add the GET handler before the existing PUT handler. Validate query cardinality and values, use the fixed table mapping, and batch a current-role read with a role-guarded target-state read. Check current role before interpreting a missing target. Return only target identity and blocked state.
- [ ] Rerun the focused moderation suite; all old and new cases must pass.

### Task 2: Report queue and administrator-only navigation

**Files:** Create `src/client/moderation.tsx`, `tests/e2e/moderation.spec.ts`; modify `src/client/api.ts`, `src/client/main.tsx`, `src/client/styles.css`.

**Interfaces:** Export `ModerationScreen(): React.JSX.Element`; add `Profile.user.plan: "free" | "creator" | "pro" | "admin"`. Define `ModerationTarget`, `ModerationState`, and `ReportPage` matching the existing server response. `ModerationScreen` consumes the same-origin `api<T>` helper and renders `<main id="main">`.

- [ ] Seed synthetic operators/reports with `seedLibrary`, `seedTimeline`, and `executeFixtureSql`. Add browser assertions for admin-only navigation, direct access denial, empty queue, 20-event first page, append of older reports without duplicates, refresh to first page, and failure/retry that preserves loaded rows. Run on both configured desktop and mobile projects.
- [ ] Run `AGES_E2E_PORT=8796 npm run test:e2e -- tests/e2e/moderation.spec.ts`; confirm the queue assertions fail because the screen is absent.
- [ ] Add the route and navigation entry, keeping existing Library/Timeline behavior. Render report fields as text and related subjects as separate target-selection buttons; never follow external destinations or load reported media.
- [ ] Implement queue fetch generation tracking, ID deduplication, loading/empty/error states, older-page retry and first-page refresh. On 401/403 clear queue and drafts and render denied/session-ended copy. Invalidate outstanding work on unmount/logout.
- [ ] Add tests delaying older-page responses across refresh and delaying queue responses across logout; assert stale data never reappears. Test long detail text containing HTML syntax is displayed literally and causes no mobile overflow.
- [ ] Rerun focused browser cases until all queue/access assertions pass.

### Task 3: Target selection and reasoned moderation

**Files:** Modify `src/client/moderation.tsx`, scoped `src/client/styles.css`, and `tests/e2e/moderation.spec.ts`.

**Interfaces:** Consumes Task 1's state GET and existing `PUT /api/admin/content` with `{ target: ModerationTarget, blocked: boolean, reason: string }`. Both return `ModerationState`. Preserve the selected exact target across successful refresh; clear its reason and feedback on target change.

- [ ] Add failing browser assertions for exact target ID/kind and current state, blank/overlong reason rejection, duplicate-submit prevention, retained failed-write draft, and explicit `Block content`/`Unblock content` actions.
- [ ] Add delayed-response assertions: selecting B before A finishes cannot show A's state; revoked-role mutation clears sensitive state; a delayed successful mutation cannot repopulate a logged-out screen. Use controlled browser transport only to create timing/failure conditions, with real local API for normal mutations.
- [ ] Implement selected-target generation tracking and state loading. Disable writes without confirmed current state. Preserve reasons on failures; never retry writes automatically. Announce confirmed writes independently of subsequent refresh errors, and require a successful state retry before another write.
- [ ] Add real API/browser block/unblock verification: reload confirms persisted state, public Timeline returns 404 while blocked and 200 after eligible restoration, and report count, R2-backed Asset delivery after restoration, and quota remain unchanged. Retain existing audit/idempotence integration assertions.
- [ ] Add keyboard-only navigation/submission and mobile wrapping checks; assert feedback uses status/alert semantics. Run the full focused browser file on desktop and mobile.

### Task 4: Verification, review, and publication

**Files:** Update `HANDOFF.md` and the Stage 09 UI status in `docs/implementation-plan.md` only after verification.

**Interfaces:** Produces a reviewed commit and a focused PR targeting current `main`; no cloud side effects.

- [ ] Run `npm ci --cache /private/tmp/ages-npm-cache`, `npm run db:migrate:local` and a migration rerun. No new migration should exist for this slice.
- [ ] Run `AGES_E2E_PORT=8796 npm run check` and `git diff --check`. Require exit 0; document any intentional pre-existing skip explicitly. Fix failures with regression coverage and rerun affected checks plus the full suite when product code changes.
- [ ] Inspect synthetic desktop/mobile screenshots of queue, selected target, and mutation feedback. Record paths and verification results in the handoff.
- [ ] Obtain independent whole-branch review using the requesting-code-review skill, including the five Review Focus conditions; resolve findings before committing implementation.
- [ ] Commit with an imperative English message. Confirm trusted authorization covers this branch's contents and destination before pushing; do not reuse authorization specific to `8aff931` for a new payload. Create and attach the PR when authorized, record tests/screenshots in its description, and require GitHub CI before merging.

## Execution review

Recommended method: native execution in this chat, because the three code tasks share one small API/client workflow and sequential changes avoid competing writers. An independent whole-branch review remains required. Product implementation starts after the user reviews this plan and selects its execution method.
