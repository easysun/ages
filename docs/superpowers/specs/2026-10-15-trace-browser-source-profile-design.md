# EventTiming browser source profile guard

## Design and status

The diagnostic-only EventTiming crosswalk is enabled only when the caller supplies browser observations identifying the exact known profile: product `Playwright Chromium` and version `153.0.8010.12`. `analyzeTrace(trace, record, segments, sourceObservations)` keeps its existing first three arguments; absent, malformed, unknown, contradictory, or unsupported observations disable only this crosswalk. The CLI passes the manifest's `browser`, `browserIdentity`, `qualification`, and `status` fields. Supplied status and qualification values must identify `synthetic-method-pilot`.

The shared validator also rejects contradictory runtime identity, vendor bundle identity, unexpected observation fields, and any attempt to supply an alternate profile name or Ages `sourceRevision` as browser proof. When a runtime user agent is supplied, every whitespace-delimited `Chrome/` product token must carry the complete pinned version; embedded substrings and conflicting product tokens are rejected. The Chromium source revision remains the pinned method scope; the manifest's Ages revision is separate. Browser observations are assertions from the manifest, not attested or signed identity.

For unsupported observations, the crosswalk returns `unavailable`, empty duration and formal-sample arrays, `methodScope: null`, and only the fixed reason `BROWSER_SOURCE_PROFILE_UNSUPPORTED`. Inventory, EventLatency, input-to-presented-frame, and frame-interval analysis continues unchanged. The known 153 profile retains its existing exact-identity diagnostic math, fallback checks, pinned scope, and unverified vendor-patch label; it does not promote formal samples.

Installed Brave 155 schema-probe output remains unsupported, including a manifest whose top-level browser fields are forged to say Playwright Chromium 153 when its supplied Brave identity or probe qualification contradicts that claim. This change does not alter crosswalk math, add a browser registry, or add any dependencies. Guarded offline verification on 14 existing Brave traces confirmed that the source-specific crosswalk remains unavailable; generic inventory and frame diagnostics remain available. All raw trace byte counts and SHA-256 values were unchanged.

## Verification

- RED-01: the focused pair ran 59 tests and failed the three new source-profile cases against the old unconditional behavior.
- RED-02: malformed runtime revision reproduced `TypeError: runtime.revision.replace is not a function`.
- GREEN-02: the targeted malformed-observation case passed after validation was hardened.
- GREEN-03: `node --test tests/tools/chromium-trace-metrics.test.mjs tests/tools/chromium-trace-cli.test.mjs` passed all 59 tests.
- Biome check passed for the four changed script and test files; `node --check` passed for all four; `git diff --check` passed for the tracked patch.
- User-agent review RED: the exact-token regression set passed the valid pinned token and failed all three invalid-token cases against the former substring check; the focused pair then passed all 63 tests.
- RED/GREEN and validation logs are retained under `.superpowers/sdd/trace-browser-source-profile/`. The pre-existing `reuse-preservation-01.json.log` and its eight artifact hashes were preserved.

- Full `npm run check` passed with exit 0: 618 runtime unit/integration tests, 15 recovery-tool tests, 106 trace-tool tests, and 321 browser tests passed; one existing browser test was skipped. Browser tests took 21.5 minutes. Lint, type checks, client build, and local Worker build dry runs passed.
