# Installed Brave Schema Probe

## Status

The bounded runner mode and focused tests passed independent review. Capture04 completed all 14 actions, retained 14 loss-free raw traces with matching hashes and byte counts, and exited successfully. Twelve frame segments resolved; the 100-item zoom and 10,000-item open segments remain unavailable. These are schema-probe observations, not formal performance acceptance. Runner Capture01 launched Brave but failed closed during runtime identity validation with `BROWSER_METADATA_UNAVAILABLE` before tracing; it produced zero traces and no manifest. Captures02 and 03 failed closed before tracing because the first `Tracing.getCategories` response was empty; each produced zero traces and no manifest. Initial diagnostics found zero page-target categories and 296 browser-target categories, including all 12 existing candidates, but ordered and same-session diagnostics later showed an empty first browser catalog followed by populated responses (0 then 296; 0 then 272, then 272). This evidence means the scope-only explanation was insufficient: the empty first catalog read is transient startup readiness, while the page-scope difference alone does not explain the failure. Diagnostics closed their CDP sessions, context, and browser successfully and started no server, trace, or navigation. Installed Brave category discovery uses the browser-level catalog and performs exactly one immediate repeat on that same CDP session only when the first response contains an actual empty array. Playwright Chromium retains its single page-level read. The trace-capture session itself is unchanged. No installation, benchmark, or analyzer invocation occurred, and Chromium source identity remains unverified.

## Purpose and invocation

This mode collects one synthetic diagnostic example for each of the existing seven actions on each existing workload: 100 interactive items and 10,000 chronological items. It is intended to inspect the installed Brave trace schema. It does not qualify the formal performance protocol or a physical device.

Run it only with the exact pair `--run --browser=installed-brave`. No arguments continue to print the existing preview; `--run` continues to select the existing Playwright Chromium pilot. The parser rejects duplicate, unknown, executable-path, profile, and fallback flags.

## Installation and launch boundary

The mode accepts only `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`. Before artifact setup or server startup, it checks the bundle identifier and version fields in `Contents/Info.plist`, confirms the bundle directories and plist are not symlinks, and confirms the executable is a regular executable file. It hashes the executable bytes. Missing, redirected, malformed, or non-executable installations fail with a generic error; raw paths and process errors are not printed.

Playwright launches that fixed executable as a browser it owns, then creates a fresh browser context. It does not attach to an existing Brave process or use a persistent user profile. Existing background flags, synthetic fixture setup, and page-request route remain in effect. The route continues only loopback page requests; it is not a process-wide egress wall.

## Evidence and qualification

The run writes below `.superpowers/sdd/installed-brave-schema-probe/runs/`, separate from the Chromium method-pilot artifacts. Its manifest purpose, status, and qualification are `installed-brave-schema-probe`. Cases and exported measurement segments carry the same qualification. The existing raw trace and SHA-256 retention behavior is reused.

Manifest browser identity keeps three observations separate:

- The app bundle identity: `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, and `SCMRevision` when it is a safe revision token.
- The installed executable SHA-256.
- Runtime observations: `Browser.getVersion` product, revision, and user agent, plus Playwright's runtime version observation.

A Chrome-style runtime product or revision does not establish Brave identity or prove which Chromium source revision the vendor binary contains. The installed build reported a runtime revision shaped as `@` followed by 39 lowercase hexadecimal characters; the bounded validator accepts that observed shape along with the existing `@` plus 40-hex and bare 40-hex forms. The runtime revision remains an opaque browser observation. The CDP contract types `revision` as a string, and Chromium's upstream revision template does not attest the installed Brave build's source identity. `chromiumSourceIdentity` remains `unverified`. Metadata is restricted to safe version, revision, and user-agent characters; filesystem paths and raw errors are excluded.

The run preserves `NEXT_PAINT_METHOD_UNPROVEN` in the manifest, every case, and each exported segment. Presented-frame segments remain diagnostic candidates. The offline analyzer is not run, and these fields do not assert formal or vendor-semantic equivalence. Host CPU, memory, and OS observations are marked incomplete and do not satisfy hardware qualification.

## Bounds and remaining gates

The runner reuses the existing 14 cases, synthetic 100/10,000-row fixtures, category probe, action diagnostics, trace hashing, and bounded owned-process cleanup. Installed Brave queries trace categories at browser scope; it makes one immediate second query on the same session only when the first `categories` value is an actual empty array. A populated first response is queried once; malformed responses are not retried; a second empty response fails closed without page fallback. The completed-read count is reported in the Brave manifest and safe CLI diagnostics. The default Playwright Chromium mode keeps its single page-scoped query and unchanged output. Existing 200 ms completion holds remain part of method diagnostics only. This mode does not add 120-trial repetitions (3 sessions of 40), a full benchmark, physical-device qualification, or hardware-matrix evidence.

The route-level request filter is scoped to Playwright page requests. It does not constrain browser-process traffic outside that route. Any formal trace analysis, repeat matrix, phone capture, or hardware qualification remains a separate reviewed gate.

## Implementation verification

The initial runner implementation passed its 37-test file after a RED/GREEN cycle; the two revision-format regressions also passed their focused RED/GREEN checks. For category readiness, the focused test command failed 5 of 6 selected tests before the implementation, then passed 6 of 6 after it. The complete `node --test tests/tools/chromium-method-pilot.test.mjs` run passed 43 tests. `node --check` passed for the runner and its test file; `npx biome check scripts/capture-chromium-method-pilot.mjs tests/tools/chromium-method-pilot.test.mjs` and `git diff --check` passed. The RED, GREEN, full-suite, syntax, Biome, formatting, and diff logs are preserved under `.superpowers/sdd/installed-brave-schema-probe/`. Captures01–03 produced no trace evidence and remain preserved. After independent scoped closure, Capture04 used two catalog reads and completed all 14 actions. Root verified every raw trace SHA-256, byte count, and false data-loss flag against the manifest. It retained bundle version 155.1.97.56 and runtime version 155.0.8059.40 as separate observations. Twelve diagnostic frame segments resolved; the 100-item zoom and 10,000-item open segments remain unavailable. Every case and exported segment retains schema-probe qualification, and next-paint remains unproven. The full `npm run check` completed with exit 0: 618 runtime unit/integration tests, 15 recovery-tool tests, 99 trace-tool tests, and 321 browser tests passed, with one existing browser skip. Client and Worker build checks, lint, and type checks passed. Worker builds were local dry runs.
