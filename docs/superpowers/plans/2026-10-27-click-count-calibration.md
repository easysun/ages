# Same-document Click-count Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect bounded same-document click counters and one trusted target record for a future native-phone calibration, without qualifying formal metrics.

**Architecture:** A separate self-contained browser function owns one immutable baseline, passive listeners, and one idempotent final result. A source-declaration builder lets the existing native Protocol Monitor workflow invoke it on a preselected DOM element; no existing observer, trace profile, analyzer, or product behavior changes.

**Tech Stack:** Node.js 22, browser EventCounts/EventTarget APIs, node:test, existing Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-10-27-click-count-calibration-design.md`

## Global Constraints

- No new dependency, application route, UI, source profile, latency computation, or formal acceptance flag is added.
- The tool runs only in a visible same-document local HTTP 127.0.0.1 or localhost fixture; it never starts tracing or injects input.
- At most 64 counter keys and two click records; counters must be nonnegative safe integers, and missing values never become zero.
- Output always has `diagnosticOnly: true` and `formalStatus: "unavailable"`; `collected` does not certify a trace or physical input.
- Preserve the existing observer v1/v2/v3 and analyzer contracts; no original pilot is retrospectively promoted.
- All committed text is English; never commit raw protocol files, cookies, traces, private review artifacts, or pre-existing HANDOFF.md changes.
- Reuse installed dependencies; do not run local npm ci/install or change the lockfile.
- User waived future design/plan approval waits and selected subagent execution with GPT-6 Luna/max. Proceed through independent reviews; phone action waits until software is ready.

## Review Focus

- A replacement document or counter object must never be read as the original document's final snapshot.
- A synthetic, foreign-target, or repeated click must not be accepted because its total happens to equal a desired count.
- Missing, throwing, unsafe, decreasing, or oversized counters must fail without inferred zero values.
- Close, abort, partial installation, and invalidation must remove only this collector's listeners and preserve an immutable result.
- Serialized code must run in a real browser realm and leave normal application event handling intact; synthetic browser tests are not physical qualification.

---

### Task 1: Implement and verify the bounded collector and native invocation

**Files:**
- Create: `scripts/click-count-calibration.mjs`
- Create: `tests/tools/click-count-calibration.test.mjs`
- Modify: `package.json` — append the new test file to `test:trace-metrics`, leaving other scripts and dependencies unchanged.
- Include the spec and this plan in the focused commit. No existing observer/analyzer source changes.

**Interfaces:**
- Consumes: a connected DOM element and opaque document label; browser `performance.eventCounts`, visibility, clock, and event lifecycle.
- Produces: `createClickCountCalibration(target, documentId)` returning `getBaseline()`, `close()`, and `abort()` with the exact result/error contract in the spec.
- Produces: `clickCountCalibrationFunctionDeclaration()` returning a self-contained `function(documentId)` declaration for `Runtime.callFunctionOn`, using `this` as the target. Pass the label through CDP `arguments`, not source interpolation.

- [x] **Step 1: Write failing behavioral tests in `tests/tools/click-count-calibration.test.mjs`.**

Use a small controlled window/document/counter/element fixture to exercise lifecycle rules. Cover these assertions, not only source-string snapshots:

```js
assert.equal(result.status, "collected");
assert.equal(result.clickDelta, 1);
assert.equal(result.diagnosticOnly, true);
assert.equal(result.formalStatus, "unavailable");
assert.deepEqual(result.reasons, []);
assert.equal(collector.close(), result);
assert.equal(collector.abort(), result);
assert.equal(collector.getBaseline(), baseline);
assert.ok(Object.isFrozen(result.before.counters));
assert.ok(Object.isFrozen(result.clicks[0]));
```

Add explicit cases for untrusted click, foreign target, two/three clicks and bounded overflow, no click, click-counter mismatch, decreasing/unsafe/missing/throwing/over-64/invalid-key counters, non-local origin, initial hidden/disconnected target, target removal/reparenting, document/performance/counter replacement, pagehide/visibility loss, clock inversion/change, invalid event numbers, abort-before-close, and partial listener-install failure. Check no final read of a replacement document; assert listener counts are restored on every close/abort/error path. Boundary-equal clock values are accepted, while event timeStamp is not treated as a latency measurement.

- [x] **Step 2: Run RED.**

Run: `node --test tests/tools/click-count-calibration.test.mjs`

Expected: the new collector/import is missing or its required behavior fails. Save focused output in the plan workspace; do not alter existing tests to manufacture RED.

- [x] **Step 3: Implement the two exports with the exact spec contract.**

Keep browser state only in the returned object's closure, no page globals. Validate the baseline before installing listeners. Freeze defined payload levels; never serialize browser objects or exception contents. Clean up partial installation before throwing. Cache the first close/abort result. Return null final snapshot/delta if identities changed or snapshot reading failed. Do not compute durations or accept supplied trace counts/proof flags.

- [x] **Step 4: Verify actual browser serialization and EventCounts behavior.**

In the same node:test file, use the existing Playwright dependency with an owned ephemeral HTTP loopback fixture and isolated headless Chromium. Reuse one owned browser, close contexts/server/browser in cleanup even on assertion failure, and never attach to installed user browsers. Evaluate the generated declaration on a plain-text target button. A Playwright target click must produce `isTrusted: true`, exact target match, counter delta one, and normal application handler execution. An explicit `dispatchEvent` must produce an invalid untrusted result. Closing must stop collection, keep cached results unchanged, and leave application handling functional. Clearly name these tests synthetic.

- [x] **Step 5: Run focused GREEN, wire the test into the existing gate, and self-review.**

Run: `node --test tests/tools/click-count-calibration.test.mjs`

Expected: every behavioral and synthetic-browser case passes; no skipped required browser checks. Inspect the module for Node/module-scope references inside serialized code, privacy leaks, DOM mutation, event suppression, unbounded records, and modifications to unrelated source. Format only the touched files with the installed formatter.

- [x] **Step 6: Run the required repository gate once.**

Run: `npm run check`

Expected: exit zero. Record exact test counts, skips, existing warnings, and any failure. Do not install dependencies or restart a still-live check merely because an observation timed out. Do not repeat the full suite on unchanged passing code.

- [x] **Step 7: Commit only the intended files and report for independent review.**

Commit message: `Add bounded same-document click-count calibration`

Stage only the new module/test, package.json, spec, and plan. Use the repository's configured easysun author identity; leave pre-existing HANDOFF.md unstaged. Report commits, focused RED/GREEN and full-gate evidence, native invocation examples, limitations, and concerns in the plan workspace. The controller performs task review and whole-branch review before pushing/creating a PR targeting main. This task does not include production deployment or a new phone capture.
