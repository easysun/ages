# Offline Chromium Trace Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Review handoff:** Root independently reviews the written design and plan before source work. The user waived further human design/spec/plan approval steps and requested GPT-6 Luna/Max implementation; root remains the reviewer.

**Goal:** Add a local-only Node.js tool that losslessly correlates the accepted Chromium pilot trace shape and reports diagnostic samples for later Task 6 measurement work.

**Architecture:** Keep trace parsing and event correlation in a pure importable module, with a small CLI responsible for reading the manifest and raw traces and emitting a summary report. Use exact integer identity values from Node.js 22 reviver source text, strict scoped async-slice pairing, and explicit measurement-segment and stream declarations for any frame interval.

**Tech Stack:** Node.js 22.22.2, native JSON.parse reviver context.source, Node built-ins, node:test. No new dependencies.

**Spec:** docs/superpowers/specs/2026-10-14-desktop-trace-metrics-design.md

## Global Constraints

- Require Node.js >=22.22.2 <23 and use the committed npm lockfile.
- Read raw trace and manifest inputs only; preserve original bytes and report each trace SHA-256.
- Use Node built-ins only. Do not launch a browser, app server, test server, Cloudflare command, or network request.
- Preserve known int64 trace identity fields with JSON.parse reviver context.source and BigInt; keep decimal measurements numeric.
- Pair only the verified pilot b/e profiles. The normal profile requires matching PID, TID, category, id2.local namespace, exact ID, and event name; the track key excludes event name so differently named nested stages can be children on the same track. The sole top-level-id exception is a completed InputLatency::MouseUp b/e pair with matching PID/TID/category/name and exact hexadecimal string ID, in its own typed namespace. Require unique interval containment and parent-occurrence ownership. Diagnose cross-thread/cross-process b/e lifetime migration, id2.global, and all other top-level-id forms. Permit the specific cross-process event correlation from MouseUp `chrome_latency_info.trace_id` to EventLatency `event_latency.event_latency_id`; that does not enable cross-process span pairing or generic global-ID joins.
- Report only diagnostic samples and counts. Do not compute p50/p95, FPS, or formal Task 6 results from the pilot.
- Never copy, stage, commit, or rewrite the ignored .superpowers pilot artifacts.
- Keep the actual desktop with an explicitly named browser and Samsung Galaxy S25 Ultra Chrome, Samsung Internet, and Brave evidence gate open for both dataset sizes and every required action.

## Review Focus

- Unsafe 64-bit identity values must remain exact while fractional vsync_interval_ms remains a number; pin this in Task 1.
- Sequential reuse of id2.local and equal values in another scope must not cross-pair; pin this in Task 1. The verified MouseUp top-level-hex-id profile and exact cross-process MouseUp/EventLatency field join must work; other cross-thread/cross-process b/e pairs and unverified ID forms must produce unsupported-shape diagnostics, not imply generic Chromium async-event support.
- Missing, duplicate, overlapping-ambiguous, malformed, or unterminated b/e pairs must yield diagnostics and no qualified sample; pin this in Task 1.
- Submit/Swap children must be uniquely contained in the matched EventLatency occurrence on its same scoped track, using timestamp and original traceEvents array order to resolve equal timestamps. Same-time stages ordered after the parent close or on another track cannot be borrowed; the matched reporter endpoint must come from its own independently paired occurrence. Pin these ownership failures in Task 1.
- A nearby FRAME_SWAP or partial match on only one frame ID must not substitute for the exact EventLatency and unique closed STATE_PRESENTED_ALL correlation; pin this in Task 1.
- A frame interval must stay within one declared action segment and renderer/layer stream; assert the two-stream 10,000-item fixture does not produce a cross-stream interval in Task 2.

---

### Task 1: Parse and correlate the accepted Chromium event shape

**Files:**
- Create: scripts/chromium-trace-metrics.mjs
- Create: tests/tools/chromium-trace-metrics.test.mjs
- Create: tests/fixtures/chromium-traces/exact-ids.trace.json
- Create: tests/fixtures/chromium-traces/reused-local-ids.trace.json
- Create: tests/fixtures/chromium-traces/partial-presentation.trace.json

