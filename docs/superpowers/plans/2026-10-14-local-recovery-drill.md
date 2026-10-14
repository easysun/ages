# Local Recovery Drill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one reproducible synthetic local D1/R2 recovery drill with a fresh split-export restore and isolated artifacts.

**Architecture:** A dependency-free Node ESM CLI invokes pinned Wrangler through argv arrays and isolated scratch configs. It uses supported schema-only/data-only D1 exports, separately restores the R2 object, and verifies synthetic joins, metadata, quota, and bytes. Node’s built-in test runner covers guards; the drill command is the local end-to-end check.

**Tech Stack:** Node.js 22.22.2+, npm, Wrangler 4.147.0 from the lockfile, Node built-ins; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-local-recovery-drill-design.md`

## Global Constraints

- Every resource command uses `--local` and `--env ""`; never pass `--remote`.
- Create each run exclusively below ignored `.wrangler/recovery-drills/<UTC timestamp>-<UUID>/`; reject existing targets and never delete or overwrite run artifacts.
- Use source/restored configs with distinct local D1 UUIDs and R2 bucket names; never load an ancestor config or root dev, E2E, or Vitest persistence.
- Back up D1 with `d1 export --no-data` then `d1 export --no-schema`; restore schema before data. Do not rewrite SQL or disable foreign keys.
- Back up and restore R2 separately. Set restored object `--content-type` from source D1 `mime_type`; document that stored R2 HTTP metadata is not independently read back.
- Preserve host `HOME`, `TMPDIR`, and `CODEX_HOME`; remove only known Wrangler auth keys from the child environment when present.
- Use Node child-process APIs with argv arrays and no shell. Add no dependencies, migration, application API, binding, deployment, or cloud resource.
- On command or comparison failure, stop, preserve artifacts, exit nonzero, and never report PASS.
- Run `npm run check` before an implementation source commit; no cloud recovery or deployment is part of this slice.

## Review Focus

- Existing run path, file, symlink, or symlinked output-parent component: reject without modification; test `refuses_existing_and_symlinked_paths_without_writing`.
- Ancestor Wrangler config contains unrelated/remote bindings: commands must use only scratch configs; test `uses_generated_scratch_configs_not_ancestor_configs`.
- Child environment inherits credentials and custom host paths: preserve host path variables while removing only known auth keys in the child; test `sanitizes_child_credentials_without_changing_host_paths`.
- Wrangler fails at an intermediate step: stop and omit PASS; test `halts_on_command_failure_without_false_pass`.
- Restored fields differ: detect quota, capture date, event date, visibility, MIME, relationship, object size, or hash mismatch; test `detects_each_recovery_snapshot_mismatch`.

---

### Task 1: Implement the isolated local recovery drill

**Files:**
- Create: `scripts/recovery-drill.mjs`
- Create: `tests/tools/recovery-drill.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- `allocateRunDirectory(drillsRoot: string, runId: string): RunPaths` exclusively creates the run and returns its root, source, restored, backup, log, and report paths.
- `buildLocalArgs(commandArgs: string[], configPath: string, persistTo: string | null): string[]` adds explicit scratch config, `--env ""`, and `--local`; add `--persist-to` only when supported. D1 export uses config-relative persistence.
- `makeWranglerEnv(parentEnv: NodeJS.ProcessEnv, logPath: string): NodeJS.ProcessEnv` preserves host path variables, sets only child `DO_NOT_TRACK`, Wrangler banner/metrics/log-path controls, removes only the known Wrangler auth keys when present, and does not mutate or log `process.env`.
- `compareSnapshots(source: Snapshot, restored: Snapshot): string[]` returns names of unequal allowlisted fields. Empty mismatches are necessary, not sufficient, for PASS.
- `runRecoveryDrill({ repoRoot, execute }): DrillResult` orchestrates the workflow and accepts an injected command executor for failure and argv tests.
- `package.json` exposes `recovery:drill` and `test:recovery-drill`; `check` includes the Node guard tests.
- `README.md` documents the exact command, ignored artifacts, local-only scope, and metadata limitation.

