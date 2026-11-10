# Offline Chromium Trace Correlation Design

## Goal and scope

Provide a small local Node.js tool that reads the existing Chromium trace JSON and its capture manifest, preserves trace IDs exactly, and reports auditable input-to-presented-frame correlation samples for later Task 6 measurement work. Its first use is to validate the accepted shape in the existing 100-item and 10,000-item pilot traces. It is an offline analysis utility; it does not capture traces, launch a browser, start the app, or perform a benchmark.

This design does not change Ages application behavior. It adds no runtime dependency and does not satisfy or reduce the named-hardware evidence gates. No current pilot percentile, frame-rate, or formal input-to-next-paint claim is authorized.

## Existing requirements and evidence

The governing requirements are in:

- docs/superpowers/plans/2026-10-08-timeline-performance.md, Task 6.
- docs/superpowers/specs/2026-10-08-timeline-performance-design.md, Binary checks and measurement protocol.
- docs/superpowers/plans/2026-10-08-chronological-overview.md, Evidence gate after source work.

Those requirements keep the 100-item interactive case separate from the 10,000-record chronological overview, retain raw traces, require named physical-device evidence and mounted-media counts, and leave the gate open until measured evidence is reviewed. The requested future evidence still covers an actual desktop with an explicitly named browser and a Samsung Galaxy S25 Ultra using Chrome, Samsung Internet, and Brave. Run both dataset sizes and the full open, Fit all, pan, zoom, resize, append, and scroll action set. Record the exact device/browser matrix in the formal report; this utility does not infer or waive any part of it.

The local pilot manifest says its click was synthetic Playwright input and that hardware details were preflight observations, not reread at capture. It records Playwright Chromium 153.0.8010.12, Mac14,7 / Apple M2 / 24 GB, macOS 27.0.1 build 26A434, a 60 Hz display, viewport and cache details. These are useful diagnostic metadata, not named-device qualification.

Read-only inspection verified these current raw files and SHA-256 digests:

- 100-item.fit-all.trace.json — f400d2860720723ab4f39b4f69c8a56109f862c50b46f48c93ffca11fceca2b4
- 10k-item.fit-all.trace.json — bc9096de6b182eb1415aa138b66cb6debd3dfaa2511578d1ff39a780276151dc

The raw files remain in the local pilot run directory under .superpowers/sdd/desktop-trace-pilot/runs and must not be copied into the repository or rewritten.

## Alternatives and decision

1. Use Perfetto SQL or a protobuf decoder. This would add a separate runtime or toolchain and could change trace interpretation across versions.
2. Write a custom JSON tokenizer or use Python to preserve 64-bit values. This duplicates parsing work despite the repository's supported Node runtime.
3. Use Node.js 22's native JSON.parse reviver source text for the known integer identity fields, then analyze only the trace shapes used by this pilot.

Choose option 3. Keep the parser bounded to the verified Chromium event forms. Unsupported or ambiguous events become explicit diagnostics; the analyzer never substitutes timestamp proximity, rounding, rAF timing, FRAME_SWAP, or a different event type to manufacture a match.

## Trace and identity contract

The supported input is the capture manifest shape produced by the existing local pilot and Chromium Trace Event JSON with a traceEvents array. The CLI reads the trace files named by the manifest, computes a SHA-256 digest, and leaves each input byte unchanged. It reports only selected metadata, counts, exact correlations, and diagnostics; it never copies event arguments into the report.

Trace timestamps use microseconds. The analyzer validates finite numeric timestamps and reports durations in microseconds. It does not interpret them as wall-clock time.

The expected upstream event contract is pinned to Chromium source revision 971a7443b0c9b0a9b2860529b33331b76077ec62: [event_latency_tracing_recorder.cc](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/cc/metrics/event_latency_tracing_recorder.cc), [compositor_frame_reporter.cc](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/cc/metrics/compositor_frame_reporter.cc), and [chrome_track_event.proto](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/base/tracing/protos/chrome_track_event.proto). The source pin explains the expected event names and fields; it does not prove that the installed Playwright Chromium binary is unpatched or identical to that source revision.

The Chromium event identity fields are not all safe JavaScript numbers. In Node.js 22.22.2, JSON.parse reviver context.source preserves the original decimal token. Convert only the known integer ID fields to BigInt: chrome_latency_info.trace_id, event_latency.event_latency_id, event_latency.surface_frame_trace_id, event_latency.display_trace_id, and their frame_reporter counterparts. Keep decimal measurements such as vsync_interval_ms as numbers. Keep id2.local and id2.global as strings with their namespace. Malformed fractional or exponent-form values in an ID field are rejected as malformed IDs.