**Interfaces:**
- Export parseTrace(text) -> TraceDocument from scripts/chromium-trace-metrics.mjs. Accept a JSON object containing traceEvents; preserve known integer ID token source exactly as BigInt and leave unrelated numbers unchanged.
- Export analyzeTrace(trace, traceRecord, segments = []) -> TraceAnalysis. Return sanitized counts, candidate diagnostics, qualifying input-to-presented-frame samples in microseconds, and frame-interval qualification state; never return raw event args.
- Support only the verified pilot b/e profiles. The general pair requires the same pid, tid, category, id2.local namespace, exact ID, and event name. The track key is pid, tid, category, namespace, and exact ID; event name is the span-occurrence match property, excluded from the track key to permit differently named nested children. Require unambiguous same-track interval containment to assign parent ownership. The only top-level-id exception is a completed InputLatency::MouseUp b/e pair with matching pid, tid, category, name, and exact hexadecimal string ID, in its own typed namespace. Cross-thread/cross-process b/e lifetime migration, id2.global, and other top-level-id forms are unsupported diagnostics. The exact chrome_latency_info.trace_id to event_latency.event_latency_id join may cross process only for the independently paired MouseUp and EventLatency occurrences.
- Current-pilot correlation uses InputLatency::MouseUp chrome_latency_info.trace_id, EventLatency event_latency.event_latency_id and frame IDs, and PipelineReporter args.frame_reporter data.

- [ ] **Step 1: Add synthetic raw JSON fixtures and failing behavior tests.** Include an integer literal beyond 2^53 in each supported trace ID field, a fractional vsync_interval_ms, sequential reuse of the same local ID, a process/category/ID-namespace collision, incomplete and duplicate b/e pairs, a trace entry with unknown data-loss status, and a valid same-scope MouseUp/EventLatency/STATE_PRESENTED_ALL chain with nested differently named stage spans. Model the accepted MouseUp as a completed b/e pair with its top-level hexadecimal string ID, and let the exact trace-ID field correlation cross process while keeping each b/e pair same-thread. Add same-time Submit/Swap spans on another track and assert they cannot be borrowed by the matched EventLatency occurrence. Assert exact IDs, unchanged decimal measurements, counts, unique identity matches, exact endpoint equality, reporter endpoint ownership, and diagnostic rejection of unsupported or loss-unqualified shapes, including cross-thread/cross-process b/e migration and global/other top-level ID forms.

- [ ] **Step 2: Run the focused Node tests and confirm the behavior is missing.**

  Run: node --test tests/tools/chromium-trace-metrics.test.mjs

  Expected: tests fail because the parser and analyzer exports do not exist.

- [ ] **Step 3: Implement exact ID parsing and scoped async-slice pairing.** Use the third JSON.parse reviver argument only for the named integer identity fields. Require integer source text for numeric IDs; preserve string IDs with their namespace. Pair only the verified pilot profiles, including the narrow same-thread top-level-hex-id exception for InputLatency::MouseUp. Keep event name in the span-occurrence key but out of the track key; require same-track, unambiguous nested intervals to establish parent ownership. Diagnose unsupported cross-thread/cross-process b/e lifetime migration, global and other top-level ID forms, duplicates, overlap ambiguity, malformed IDs, and missing endpoints. Keep the specific cross-process MouseUp/EventLatency exact-field correlation separate from span pairing.

- [ ] **Step 4: Implement the MouseUp correlation and exact presentation proof.** Require a unique completed MouseUp-to-MOUSE_RELEASED EventLatency match by exact 64-bit ID; require the state and both frame IDs to come from one independently paired STATE_PRESENTED_ALL PipelineReporter occurrence. Require that reporter's own close endpoint to equal the EventLatency endpoint. Require SubmitCompositorFrameToPresentationCompositorFrame and terminal SwapEndToPresentationCompositorFrame to be uniquely contained child occurrences of the exact matched EventLatency on the same scoped track, with the terminal child ending at the parent endpoint. Resolve equal timestamps by original traceEvents order; reject stages ordered after the parent close, stages on another track, or stages from a sibling occurrence. Any reporter-stage data used must be contained in and attributed to that exact reporter occurrence. Emit only the individual input-to-presented-frame duration in microseconds. Do not label it input-to-next-paint.

