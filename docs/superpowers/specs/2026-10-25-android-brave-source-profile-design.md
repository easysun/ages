# Android Brave diagnostic source profile

## Purpose
Recognize the installed Android Brave source observed on the authorized S25 Ultra capture without treating macOS bundle identity as Android evidence. This enables discrete EventTiming diagnostic candidates only. The formal performance protocol and its complete browser/action matrix remain unchanged.

## Exact observation contract
The observation root has exactly browser, browserIdentity, qualification, status. Qualification and status both equal `installed-android-brave-schema-probe`.
Browser has exactly product `Runtime Android browser observation` and version `155.0.8059.85`.
BrowserIdentity has exactly platform, package, runtime, chromiumSourceIdentity. Platform has exactly os `Android`, version `16`, apiLevel 36. ChromiumSourceIdentity is `unverified`.
Package has exactly identifier `com.brave.browser`, versionName `1.97.59`, versionCode 429705904, minSdk 32, targetSdk 37, artifacts. Artifacts is an object with exactly these basename-to-SHA256 entries (no paths):
- base.apk: b5cf4775da7b98b49061d95723d586e6fb88043131db1d940912b214b26a8c33
- split_chrome.apk: 055ae12ddb53aac8c7b6d9064d725111f6ab3e7a390f0b04ce01245697fb39d8
- split_config.zh.apk: d151e31a957eadb09d11b85d117d8574f334de045cf1e52d7b61c26e407b6f68
- split_on_demand.apk: 4c4d15e114b1e5689f6d48734aa4de960c53b8918d0698b2f632534fcd1cc893
Runtime has exactly version `155.0.8059.85`, product `Chrome/155.0.8059.85`, revision `@c7357bfd2a76c2467ba1ae62593a81ae92c0520`, userAgent `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36`.
The reduced UA does not establish actual Android OS version. The platform tuple comes from separate authorized device metadata. Unknown, missing, mistyped or changed values at every level reject the profile. Object key order does not matter. Arrays, paths and extra artifacts reject it.

## Analyzer behavior
Use internal profile `android-brave15585`. Permit its signed interaction ID/offset semantics in both legacy and modern crosswalks. Keep all event matching, fallback endpoint requirements, int64 parsing and rejection rules intact.
Return a distinct Android methodScope with observedBrowserVersion, platform `Android`, observedPackageIdentifier, observedPackageVersion, observedRuntimeRevision, chromiumSourceIdentity `unverified`, evidenceClass `installed-android-brave-schema-probe`, vendorPatchIdentity `unverified`, navigationDocumentIdentity `not-inferred`, originScope `capture-case + renderer PID + frame`. Reuse the existing Brave15585 protocol catalog compatibility only as diagnostic compatibility; do not claim desktop executable/source equivalence or add an observedBundleRevision.
Gate reasons include ACTION_ATTRIBUTION_UNPROVEN, INTERACTION_AGGREGATION_UNPROVEN, BROWSER_SOURCE_COMPLETENESS_UNPROVEN, MODALITY_EQUIVALENCE_UNPROVEN, INSTALLED_ANDROID_BRAVE_SCHEMA_PROBE_ONLY, VENDOR_PATCH_IDENTITY_UNVERIFIED, NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED.
FormalActionStatus always remains unavailable and formalActionSamples empty. Do not add this profile to version-two or version-three observer allowlists; observer attribution remains unsupported. With version-three evidence the Android profile must be rejected.

## Boundaries and acceptance
Modify only the existing metrics analyzer and its two tool test files; add these design/plan documents. No CLI production change, dependency, runtime app change, capture protocol change, deployment, device action or raw trace commit. Existing desktop profiles stay compatible. Tests must independently pin the valid contract and rejection mutations, signed bounds, endpoint gates, observer exclusion, redaction and CLI propagation. A private real-capture check may consume ignored evidence but cannot promote formal samples.
