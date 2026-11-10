# Recovery Trigger Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the existing synthetic local recovery drill reproduce and safely recover live distribution links and permanent slug reservations.

**Architecture:** Keep separate unmodified schema/data exports. In the fresh offline restored database only, capture all trigger DDL from sqlite_schema, defer those triggers while replaying the data, reinstall the exact DDL, and verify both restoration and post-restore enforcement. Use existing Wrangler argv/file execution without dependencies or SQL dump rewriting.

**Tech Stack:** Node.js 22, installed Wrangler, local D1/R2, node:test.

**Spec:** docs/superpowers/specs/2026-10-14-local-recovery-drill-design.md; this plan extends its synthetic fixtures and safe local replay order based on the observed remote-export collision.

## Global Constraints

- Local synthetic resources only; no Cloudflare writes, remote flags, production credentials, or input export support.
- Preserve raw schema/data exports unchanged. Keep foreign-key, unique, primary-key, and check constraints enabled.
- Only defer triggers in the newly allocated offline scratch restore target; never serve it until verification succeeds.
- Fail closed on any command failure, malformed trigger capture, missing/replaced trigger, data mismatch, quick_check or FK error, or failed enforcement probe. Preserve artifacts and never reuse failed targets.
- No dependency changes or installations. Preserve existing HANDOFF.md modifications and untracked files.

## Review Focus

- A live URL Link plus deleted Link reservation must survive replay without duplicate slug writes.
- Historical rows may conflict with current insert-only guards: defer every captured app trigger, not a hardcoded one.
- Failed trigger reinstall or missing trigger must prevent PASS.
- Exact trigger names and DDL must match after replay; identifier quoting must preserve names safely.
- Reinstalled reservation trigger and reservation uniqueness must still prevent slug reuse; verify foreign keys, supported quick_check, and quota invariants.

### Task 1: Extend the drill and verify guarded trigger replay

**Files:** Modify scripts/recovery-drill.mjs, tests/tools/recovery-drill.test.mjs, README.md (local recovery section only).

**Interfaces:** Preserve runRecoveryDrill options/result compatibility and existing local command guards. Any new helper should remain focused on captured sqlite_schema trigger records and return deterministic scratch SQL; do not parse SQL exports with regular expressions.

- [x] Write failing tests for replay order, raw export preservation, exact trigger-set verification, malformed captures, and failure during trigger reinstall. Extend synthetic seed with one active URL Link and a second deactivated/deleted Link whose slug remains reserved; assert exact expected link/reservation counts, not merely source/restore equality.
- [x] Run npm run test:recovery-drill and record the expected RED failure before implementation. Also reproduce the duplicate reservation in a real local drill with the expanded fixture before adding replay deferral.
- [x] Capture trigger name/sql from the restored database after importing schema; generate separate quoted DROP and exact CREATE files; execute drop -> untouched data -> recreate. Validate captures and compare the captured trigger set with restored sqlite_schema rows. Keep existing constraints active.
- [x] Compare source/restored URL Link fields and reservation tombstone independently against expected seed values, retaining existing asset/timeline/quota/object comparisons. After initial snapshot verification, probe that a new synthetic Link creates a reserved slug and that reusing a tombstoned slug fails; check supported PRAGMA quick_check and foreign keys before PASS.
- [x] Update README to describe offline trigger deferral and enforcement checks without claiming cloud restore or operational cutover acceptance.
- [x] Run npm run test:recovery-drill, npm run recovery:drill, then npm run check. All must exit0. Save finite logs under ignored .superpowers; report actual test totals.
- [x] Self-review only task files; obtain independent review, fix findings, then commit exact task files in English. Do not stage HANDOFF.md, private exports, or credentials. Root handles push/PR and CI after review.
