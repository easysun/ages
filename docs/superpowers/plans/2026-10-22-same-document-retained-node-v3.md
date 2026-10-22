# Same-Document Retained Node Evidence, Version Three Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement these tasks task-by-task, with focused review checkpoints and one combined branch review.

**Goal:** Add an explicit diagnostic-only v3 path that tests exact retained-node identity across one root loading event and one same-document history navigation.

**Architecture:** Extend the existing browser sidecar, CDP lifecycle tracker, capture runner, and analyzer contracts; keep v1/v2 behavior and historical fingerprints intact. V3 remains provisional until post-trace identity proof and lifecycle cleanup close, then writes an immutable sidecar, manifest, and manifest-bound cleanup receipt for CLI analysis.

**Tech Stack:** Node.js 22, Playwright, Chrome DevTools Protocol, Node test runner, existing Ages trace analyzer.

**Spec:** `docs/superpowers/specs/2026-10-22-same-document-retained-node-v3-design.md`

## Global Constraints

- V3 is opt-in, diagnostic-only, and bound only to exact profile `brave15585`; formal samples and action-segment output remain unavailable.
- Preserve the observed Brave bundle/runtime revision and executable hash; keep `chromiumSourceIdentity` unverified and make no source-attestation claim.
- Preserve v1/v2 declarations, sidecars, outputs, and every historical accepted fingerprint; keep all fingerprints finite and reviewed.
- Allow only one root loading callback received after the acknowledged before-input marker and tracker phase update, followed by one root historyApi callback; this is receipt order only.
- The lifecycle journal reports `orderingBasis: "cdp-receipt"` and `sourceOrder: "unknown"`; receipt sequence never proves source time or causality, including for a delayed callback.
- Select v3 with `retainedNodeEvidenceVersion: 3` in observer and tracker APIs; default retained-node version 2 output stays unchanged.
- Keep the exact saved document/root/target, default unique context, root frame/loader, selected target/session, and trace PID/node gates; raw positive `EventTiming.nodeId` must equal the retained positive backend ID.
- Bind `retainedTargetProof` to the exact trusted DOM click record and existing mapping; only a post-trace, pre-release reference/CDP proof may qualify. Null or false required proof fields reject; final disconnected/detached booleans may be false.
- Monitor lifecycle through trace end, final pre-release identity proof, pending drain, and listener removal; any late fatal or unknown event invalidates a provisional pass.
- Keep the 256 KiB sidecar, 512-record, 32-node, 16 KiB mapping, and 128-event limits; never store URL, page text, headers, cookies, DOM descriptions, arbitrary protocol payloads, or error stacks.
- Use no new dependencies, retries, extra actions, delays, idle windows, or app/fixture source changes; preserve raw artifacts and failures.

## Review Focus

- Malformed, oversized, or sensitive witness fields must be rejected: `version three observation accepts only the closed loading witness schema` and `loading witness accepts 128 entries but rejects dropped and overflowed events` in Task 1.
- Missing, duplicate, reordered, wrong-phase, or foreign-frame lifecycle callbacks must invalidate, while delayed callbacks remain source-time unknown: `only the ordered root loading and historyApi pair is provisionally allowed` and `delayed lifecycle delivery never claims source-time order` in Task 2.
- Missing, false, or inconsistent source/final identity proof must reject without rejecting a correctly retained detached target: `v3 association requires singleton raw positive backend node equality and preserves API null` and the table-driven proof-field mutation case in Task 4.
- A fatal or unknown event during deferred cleanup must demote a provisional pass before final serialization: `late fatal and unknown CDP events after provisional pass make final v3 sidecar unavailable` in Task 3.
- Unknown hashes, altered sidecars, or absent/mismatched receipts must block analysis: `v1 and v2 historical and current fingerprints stay profile-bound` and `v3 CLI requires the actual manifest-bound run cleanup receipt before analysis` in Task 4.

---

### Task 1: Add the closed v3 browser observation schema

