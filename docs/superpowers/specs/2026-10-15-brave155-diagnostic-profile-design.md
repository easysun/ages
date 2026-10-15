# Brave 155 Diagnostic EventTiming Profile

## Design and scope

The EventTiming crosswalk now has two separate asserted profiles. The existing Playwright Chromium 153.0.8010.12 profile keeps its current validation, signed-to-unsigned normalization, method scope, gates, and candidate math. The additional Brave profile is enabled only by the complete installed-browser observation tuple below; missing, malformed, unknown, conflicting, or forged observations keep the crosswalk unavailable with the fixed `BROWSER_SOURCE_PROFILE_UNSUPPORTED` reason and `methodScope: null`.

The Brave tuple records these values independently:

- Manifest browser: product `Runtime browser observation`, version `155.0.8059.40`.
- Qualification and status: `installed-brave-schema-probe`.
- Bundle: identifier `com.brave.Browser`, short version `155.1.97.56`, bundle version `197.56`, SCM revision `b01cdf43be4b4d5559bf7e58229e666e24454f50`.
- Executable SHA-256: `6099adb0e47d7c12922bb2dca02e2a044b71ae2895c0bbab1717f8660ffb99a7`.
- Runtime: version `155.0.8059.40`, product `Chrome/155.0.8059.40`, revision `@b01cdf43be4b4d5559bf7e58229e666e24454f5`, and a required user-agent string whose every whitespace-delimited `Chrome/` product token is exactly `Chrome/155.0.0.0`.
- `chromiumSourceIdentity`: `unverified`.

The runtime version, bundle versions, runtime revision, and bundle SCM revision are distinct observations and are validated separately. The executable hash identifies the asserted observed bytes; it does not attest the binary or establish vendor source equivalence. The user-agent string is validated but never copied into the crosswalk report.

The 155 method scope pins Chromium source revision `cfaadc5a132d78e1828635aa8405a499f3e14864` and separately names published Brave Core revision `b01cdf43be4b4d5559bf7e58229e666e24454f50`. Its evidence class is `installed-brave-schema-probe`; vendor patch identity remains `unverified`; navigation document identity remains `not-inferred`; origin scope remains `capture-case + renderer PID + frame`. Its gates retain unproven action attribution, interaction aggregation, source completeness, modality equivalence, vendor patch identity, and navigation identity. `SYNTHETIC_METHOD_PILOT_ONLY` is replaced by `INSTALLED_BRAVE_SCHEMA_PROBE_ONLY` for this profile.

## Crosswalk constraints

The 155 profile requires both legacy `interactionId` and `interactionOffset`, and modern `interaction_id` and `interaction_offset`, to be exact integers from 0 through 2,147,483,647 before identity normalization and crosswalk matching. Missing and malformed values keep their existing rejection reasons. A negative or larger value produces `BRAVE_SIGNED_IDENTITY_OVERFLOW_UNVERIFIED`; the analyzer does not wrap or truncate it. The legacy 153 profile retains its prior signed normalization.

Both profiles use the existing typed slice pairing and exact same-entry crosswalk behavior. Pairing still requires complete begin/end slices with their expected categories and typed IDs, exact process/thread/frame/node/cancelable/event identity, matching processing endpoints, explicit fallback reason `None` with zero fallback time and no `fallback_time_us`, unambiguous identity, and a supported DOM event mapping. `n` markers remain diagnostics and never become candidates, even when they carry an event-timing payload. Candidates remain `diagnostic-only`; `formalActionStatus` stays `unavailable` and `formalActionSamples` stays empty.

## Source basis and limits

At the pinned Chromium revision, [`window_performance.cc`](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/third_party/blink/renderer/core/timing/window_performance.cc#1215) contains the legacy EventTiming and modern EventProcessing trace emission paths. [`performance_event_timing.cc`](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/third_party/blink/renderer/core/timing/performance_event_timing.cc#152) defines EventTiming timestamp and interaction identity behavior; the [`Chrome track-event proto`](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/base/tracing/protos/chrome_track_event.proto#2543) defines the emitted event-timing payload. The published release record is [Brave v1.97.56](https://github.com/brave/brave-browser/releases/tag/v1.97.56).

Source-shape agreement supports a diagnostic crosswalk only. This work does not audit the complete Brave patch set, attest the installed binary, prove Brave-to-Chromium source identity, establish action attribution or next-paint semantics, or qualify formal performance results.

## Verification

- RED: the new Brave-profile tests failed while the old analyzer returned the fixed unsupported result for the complete Brave tuple (four selected metrics tests and one CLI test failed as expected).
- GREEN: `node --test tests/tools/chromium-trace-metrics.test.mjs tests/tools/chromium-trace-cli.test.mjs` passed all 70 tests, including the existing 153 signed-normalization regressions and the new Brave tuple, boundary, pairing, and CLI cases.
- `npx biome check scripts/chromium-trace-metrics.mjs scripts/analyze-chromium-traces.mjs tests/tools/chromium-trace-metrics.test.mjs tests/tools/chromium-trace-cli.test.mjs`, `node --check` for those four files, and `git diff --check` passed.
- One guarded offline analysis of the 14 preserved Capture04 traces exited successfully. Eleven traces produced 55 diagnostic candidates; three remained unavailable. The analyzer rejected 150 markers and 590 unsupported event types. All 14 raw byte counts and SHA-256 values matched the manifest and remained unchanged; all data-loss flags were false. Every result retained the 155 scope and qualification gates, with no formal action samples.
- Full `npm run check` passed with exit 0: 618 runtime unit/integration tests, 15 recovery-tool tests, 113 trace-tool tests, and 321 browser tests passed; one existing browser test was skipped. Browser tests took 21.6 minutes. Lint, type checks, client build, and local Worker build dry runs passed.
