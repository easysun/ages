# Formal Performance Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Review handoff:** Root independently reviews this design and plan before source work. Root reviews the exact synthetic method-pilot scope before any new capture. This plan does not authorize physical phone capture.

**Goal:** Add offline, auditable percentile and trace-qualification reporting, then discover a valid Chromium input-to-next-paint method without closing the physical-device gate.

**Architecture:** First probe the existing trace category/data shape and pinned source flow before implementing quantiles. Then extend the dependency-free analyzer with explicit sample groups, nearest-rank summaries, active-window frame intervals, and a legacy EventTiming diagnostic. After the reviewed local Playwright Chromium pilot establishes real record shapes, add only correlations proven by exact flow/typed IDs and pinned source semantics.

**Tech Stack:** Node.js 22, existing `node:test`, existing `@playwright/test`, existing Chromium trace analyzer. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-14-formal-performance-protocol-design.md`

## Execution status

The offline protocol summaries and exact discrete-entry crosswalk passed independent review and 56 parser/CLI tests. After the bounded group-lifetime repair passed 31 runner tests, Capture05 completed all 14 actions, preserved 14 loss-free raw traces, and exited successfully. Both open frame segments and the 10,000-item resize segment remain unavailable; 11 segments resolved. All formal action metrics and physical-device acceptance remain open. The full repository gate is pending.

## Global Constraints

- Keep `input-to-presented-frame` separate from formal `input-to-next-paint`; no equivalence claim without exact identity and endpoint evidence.
- Use nearest-rank quantiles, 120 scheduled repetitions per same device/browser × workload × action cell, at least 100 qualified input samples, and at least 100 qualified frame intervals across 100 valid trials as defined in the spec. The 120 repetitions are a chosen repeatability convention, not a statistically derived guarantee.
- Preserve raw traces byte-for-byte and report SHA-256; never check in pilot traces or product media.
- Frame intervals require exact frame IDs, renderer/layer stream identity, a declared action, and one explicit active window. Preserve per-session counts; pool only the three sessions within that same cell.
- The already-authorized method pilot is local synthetic Playwright Chromium only. Root's written review is a quality gate for the runner and exact scope, not a request for another user authorization. Do not capture a phone, use `chrome://inspect`, ADB, CDP for phone access, another browser, or install an SDK.
- Do not call hardware evidence complete until the full physical Mac and Samsung S25 Ultra matrix passes.

## Review Focus

- Existing legacy EventTiming endpoints may be fallback times; test that missing fallback proof produces no formal N2P sample.
- Exact flow/event IDs may be absent or ambiguous; test that no timestamp-proximity fallback creates a join.
- Event Timing observer output is thresholded and excludes continuous events; retain censored, missing, and unsupported counts rather than treating them as zero.
- Frame intervals can bridge idle periods or streams; test explicit active-window and exact stream boundaries.
- Quantiles can be misleading for small or pooled groups; test the 100-sample gate, nearest-rank indexes, same-cell pooling only, and `OBSERVED_ONLY` vs formal completeness.

---

### Task 1: Probe trace shape, then add offline percentile and active-window qualification

**Files:**
- Modify: `scripts/chromium-trace-metrics.mjs`
- Modify: `scripts/analyze-chromium-traces.mjs`
- Modify: `tests/tools/chromium-trace-metrics.test.mjs`
- Modify: `tests/tools/chromium-trace-cli.test.mjs`