**Files:** Modify `scripts/browser-stimulus-observer.mjs`; test `tests/tools/chromium-method-pilot.test.mjs` and `tests/tools/retained-input-node-evidence.test.mjs`.

**Interfaces:** Keep `validateTrustedStimulusObservation(payload, expectedDocumentId)` and `writeTrustedStimulusSidecar({ directory, fixture, payload, frameProvenance })`; select v3 only through `installTrustedStimulusObserver(page, { retainInputNodes: true, retainedNodeEvidenceVersion: 3 })`. Add the exact schema-version-3 `sameDocumentLoadingWitness` keys from the spec, including `orderingBasis`, `sourceOrder`, and nullable `retainedTargetProof`; default version 2 remains unchanged.

- [ ] Add failing tests `version three observation accepts only the closed loading witness schema`, `loading witness accepts 128 entries but rejects dropped and overflowed events`, and `trusted DOM source proof binds capture scope to one record index` for `targetIsNode`, `ownerDocumentMatches`, `rootContainsTarget`, `connected`, and `composedPathStartsAtTarget`.
- [ ] Run the two focused test files and confirm the new cases fail before implementation.
- [ ] Extend observer capture and sidecar validation for schema 3 while leaving schemas 1 and 2 byte/behavior compatible; record owner-document, root-containment, connectivity, and composed-path scope synchronously before bubbling.
- [ ] Rerun both focused files; expect all existing and new tests to pass.

### Task 2: Add the lifecycle journal and final identity proof

**Files:** Modify `scripts/retained-input-node-evidence.mjs`; test `tests/tools/retained-input-node-evidence.test.mjs`.

**Interfaces:** Extend `createRetainedInputNodeEvidenceTracker({ page, pageSession, browserSession, timeoutMs, retainedNodeEvidenceVersion = 2 })`; v3 callers pass `retainedNodeEvidenceVersion: 3`, while default v2 results stay unchanged. Add `setPhase(phase)` and `captureFinalIdentityProof({ documentId, sourceRecordIndex, targetToken, mappingIndex })`; extend `finalize({ documentId, scope, observerCleanup, observerFailureReasonCode })` to return the closed v3 witness and cleanup evidence.

- [ ] Add failing tests `only the ordered root loading and historyApi pair is provisionally allowed`, `lifecycle witness rejects malformed, foreign, duplicate, and wrong-phase events`, `delayed lifecycle delivery never claims source-time order`, `loading witness preserves first invalidation at capacity`, and `late fatal and unknown lifecycle events demote provisional completion`.
- [ ] Run `node --test tests/tools/retained-input-node-evidence.test.mjs` and confirm the v3 cases fail.
- [ ] Implement bounded sanitized callback-receipt projection, phase/order/count gates, baseline and final CDP scopes, the exact target proof object, saved-reference comparison in the unique context, and drain/listener-removal closure. Keep source time unknown and the allowed receipt pair provisional; never relax other lifecycle gates.
- [ ] Rerun the focused file; expect all cases to pass with fatal-over-unknown precedence and no late-event pass.

### Task 3: Wire the single-case producer and prove cleanup races

**Files:** Modify `scripts/capture-chromium-method-pilot.mjs`; test `tests/tools/chromium-method-pilot.test.mjs`.

**Interfaces:** Add exact opt-in `--retain-input-nodes-v3`, valid only with `--run --browser=installed-brave --observe-inputs`; use a separate `.superpowers/sdd/same-document-retained-node-v3` artifact root and execute exactly `100-interactive/open`. Pass `retainedNodeEvidenceVersion: 3` to both observer and tracker. Add local `inspectTraceEpochBeforeInput(traceBytes, markerName)` returning only the proven root-frame/PID epoch and marker ordering; include all producer/collector inputs in the explicit source-hash list.