Support only the verified pilot b/e profiles. The general supported profile requires a begin/end pair to have the same process ID, thread ID, category, id2.local namespace, exact local ID, and event name. Its track key is process, thread, category, namespace, and exact ID; event name identifies the span occurrence and matching close but is excluded from the track key so differently named nested stages can share a track. Build occurrence ownership from unambiguous interval nesting on that same track. A child span must be contained by its parent occurrence; timestamp equality by itself never establishes ownership. Sequential reuse after a completed occurrence is allowed. The sole top-level-id exception is a completed InputLatency::MouseUp b/e pair with the same process ID, thread ID, category, event name, and exact hexadecimal string ID. Give this exception its own typed namespace; do not treat it as id2.local. Other top-level id forms, id2.global, and begin/end lifetime migration across threads or processes are unsupported and produce explicit diagnostics. Exact trace-ID correlation from the independently paired MouseUp occurrence to EventLatency may cross process only through the verified chrome_latency_info.trace_id == event_latency.event_latency_id fields; this is an event correlation, not cross-process slice pairing or generic global-ID support. Preserve namespaces so equal values in different namespaces never cross-match. Missing, duplicate, overlapping-ambiguous, or unterminated pairs are diagnostics, not zero-duration events. This is a pilot-profile parser contract, not generic Chromium async-event support.

## Correlation and qualification

For each completed InputLatency::MouseUp occurrence:

1. Require a completed MouseUp occurrence in the narrow same-process/thread/category top-level-hex-id profile above. Read its exact chrome_latency_info.trace_id and require exactly one independently completed EventLatency whose event_latency.event_latency_id is equal and whose event type is MOUSE_RELEASED. This exact field-based correlation may cross process; do not join the MouseUp and EventLatency b/e lifetimes across process.
2. Require the matched EventLatency occurrence to be uniquely paired in the supported profile. Require exactly one independently paired PipelineReporter occurrence whose own state is STATE_PRESENTED_ALL and whose own surface_frame_trace_id and display_trace_id both exactly match the EventLatency record. Derive the reporter endpoint from that occurrence's own begin/end pair and require it to equal the EventLatency end. If reporter-stage data is present or used, it must be contained in and attributed to that exact reporter occurrence; do not borrow state, IDs, stages, or endpoints from a sibling occurrence or another track based on matching timestamps.
3. Require SubmitCompositorFrameToPresentationCompositorFrame and its terminal SwapEndToPresentationCompositorFrame breakdown to be completed child occurrences of the matched EventLatency occurrence: each must use the same scoped track, be uniquely contained by that exact EventLatency interval, and the terminal child must end at the EventLatency end timestamp. Determine temporal order by timestamp and then original traceEvents array order, so a child beginning or ending after its parent close is outside even when timestamps tie. A same-time stage on another track, another EventLatency occurrence, or a sibling occurrence cannot satisfy this check.
4. Emit one diagnostic inputToPresentedFrameUs sample as EventLatency end minus MouseUp start only when the preceding matches and endpoint checks are unique and positive.

This sample is named input-to-presented-frame. The equivalence between it and Task 6's formal input-to-next-paint metric remains unverified and must be resolved in the formal measurement protocol. A closed EventLatency slice alone is insufficient. FRAME_SWAP, the nearest frame by timestamp, an rAF callback, or a matching surface ID without a matching display ID cannot qualify a sample.

The analyzer counts PipelineReporter states, including STATE_NO_UPDATE_DESIRED, and reports why a candidate did not qualify. A no-update, dropped, partial, missing, ambiguous, or unterminated pipeline record is never treated as a presented frame. A trace entry qualifies only when its manifest says dataLossOccurred is false; true or unknown loss status keeps its samples diagnostic and unqualified. Async pairing is limited to the verified pilot profiles above. Unsupported cross-thread/cross-process b/e lifetime migration and ID namespaces emit reason codes even if an ID value or timestamp appears to match. Exact field-based event correlations are limited to the documented MouseUp/EventLatency and EventLatency/PipelineReporter links; they do not establish generic cross-process or global-ID join support.

Frame intervals are eligible only within a declared measurement segment and one declared renderer/layer stream. The optional manifest extension is measurementSegments, whose entries specify trace basename, an action label from `open`, `fit-all`, `pan`, `zoom`, `resize`, `append`, or `scroll`, half-open startUs/endUs bounds, renderer PID, layerTreeHostId, and frameSource. Reject other action values with an `INVALID_MEASUREMENT_SEGMENT` diagnostic and do not copy the supplied label into report samples. Within each declared stream, identify a distinct frame by its exact surface_frame_trace_id and display_trace_id pair. Use the closing timestamp of each complete STATE_PRESENTED_ALL PipelineReporter as that presented frame's endpoint, then compute raw deltas between adjacent endpoints inside the segment. Such deltas may include idle time; report them as diagnostic frame intervals, never as FPS. A future protocol that wants to exclude idle time must declare its active subsegments. Do not bridge streams, actions, or segment boundaries. The pilot manifest has no measurementSegments, so its report must say that no qualified frame-interval series is available. It may report presentation-record counts, but no general frame rate or percentile.

