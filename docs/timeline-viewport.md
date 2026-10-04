# Timeline Viewport Design

## Decision and scope

Timeline navigation is a core product capability. Implement continuous, resolution-independent navigation with automatic initial framing. "Lossless" means retaining domain data and redrawing text/vector geometry at the current scale; it does not promise additional detail beyond an image or video's original resolution.

Keep the first implementation inside Ages. Separate a small, dependency-free viewport module from the React renderer and application services. Do not create another repository or publish a package merely to anticipate future reuse.

## Two coordinate modes

- **Story mode (default):** layout follows `TimelineItem.position`. Dates are labels; dragging changes narrative order through the versioned API. Unequal position gaps are not elapsed time.
- **Chronological overview:** coordinates derive from explicitly interpreted event dates, not upload time. Undated items remain available in a labeled group. Date-only events retain their precision and chosen calendar/timezone semantics.

Zooming, panning, resizing, and switching presentation modes never write `event_at`, `position`, or timeline versions. Only explicit editing actions mutate the story. Do not imply proportional elapsed time in story mode.

## Rendering and navigation

Use SVG for the axis/connectors and semantic HTML for readable media cards and controls. Recompute geometry at each view scale; do not scale a screenshot or the entire editor with a CSS transform. Keep labels and controls at readable sizes, showing grouped markers in overview and progressively revealing details. Preserve an accessible chronological/story list independently of the visual overview.

Prefer standard platform APIs and the existing stack. Evaluate `d3-zoom` for the browser gesture adapter when the editor is built; do not import the entire D3 bundle. Its gesture handling is useful, but it does not supply our domain ordering, accessibility, auto-fit policy, or media virtualization. Canvas/WebGL is deferred until profiling demonstrates a need.

Initial fit waits for loaded bounds and a nonzero container measurement. Small stories fit with padding; large stories open a readable view with an overview, rather than shrinking every caption. An explicit **Fit all** control remains available. Once the user navigates, asynchronous media loading, additions, and resize must not reset their chosen view. Resize preserves the focused world coordinate; navigation to another timeline starts a new viewport. Keep viewport state separate from saved content.

Support anchored zoom, pan, zoom-in/out buttons, Fit all, keyboard navigation, and single-pointer alternatives to drag actions. Ordinary mobile scrolling and browser page magnification must remain available. Gesture arbitration, pinch behavior, reduced motion, and focus retention require browser tests before release.

## Module and extraction boundary

The viewport core accepts numeric logical bounds and produces numeric view state. It must not import React, DOM APIs, Cloudflare bindings, authentication, asset delivery, or persistence. A React adapter owns measurement, input events, focus, rendering, and lifecycle. Ages owns authorization, fetching, ordering mutations, and media URLs. Future native or spatial adapters can reuse the contracts without treating browser coordinates as stored domain data.

Extract into a local sibling repository only after a working Ages integration and a second independent example demonstrate reuse, with a stable API, isolated tests, dependency/license review, and a maintenance owner. A separate repository does not itself reduce maintenance. Public release, license choice, and any patent strategy require a separate decision; local repository creation is not authorization to publish proprietary code.

## Acceptance gates

1. Pure tests: fit contains bounds plus padding when allowed by the configured span limits; empty, single-item, identical-date, and zero-size cases remain finite; zoom preserves its anchor; limits clamp; inverse coordinate mapping round-trips within a stated tolerance.
2. State tests: initial fit runs only when measurable; manual navigation survives resize and append; explicit Fit all reframes; no viewport operation mutates timeline data.
3. Browser tests: desktop and 375-pixel mobile layouts, mouse/touch/keyboard controls, browser zoom, reduced motion, and focus retention pass. Text remains readable at overview and detail scales.
4. Performance fixtures: 100 interactive items and 10,000 lightweight overview records. Measure frame/input latency and mounted media counts on named hardware; virtualize offscreen media. Do not claim a frame-rate target from unit tests.
5. Core product regression: reordering, captions, privacy, server version conflicts, and refresh persistence remain correct with viewport navigation enabled.

## Implemented core and remaining integration

`src/timeline/viewport.ts` exports `fitViewport`, `zoomViewport`, `panViewport`, `resizeViewport`, `worldToScreen`, and `screenToWorld`. View state is `{ center, span }` in logical units. Fit accepts measured extent and pixel padding, returning `null` until the container is large enough. Empty content gets a finite default centered at zero; a single coordinate uses the configured minimum span. Zoom factors above one zoom in around a fractional anchor in `[0, 1]`. Resize preserves the center and units per pixel, within limits.

Callers choose unit-appropriate finite positive span limits, skip resize while hidden, and set a maximum span large enough for an intended overview. The module has no date parser, render lifecycle, gesture binding, storage dependency, or automatic data-change listener. The React adapter must implement the initial-fit/manual-navigation policy; it is not provided by these math helpers.

Sixteen unit tests cover these contracts, including millisecond-level event-time round trips and subpixel drift after 1,000 reciprocal zoom pairs. These are numeric guarantees over the tested ranges, not promises of infinite precision or verified screen rendering. The React adapter is implemented in `src/client/story-viewport.tsx`: ResizeObserver measurement, readable initial framing, explicit Fit all, anchored Shift-wheel zoom, pointer pan/pinch, grouped SVG markers, and native keyboard buttons. Its local browser fixtures verify manual navigation after resize/append, unchanged domain data, native vertical scrolling and page magnification, reduced motion, focus, and observer/wheel-listener cleanup. The semantic editable HTML list remains available independently of the overview.

This first adapter uses narrative positions. Chronological overview, 10,000-record virtualization, and named-hardware frame/input latency measurements remain open; the100-item fixture verifies functional behavior without making a frame-rate claim.

## Evidence and intellectual property

[D3 zoom](https://d3js.org/d3-zoom) already supports pan, wheel/pinch zoom, programmatic controls, and multiple rendering surfaces. [SVG coordinate systems](https://www.w3.org/TR/SVG2/coords.html) provide scalable geometry. These are established techniques, not evidence that this product has a patentable invention. [WCAG dragging guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) informs alternatives to drag-only controls.

Technical difficulty alone does not establish patentability. Taiwan's [invention examination criteria](https://www.tipo.gov.tw/tw/patents/998-66049.html) address industrial applicability, novelty, and inventive step, including prior public disclosure. No patent search or legal opinion has been completed. If a concrete technical invention emerges, record it privately and consult a qualified patent professional about target jurisdictions before public disclosure or open-source publication; do not rely on an assumed grace period.