**Interfaces:**
- `nearestRank(values, percentile)` accepts finite nonnegative values and percentile `0.5` or `0.95`; it returns the observed value at one-based rank `ceil(percentile * n)`, or `null` for an empty list.
- Optional `protocolGroups` contain 1–56 cells. Each contains only fixed `deviceKey`, `browserKey`, `workload`, canonical `action`, `plannedTrials: 120`, three sessions of 40, and up to 120 non-valid trial entries. Mac permits Brave; S25 Ultra permits the three requested browsers. Cell keys and session/trial references must be unique. Reasons are `NOT_CAPTURED` or `UNSUPPORTED_INPUT` for `missing`; `TRACE_TRUNCATED` or `ACTION_INCOMPLETE` for `censored`; `TRACE_DATA_LOSS`, `AMBIGUOUS_CORRELATION`, or `MALFORMED_TRACE` for `invalid`. Omitted trials without linked segments are missing. Manifest fields cannot assert valid samples or provide timing values.
- A protocol-linked segment identifies its group index, session, and trial and requires one or more bounded, non-overlapping `activeWindows: [{ id, startUs, endUs }]`, exact action and trace, and renderer/layer/frame-source identity. Each segment may have at most 120 windows; one manifest may have at most 6,720 measurement segments. Fully consistent duplicate records for an exact frame pair, endpoint, renderer, compositor stream, and presented state count once. Conflicting endpoint/stream reuse or reuse across active-window/trial contexts invalidates all affected linked trials as `invalid/AMBIGUOUS_CORRELATION` and discards their intervals without bridging. Malformed identities/endpoints map to `invalid/MALFORMED_TRACE`, trace loss or unknown loss state to `invalid/TRACE_DATA_LOSS`, and no matched reporter to `missing/UNSUPPORTED_INPUT`. Derived and manifest-declared statuses share exactly 120 planned group trials and 40 per session; no extra unqualified status bucket is reported. Linked active windows in the same trace cannot overlap, preventing duplicate frame use.
- Group by exact device/browser × workload × action. Preserve session diagnostics; pool only the three sessions within the same cell. Report frame interval p50/p95 only when the cell has at least 100 qualified trials and 100 intervals. Below either floor, omit percentiles and report `NO_ADJACENT_PRESENTED_FRAME` and/or `INSUFFICIENT_VALID_SAMPLES`. With enough values, label summaries `observed-only` and retain source-completeness reasons; this implementation does not declare formal completeness. Never extend gestures, active windows, or idle periods to meet a floor.
- Every group keeps `input-to-next-paint` unavailable with `NEXT_PAINT_METHOD_UNPROVEN`; existing input-to-presented-frame diagnostics cannot supply its samples.

- [x] **Step 1: Read existing trace shape before metric implementation.** Read the two current pilot files read-only; record raw hashes, enabled categories, and sanitized counts only. Confirm both have legacy EventTiming B/E spans and zero `cat == latency` records. Check the pinned-source expected shapes: `EventCreation`/`EventEndTime` on the primary event flow; `EventProcessing` latency with `fallback_reason`, `fallback_time`, and `ChromeTrackEvent.event_timing`; and `EventsInAnimationFrame`/`EventPresentation`/`EventFallbackTime` joined by frame flow and typed `frame_index`. Do not print event arguments. Write down which fields can and cannot be tested from these old traces before proceeding; they cannot qualify a next-paint sample.
- [ ] **Step 2: Add failing tests** for nearest-rank values at `n=1`, `n=100`, and `n=120`; ties; invalid values; empty groups; `validCount=99` versus `100`; disjoint valid/missing/censored/invalid counts; `OBSERVED_ONLY` versus formal completeness; session diagnostics; and action/browser/workload groups that must never pool.
- [x] **Step 3: Add failing frame tests** with adjacent presented frames inside one active window, an idle gap split across two windows, exact same-stream identity, and a second renderer/layer stream. Test the 100-interval and 100-valid-trial thresholds, `NO_ADJACENT_PRESENTED_FRAME`, and assert no interval bridges a window or stream.
- [ ] **Step 4: Run** `node --test tests/tools/chromium-trace-metrics.test.mjs tests/tools/chromium-trace-cli.test.mjs` and confirm the new assertions fail.
- [ ] **Step 5: Implement** the pure nearest-rank and per-group summary in the existing analyzer, validate active-window bounds, and emit explicit unavailable/insufficient-sample reason codes. Keep current pilot output diagnostic and do not add formal percentiles to it.
- [ ] **Step 6: Rerun** the focused Node tests and require all quantile, sample-status/count, no-pooling, active-window, and stream-identity assertions to pass.

### Task 2: Inventory existing EventTiming records without qualifying them

**Files:**
- Modify: `scripts/chromium-trace-metrics.mjs`
- Modify: `scripts/analyze-chromium-traces.mjs`
- Modify: `tests/tools/chromium-trace-metrics.test.mjs`
- Modify: `tests/tools/chromium-trace-cli.test.mjs`