## Tool boundary and report

Create one importable Node module for parsing/correlation and one CLI entry point:

- scripts/chromium-trace-metrics.mjs — parseTrace(text) and analyzeTrace(trace, traceRecord, segments) pure functions.
- scripts/analyze-chromium-traces.mjs — read the manifest and its basename-only trace files, call the pure analyzer, and emit a JSON report.

Run it as:

    node scripts/analyze-chromium-traces.mjs <manifest.json> [--out <new-report.json>]

With no --out option, write the report to stdout. With --out, create a new file exclusively and fail if the destination exists; never overwrite an input, manifest, symlink, or prior report. Reject trace paths containing directory traversal or path separators. Invalid JSON or an invalid manifest fails the command without emitting a partial report. A valid trace with unsupported or incomplete event shapes produces diagnostics and no qualified sample for that shape.

The report includes a schema version, input trace basename and SHA-256, fixture label, declared browser/hardware/cache metadata needed to interpret the sample, event counts, correlation sample values and units, measurement-segment status, and qualification reason codes. It excludes database IDs, full trace payloads, URLs, captions, media details, and unrelated event args. It does not compute p50/p95, FPS, or summary latency statistics.

Use only Node.js built-ins. The command has no network, Cloudflare, browser, server, or app import path. It never invokes capture.mjs and does not write into the pilot run directory.

## Binary checks

- Parsing either original pilot trace preserves its input SHA-256. The 100-item trace contains 1,447 events; the 10,000-item trace contains 2,305.
- Each pilot has three completed EventLatency slices and one unique exact MouseUp-to-MOUSE_RELEASED EventLatency match. The diagnostic input-to-presented-frame samples are 36,873 microseconds and 37,810 microseconds respectively, with exact terminal endpoint agreement and one matching STATE_PRESENTED_ALL reporter for each.
- The 100-item trace has five closed PipelineReporter pairs (two STATE_PRESENTED_ALL and three STATE_NO_UPDATE_DESIRED); the 10,000-item trace has eight (five STATE_PRESENTED_ALL and three STATE_NO_UPDATE_DESIRED). The 10,000-item trace has presented-all records on two renderer/layer streams. No interval may cross between them, and neither pilot has a declared measurement segment, so neither yields a qualified interval series.
- Synthetic tests preserve integer IDs above 2^53 and keep fractional fields numeric; prove sequential local-ID reuse does not cross-pair; accept only the completed MouseUp top-level-hex-id exception; and reject wrong namespaces, malformed IDs, other top-level/global IDs, cross-thread/cross-process b/e pairs, missing/duplicate endpoints, and incomplete slices. Include a MouseUp/EventLatency exact-ID correlation across different processes to pin that event link separately from b/e lifetime pairing.
- Synthetic correlation tests require exact MouseUp/EventLatency identity, both surface and display IDs, the unique closed STATE_PRESENTED_ALL occurrence, and exact terminal timestamps. Require Submit/Swap spans to be uniquely nested children of the matched EventLatency occurrence on the same scoped track. Include a negative case where same-time Submit/Swap spans on a different track cannot be borrowed. Prove the matched reporter's endpoint comes from its own paired occurrence, and any reporter-stage data used belongs to that occurrence. A nearby FRAME_SWAP, an rAF marker, or only one matching ID must produce no qualified sample.
- Synthetic frame tests prove that intervals are emitted only for adjacent presented frames in the declared segment and same renderer/layer stream. Missing segments, missing stream IDs, multiple streams, and action boundaries emit no cross-stream or cross-action interval.
- CLI tests prove basename-only input resolution, no trace mutation, summary-only output, and exclusive no-overwrite output.

The existing pilot is a read-only local acceptance fixture, not a formal benchmark or committed test fixture. The analyzer's successful pilot report must remain explicitly diagnostic: synthetic input, preflight-only hardware metadata, no declared measurement segment, no percentiles, and no Task 6 gate closure.

## Follow-up evidence gates

After independent review of the tool and its output, the evidence owner must define and record the formal input-to-next-paint method and whether input-to-presented-frame satisfies it. Before capture, the owner and performance reviewer must set a minimum sample count for each percentile group; this design does not invent a threshold. A separately authorized capture task must add explicit action boundaries and renderer/layer stream identity to each trace manifest. The complete named-device matrix must then record raw loss-free traces, all required actions for both 100-item interactive and 10,000-item chronological cases, p50/p95 input-to-next-paint and frame intervals, and mounted media counts before and after scrolling. The actual desktop and Samsung Galaxy S25 Ultra browser runs remain outstanding across Chrome, Samsung Internet, and Brave.
