# Calibrated interaction-group analysis design

## Intent

Add a reusable offline analysis path for one bounded pointer activation. It should retain every uniquely exact-paired EventTiming/EventProcessing member in a nonzero interaction group, report each member's exact trace duration and endpoint class, compute raw and Chrome-source-rounded group maxima with ties, and optionally check `C = N + D` from the existing click-count calibration snapshots. This is evidence for a bounded method check only; it does not qualify a formal performance trial.

## Goals and non-goals

- Preserve existing `discreteEventTimingCrosswalk.candidates` and all current profile behavior. The new group report is additive.
- Keep all supported interaction members in the maximum calculation, including recognized fallback endpoints. Only a maximum whose source-rounded tied members are all presentation endpoints may carry a presentation claim.
- Check count closure for the source-supported, interaction-ID-capable Event Timing API population before observer thresholding. Unsupported API types are outside that population.
- Wire the analysis into the existing trace parser and manifest CLI so the output can be reused across captures. Add no dependency and make no product/UI changes.
- Do not claim complete source coverage, modality equivalence, vendor binary identity, formal action attribution, hardware compliance, or completion of the original device/workload/session matrix.

## Repository constraints and evidence

The current exact crosswalk already parses lossless legacy and modern timing fields, requires unique identity and exact processing endpoints, and computes integer-microsecond spans. It currently retains only a boolean `fallbackProven` and omits a pair from `candidates` unless the endpoint is fallback-free. The group path must retain the recognized endpoint details and matched pair rows separately, without changing that candidate filter.

`scripts/click-count-calibration.mjs` already produces bounded before/after snapshots of the full `Performance.eventCounts` map, clock values, and trusted exact-target click rows. The analyzer CLI validates trace basenames and hashes raw traces in its report; it has safe regular-file readers that can also load a small calibration sidecar.

The reviewed, sanitized Chrome 155 sample has three unique exact pairs: click (79,668 µs, presentation), pointerdown (25,338 µs, recognized fallback), and pointerup (2,083 µs, recognized fallback). The click is the unique raw and source-rounded maximum (80 ms). Each type has `C = R = 1`; for pointerdown, source gives `C = N + D`, `D ≥ 0`, and `R ⊆ N`, so equality closes `N = 1, D = 0`. This demonstrates why an all-members-fallback-free rule is unnecessarily strict.

Scope the new source method to Chrome 155.0.8059.84 and Chromium revision `5869fe313571d75152b77813cf0a4ee26a4e6df0`. The reviewed source establishes that `GetEndTime()` chooses fallback time when present, otherwise presentation time; Event Timing duration uses that endpoint and rounds to 8 ms; EventCounts increments before reporting/threshold handling; and navigation Event Timing is unsupported when its feature-gated counters are absent. The source-backed relative-clock guard is 11 ms. This pins source semantics, not the vendor browser binary.

## Proposed interfaces

### Library

Add one optional final argument to the existing exported analyzer:

```js
analyzeTrace(
  trace,
  traceRecord,
  segments = [],
  sourceObservations,
  observerEvidence = undefined,
  interactionGroupCalibration = undefined,
)
```

For the exact Chrome 155 source scope, the analyzer adds `interactionGroups` to its result. The CLI constructs source observations per bound record (not the pre-existing shared browserSourceObservations object) from the manifest browser and status and that record’s descriptor revision. The new group analysis validates this exact schema independently of the existing crosswalk profile selector: `{browser: {product: "Google Chrome", version: "155.0.8059.84"}, status: "bounded-click-calibration", sourceRevision: "5869fe313571d75152b77813cf0a4ee26a4e6df0"}`. Extra keys or mismatched values do not activate this group-analysis profile. Existing profile schemas and existing `discreteEventTimingCrosswalk` selection and output remain unchanged, including for Chrome 155. Each row uses a stable ordinal (`group-1`, ordered by earliest member) and contains only sanitized fields:

```js
{
  group: "group-1",
  status: "diagnostic-only" | "bounded-calibration-verified",
  formalStatus: "unavailable",
  members: [{
    member: "member-1",
    eventType: "pointerdown",
    rawTraceSpanUs: 25338,
    durationUs: 25338, // null when source endpoint semantics are unknown
    endpointClass: "presentation" | "recognized-fallback" | "unknown",
    sourceRoundedDurationMs: 24, // null when durationUs is null
  }],
  observedMaximum: {
    rawDurationUs: 79668,
    rawMembers: ["member-3"],
    sourceRoundedDurationMs: 80,
    roundedMembers: ["member-3"],
    presentationClaimEligible: true,
  },
  countClosure: {
    status: "closed" | "open" | "unavailable",
    byType: [{ eventType: "pointerdown", C: 1, R: 1, N: 1, D: 0 }],
    unsupportedApiTypes: ["navigate", "popstate", "hashchange"],
  },
  reasonCodes: [],
}
```