- [ ] **Step 1: Write failing Node guard tests.** In `tests/tools/recovery-drill.test.mjs`, use `node:test`, `node:assert/strict`, and test-owned temporary directories. Add tests named in Review Focus, plus `builds_only_local_commands_with_scratch_persistence` and `compares_asset_timeline_quota_and_object_transfer_fields`. Inject a fake executor so failures and argv are asserted without Cloudflare access.
- [ ] **Step 2: Run tests to confirm the missing implementation fails.** Run `node --test tests/tools/recovery-drill.test.mjs`. Expected: fail because `scripts/recovery-drill.mjs` does not yet export the planned functions.
- [ ] **Step 3: Implement path, config, argv, and environment helpers.** Reject unknown CLI arguments before allocation and reject run-ID traversal. Canonicalize the repo root, then reject symlink components below it. Reject remote flags, unsupported resource command families, and config/environment/persistence overrides in command input. Locate the repo from `import.meta.url`; allocate only below `.wrangler/recovery-drills`; reject symlinked parent components and existing targets; write minimal scratch configs with distinct D1 UUIDs/bucket names and an explicit migrations directory; add local flags; and create child env without changing host `HOME`, `TMPDIR`, or `CODEX_HOME`.
- [ ] **Step 4: Implement synthetic source, backup, and restore stages.** Apply current migrations to source D1; put the fixed 69-byte PNG (expected SHA-256 `d3c936ebdd73f46e6422d5946044c99d524554082272019ab738800318b04892`) into source R2; seed generated user/Asset/Timeline/TimelineItem IDs with the spec’s fixed quota and timestamps; transition the Asset pending-to-ready and require quota usage 69; write seed/query SQL only to run-local files; export schema then data; retrieve R2 bytes; replay schema before data into restored D1; and put the object into restored R2 with the source D1 MIME.
- [ ] **Step 5: Implement comparisons, structured logs, and fail-stop reporting.** Compare the allowlisted source/restored row fields including quota, captured date, event date, visibility, MIME, and relationship. Compare original, backup, and restored byte size and SHA-256. Log only structured argv/status and synthetic counts/hashes/comparison results. Explicitly mark stored R2 HTTP Content-Type as not independently verified. Emit PASS only when all available checks pass; on any command or comparison failure, preserve artifacts and exit nonzero.
- [ ] **Step 6: Add package entry points and concise operations docs.** Add `npm run recovery:drill` for the CLI and `npm run test:recovery-drill` for `node --test tests/tools/recovery-drill.test.mjs`; include the Node tests in `npm run check`. Add a concise README section with local-only scope and the R2 metadata limitation.
- [ ] **Step 7: Run focused tests.** Run `node --test tests/tools/recovery-drill.test.mjs`. Expected: all filesystem, scratch-config/argv, environment, failure-stop, and comparison tests pass.
- [ ] **Step 8: Run the clean local end-to-end drill.** Run `npm run recovery:drill`. Expected: a new ignored run directory; local Wrangler commands exit 0; exactly one matching source/restored join; quota usage equals object size; captured/event dates, D1 MIME and visibility match; original/backup/restored bytes and hashes match; final status PASS with the stored-R2-metadata limitation visible.
- [ ] **Step 9: Obtain one independent review of the completed slice.** Preserve the focused tests and actual local round-trip results, freeze source hashes, and consolidate any findings before a scoped closure.
- [ ] **Step 10: Root runs the exact-state full repository gate after review is ready.** Run `npm run check`. Expected: lint, typecheck, Vitest, builds, browser tests, and the Node guard suite pass. No implementation source commit before this full gate; root owns commit, push, PR, and remote CI integration. Do not provision cloud resources or deploy.
