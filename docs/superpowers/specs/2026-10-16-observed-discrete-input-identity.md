# Observed Discrete Input Identity

## Purpose and limits

Associate selected observed discrete inputs with existing exact EventTiming/EventProcessing diagnostic candidates. This is a step toward the formal performance protocol, not a substitute for its seven actions, named device/browser matrix, complete trials, or cloud gates. Continuous inputs and resize remain unsupported. Primary cold-open inputs that fail the DOM identity check remain rejected; secondary mode activation cannot replace them.

No new capture, dependency, browser instrumentation, application behavior, or threshold change is required. Reanalyze retained bytes. Do not claim human input, installed vendor source attestation, unrestricted interaction completeness, API-duration equality, or formal trial qualification.

## Separate browser source profile

Preserve the existing Chromium 153 and Brave 155.0.8059.40 guards unchanged. Add a separately selected diagnostic profile for the observed Brave 155.0.8059.80 identity:

- Browser product/version and runtime product: `Runtime browser observation`, `155.0.8059.80`, and `Chrome/155.0.8059.80`.
- Bundle identifier `com.brave.Browser`, short version `155.1.97.57`, bundle version `197.57`.
- Bundle revision `7bfa200812971b7811541ae6e5b72620abebe3a7`; runtime revision `@7bfa200812971b7811541ae6e5b72620abebe3a`. These are distinct literal values, never padded or equated.
- Executable SHA-256 `a17d7d68343726bb2a601ef237b90198bf1bb0133952dc3935435c8fed70d6f5`.
- Existing reduced-UA product-token checks for `155.0.0.0`; `chromiumSourceIdentity` exactly `unverified`.
- Closed four-field source envelope: browser, browserIdentity, qualification, status. Both qualification and status remain `installed-brave-schema-probe`.

Pin published upstream revision `43a195105613ac83c21d3f14de279f4a045c7da0` separately. Official Brave v1.97.57 release lineage and byte-identical relevant timing/frame/proto files support a published-source diagnostic profile, not binary attestation. Unknown versions, changed identity fields, unsupported envelopes, and supplied qualification flags never enable a profile.

## Observer evidence and integrity

Source-profile selection alone proves no observation contract. Independently validate the original instrumented synthetic observer envelope, its closed schemas, fixed threshold metadata, bounded records, and stable document/frame provenance using the existing observer validators. Require loss-free trace coverage and the existing captured trace/sidecar byte lengths and SHA-256 values. Sidecars must be regular files within the manifest directory; reject traversal, symlinks, mismatched case/trace references, missing files, and altered bytes. Preserve raw evidence and fail closed; never repair or rewrite input artifacts.

Prove the existing collector lifecycle using the original manifest source hash exactly `96a969d576f7610b66217294480c444a36205cec69dba66e8dee0b9a820ce8ae`, recomputed from reviewed collector inputs. Do not use sourceRevision as proof: the retained capture included working-tree changes. Require case actionStatus `completed`, absent actionReasonCode, and case plus linked trace dataLossOccurred exactly false. Accept only measurementStatus `resolved` with absent measurementReasonCode, or `unavailable` with reason exactly `FRAME_STREAM_MISSING`. Reject every other lifecycle state. In the pinned collector, these states exclude capture failures and prove it reached the segment builder: tracing starts before the action callback arms observation; the callback drains observation/provenance before tracing ends. The separate nested `NEXT_PAINT_METHOD_UNPROVEN` flag is not lifecycle proof. A supplied boolean cannot replace these original fields.

The observed API entry must have a unique trusted DOM counterpart with exact document ID, mapped type, API startTime equal to DOM timeStamp, and opaque target token. Delivery phase is not dispatch phase. Target misses remain rejected. This API/DOM timestamp comparison is separate from API/trace association; API and trace timestamps are not equal because exposed API timestamps are clamped.

Selected action diagnostics use only `click` with dispatch phase `primary` and target label `open-primary`, `fit-all`, or `append-confirm`, or dispatch phase `secondary` with label `open-secondary`. Keep secondary open separate. Other precise matches may be counted as rejected incidental entries; pointer release after pan and Shift keys during zoom cannot become action samples. Count every contender before applying this stimulus rule.

## Identity and ordering of rejection

For the stable document/case, form the API-to-legacy key from exact recorded frame ID, explicitly mapped discrete type, and positive integer interaction ID at most `2147483647`. Never normalize an API interaction ID or infer frame/PID from proximity.

Interaction IDs identify groups, not necessarily individual events. Count all API contenders before DOM/target/window filtering. Count all raw legacy EventTiming begins before endpoint, crosswalk, fallback, target, or window filtering. Require singleton multiplicity in both directions. Malformed or incomplete contenders must not disappear and manufacture uniqueness; if their identity cannot be safely classified, reject association for the affected scope. Trace loss, unknown completeness, unstable document, invalid identities, duplicates, or absent candidates reject association.

Only after singleton association and trusted-DOM identity pass may the existing exact legacy-to-modern crosswalk and fallback checks select a presentation candidate. Keep original trace-array indices privately through this operation; matching sanitized summaries by event type or duration is forbidden. Require the existing exact processing endpoints and other crosswalk identities, fallback reason None, zero fallback time, and a valid closed endpoint.

Output bounded, sanitized accepted/rejected entry counts and reason codes. Accepted records may expose fixed action/stimulus label, mapped type, trace duration in microseconds, processing-tail duration, and diagnostic status. Do not expose raw frame/node/target IDs, timestamps, event arguments, URLs, or content. Do not emit formal action samples or percentiles from this association. Existing CLI behavior for captures without observer sidecars remains unchanged.

## Verification

Binary acceptance requires tests for the actual .80 source projection, every changed identity field, unchanged .40 guards, duplicate contenders rejected before all filtering, incomplete/malformed contenders, zero/overflow IDs, exact DOM target misses, stale provenance, absent/changed sidecars, and unsupported continuous modalities. Reject completed actions paired with capture-failure reasons, missing/changed collector hash, unknown measurement states, or conflicting case/trace loss fields. A singleton accepted fixture must still report formal status unavailable. Reanalyze the existing 14-case capture with matching raw hashes; report accepted/rejected discrete diagnostics and preserve all cold-open gaps. Run the full repository check and independent code review before publication.

## Source references

- [Brave v1.97.57 release](https://github.com/brave/brave-browser/releases/tag/v1.97.57).
- [Interaction-ID reuse](https://chromium.googlesource.com/chromium/src/+/43a195105613ac83c21d3f14de279f4a045c7da0/third_party/blink/renderer/core/timing/responsiveness_metrics.cc#418), including composition keyup at lines 348–356.
- [Trace/API event identity and trace payload](https://chromium.googlesource.com/chromium/src/+/43a195105613ac83c21d3f14de279f4a045c7da0/third_party/blink/renderer/core/timing/performance_event_timing.cc#374).
- [Frame ID generation](https://chromium.googlesource.com/chromium/src/+/43a195105613ac83c21d3f14de279f4a045c7da0/third_party/blink/renderer/core/inspector/identifiers_factory.cc#84).