**Interfaces:**
- Add a sanitized EventTiming inventory containing legacy begin/end counts, latency-category event count, EventProcessing count, fallback status, and reason codes; never return raw arguments.
- Legacy EventTiming spans without exact modern fallback evidence receive `LEGACY_EVENT_TIMING_FALLBACK_UNKNOWN` and contribute zero formal input-to-next-paint samples.
- Read the existing ignored `.sdd/desktop-trace-pilot` files read-only. Do not add them to tests or rewrite them.

- [ ] **Step 1: Add synthetic trace tests** for legacy EventTiming with no fallback evidence, sanitized field inventory, and same-time legacy spans that remain unqualified. Do not invent modern latency fixtures before the method pilot reveals the actual record shape; do not infer modern fallback from event name or timestamp.
- [ ] **Step 2: Run** `npm run test:trace-metrics` and confirm these cases fail before the analyzer change.
- [ ] **Step 3: Inspect the current two pilot traces read-only** through the analyzer. Confirm their EventTiming inventory is diagnostic because `latency` fallback evidence is absent; report counts and existing raw hashes without printing or copying event arguments.
- [ ] **Step 4: Implement** the sanitized inventory and explicit unsupported diagnostics. Keep EventTiming values out of formal percentile groups until endpoint semantics are established.
- [ ] **Step 5: Rerun** `npm run test:trace-metrics`; confirm the current pilot remains diagnostic, the trace hashes are unchanged, and no formal p50/p95 is emitted.

### Task 3: Run the bounded synthetic Chromium method-discovery pilot

**Review gate:** Root reviews the runner and exact synthetic-only capture scope before execution. This uses the already-authorized local Playwright Chromium workflow; no additional user authorization is requested. No physical device or phone connection is included.

**Files:**
- Create: `scripts/capture-chromium-method-pilot.mjs`
- Create: `tests/tools/chromium-method-pilot.test.mjs`
- Modify: `scripts/analyze-chromium-traces.mjs`
- Modify: `package.json`

**Interfaces:**
- Launch only the existing local app and Playwright Chromium; use synthetic fixtures of exactly 100 story items and 10,000 chronological records. Open starts with the actual Timeline route activation for both workloads, retaining the initial chronological projection fetch and index build. For 10,000 records, activate Chronological after projection readiness as an explicitly separate secondary input/render window; do not mix that input into primary open next-paint samples or report a preloaded mode switch as cold opening. Final 10k completion requires the overview to be visible. Controlled delayed projection responses belong only to this synthetic method pilot, not physical benchmark samples.
- Capture one method-discovery repetition per action and workload, not percentile evidence. Record `open`, `fit-all`, `pan`, `zoom`, `resize`, `append`, and `scroll` separately, including a delayed open and append completion marker.
- Probe category availability and payload shapes before relying on them. Enable and retain the Chromium `latency`, `devtools.timeline`, input/scroll, and PipelineReporter trace categories needed to inspect primary event flows, `EventProcessing` and its `ChromeTrackEvent.event_timing` proto, `EventFallbackTime`, frame flows, input, and presentation records. Record exact categories, event names, typed IDs/flow fields, and browser binary version in the manifest. Never join by event name or nearest timestamp.
- Write a new local run directory with raw trace SHA-256, capture-time metadata, action/active-window segments, trace-loss status, and no product data. Fail rather than overwrite an existing run.

- [ ] **Step 1: Add tests** for safe output directory creation, trace-preserving hashes, one explicit action segment per stimulus, separate completion markers for open/append, and rejection of missing capture-time browser/version metadata.
- [ ] **Step 2: Run** `node --test tests/tools/chromium-method-pilot.test.mjs` and confirm the pilot runner is not yet present.
- [ ] **Step 3: Implement** the local synthetic runner using the repository's existing Playwright dependency. Do not add a phone target, remote-debugging path, new browser, or SDK setup.
- [x] **Step 4: After root's written scope review, run** one capture set for both fixture sizes and the seven actions. Preserve each raw trace unchanged and record digests before analysis.
- [x] **Step 5: Verify** the run manifest, hashes, and all expected action records; label the output `synthetic-method-pilot`, never hardware evidence.

