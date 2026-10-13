# Original Object Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report old R2 `originals/` objects whose keys have no D1 Asset row, without deleting objects or changing Asset data or quota.

**Architecture:** Add one report-only reconciliation function to the existing scheduled cleanup. Each cron invocation lists and classifies at most one page of 100 R2 objects, queries D1 with bound key chunks of at most 90 values, and stores only the opaque continuation cursor in existing `LINK_CACHE`.

**Tech Stack:** Node.js 22, TypeScript 6, Cloudflare Workers D1/R2/KV, Vitest 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-13-object-reconciliation-design.md`

## Global Constraints

- Scan only the `originals/` prefix; request at most 100 R2 objects and make at most one R2 `list` call per scheduled invocation.
- Use R2 `truncated` and `cursor` for continuation; do not infer completion from page length.
- An object is eligible only when its valid `uploaded` timestamp is strictly older than 24 hours.
- Match against every `assets.r2_key` row regardless of Asset status; use at most 90 bound D1 key parameters per query.
- Store only the opaque cursor under `ops:original-object-reconciliation:v1` in existing `LINK_CACHE`, with a 24-hour TTL. Never log the cursor.
- Log aggregate counts and bytes only. Do not log, expose, or persist candidate keys or other user metadata.
- Do not delete R2 objects or mutate Asset rows, Asset status, or quota. Do not add migrations, bindings, dependencies, or API routes.
- Run reconciliation after existing scheduled cleanup and isolate its failures with one generic failure event per failed invocation.

## Review Focus

- A short page with `truncated: true` must continue from its cursor; pin this with an injected R2-list response and a second scheduled invocation.
- The exact 24-hour cutoff, recent, future, and invalid timestamps must be excluded; assert aggregate skip counters.
- Asset rows in `pending`, `ready`, `failed`, `deleted`, and `purged` statuses must all protect their keys; assert no candidate count or byte total for them.
- A D1 or KV checkpoint failure must not advance the cursor; assert the same page is safely retried and no Asset/quota fields change.
- An R2 list failure with a saved cursor must attempt one checkpoint reset, issue no same-invocation retry, and emit a key-free generic event; assert the scheduled handler resolves and existing cleanup still runs.

## Files

- Create `src/assets/reconciliation.ts` for one-page listing, timestamp classification, bound D1 matching, checkpointing, and aggregate diagnostics.
- Modify `src/cleanup.ts` to call reconciliation after the current cleanup operations and catch reconciliation failures only.
- Create `tests/integration/object-reconciliation.test.ts` for scheduled-handler behavior using local D1/R2/KV plus injected list and storage failures.

---

### Task 1: Add bounded report-only scheduled reconciliation

**Files:**
- Create: `src/assets/reconciliation.ts`
- Modify: `src/cleanup.ts`
- Test: `tests/integration/object-reconciliation.test.ts`

**Interfaces:**
- Export `reconcileUntrackedOriginals(bindings: Bindings): Promise<void>`; invoke it once at the end of `scheduledCleanup` and catch only this call's failures.
- Use `prefix: "originals/"`, `limit: 100`, cursor key `ops:original-object-reconciliation:v1`, strict grace `86_400_000` ms, cursor TTL `86_400` seconds, and D1 lookup chunks of at most 90 keys.
- Emit `original_object_reconciliation_page` with only `objects_scanned`, `objects_eligible`, `asset_rows_found`, `missing_asset_rows`, `bytes_scanned`, `missing_asset_bytes`, `skipped_recent`, `skipped_future`, and `skipped_invalid_uploaded`.
- On a reconciliation failure, scheduled cleanup emits only `{ event: "original_object_reconciliation_failed" }`; do not include the thrown error.

- [ ] **Step 1: Write failing classification, privacy, and no-mutation integration tests.** Call the reconciliation function directly against real local D1/R2/KV. Seed old `originals/` objects with and without matching Asset rows, including every Asset status. Assert the exact missing-row/byte aggregates, that all objects remain, no rows are created, and Asset/quota snapshots are unchanged. Direct calls isolate report-only behavior from the existing scheduled purge's intentional mutations. Inject exact-cutoff, recent, future, and invalid dates and assert exact skip counters. Verify that unrelated prefixes are not scanned and that logs omit keys, owner IDs, filenames, cursors, and error text.
- [ ] **Step 2: Write failing pagination and retry integration tests.** Seed more than 100 actual local R2 keys and assert successive calls process at most 100 objects, persist continuation, and clear the checkpoint at the end. Inject a short truncated page and assert the next call uses its cursor rather than treating its length as completion. Inject a 100-key eligible page and verify every D1 lookup has at most 90 bound parameters. Verify zero eligible keys skip D1, a truncated response without a nonempty cursor fails without advancing, cache loss restarts safely, and repeated pages never mutate Assets, quota, or objects.
- [ ] **Step 3: Write failing error-isolation integration tests.** Inject KV read/write/delete failures, D1 classification failure, R2 list failure without a cursor, and list failure with a saved cursor. Assert at most one list request per invocation, no cursor advance after incomplete classification, best-effort reset after a saved-cursor list failure, and generic failure logs without user data. Invoke the real scheduled handler with an expired auth row to prove existing cleanup completes despite reconciliation failure. Do not mistake the existing purge's intended changes for reconciliation mutations.
- [ ] **Step 4: Run the focused test and confirm missing reconciliation behavior fails before implementation.**

  Run: `npx vitest run tests/integration/object-reconciliation.test.ts`

  Expected: FAIL because the new reconciliation module or behavior is absent. Preserve the actual RED log.
- [ ] **Step 5: Implement the report-only function and scheduled integration.** List one page, classify timestamps using one invocation time, and query eligible keys using bound placeholder chunks with no status predicate. After successful classification, store the opaque cursor or clear it at scan completion, then emit the aggregate event. After a saved-cursor list failure, best-effort clear the checkpoint and stop without retrying or inspecting vendor error strings. Let scheduled cleanup catch this call's failure and emit one generic event. Preserve prior cleanup order and behavior.
- [ ] **Step 6: Run focused tests, the existing cleanup regression tests, typecheck, lint, and builds.**

  Run: `npx vitest run tests/integration/object-reconciliation.test.ts tests/integration/abuse-cleanup.test.ts tests/integration/uploads.test.ts`

  Expected: PASS with real local bindings and unchanged existing cleanup/upload contracts. Then run `npm run lint`, `npm run typecheck`, and `npm run build` and resolve failures before review.
- [ ] **Step 7: Obtain one independent review of the completed slice.** Consolidate any fixes, verify their regression cases, and request a scoped closure from the same reviewer. Freeze source hashes when ready.
- [ ] **Step 8: Run the complete exact-state repository check before any source commit.**

  Run: `npm run check`

  Expected: lint, types, unit/integration tests, builds, and browser tests pass. Preserve output and terminal exit status. Any failure blocks a source commit; do not replace this gate with focused tests.
- [ ] **Step 9: Commit the verified reconciliation slice, push, and open a PR targeting main.**

  ```bash
  git add src/assets/reconciliation.ts src/cleanup.ts tests/integration/object-reconciliation.test.ts
  git commit -m "feat: report untracked original objects"
  ```

  Record the exact local gate and review results in the PR. Wait for actual remote CI success before the authorized normal merge. Cloud deployment and object deletion are separate actions.

## Release boundary

This implementation provides bounded, local-testable diagnostics only. It does not delete or repair objects, prove a point-in-time bucket inventory, or close live Cloudflare scheduler, R2, alerting, or backup/recovery gates. A local integration pass is not evidence of cloud execution.
