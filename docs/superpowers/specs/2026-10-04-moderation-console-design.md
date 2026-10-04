# Administrator Moderation Console

## Purpose and scope

Provide a usable operator workflow for the bounded reporting and reversible moderation backend merged in PR #17. An administrator can review report events and explicitly block or unblock a reported Timeline, Link, or a Link's related Asset/Timeline with a recorded reason. Reports remain append-only events; moderation does not resolve or delete a report.

The chosen scope is an administrator console. A queue-only screen would leave operators dependent on manual API calls. A public reporter form plus report lifecycle would enlarge this change into a second workflow, so those are deferred. No account provisioning, role assignment, cloud deployment, public media bypass, or database migration is included.

## Architecture and contracts

Add `/admin/reports` to the existing React application's path routing. Show its navigation entry only when `/api/me` identifies an administrator, but enforce access independently at every API request. A directly loaded URL must handle unauthenticated and non-administrator sessions without rendering report data.

Reuse `GET /api/admin/reports` for descending keyset pagination, initially requesting 20 events. Display report ID, creation time, category, detail, reported target, and observed Timeline version. Expose related subjects only when the existing API returns their stable IDs. Render untrusted report detail as text. Do not automatically open reported external destinations or preload blocked media.

Add `GET /api/admin/content?kind=asset|timeline|link&id=<stable-id>` returning `{ moderation: { target: { kind, id }, blocked: boolean } }`. Strictly validate a single kind and ID, reject extra/repeated parameters, return the existing standardized errors, recheck the current database role inside the read, and send `Cache-Control: private, no-store`. Reuse the existing fixed table mapping; never interpolate caller-provided SQL identifiers. A missing target returns 404. This read exposes only the moderation state, not private content.

Reuse same-origin `PUT /api/admin/content` for mutation with the exact selected target, desired `blocked` boolean, and a required trimmed reason of at most 500 characters. Display the returned state and refresh the selected target's state after success. A later administrator can change it again; displayed state is a snapshot, not a lock. Repeated requests for the same state remain idempotent under the existing backend contract.

## Interaction and failure handling

Use semantic lists, headings, labeled fields, native buttons, and the existing responsive visual styles. Each report exposes its reported target plus valid related subjects as distinct choices. Display the exact kind and ID with current state before enabling a mutation; state-load failure must never imply that a target is unblocked.

Require the reason and an explicit button labeled `Block content` or `Unblock content`; show the selected target and the effect beside that action. Preserve the reason on request failures. Disable duplicate submission while pending, and announce success/failure through status/alert regions. A failed refresh after a successful mutation must report the confirmed mutation separately from the failed refresh. Never automatically retry a mutation.

Pagination uses a `Load older reports` button. A failed page fetch retains existing rows and the same next cursor for retry; deduplicate by event ID when appending. Refresh restarts at the first page and cannot mix earlier results with stale requests. An empty list is a normal state.

On 401 or 403, clear reports, selected state, and drafts and render the sign-in/access-denied state. Late requests after logout, selection change, refresh, or unmount must not restore old data or change a new target. Switching targets clears reasons and feedback so an operator cannot apply a previous target's draft accidentally.

## Files and dependencies

Create `src/client/moderation.tsx` for the console and its state. Extend `src/client/api.ts`, `src/client/main.tsx`, and scoped rules in `src/client/styles.css`. Extend `src/routes/moderation.ts` only for the state-read API. Add real-binding integration coverage in `tests/integration/moderation.test.ts` and desktop/mobile browser coverage in `tests/e2e/moderation.spec.ts`, using existing synthetic fixture helpers. No new dependency is required; Node.js 22 and the committed npm lockfile remain mandatory. All source, documentation, identifiers, and user-facing copy in this slice are English.

## Binary acceptance checks

1. Real D1 integration tests reject anonymous/non-admin/revoked-role state reads, malformed queries, and missing targets, while returning authoritative state for each supported target kind without mutating content.
2. Desktop and 375-pixel mobile browser tests cover queue loading, empty state, pagination, retry without lost rows, target selection, required reasons, and a complete block/unblock flow persisted after reload.
3. Revoked access and logout clear rendered sensitive data; deliberately delayed requests cannot repopulate it or overwrite a different target's state.
4. Keyboard-only operation reaches and submits every control, feedback is announced, and long IDs/details cause no horizontal page overflow.
5. Real API/browser regression verifies blocked public content returns 404 and unblocking restores eligible access while report count, Asset bytes, and quota remain unchanged. Existing backend audit/idempotence tests continue passing.
6. Full `npm run check` and `git diff --check` pass before the implementation commit. Record UI screenshots and independent review in the follow-up PR; GitHub CI must pass before merge.

## Status

The user approved this written specification on October 4, 2026. The implementation plan is `../plans/2026-10-04-moderation-console.md`; its review and execution-method selection remain pending. Product implementation has not started.
