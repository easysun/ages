# Calibrated Interaction Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reconstruct a bounded pointer activation's exact interaction members and validate its EventCounts population without qualifying a formal trial.

**Architecture:** Extend the existing lossless trace parser with a separately scoped Chrome 155 group analysis and retain the existing crosswalk unchanged. Bind one bounded collector sidecar per trace through the existing CLI's verified-file handling, returning sanitized diagnostic results. Counter closure is conditional on declared document and trace binding.

**Tech Stack:** Node.js 22, built-in `node:test`, existing lossless Chromium trace parser, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-calibrated-interaction-groups-design.md`

## Global Constraints

- Chrome 155.0.8059.84, source revision `5869fe313571d75152b77813cf0a4ee26a4e6df0`, and the exact source observations schema are the only new supported scope.
- Keep existing profile selection, single-event candidates, and all formal-action gates unchanged.
- Match event identity exactly and use an 11,000 µs conservative boundary guard, never proximity matching.
- Preserve all known-endpoint group members, all raw and rounded maximum ties, and source-predicted rather than observed API rounding.
- Count closure is conditional on validated declared capture/document binding and cannot certify formal trials or cryptographic provenance.
- All output must be sanitized; no private traces, credentials, URLs or identifiers committed.

## Review Focus

- Duplicate or malformed relevant events must prevent closure; cover ambiguous exact pairs and incomplete slices in Task 1.
- Supported keyboard/input events with a nonzero counter must block false pointer-only closure; cover this in Task 1.
- A recognized fallback must agree in both absolute and relative microseconds; cover contradictory and fractional endpoints in Task 1.
- A snapshot-boundary event cannot be silently excluded; cover both exact guard boundaries and outside events in Task 1.
- Sidecar substitutions, symlinks, path traversal and mismatched trace digests must not yield verified results; cover each in Task 1.

### Task 1: Add the bounded calibrated group analyzer and CLI binding

**Files:**
- Modify: `scripts/chromium-trace-metrics.mjs`
- Modify: `scripts/analyze-chromium-traces.mjs`
- Modify: `tests/tools/chromium-trace-metrics.test.mjs`
- Modify: `tests/tools/chromium-trace-cli.test.mjs`
- Add synthetic fixture under `tests/fixtures/chromium-traces/` only if needed.
- Add the design and this plan to the same branch; do not stage `HANDOFF.md`.

**Interfaces:**
- Consumes existing `parseTrace(rawText)` and `analyzeTrace(trace, record, segments, sourceObservations, observerEvidence)` interfaces.
- Produces optional `analyzeTrace(trace, record, segments, sourceObservations, observerEvidence, interactionGroupCalibration)` result `interactionGroups` and optional per-trace CLI `interactionGroupCalibration` descriptor, exactly as specified in the design.
- The CLI verifies bytes and passes `{sidecar, binding}`; direct library use assumes a parsed trace and does not claim byte digest verification.

- [ ] **Step 1: Write failing behavioral tests.** Add synthetic three-member cases asserting click 79,668 µs → 80 ms, pointerdown 25,338 µs → 24 ms and pointerup 2,083 µs → 0 ms, C=R=1 each, recognized fallback endpoints, and unavailable formal status. Add tests for raw and rounded ties, a fallback maximum, unsupported/malformed endpoint, 11 ms window boundaries, extra/missing/ambiguous/incomplete entries, keyboard/input counters, navigation keys absent/present/partial, and sanitized output. Add CLI tests for digest mismatch, symlink/traversal, document mismatch, wrong source pin, forged count/status, and private identifiers absent from serialized output. Do not include recorded private payloads.
- [ ] **Step 2: Observe RED.** Run `npm run test:trace-metrics`; expect at least the new group or CLI tests to fail specifically because the group functionality does not exist. Save complete output in the task workspace.
- [ ] **Step 3: Implement.** Implement the optional analyzer and CLI sidecar as specified. Compare exact integer microsecond fallback endpoints and exact binary64 snapshot boundaries. Recompute collector validity and counters; never accept caller status as proof. Keep unknown/incomplete/mismatched situations open or unavailable, with fixed reason codes and no sensitive values. Report bounded closure separately from formal status.
- [ ] **Step 4: Observe GREEN and verify regression.** Run `npm run test:trace-metrics`; expect all existing and new trace tests to pass. Run `npm run check`; expect all lint, typecheck, runtime, trace, worker builds and Playwright checks to pass. Save full output and exit status.
- [ ] **Step 5: Review and commit.** Review the diff and tests against the spec; run `git diff --check`. Stage only the two scripts, their tests and any synthetic fixture, the design and this plan. Commit with an imperative English message. Record the exact commit and results in the ledger. If a fresh reviewer is available, review the complete diff before PR; if unavailable, record that explicitly and do not claim independent review.
