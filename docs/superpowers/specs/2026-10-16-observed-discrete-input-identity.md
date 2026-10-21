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

### 2026-10-21 addendum: analyzer-only Brave 155.0.8059.85 compatibility profile

An additional closed analyzer profile may interpret the exact installed Brave 155.0.8059.85 observation: runtime product `Chrome/155.0.8059.85`; bundle `com.brave.Browser`, short version `155.1.97.59`, bundle version `197.59`, and SCM revision `c7357bfd2a76c2467ba1ae62593a81ae92c05205`; executable SHA-256 `67539969b31e7579456d87ea62d9556f928f9c92af86bb3f43fe33b57d1cfad7`; reduced-UA Chrome token `155.0.0.0`; and `chromiumSourceIdentity: unverified`. The runtime revision prefix `@c7357bfd2a76c2467ba1ae62593a81ae92c0520` and complete Brave bundle revision remain distinct observations. Pin the analyzer's Chromium source-shape basis separately to `0e66b94549a8bd85f03fbdf189b752d6e7b63c32`; keep `vendorPatchIdentity: unverified` and all diagnostic and formal gates.

For this profile only, the analyzer may consume the existing version-two catalog ID `chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99` as diagnostic source compatibility. Observed discrete association for `.85` is limited to schema-version-two evidence; the existing version-one association guard remains `.80`-only. The saved capture and sidecars retain that original `.80` catalog unchanged; the new `.85` source pin describes the analyzer interpretation and was not emitted by the old producer. The compatibility decision is bounded to this exact profile and catalog. It does not infer installed Brave source identity or relax version-two lifecycle, context, PID, frame, DOM, node-mapping, byte, or hash checks.

The consumed upstream files are byte-identical at Chromium `.80` (`43a195105613ac83c21d3f14de279f4a045c7da0`) and `.85` (`0e66b94549a8bd85f03fbdf189b752d6e7b63c32`) pins. Full-file SHA-256 comparison, including the V8 protocol file despite its separate pin change, is the compatibility basis:

| Consumed upstream file | SHA-256 at both pins |
| --- | --- |
| `third_party/blink/renderer/core/timing/performance_event_timing.cc` | `343d1e9cdec53d7c0c302f6700fb4ef4f07ca7d6e61dd8f201d52b18dc809a5f` |
| `third_party/blink/renderer/core/timing/window_performance.cc` | `cea67bf930f75777936e2961aa8356bc69733793471cde0b9d4ae537e1261c57` |
| `base/tracing/protos/chrome_track_event.proto` | `792224c0662edfd70fa4d2b830038067ef6365908e6433d5dab103ab11a4b7ce` |
| `content/browser/devtools/protocol/tracing_handler.cc` | `c576569f0105fca80343bc9cb77a4cf3e2e961fd225b19a390680b3ab45193d2` |
| `third_party/blink/renderer/core/inspector/identifiers_factory.cc` | `8d8ee04ee5253f701bdd0d642ab1e7abade7a645c72f19d31203466ca79ed3bb` |
| `third_party/blink/renderer/core/inspector/inspector_dom_agent.cc` | `e7c983b4b00f47757dbb29c69a129693b8ac61a2e0e60643aa124bbae203c84f` |
| `third_party/blink/public/devtools_protocol/domains/Page.pdl` | `e944a3b19fa2c87b4ed0a84cca85b16b127618725394496ba046a2dfdf9405be` |
| `third_party/blink/public/devtools_protocol/domains/DOM.pdl` | `50c460459e502a0a75a07de32e0589126c737a62f14c6b969df73009f958f702` |
| `third_party/blink/public/devtools_protocol/domains/Inspector.pdl` | `8d00a2b3a556d6b8f5814754eff1e8f632ab93490e2518f95bbf5d35c93075d2` |
| `third_party/blink/public/devtools_protocol/domains/Target.pdl` | `136ca4a240e64aa727e0b261cbe7ac853748154aaa8c4a86fe818d7c522535d6` |
| V8 `include/js_protocol.pdl` (`d89479ac5446a374c55a35be19b5a23437558d99` at `.80`, `712e1808de2d7416f1276d0deb1ee4ac978132b8` at `.85`) | `678fd97bf64779f0a82dba9e02cc00ab21b18eaec6570b10f7bbd63512cc84f0` |

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
- [Brave v1.97.59 release](https://github.com/brave/brave-browser/releases/tag/v1.97.59), [upgrade issue #59971](https://github.com/brave/brave-browser/issues/59971), and [Brave Core revision c7357bfd](https://github.com/brave/brave-core/commit/c7357bfd2a76c2467ba1ae62593a81ae92c05205).
- [Chromium 155.0.8059.85 source tag](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.85), including [PerformanceEventTiming](https://chromium.googlesource.com/chromium/src/+/0e66b94549a8bd85f03fbdf189b752d6e7b63c32/third_party/blink/renderer/core/timing/performance_event_timing.cc#349), [WindowPerformance](https://chromium.googlesource.com/chromium/src/+/0e66b94549a8bd85f03fbdf189b752d6e7b63c32/third_party/blink/renderer/core/timing/window_performance.cc#1317), [EventTiming proto](https://chromium.googlesource.com/chromium/src/+/0e66b94549a8bd85f03fbdf189b752d6e7b63c32/base/tracing/protos/chrome_track_event.proto#2714), [node ID source](https://chromium.googlesource.com/chromium/src/+/0e66b94549a8bd85f03fbdf189b752d6e7b63c32/third_party/blink/renderer/core/inspector/identifiers_factory.cc#123), and [DevTools backend-node mapping](https://chromium.googlesource.com/chromium/src/+/0e66b94549a8bd85f03fbdf189b752d6e7b63c32/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc#2513).
- [V8 712e1808 JavaScript protocol PDL](https://chromium.googlesource.com/v8/v8/+/712e1808de2d7416f1276d0deb1ee4ac978132b8/include/js_protocol.pdl#1520).