### Task 4: Prove or reject trace input-to-next-paint correlations

**Files:**
- Modify: `scripts/chromium-trace-metrics.mjs`
- Modify: `scripts/analyze-chromium-traces.mjs`
- Modify: `tests/tools/chromium-trace-metrics.test.mjs`
- Modify: `tests/tools/chromium-trace-cli.test.mjs`
- Create: `tests/fixtures/chromium-traces/event-timing-fallback.trace.json`
- Create: `tests/fixtures/chromium-traces/continuous-input.trace.json`

**Interfaces:**
- Pin the examined Blink implementation to the exact Chromium source revision and record the pilot binary version. Parse legacy `EventTiming` and only observed `EventCreation`, `EventEndTime`, `EventProcessing`, `EventPresentation`, `EventFallbackTime`, `EventsInAnimationFrame`, input-latency, and PipelineReporter shapes observed in that pilot. EventFallbackTime is source-known but absent from the pilot; do not invent payload support for it.
- Implement the observed discrete-entry crosswalk in the spec: exact binary64 inversion of legacy relative timestamps, consistent explicitly scoped origin, and bidirectionally unique modern/legacy identity tuples. Exported pointer flows and frame_index are absent; do not invent them. Require explicit no-fallback evidence before treating the legacy end as presentation.
- Preserve exact integer identities and signed-int32/uint32 interaction normalization only. Reject ambiguous tuples, inconsistent origins, incomplete slices, unknown fields/encodings, fallback contradictions and unequal endpoints. An independently complete entry can remain diagnostic beside an incomplete frame group, but group-dependent aggregation cannot qualify.
- Add sanitized diagnostic candidate counts/latencies and reasons before any formal action aggregation. Explicit document/window/stimulus attribution is required for action samples; continuous modalities cannot borrow incidental discrete entries. No manifest flag or supplied duration can assert proof.
- Keep `input-to-presented-frame` as a separately named metric. Continuous pan/scroll/zoom inputs may produce a diagnostic input-to-presented-frame sample only when their exact input and frame correlations qualify; this does not prove N2P equivalence.

- [x] **Step 1: After the pilot reveals real payloads, add tests** for exact EventTiming-to-modern-entry association, explicit fallback rejection, explicit no-fallback candidate, duplicate identity rejection, binary64 decimal-tail inversion, scoped origin, signed interaction normalization, observed unequal processing endpoints and incomplete-group handling, and absence of event-name or timestamp-proximity joins.
- [x] **Step 2: Add continuous-input cases** for exact input identity to EventLatency, both frame IDs, unique `STATE_PRESENTED_ALL` reporter, active-window attribution, and unavailable records when the browser omits the required source.
- [x] **Step 3: Implement only the event forms present in the reviewed pilot** and report source-specific counts, qualified samples, and unsupported reasons. Do not add `nearestPaint` or infer an endpoint from `commitFinishTime`.
- [x] **Step 4: Run** `npm run test:trace-metrics` and the offline analyzer on the synthetic method-pilot traces. Require either exact proof for a supported event shape or an explicit rejection; neither result may be substituted with a nearby timestamp.
- [x] **Step 5: Review the report** and keep the formal N2P gate open for every browser/action group lacking a complete validated source.


**Verified status:** The six Task 4 paths passed independent scoped closure with 56 parser/CLI tests. Capture02 analysis preserves all 14 raw digests and reports 42 diagnostic candidates, with every formal action result unavailable. The exact crosswalk and strict source-shape guards are supported; physical completeness and action attribution remain open. Bounded runner verification passed; the full repository gate is still pending.

## Separate physical evidence gate

After method review, a separately scoped capture task must complete the full Mac and Samsung matrix and the 120 scheduled repetitions per group. Phone traces and capture-time metadata must be supplied through the supported user workflow. Do not use this plan to access the phone or to mark any physical-device requirement complete.

## Final verification and review gate

Before any source commit, run `npm run check` on the completed change and obtain an independent written review of the implementation and generated reports. Fix review findings and rerun the affected checks plus the full check. Record validation and keep the hardware gate open unless its separate evidence requirements pass. This plan does not include committing, publishing, or closing the physical-device gate.