- [ ] **Step 5: Run the focused Node tests and confirm they pass.**

  Run: node --test tests/tools/chromium-trace-metrics.test.mjs

  Expected: exact ID, same-scope pairing, reuse, input correlation, endpoint, malformed-shape, and no-fallback cases pass.

### Task 2: Qualify presentation intervals by explicit segment and stream

**Files:**
- Modify: scripts/chromium-trace-metrics.mjs
- Modify: tests/tools/chromium-trace-metrics.test.mjs
- Modify: tests/fixtures/chromium-traces/partial-presentation.trace.json

**Interfaces:**
- Consume TraceDocument and TraceAnalysis from Task 1.
- Each measurementSegments entry has trace basename, an action from `open`, `fit-all`, `pan`, `zoom`, `resize`, `append`, or `scroll`, startUs, endUs, rendererPid, layerTreeHostId, and frameSource. Bounds are half-open: startUs <= frame endpoint < endUs. Reject other action values with `INVALID_MEASUREMENT_SEGMENT` and omit them from report samples.
- Use the stream key (renderer PID, layerTreeHostId, frameSource). A report with no segment or incomplete stream identity contains no qualified frame interval values.

- [ ] **Step 1: Add failing tests for segmented same-stream intervals.** Build synthetic reporters on two renderer/layer streams, adjacent frames within one segment, a separate segment after an idle period, and a second action. Assert exact surface/display frame-pair identity, only adjacent frames within one declared segment and stream produce raw interval samples, and no interval bridges streams, segments, actions, or a missing segment declaration. Do not infer an idle threshold.

- [ ] **Step 2: Run the focused Node tests and confirm the interval gate fails.**

  Run: node --test tests/tools/chromium-trace-metrics.test.mjs

  Expected: the analyzer currently has no segment-qualified interval behavior.

- [ ] **Step 3: Add distinct presented-frame selection and interval qualification.** Use only closed STATE_PRESENTED_ALL reporters with complete stream identity and manifest-confirmed loss-free traces. Use reporter close timestamps as presentation endpoints, then keep each sample's endpoints in the same half-open segment and stream. Report unsupported or missing segment/loss fields as reason codes; never substitute timestamps from another stream or infer an idle threshold.

- [ ] **Step 4: Run the focused Node tests and confirm the interval gate passes.**

  Run: node --test tests/tools/chromium-trace-metrics.test.mjs

  Expected: the two-stream regression excludes cross-stream intervals and all missing-segment cases return no qualified series.

### Task 3: Add the safe offline CLI and report

**Files:**
- Create: scripts/analyze-chromium-traces.mjs
- Create: tests/tools/chromium-trace-cli.test.mjs
- Modify: package.json

**Interfaces:**
- CLI syntax: node scripts/analyze-chromium-traces.mjs <manifest.json> [--out <new-report.json>].
- Read trace entries relative to the manifest directory and accept basename-only .trace.json paths. Reject traversal, invalid JSON, invalid manifests, and non-regular trace files.
- Without --out, emit the complete sanitized JSON report on stdout. With --out, create the report exclusively and fail if any destination already exists.
- Add npm run test:trace-metrics using Node's built-in test runner, and include it in npm run check without changing the existing test commands.

- [ ] **Step 1: Add failing CLI tests.** Assert that the manifest's traces are analyzed read-only; the output includes digests, selected environment metadata, counts, sample units, and reason codes but no raw args or database ID; a traversal path fails; an existing output and output symlink are never replaced; and malformed inputs produce no partial report.

- [ ] **Step 2: Run the focused CLI tests and confirm they fail.**

  Run: node --test tests/tools/chromium-trace-cli.test.mjs

  Expected: the CLI and npm script are missing.

