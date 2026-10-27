# Same-document click-count calibration collector

## Purpose and limits

Prepare the missing browser-side evidence for a future bounded physical-tap calibration: the same document's click counter before and after one trusted target click. The retained phone pilots have no counter snapshots and cannot be promoted retrospectively. This collector is one step toward the existing formal performance protocol, not a replacement for its browser/workload/action matrix, endpoint, aggregation, completeness, or repetition requirements.

The exact Chromium 143 and 155 source checks found that `eventCounts.click` increments after Event Timing eligibility filtering and before entry creation, independently of observer thresholds. Dropped-input additions affect pointer/touch counters, so only the click delta is compared in this calibration. Equal counts alone do not prove completeness. A future capture must also retain the declared target/frame/document, a trusted target record, unique exact raw trace spans, original stream integrity, and the reported physical action.

## Approach

The agent chooses a separate small collector under the user's delegated design authority.

- Manual console snapshots and an ad-hoc listener require repeated lifecycle and identity bookkeeping without tested cleanup.
- Extending the existing synthetic stimulus observer would change its versioned payloads and desktop-only retained-node contracts.
- A standalone browser function, a native-CDP function-declaration builder, and focused tests provide the needed evidence without changing those contracts. This is the selected approach.

No new dependency, application route, UI, source profile, latency computation, or formal acceptance flag is added.

## Files and interfaces

Create `scripts/click-count-calibration.mjs` exporting:

- `createClickCountCalibration(target, documentId)` runs in the target browser realm and returns `{ getBaseline(), close(), abort() }`. It is self-contained when serialized with `Function.prototype.toString`; it must not reference Node imports or module-scope values.
- `clickCountCalibrationFunctionDeclaration()` returns a CDP-compatible function declaration taking `documentId` and calling the collector on `this`, the preselected DOM element. Arguments are passed separately through `Runtime.callFunctionOn`, never interpolated into source.

`getBaseline()` always returns the same frozen initial snapshot (`before` in the final result), including after close or abort. It never samples again. Initial failure throws before a collector object is returned.

The native caller first binds that exact target with `DOM.describeNode` and records the root frame, loader, execution context, and target/session metadata. The opaque `documentId` is a label, not independent proof of browser identity. The caller owns the returned remote object and releases its object group after reading the final result.

## Browser lifecycle