Names above show the shape; counts and members come from input evidence. Do not emit document labels, frame IDs, interaction IDs, renderer/process IDs, URLs, raw trace payloads, or counter snapshot timestamps. `rawTraceSpanUs` is always the exact observed span. `durationUs` and its source-rounded value are populated only when the pinned source proves the pair's end semantics. Maxima are labeled observed until count closure succeeds.

### CLI calibration binding

Allow an optional per-trace descriptor in the existing manifest:

```json
"interactionGroupCalibration": {
  "sidecar": "capture-calibration.json",
  "sidecarByteCount": 1234,
  "sidecarSha256": "<64 lowercase hex characters>",
  "documentId": "opaque-capture-label",
  "frame": "exact trace frame string",
  "rendererPid": 1234,
  "targetNodeId": "196",
  "traceSha256": "<64 lowercase hex characters>",
  "sourceRevision": "5869fe313571d75152b77813cf0a4ee26a4e6df0"
}
```

Bind it to that trace record. The library final argument is `{sidecar, binding}`, where `binding` is this descriptor without `sidecar`, `sidecarByteCount`, and `sidecarSha256`; the CLI reads the sidecar itself. Frame must be a bounded nonempty string, rendererPid a positive safe integer, targetNodeId a canonical positive decimal integer string. All are explicit capture metadata and are never emitted in reports. Count only the declared renderer/frame document scope; require the single selected click to match targetNodeId. Never infer document ownership from timestamp overlap or uniqueness alone. Accept it only for browser product/version Chrome 155.0.8059.84 and the exact revision above. Validate the sidecar basename, 256 KiB maximum bounded regular-file read, exact sidecar byte count and SHA-256, require its `documentId` to match the descriptor, and compare `traceSha256` to the bytes actually analyzed. Require traceRecord.dataLossOccurred to be exactly false for bounded verification; unknown or true leaves closure unavailable. Do not print either identifier or sidecar path. Only the CLI verifies the digest against original bytes; the library operates on an already-parsed trace and does not claim it independently verified the byte digest. The existing collector result is unsigned, so this binding is explicit capture metadata, not an attestation; the report remains diagnostic.

Revalidate the sidecar from its before/after snapshots and click rows. Require the same finite `timeOrigin`, monotonic `observedAt`, identical supported counter keys, nondecreasing safe integer counters, and exactly one trusted exact-target click whose observation time lies in the bracket. Recompute `clickDelta` from the snapshots and compare it with the click-row count. Do not accept the caller's `status` or `clickDelta` fields as proof; reject contradictory declarations. Also reject overflow, nonempty collector reasons, malformed rows, replacement/visibility evidence, and any missing counter needed for a supported event type.

### Group and count rules

1. Reuse the existing exact legacy/modern pair parser. Group by the exact capture/document scope, frame, and nonzero interaction ID; never join by timestamp proximity. Require one unique click-group candidate in the collector bracket. Use the pinned 11 ms guard only for conservative boundary classification: a processing start must be strictly greater than before.observedAt*1000 + 11000 and strictly less than after.observedAt*1000 - 11000 to be certainly inside. Values strictly outside the expanded bracket are outside; values within 11 ms of either boundary are uncertain and prevent count closure for any supported nonzero-ID-capable type. Compare exact binary64 rational snapshot values to integer microseconds, without floating epsilon. The guard is not an identity key. Any member of the selected interaction outside the certainly-inside window, or any unmatched/ambiguous relevant record, prevents closure.
2. Retain every unique closed pair in that group. Classify `None` + zero fallback time + absent `fallback_time_us` as presentation. Classify `DoesNotNeedNextPaint` as recognized fallback only when both fallback fields are explicit lossless positive integer microseconds, args.fallback_time equals the paired legacy endTimestampUs, and legacy.originUs + event_timing.fallback_time_us equals that same endTimestampUs. Add fallback_time_us to the lossless integer-token field set. Missing, contradictory or fractional fields cannot validate the endpoint. Include presentation and validated recognized-fallback durations in raw and rounded maxima. Preserve every tie. Unknown, contradictory, or unvalidated fallback data remains visible as a diagnostic member but prevents bounded group verification and cannot supply an API duration.
3. Compute `C` from revalidated after-minus-before counters. `R` is the number of unique closed, exact-matched modern records by type in the selected group and guarded document window. `N` is not asserted from a caller; infer it only from the pinned source equation `C = N + D`, `R ⊆ N`, and source-supported `D` bounds. For pointerdown, `D ≥ 0`; for pointerup/click, `D = 0`. Closure requires `C = R` for every supported interaction-ID-capable type in the window. On equality, infer `N = R` and `D = 0`. Any surplus/deficit, ambiguous pair, unsupported source path, or unaccounted supported type leaves closure open.
4. Derive supported API types from the pinned reporting gate and the captured counter map. In particular, when Navigation Event Timing is off and its counter keys are absent, navigation entries are outside the API-defined population; do not require a passive witness for internally created/canceled navigation entries. If navigation support is on, it must be counted/mapped under an accepted source rule or closure stays open.
5. Round nonnegative safe integer microsecond durations with the pinned source conversion `Math.round((Number(durationUs) / 1000) / 8) * 8`, rejecting values whose rounded result is not a safe integer. This mirrors source InMillisecondsF()/8 followed by std::round for nonnegative values. The test suite must cover rounding boundaries and collapsed rounded ties. A presentation claim is eligible only when every member tied for the reported source-rounded maximum has a presentation endpoint. A fallback member below the maximum does not disqualify the group.
6. A closed bounded calibration remains `formalStatus: "unavailable"`. The original protocol's full trial matrix, action attribution, physical-device and browser/source gates remain unchanged.