- [ ] **Step 3: Implement the CLI and exclusive output.** Resolve only basename trace entries beside the manifest, hash raw file bytes before analysis, and use Node built-ins for file access and SHA-256. Write no files unless --out is supplied; create that destination with exclusive-create semantics. Never import capture.mjs or invoke child processes, browser, server, or network code.

- [ ] **Step 4: Add the focused Node test command to package.json and the full check.** Keep the new command separate from test:recovery-drill and add it once to check.

- [ ] **Step 5: Run both focused Node suites.**

  Run: node --test tests/tools/chromium-trace-metrics.test.mjs tests/tools/chromium-trace-cli.test.mjs

  Expected: parser, correlation, frame interval, CLI safety, report privacy, and no-overwrite checks pass.

### Task 4: Check the immutable pilot and preserve formal evidence gates

**Files:**
- Verify: scripts/analyze-chromium-traces.mjs
- Verify: scripts/chromium-trace-metrics.mjs
- Verify: the existing ignored run manifest and two trace files, read-only

**Interfaces:**
- Consume the Task 3 CLI. Print the report to stdout; do not set --out for this pilot run.
- Expected original SHA-256 values are f400d2860720723ab4f39b4f69c8a56109f862c50b46f48c93ffca11fceca2b4 for 100-item.fit-all.trace.json and bc9096de6b182eb1415aa138b66cb6debd3dfaa2511578d1ff39a780276151dc for 10k-item.fit-all.trace.json.

- [ ] **Step 1: Run the offline analyzer against the existing local manifest.**

  Run: node scripts/analyze-chromium-traces.mjs .superpowers/sdd/desktop-trace-pilot/runs/run-1791936963852-92c6e62d-1e93-4489-ac57-640940ccfa14/manifest.json

  Expected: two diagnostic-only traces; 1,447 and 2,305 events; three EventLatency pairs and one exact MouseUp sample per trace; five and eight closed PipelineReporter pairs; two and five STATE_PRESENTED_ALL records; three STATE_NO_UPDATE_DESIRED records per trace; endpoint agreement for each diagnostic sample; no qualified frame interval series because the manifest has no measurement segment; no percentiles.

- [ ] **Step 2: Recompute the two raw SHA-256 values and confirm both are unchanged.** Any digest difference blocks completion; do not repair or overwrite the pilot.

- [ ] **Step 3: Run the new focused suites and the repository check required for a source change.**

  Run: npm run test:trace-metrics

  Run: npm run check

  Expected: both pass. Reuse a full check only when no source changed after that passing check.

- [ ] **Step 4: Record the evidence gate as open in the implementation review.** The current pilot uses synthetic input and preflight-only hardware metadata, has no declared action measurement segments, and does not prove input-to-next-paint equivalence. Do not report p50/p95 or mark Task 6 complete.

- [ ] **Step 5: After the integrated `npm run check` passes, review and commit all source, tests, package metadata, and plan/spec documentation together.** Do not create intermediate commits for Tasks 1–3; the repository check is the required pre-commit gate for the complete change. Reuse that passing check only if no source changes follow it.

## Follow-up evidence work after tool review

- The measurement owner and performance reviewer define the formal input-to-next-paint event method and decide whether the diagnostic input-to-presented-frame sample can satisfy it.
- Before any named-device capture, they set a minimum valid sample count for each dataset, device/browser, action, and metric group. The analyzer reports counts; it does not choose a sample threshold.
- A separate authorized capture task records explicit boundaries for open, Fit all, pan, zoom, resize, append, and scroll, plus renderer PID, layerTreeHostId, and frameSource per measurement segment. This plan does not implement capture.
- Run the full 100-item interactive and 10,000-item chronological cases on the actual physical desktop with a named browser and on Samsung Galaxy S25 Ultra with Chrome, Samsung Internet, and Brave. Retain raw loss-free traces, environment metadata, mounted-media counts before and after scrolling, and reviewed p50/p95 values. Keep every required device, browser, dataset, and action gate open until the complete evidence has been reviewed.
