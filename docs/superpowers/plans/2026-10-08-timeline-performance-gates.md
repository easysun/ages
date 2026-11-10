# Timeline Performance Gate Preparation

**Goal:** Close the existing viewport acceptance gates without treating the 100-item functional fixture as evidence for 10,000-record performance.

**Requirements:** `docs/timeline-viewport.md`, acceptance gate 4; `docs/implementation-plan.md`, stage 06. Existing evidence and scoped gaps are recorded in `.superpowers/sdd/viewport-gate-audit.md`. Execute after ContentNodes and ContentEdges integration on an isolated feature branch. This preparation is not an implementation-ready API specification.

## Binding acceptance

- Keep the 100-item keyboard/touch interactive workflow and the complete accessible ordered editing list.
- Exercise a separate 10,000-lightweight-record overview fixture, including initial framing, Fit all, pan, zoom, resize and append.
- Measure input/frame latency and mounted media counts on named hardware and browser versions; retain measurements and reproducible scenario details. No invented FPS threshold or unit-test frame-rate claim.
- Virtualize offscreen media rather than equating lazy image loading or video preload suppression with virtualization.
- Preserve TimelineItem.position, event_at, version and original media identity during viewport operations. Manual framing survives resize/append.
- Preserve readable text, focus, reduced motion, browser magnification and native vertical scrolling. Do not scale the entire editor as a screenshot.

## Preflight and design work

- [ ] Inspect current authorized Timeline detail/list contracts and callers immediately before editing. The existing full item response and missing-asset metadata fan-out are identified risks, not approved large-story contracts.
- [ ] Define and independently review a lightweight authorized overview read contract, stable pagination/version behavior and bounded metadata acquisition. Private/unlisted/moderated content must retain existing access policy; a synthetic client-only fixture cannot establish production large-story support.
- [ ] Define media mounting and offscreen editing/focus behavior before selecting an implementation. Prefer existing platform APIs and dependencies; add no virtualization library solely for convenience.
- [ ] State binary functional pass/fail checks and the measurement protocol before implementation. Hardware-specific measurements establish evidence, not a universal latency guarantee.

## Implementation and validation sequence

- [ ] Add meaningful failing integration/browser cases for the approved contract and media mounting bounds, preserving the existing 100-item functional regression suite.
- [ ] Implement only the reviewed read/mounting changes, then inspect desktop/mobile rendering and keyboard/touch behavior.
- [ ] Profile the 10,000-record scenario on named hardware/browser; record mounted image/video counts and input/frame measurements, including limitations.
- [ ] Run one exact-state full repository check after consolidated self-review, independently review the branch and publish a focused PR with evidence. No deployment or package publication is implied.

## Separate remaining viewport requirement

Chronological overview remains a distinct design/implementation slice: event-time presentation must preserve narrative order, date-only precision, explicit time zones and undated items. This performance slice must not silently waive that open requirement or mutate narrative order to simulate chronology.