## Files to reuse or edit

- `scripts/chromium-trace-metrics.mjs`: add the independent pinned Chrome 155 group scope and reuse the shared private pairing/parsing primitives, implement the group summary and count closure, and preserve existing profile selector and candidate output.
- `scripts/analyze-chromium-traces.mjs`: validate/bind the optional calibration descriptor and sidecar, pass it to `analyzeTrace`, and publish only the sanitized group report.
- `tests/tools/chromium-trace-metrics.test.mjs`: pure group/max/rounding/endpoint/count-closure behavior.
- `tests/tools/chromium-trace-cli.test.mjs`: sidecar and trace-hash binding, validation/recomputation, and sanitized output.
- Synthetic trace fixtures only if existing fixtures cannot express the cases. Reuse `scripts/click-count-calibration.mjs`; no collector change is required for this draft.

No product code, dependencies, formal protocol qualification, or changes to `HANDOFF.md` are in scope.

## Binary acceptance checks

- Existing trace-metric and CLI tests continue to see unchanged individual `candidates` and formal-gate fields.
- The Chrome 155 synthetic fixture reports all three exact members and their endpoint classes; computes 79,668 µs raw / 80 ms rounded maximum; and accepts the two fallback-bearing nonmax members. A fixture with a fallback maximum or mixed maximum tie cannot claim presentation.
- Recognized fallback is included only after exact source-end validation. Unknown or contradictory fallback preserves diagnostic rows but makes bounded group verification fail.
- `C = R = 1` closes the sample's pointerdown/up/click counts and infers `N = 1`, `D = 0`; an extra/missing record does not close. A supported API type with a nonzero counter but no mapped record blocks closure.
- Missing navigation counter keys under the pinned disabled feature gate do not block the API-population closure or introduce a no-navigation-witness requirement. Enabled navigation support without a complete accepted mapping remains open.
- A candidate strictly inside the 11 ms contracted bracket is admitted; boundary/near-boundary supported records prevent closure, and a nearby but different trace identity is never joined by proximity. Raw out-of-window records cannot cancel missing in-window entries.
- Recomputing click delta from snapshots catches forged/mismatched `status` or `clickDelta`. Trace digest, document-label binding, malformed keys/counters/timestamps, extra/untrusted clicks, and sidecar path violations reject or leave verification unavailable.
- Serialized group output contains no document label, frame/interaction/process ID, URL, raw trace payload, or counter time; it reports stable ordinals, event types, durations, counts, and fixed reason codes only.

## Decisions delegated by the user

- Root selects one calibration sidecar per trace because the existing collector is single-activation evidence. Arrays and multi-activation captures are outside this change.
- Navigation keys must be all absent or all present in both maps. Partial presence is malformed. When present, count closure remains unavailable until an accepted exact navigation mapping exists. No API-data substitute or navigation witness is added.
- This change extends pinned source semantics to Chrome 155 for this bounded method report; it does not unlock formal action trials. Preserve the existing formal protocol and trial aggregation gates.
- `bounded-calibration-verified` means verified count algebra and endpoint analysis conditional on the declared capture/document binding, not cryptographic provenance or verified action/hardware. Report an explicit fixed scope label documenting that condition. Do not call this complete formal source coverage.
- Preserve source-predicted rounded values as such; do not call them observed API durations. If any rounded maximum tie has a fallback/unknown endpoint, presentationClaimEligible is false. Unknown endpoint members make complete group maximum unavailable rather than silently dropping them: set `observedMaximum` to null and preserve all diagnostic member rows.

## Known limits

The existing v1 collector's `documentId` is a caller-provided label, and its output does not contain a trace digest or source revision. The CLI descriptor binds those values by explicit manifest metadata and verifies both sidecar and trace hashes; it cannot cryptographically prove that the unsigned collector sidecar came from the same browser capture. The source revision is not proof of the installed browser's patch identity. The single calibration can test the reducer and source counting argument, but it cannot qualify an action or the original performance gate.
