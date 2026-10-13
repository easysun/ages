# Original Object Reconciliation Design

## Goal

Add a report-only pass to scheduled cleanup that counts R2 keys below `originals/` with no matching D1 `assets.r2_key` row. Each cron invocation lists at most 100 objects. This is operational evidence, not a point-in-time inventory or proof that every missing row was found.

Only objects uploaded strictly more than 24 hours ago are eligible. Recent, future, and invalid `uploaded` timestamps are skipped with aggregate diagnostics. Any existing Asset row protects its key regardless of status (`pending`, `ready`, `failed`, `deleted`, or `purged`). The pass never deletes objects or changes Asset rows, status, or quota.

## Current gap and decision

`src/routes/uploads.ts` creates keys under `originals/`. Existing upload cleanup in `src/assets/cleanup.ts` starts from pending/failed D1 rows, so it cannot find an R2 object whose Asset row is absent. Local D1, R2, and KV bindings are already available.

Choose one bounded R2 page per cron, compared against D1. A full-bucket scan per invocation is unbounded; checking only D1-referenced keys cannot find objects with no D1 row.

## Scan behavior

Run `reconcileUntrackedOriginals(bindings)` once after all existing work in `scheduledCleanup`. Call `MEDIA.list({ prefix: "originals/", limit: 100, cursor })` at most once. Use only `truncated` and the returned opaque `cursor` to determine continuation: R2 may return fewer than the requested limit while more results remain. If `truncated` is true without a non-empty cursor, fail the page without advancing the checkpoint.

Capture one invocation time. An object is eligible only when its `uploaded` Date is valid and strictly older than `now - 24 hours`; exact-cutoff/newer objects are recent, future timestamps are future, and invalid timestamps are invalid. Query only eligible keys using bound `assets.r2_key` values in chunks of at most 90. Skip D1 when there are no eligible keys and never filter by Asset status. An eligible key with no matching row increments the page's missing-row and byte totals.

After a page is fully classified, store its cursor in the existing `LINK_CACHE` under `ops:original-object-reconciliation:v1` with a 24-hour TTL when truncated; delete the checkpoint when the scan ends. The KV value contains only the opaque cursor. Loss, expiry, overlap, or replay can repeat diagnostic work but cannot authorize access, change quota, or delete media. Concurrent R2 writes can be missed or repeated during a pass, so a completed cycle is not an authoritative snapshot and later cycles continue.

## Failure and privacy behavior

Reconciliation runs last and its failures are caught without blocking existing cleanup. Emit a generic failure event on every failed invocation; omit exception text, keys, cursors, owner IDs, filenames, and other user metadata. On D1 classification or KV checkpoint failure, do not advance; the page is safe to repeat. If listing with a saved cursor fails, best-effort delete that checkpoint and stop without a same-invocation retry. This avoids guessing provider error strings and caps list calls at one per invocation; persistent failures remain visible as repeated generic events.

`objects_scanned` and `bytes_scanned` count all listed objects and their sizes, including skipped timestamps. `objects_eligible` counts keys submitted to D1 classification; `missing_asset_bytes` sums only eligible objects without an Asset row. Successful diagnostics are page-local aggregate counts and byte totals; overlap or retries can repeat them, so they are not cumulative unique-object totals. Do not persist or expose candidate key lists. The feature adds no migration, binding, dependency, API route, object deletion, Asset mutation, or quota adjustment.

## Verification

Use `tests/integration/object-reconciliation.test.ts` with real local D1/R2/KV for classification, checkpoint progression, and no-mutation assertions. Inject list, timestamp, D1, and KV boundaries for short truncated pages, invalid cursors, and failures. Repeated or overlapping pages may repeat diagnostics but must not mutate Asset/quota data or delete objects. Verify at most one list call per invocation and that existing cleanup completes on reconciliation failure. Live-cloud scheduler and bucket behavior remain separate release gates; local tests do not close them.

Cloudflare's [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) defines `uploaded` as a `Date`, allows list results shorter than the requested limit, and directs callers to `truncated` and `cursor` for continuation.
