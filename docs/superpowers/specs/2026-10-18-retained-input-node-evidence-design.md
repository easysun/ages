# Retained Input Node Evidence

## Purpose and boundary

Connect actual Ages synthetic cold-open inputs to their existing trace candidates when the Event Timing API no longer exposes the removed target. Preserve the full Living Timeline, cloud, hardware, and formal-performance goals. This feature supplies instrumented diagnostics only; it does not qualify formal samples, continuous input, resize, human input, or vendor binary/source attestation.

The reviewed two-target pilot established exact namespace correspondence for a connected and a synchronously removed target. Its successful run is `run-2026-10-18T11-22-54.391Z-18983bcd-e4d6-4bf1-8fa3-81bdf391974d`; raw trace integrity, initial frame/PID association, two singleton legacy/node matches, and cleanup were independently checked. Previous failed runs remain immutable. This evidence does not establish that the actual Ages collector composes correctly.

## Selected approach

Add an explicitly enabled, versioned extension to the existing observer and case orchestrator. Reuse the existing sidecar integrity path and analyzer crosswalk. A separate replacement collector would duplicate lifecycle responsibilities; inferring targets from labels would provide no node identity. Neither approach is selected.

The new CLI mode is the existing `--run --browser=installed-brave --observe-inputs` plus `--retain-input-nodes`. Reject the additional flag in every other mode before launching resources. Keep all existing invocations and version-one captures unchanged. Do not copy the throwaway pilot's exactly-two-target fixture rules into the collector.

Use the existing literal Brave .80 compatibility profile and pinned Chromium/V8 protocol catalog. Unknown runtime metadata remains unavailable. Preserve the distinct bundle/runtime revision strings, executable hash, headful launch, and `chromiumSourceIdentity: unverified`. Do not broaden the source profile to make a capture pass.

## Browser observation

For the new mode, observe actual `event.target` at a window capture listener before application handlers can remove it. Use the observer's opaque token identity and a bounded strong `Map<token, Node>`. Label registration remains stimulus-selection metadata; neither a registered ancestor, locator, selector, nor `composedPath()` may substitute for the actual target.

Retain only supported actual Node targets. Record whether the root is the selected document and whether pointer-capture/shadow uncertainty occurred. Unsupported or ambiguous scope invalidates the affected evidence rather than dropping a contender. Do not change raw API target nullness or fill API tokens from DOM records. Preserve the 16 ms API threshold and all missing/censored counts. Never add busy work, delays, application changes, or repeated trials to force an API entry.

The strong-reference map has at most 32 nodes; serialized mappings have at most 16 KiB. Overflow is permanent unavailability. Strong retention changes instrumentation semantics and must be declared in the manifest. No application page outside the owned synthetic fixture receives this instrumentation.

## Versioned evidence contract

Keep the version-one declaration, observation, source hash, validation, and interpretation intact. The new declaration and sidecar explicitly identify version two and contain one closed `retainedNodeEvidence` object. No optional unversioned field may silently change version-one meaning.

The version-two extension contains bounded status/reason fields, exact token-to-backend-node mappings, the selected default execution-context unique identity, frame/document/loader snapshots through mapping, supported protocol-catalog identity, lifecycle coverage/loss/overflow evidence, and a fixed boolean/null cleanup receipt. Backend node IDs are positive signed-32-bit integers. Never serialize remote object handles, DOM descriptions, text, attributes, URLs, or profile paths.

Keep the existing 256 KiB sidecar ceiling and existing record-count ceiling. Reserve the extension's worst-case envelope budget before accepting observation records; the version-two record-byte budget cannot exceed the previous limit. Test that budgeting agrees with actual serialized bytes. If the complete envelope exceeds a cap, preserve an unavailable result; do not truncate records or raise a limit silently. Use write-exclusive artifacts with actual byte counts and SHA-256, plus existing confined regular-file/no-follow/nonblocking CLI reads.

## Continuous ownership and lifecycle

The same owned page CDP session must establish exactly one default context associated with the exact root frame. Install listeners before successful Page/Runtime/Inspector enablement and target discovery. `Runtime.enable` supplies existing contexts; validate actual `auxData.frameId`, `auxData.isDefault`, and `uniqueId`. Use `Runtime.evaluate({uniqueContextId, returnByValue:false, objectGroup})`, then `DOM.describeNode({objectId, depth:0, pierce:false})`; consume only the bounded positive backend ID.

Maintain the reviewed protocol invalidation catalog continuously through mapping, reference release, and final snapshots. Navigation start/commit, same-document navigation, document opening, BFCache restoration, relevant frame detach/swap/subtree changes, context destruction/clearing, selected-target changes, crash, session loss, and transport loss permanently invalidate the scope. Ambiguous event scope is not ignored. Successful enables and installed listeners support the pinned source-compatible catalog; they do not enumerate runtime events or attest the binary.