1. Accept an element that is connected to its current owner document. Require a visible document at HTTP `127.0.0.1` or `localhost` only. This tool is for the isolated local synthetic fixture, not production or arbitrary websites.
2. Validate `documentId` against `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Read the same window's `performance` and `eventCounts` objects and retain their identities in the closure.
3. Copy the initial counter map and clock metadata. Require a `click` key, at most 64 unique lowercase ASCII keys of at most 32 characters, and nonnegative safe-integer values. Missing, throwing, malformed, or unsafe counters fail closed; absent values never become zero.
4. Add a passive capture-phase document click listener. Retain at most two records, recording only `isTrusted`, exact `event.target === target`, event timestamp, and observation time. Record unrelated clicks as mismatches; a third click sets overflow. Do not collect captions, URLs, HTML, form values, or media; inspect only location protocol/hostname for the initial origin guard. Do not prevent or stop events, trigger input, read layout, or mutate application DOM.
5. Mark page hide or a transition away from visible as invalid. At close, require the same document, performance object, counter object, connected target, and visible state. Copy the final counters, remove every installed listener, and freeze the result. Abort also removes all listeners and returns an invalid result. Partial installation failure cleans up before throwing.
6. Close and abort are idempotent: the first finalization wins, and subsequent calls return the same cached result without another snapshot or listeners.

The collector detects extra clicks, not every possible concurrent input modality. The capture controller must isolate the declared tap, reject unrelated input in its action record/raw trace, and reject document/context/session loss outside this closure. A click on a descendant is intentionally rejected; the initial local control uses a plain-text button, and a different target shape needs a separately declared mapping.

## Data and validation

The final result has exactly these top-level fields:

`schemaVersion: 1`, `evidenceClass: "same-document-click-count-calibration"`, `documentId`, `diagnosticOnly: true`, `formalStatus: "unavailable"`, `status`, `reasons`, `before`, `after`, `clickDelta`, `clicks`, and `overflow`.

Each snapshot contains `timeOrigin`, `observedAt`, and `counters`. Each click record contains `type: "click"`, `isTrusted`, `targetMatched`, `timeStamp`, and `observedAt`. Do not include browser objects or target contents in serialized evidence. All returned data is frozen recursively through these defined levels.

Clock rules are exact, without tolerances: all timestamps are finite nonnegative numbers; final `timeOrigin` must equal the initial value; final snapshot `observedAt` must be at least the initial value; click observation times must be nondecreasing and lie in that closed snapshot bracket. Equality at a boundary is valid. The event's `timeStamp` is retained as a finite nonnegative number but is not compared with observation times or used to infer latency. Invalid event numbers become null plus `EVENT_RECORD_INVALID`; an invalid initial snapshot throws `CALIBRATION_COUNTER_INVALID`, and an invalid final snapshot becomes null plus `COUNTER_INVALID`. A changed time origin is `DOCUMENT_CHANGED`. Document/performance/counter identity change prevents a final counter read and yields null `after` and `clickDelta`; do not sample a replacement document.

The final counter key set must equal the baseline set, and every counter must be nondecreasing; otherwise use `COUNTER_INVALID`, null `after`, and null `clickDelta`. This check does not turn non-click deltas into event-presence evidence.

`status` is `collected` only for one trusted exact-target click, click delta exactly one, no overflow, unchanged identities, valid monotonic clocks, and no invalidation. Otherwise it is `invalid`; this does not certify a raw trace or a physical input. `clickDelta` is null if either snapshot is unavailable or invalid.

Constructor errors use `CALIBRATION_INVALID_DOCUMENT_ID`, `CALIBRATION_TARGET_UNAVAILABLE`, `CALIBRATION_ORIGIN_NOT_ALLOWED`, `CALIBRATION_NOT_VISIBLE`, `CALIBRATION_COUNTER_UNAVAILABLE`, `CALIBRATION_COUNTER_INVALID`, or `CALIBRATION_INSTALL_FAILED`. Final reason codes are `DOCUMENT_CHANGED`, `TARGET_CHANGED`, `VISIBILITY_CHANGED`, `COUNTER_SOURCE_CHANGED`, `COUNTER_READ_FAILED`, `COUNTER_INVALID`, `UNTRUSTED_CLICK`, `TARGET_MISMATCH`, `EXTRA_CLICK`, `CLICK_MISSING`, `CLICK_COUNTER_MISMATCH`, `EVENT_RECORD_INVALID`, or `ABORTED`; return distinct codes in deterministic sorted order. Do not embed exception messages or supplied values in errors.

## Capture usage and acceptance

The collector never starts or stops tracing and never automates a phone. The supported workflow remains the authorized native DevTools Protocol Monitor: preflight the exact local target, start original-stream tracing, create the collector on that target, verify its baseline, request one physical tap, close the collector, stop/read/close the original trace stream, compare the click delta and trusted record against the unique exact-target legacy click span, then release the object group. Reject source loss, pending/missing spans, navigation, counter mismatch, fallback endpoints, or ambiguity. Keep raw protocol exports private because other commands may contain the local synthetic cookie.

Counter agreement is only a bounded eligible-click calibration. It does not qualify pointer/touch counts, continuous gestures, resize, unrestricted interactions, source-wide completeness, latency distributions, vendor patch equivalence, or any formal trial. No phone action is requested until the collector and offline tests are ready.

Pass/fail before implementation: unit tests must reject every lifecycle/data failure above; an isolated Playwright Chromium test must observe one trusted synthetic target click and a counter delta of one while normal application click handling still runs. A synthetic `dispatchEvent` must be rejected as untrusted. Browser test evidence remains synthetic and cannot satisfy the physical matrix. Run the repository's complete `npm run check` before committing; reuse existing dependencies and never run local package installation.

References: the existing [formal protocol](2026-10-14-formal-performance-protocol-design.md), Chromium [143 EventCounts](https://chromium.googlesource.com/chromium/src/+/8518487e5f1f3bd2a099bcd27351be965825d984/third_party/blink/renderer/core/timing/event_counts.cc), and [155 EventCounts](https://chromium.googlesource.com/chromium/src/+/5869fe313571d75152b77813cf0a4ee26a4e6df0/third_party/blink/renderer/core/timing/event_counts.cc).
