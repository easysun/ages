# Observed Discrete Input Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Associate retained, observed discrete inputs with exact trace presentation candidates while rejecting ambiguous or incomplete evidence.

**Architecture:** Add an isolated .80 diagnostic source profile and a separately validated observer-evidence input to the existing analyzer. Retain raw indices privately through association and crosswalk; integrate bounded sidecar loading into the existing offline CLI. Existing modes remain unchanged when observation evidence is absent.

**Tech Stack:** Node.js 22, existing Node test runner, existing lossless trace parser and observer validators; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-observed-discrete-input-identity.md`.

## Global Constraints

- All output remains diagnostic; formal action samples and percentiles remain unavailable.
- Preserve all raw captures, failed records, and source hashes. No new browser capture or application change.
- Require stable document provenance, trace loss explicitly false, closed observer schemas, and exact file integrity.
- Positive API interaction IDs must be integers at most `2147483647`; no normalization or timestamp tolerance.
- Count multiplicity before filtering. Unsupported continuous/resize and primary-open misses remain rejected.
- Preserve Chromium 153 and Brave .40 guards and behavior. Never equate published upstream revision with Brave binary identity.

## Review Focus

- A duplicate with an invalid endpoint must still make its identity ambiguous.
- A malformed contender must not disappear and manufacture a unique match.
- Observer delivery phase must not assign the action; use the matching DOM dispatch record.
- Sidecar substitution, symlinks, or traversal must fail before association.
- Same-looking .80 metadata with a changed revision or executable must not enable parsing.

### Task 1: Add the isolated .80 published-source diagnostic profile

**Files:** Modify `scripts/chromium-trace-metrics.mjs`; test `tests/tools/chromium-trace-metrics.test.mjs`.

**Interfaces:** Preserve `analyzeTrace(trace, traceRecord, segments, sourceObservations)` and its existing output. The private profile selector gains one explicit .80 branch; the existing .40 guard is unchanged.

- [x] Write failing tests accepting the spec's exact four-field .80 projection, rejecting each changed identity/extra-field envelope, and preserving .40 cases. Assert `formalActionStatus === "unavailable"` and no formal samples.
- [x] Run `node --test tests/tools/chromium-trace-metrics.test.mjs`; save the expected RED evidence.
- [x] Implement the separate literal guard and method scope. Share parsing only after profile selection; keep .80 vendor identity unverified and pin its separate published revision.
- [x] Rerun the focused tests and require all profile and previous crosswalk assertions to pass.

### Task 2: Associate observed entries before crosswalk filtering

**Files:** Modify `scripts/chromium-trace-metrics.mjs`; reuse validators from `scripts/browser-stimulus-observer.mjs`; test `tests/tools/chromium-trace-metrics.test.mjs`.

**Interfaces:** Extend `analyzeTrace` with optional fifth argument `observerEvidence = undefined`. When supplied, it contains `{ declaration, sidecar, capture: { sourceHashSha256, caseRecord } }`, the original manifest observation declaration, parsed original sidecar, source hash, and linked original case record. Add `observedDiscreteInputs` only for this mode: `{ status, counts: { apiEntries, accepted, rejected }, entries, rejectionCounts, formalActionStatus: "unavailable", formalActionSamples: [] }`. Accepted entries contain only fixed dispatch/action labels, mapped event type, trace duration, processing-tail duration, and diagnostic status. Keep raw identity/index maps and capture metadata private.

- [x] Write failing fixtures for a genuine singleton, duplicate API before DOM filtering, duplicate raw begin before fallback/endpoint/window filtering, incomplete/malformed contenders, zero/overflow IDs, stale provenance, target mismatch, and delivery-phase disagreement. Also reject completed actions with capture-failure reasons, missing/changed collector hash, unknown measurement states, and conflicting case/trace loss fields; accept exactly the two lifecycle states in the spec. Assert continuous and resize cannot borrow incidental discrete events, accepted records remain diagnostic, and absent fifth argument preserves previous output.
- [x] Run the focused Node test file and retain expected RED failures.
- [x] Validate the original observer declaration/sidecar with existing closed-schema validators and exact fixed metadata. Enforce the spec's literal collector hash and lifecycle allowlist before association. Build multiplicity maps across all contenders first; reject unclassifiable scopes. Require the exact trusted DOM counterpart and stable frame, then select the existing crosswalk candidate by private raw begin index, never by summary duration or type alone.
- [x] Rerun focused tests; require all rejection ordering and privacy assertions to pass.

### Task 3: Load and verify sidecars in the offline CLI

**Files:** Modify `scripts/analyze-chromium-traces.mjs`; test `tests/tools/chromium-trace-cli.test.mjs`; update the existing CLI section in `README.md` only as needed.

**Interfaces:** Existing CLI syntax and captures without observation evidence remain unchanged. For observer captures, load each case's referenced sidecar using the original manifest reference and integrity fields, then pass the original declaration, sidecar, manifest source hash, and linked case record using Task 2's fifth-argument contract. Expose only the bounded sanitized association result.

- [x] Add failing CLI fixtures for correct sidecar integrity, wrong bytes/hash, missing file, symlink, traversal, duplicate/mismatched case reference, malformed envelope, and existing captures without sidecars. Assert no raw IDs, content, or event arguments in output; formal next paint stays unavailable.
- [x] Run `node --test tests/tools/chromium-trace-cli.test.mjs` and retain expected RED evidence.
- [x] Implement bounded regular-file loading confined to the manifest directory and verify exact SHA-256/byte count before parsing or association. Do not accept an external proof flag or synthesize missing fields.
- [x] Run `npm run test:trace-metrics`; require all trace-tool tests to pass.
- [x] Reanalyze the retained 14-case .80 observer capture once, preserving input hashes and reporting rejected primary-open entries. No recapture, metric promotion, or formal summary.
- [ ] Obtain a fresh whole code review, repair consolidated findings with the same reviewer's scoped closure, run `npm run check`, and inspect the final diff. Commit explicit paths only after the full gate passes; push and create a PR against main after PR #40 integration. Record CI results before merge.