Require exactly one initial `TracingStartedInBrowser` target-frame association with a positive renderer OS PID, preceding every selected candidate. Every candidate must have the exact frame and outer PID. Reject subsequent target-scoped ProcessReady/FrameCommitted/FrameDeleted metadata, conflicting associations, missing fields, or trace loss. Matching frame/loader snapshots alone is insufficient.

Version-two orchestration is: baseline and arm; run the existing action; drain and freeze records while retaining nodes; resolve mappings; clear strong references and release the object group; take final identity/provenance snapshots; finalize monitoring; write the immutable sidecar; close owned resources. Monitoring remains active during reference release. Every error follows the same bounded cleanup path. Preserve the existing version-one close behavior and perform no observation work when disabled.

Pending protocol work must be interrupted on invalidation and must settle before success. Adapters must preserve the actual event-emitter interface required by tracing. Validate capabilities before allocating timers, remove partial subscriptions, and settle completion/cancel/setup-error paths idempotently. Use real orchestrator/adapter composition tests rather than independently mocked helpers.

## Analyzer association

Retain all API and raw legacy contenders before any target, action, endpoint, or successful-candidate filtering. Require singleton API/legacy association by exact frame, mapped discrete type, and positive interaction ID no greater than `2147483647`. Preserve raw trace-array indices through the existing modern crosswalk; never match summary durations or timestamps by proximity.

For version two, identify a unique trusted DOM counterpart by exact document, event type, and API `startTime === DOM timeStamp`. If the API exposes a target, its token must equal the actual DOM token. If it exposes null, keep it null. In both cases, require that token's unique retained mapping to equal the associated legacy `nodeId` within the proven context/frame/PID epoch. Missing or duplicate DOM records/mappings invalidate association. Dispatch labels and phases select only the existing supported click actions; they do not establish identity. Secondary open never replaces primary open.

Pin the newly reviewed collector source hash, including every extracted helper in its explicit source-input list, with separate schema-and-mode lifecycle entries. The updated collector's disabled-retention version-one path also needs its own reviewed entry so existing invocations remain usable; version-two proof cannot authorize it implicitly. Keep the old literal hash and lifecycle rules available only for their original schema. Unknown hashes, partial actions, unsupported measurement states, missing required cleanup, or conflicting loss fields fail closed.

CLI output remains sanitized counts, labels, durations, and reason codes. Raw IDs/timestamps remain confined to bounded private synthetic artifacts. Formal status and percentiles remain unavailable. Old captures cannot acquire mappings or new qualification retrospectively.

## Binary verification and delivery

- Browser tests cover actual window targets, connected/removed nodes, immutable API nullness, no ancestor substitution, bounds, and empty references after cleanup.
- Real collector composition tests cover disabled and enabled modes, initializer/session wiring, full ordering through drain/mapping/release/final snapshot, and startup/action/setup/cancel failures without orphan callbacks.
- Inject every supported lifecycle loss at asynchronous mapping boundaries, including after a node response and before the final snapshot. Assert permanent rejection, no subsequent commands, and cleanup.
- Analyzer tests cover exact equality, mismatched nodes/PIDs/epochs, malformed contenders and duplicates before filtering, absent API targets, multiple DOM counterparts, missing cleanup, unsupported modalities, and unchanged version-one behavior.
- CLI tests cover extended-envelope limits, byte/hash tampering, substitution, confinement, and unchanged old captures.
- Independently review the specification and implementation plan before implementation. Run the full repository check and independent code review before publication.
- After implementation review, execute one separately reviewed fresh capture using the existing synthetic Ages case matrix. Preserve missing primary inputs and all failures; do not retry to manufacture success. Report actual primary-open association and cleanup evidence without formal promotion.

## Sources

Use the existing observed-discrete-input specification's pinned EventTiming/frame references. Backend node identity follows `Node::GetDomNodeId` through `IdentifiersFactory::IntIdForNode` and `InspectorDOMAgent::BuildObjectForNode` at Chromium `43a195105613ac83c21d3f14de279f4a045c7da0`. Frame/PID metadata follows that revision's `content/browser/devtools/protocol/tracing_handler.cc` lines 212–242 and 1160–1224. Protocol events follow its `third_party/blink/public/devtools_protocol/domains/{Page,Inspector,Target}.pdl` and V8 `d89479ac5446a374c55a35be19b5a23437558d99/include/js_protocol.pdl`. These are published-source compatibility references, not installed-binary attestation.