- [ ] Add failing tests `v3 runner option is exact and selects only the primary 100-item open`, `trace PID epoch is accepted only from raw trace ordering before the marker`, `v3 capture preserves references until post-trace proof and cleanup closure`, `delayed pre-marker lifecycle delivery remains source-order unknown`, and `late fatal and unknown CDP events after provisional pass make final v3 sidecar unavailable`. The race test holds fake CDP cleanup, lets provisional analysis pass, emits fatal or unknown before listener removal, then asserts the serialized final sidecar is unavailable.
- [ ] Run `node --test tests/tools/chromium-method-pilot.test.mjs` and confirm the v3 cases fail.
- [ ] Implement the one-case path: acknowledge the existing `TimeStamp` marker before setting tracker receipt phase; retain references through trace completion and offline PID/order checks; take the final proof before clearing/releasing; keep monitoring through drain and listener removal; write sidecar only after collector cleanup, then manifest, then actual-hash run receipt. Keep v1/v2 orchestration unchanged and make no source-time claim for delayed callbacks.
- [ ] Rerun the focused file; expect both fatal and unknown deferred-event variants to leave no complete v3 sidecar. Freeze all producer source files and the explicit input list after this task.

### Task 4: Add v3 analysis, receipt enforcement, and finite fingerprints

**Files:** Modify `scripts/chromium-trace-metrics.mjs` and `scripts/analyze-chromium-traces.mjs`; test `tests/tools/chromium-trace-metrics.test.mjs` and `tests/tools/chromium-trace-cli.test.mjs`.

**Interfaces:** Extend `analyzeTrace(trace, traceRecord, segments, sourceObservations, observerEvidence)` for the closed v3 schema and exact Brave 15585 profile. Require one eligible raw legacy contender with positive `nodeId === retained backendNodeId`; preserve API-target nullness and all existing v1/v2 gates. Require the actual manifest-bound cleanup receipt for v3 CLI analysis.

- [ ] Add failing tests `v3 association requires singleton raw positive backend node equality and preserves API null`, a table-driven `v3 rejects each missing, false, or inconsistent retained-target proof field` case, `v3 rejects identity and trace-order mismatches`, `v1 and v2 historical and current fingerprints stay profile-bound`, and `v3 CLI requires the actual manifest-bound run cleanup receipt before analysis`; cover altered sidecar bytes, ambiguous contenders, and unknown hashes. Accept `connected: false` and `rootContainsTarget: false` only in the final proof, with all other proof gates satisfied.
- [ ] Run the two focused test files and confirm the v3 cases fail.
- [ ] Implement v3 diagnostic-only output with formal/action segments unavailable. After Task 3's producer bytes are frozen, compute and register only the reviewed finite v3 hash plus any new default v1/v2 hashes required by shared-source changes; retain every historical entry and profile gate. Add tests proving unknown hashes still reject and default v1/v2 orchestration remains accepted under finite entries.
- [ ] Rerun both focused files; expect v1/v2 outputs unchanged, v3 exact association accepted only with complete proof, and receipt/hash failures rejected.

### Task 5: Verify, review, merge, and run the one controlled probe

**Files:** No further source changes unless a review finding requires them; preserve all run artifacts under the v3 artifact root.

- [ ] Run `npm run test:trace-metrics`; expect all trace, CLI, observer, producer, and tracker tests to pass.
- [ ] Complete one independent review of the full branch, resolve findings, then run `npm run check` once; if review changes source, rerun the checks affected by those changes and the full check before commit.
- [ ] Commit the complete feature once after the full check, open/review/merge its PR, and do not capture before merge and green checks.
- [ ] After merge, run exactly one synthetic capture with `node scripts/capture-chromium-method-pilot.mjs --run --browser=installed-brave --observe-inputs --retain-input-nodes-v3`; preserve failures and raw artifacts. Run `node scripts/analyze-chromium-traces.mjs <manifest.json> --out <new-report.json>` only after verifying the final sidecar, manifest, and manifest-bound cleanup receipt exist and match. Report the actual diagnostic result without qualification promotion.
