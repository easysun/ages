# Chronological Timeline Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add an owner-only chronological overview that keeps calendar-date precision separate from exact UTC instants while leaving story order and editing behavior intact.

**Architecture:** Add pure calendar/instant projection and visible-range indexing, then extend the approved owner-paged overview with an opt-in chronological projection. Integrate that projection into the existing Timeline editor and viewport, preserving (position, id) editing order, stable-ID selection/drafts, independent frames, and the performance design's read/write race rules.

**Tech Stack:** Node.js 22.22.2, npm, TypeScript 6, Hono 4, Zod 4, React 19, Cloudflare Workers D1, Vitest 4, Playwright 1.63, Biome 2.5. Use existing browser APIs and dependencies only.

**Spec:** docs/superpowers/specs/2026-10-08-chronological-overview-design.md

**Rendering contract refinement:** This plan and the spec replace the earlier `O(log n + k)` visible-candidate scan and one-mark-per-date-item interpretation. `k` can be all 10,000 rows under Fit all; the approved occupied-bin bound is normative. Pan/zoom must use binary-searched 48-pixel aggregates and must not enumerate or mount every visible row. The independent plan reviewer must review this refinement.

## Global Constraints

- Do not begin source work until ContentNodes, ContentEdges, and the approved Timeline performance integration are present in the selected base.
- TimelineItem.event_at is the only chronological source. Never substitute Asset.captured_at, upload time, creation time, or position.
- Calendar dates use proleptic-Gregorian label coordinates and retain their saved timezone; never infer a UTC interval or compare a date label with an exact instant on one scale.
- Keep story mode as the default; the editor list, ordinals, focus mapping, and reorder payload remain (position, id) based.
- Keep the full-detail, default overview, mutation, public Timeline, and moderation contracts unchanged. The chronological overview is authenticated, owner-scoped, private, and no-store; another owner's request remains 404.
- Use the integrated performance design's bounded editor windows, owner overview, version pinning, editor-level drafts, and minimal-write acknowledgement path. Do not create parallel routes, queues, cursor rules, or draft state.
- Fetch every overview page until next_cursor is null. Ten thousand is a measurement fixture, not a cap. Overview markers mount no media.
- Add no migration, dependency, public route, or deployment. Keep performance evidence separate from functional tests; report measured values without inventing a frame-rate or latency threshold.
- Run npm run check before each source commit. If source changes after a passing check, rerun it before the next commit; do not repeat a full check against an identical source tree.

## Review Focus

- Four-digit ISO dates, leap years, 0000-01-01/9999-12-31, and locally skipped Pacific/Apia dates must remain finite Gregorian labels with no midnight or next-date timezone lookup. Pin in Task 1.
- Offset instants must sort by normalized UTC epoch independent of their display zone, reject invalid/out-of-range coordinates, and remain incomparable to calendar labels. Pin in Task 1.
- Half-open viewport edges, clipped date-span coverage, unique midpoint membership, lazy chooser paging, and 10,000-row Fit all aggregation must use bounded binary searches, with at most one mark per occupied 48-pixel bin. Pin in Tasks 1 and 3.
- Default versus chronological projection shape, projection-bound cursors, owner checks, and same-batch snapshot version checks must remain compatible. Pin in Task 2.
- A read/auth/Timeline switch racing a committed write must not lose expected_version + 1, drafts, focus, or manual frames, and must never replay a committed append. Pin in Task 3.

---

## Execution preflight

This plan can be reviewed before its prerequisites are integrated; implementation cannot. Before touching source, verify that the selected base includes the approved ContentNodes, ContentEdges, and Timeline performance changes. When this plan was drafted, the Timeline route had the full-detail endpoint but no owner overview route. Verify the integrated overview contract in the selected base; do not implement against the earlier state or invent a substitute API. Start feat/chronological-overview from the actual integrated base and record its actual git rev-parse HEAD. If any prerequisite contract is absent or differs from the approved designs, stop before source work and reconcile the plan against the integrated contracts.

### Task 1: Add pure event-time projection and visible-range indexes

**Files:**
- Create: src/timeline/chronological.ts
- Create: tests/unit/timeline-chronological.test.ts

**Interfaces:**
- Consume EventAt as a type from src/timeline/validation.ts; keep the browser-shared coordinate module free of runtime dependencies and DOM/React/storage APIs.
- ChronologicalOverviewRow = Readonly<{ id: string; position: number; event_at: unknown }> is the untrusted projected input.
- CalendarDateBand = Readonly<{ id: string; position: number; date: string; time_zone: string; dayOrdinal: number; start: number; end: number }> where start === dayOrdinal and end === dayOrdinal + 1.
- ExactInstantPoint = Readonly<{ id: string; position: number; instant: string; time_zone: string; epochMs: number }>.
- DateBinAggregate = Readonly<{ bin: number; pixelStart: number; pixelEnd: number; spanCoverageCount: number; itemCount: number; firstItemIndex: number; endItemIndex: number; firstDate: string | null; lastDate: string | null }> where item indices are the contiguous `dates` slice whose clipped-span midpoint belongs to that bin; first/last date are null when the bin contains span coverage but no midpoint member.
- ChoiceRange = Readonly<{ firstItemIndex: number; endItemIndex: number }> and ChoicePage<T> = Readonly<{ items: readonly T[]; nextOffset: number | null }>.
- ChronologicalIndex = Readonly<{ dates: readonly CalendarDateBand[]; instants: readonly ExactInstantPoint[]; instantCoordinates: readonly number[]; undated: readonly Readonly<{ id: string; position: number }>[]; storyOrdinalById: ReadonlyMap<string, number> }>.
- Produce buildChronologicalIndex(rows: readonly ChronologicalOverviewRow[]): ChronologicalIndex, aggregateDateBins(index: ChronologicalIndex, view: Viewport, extent: number, binWidth?: number): readonly DateBinAggregate[], and pageChoices<T>(items: readonly T[], range: ChoiceRange, offset?: number, limit?: number): ChoicePage<T>. Import Viewport from src/timeline/viewport.ts as a type only. Default the date bin width to 48 CSS pixels and cap every chooser `limit` at 100. Use `pageChoices` for date midpoint slices, exact-point helper groups, and the single Undated index range. Malformed projected values fail the complete build; they never become undated rows. The offset is local to the accepted snapshot and group; date chooser offsets are also frame-local, so changing the snapshot or frame discards that chooser.
- Keep `instantCoordinates` index-aligned with `instants`, sorted by `(epochMs, id)`, and pass it to the 48-pixel occupied-bin helper added by the performance integration. Do not map visible instant rows during a render. Build `storyOrdinalById` once from `(position, id)` order so a chronological selection maps back to narrative order without using the chronological array index.
- Date rows sort by (dayOrdinal, time_zone, id), instant rows by (epochMs, id), and undated rows by (position, id). Date sorting is by stored ISO label; timezone is only the deterministic presentation tie-break for equal labels.

- [ ] **Step 1: Write failing coordinate, aggregate, and paging tests.** Add tests named maps_date_labels_to_gregorian_ordinals_without_timezone_conversion, normalizes_exact_instants_to_utc_epochs_and_orders_equal_points_by_id, keeps_null_events_undated_and_rejects_malformed_projection_rows, aggregates_clipped_date_spans_with_unique_midpoint_membership, performs_bounded_binary_search_work_for_fit_all_10k_dates, and pages_group_choices_without_enumerating_remaining_ids. Cover date ordinals for 0000-01-01, the epoch date, leap-day/non-leap-century rules, and 9999-12-31; assert Pacific/Apia dates 2011-12-29 and 2011-12-30 remain adjacent `[dayOrdinal, dayOrdinal + 1)` calendar-label bands without resolving local midnights; prove the date helper never parses a bare date. Cover offset-normalized UTC instants with distinct display zones, equal-instant ordering by ID, identical coordinates when only position changes, invalid/out-of-range instant rejection, malformed EventAt rejection, null-only undated membership, and deterministic date/timezone ties. Compare each aggregate's coverage count against a per-row test oracle for half-open edge touches, clipped offscreen starts/ends, equal dates, and spans crossing multiple bins; verify each ID contributes to exactly one midpoint group. On a 10,000-row Fit all fixture, require at most four binary searches per 48-pixel bin, no candidate-row enumeration, and no more aggregate outputs than occupied bins. Page a 10,000-item single-bin date group, a 10,000-point equal-instant group, and a 10,000-item Undated group; each first page reads at most 100 sorted IDs, preserving `(dayOrdinal, time_zone, id)`, `(epochMs, id)`, and `(position, id)` order respectively.
- [ ] **Step 2: Run the focused unit tests and confirm they fail before implementation.**

  Run: npx vitest run tests/unit/timeline-chronological.test.ts

  Expected: the new module and coordinate/index contracts are missing; existing viewport tests remain unchanged.
- [ ] **Step 3: Implement the pure projection and bounded date-bin helpers.** Use integer proleptic-Gregorian arithmetic for date ordinals; do not use Date.parse, host timezone behavior, midnight resolution, or conversion of date-only values. This treats a stored date as a calendar-label interval even when that date is skipped in its valid IANA zone; DST midnight gaps/folds require no boundary guess or dependency. Parse only the complete normalized UTC instant string for `epochMs` and reject non-finite values outside the inclusive ECMAScript Date range `[-8.64e15, 8.64e15]`. Validate the strict EventAt discriminator/field shape, date validity, and IANA identifier with built-in Intl (cache validation by distinct zone during one index build); do not import Zod at runtime into the browser-shared helper. Publish no partial index on malformed input. Build `instantCoordinates` and the `(position, id)` story-ordinal map once per accepted snapshot.
- [ ] **Step 4: Add per-bin binary searches and bounded chooser paging.** For each 48-pixel date bin, binary-search twice by `dayOrdinal` for bands intersecting that bin's half-open world interval, and twice by monotonic clipped-span midpoint for unique chooser membership; return counts and the contiguous midpoint slice without iterating its rows. Return one aggregate per occupied bin, with separate `spanCoverageCount` and unique `itemCount`; its date range comes from the midpoint slice endpoints when `itemCount > 0`. `pageChoices` reads only the requested ≤100 rows from the supplied range. Use the integrated point-bin helper over the precomputed `instantCoordinates` for the instant lane; convert its contiguous ordinal group bounds to an index range and pass those to `pageChoices`. Use the same helper for the `(position, id)`-sorted Undated range. Tests instrument array reads and require no more than four `ceil(log2(n + 1))` search comparisons per date bin plus constant endpoint reads, including when all 10,000 rows are visible; verify aggregate output and DOM-ready marker count are bounded by occupied bins. Keep an oracle loop in tests only to prove coverage counts and half-open clipping are exact.
- [ ] **Step 5: Run the focused unit tests and confirm they pass.**

  Run: npx vitest run tests/unit/timeline-chronological.test.ts tests/unit/viewport.test.ts

  Expected: coordinate, precision, ordering, half-open clipped coverage, unique midpoint membership, bounded 10,000-row Fit all work, lazy chooser, invalid-input, and sparse-query checks pass with no new dependency.
- [ ] **Step 6: Run npm run check and commit the helper only after it passes.**

  Run: npm run check

  Expected: build, lint, typecheck, tests, and Playwright pass. Commit as feat: add chronological timeline indexing.

### Task 2: Add the compatible owner-only chronological overview projection

**Files:**
- Modify: the overview query schema in src/timeline/validation.ts introduced by the performance integration
- Modify: the owner overview handler in src/routes/timelines.ts introduced by the performance integration
- Test: tests/unit/timeline-validation.test.ts
- Test: tests/integration/timelines.test.ts

**Interfaces:**
- Consume the integrated GET /api/timelines/:id/overview first-page, cursor, inclusive lower-bound, count, summary, version, and owner-check contracts from the approved performance design. Extend their actual schema and handler names in place; do not create a second overview endpoint or guess an unintegrated helper name.
- Accept only an optional projection=chronological selector. With the selector omitted, preserve the integrated default { id, position } page shape exactly. With it, return the same envelope and rows { id, position, event_at }, where event_at is the parsed existing EventAt | null; include no caption, asset metadata, or media URL.
- Bind continuation cursors to Timeline ID, projection, and exclusive (position, id) key. Require the existing pinned version on continuations/lower-bound reads and retain the same 1–1,000 page limit.

- [ ] **Step 1: Add failing integration cases on the integrated performance overview.** Add cases named keeps_default_overview_shape_and_returns_event_at_only_for_chronological_projection, binds_chronological_cursor_to_timeline_projection_and_snapshot_version, and pages_all_10001_chronological_rows_without_a_10000_cap. Verify omitted-selector responses are shape-compatible with the default overview; chronological pages contain date, instant, and null values in story keyset order with no extra fields; an unknown projection, another owner, a cursor reused across projections/Timelines, and stale continuation/lower-bound reads fail without rows. Assert owner/version and projection reads still use one D1 batch and responses remain private/no-store. Verify the existing owner visibility of moderated items remains the same for both projections. Extend the existing set-based fixture to 10,001 rows and require every unique ID across exactly eleven 1,000-row pages, with next_cursor null only on the last page. Keep public route/moderation behavior unchanged.
- [ ] **Step 2: Run focused tests and confirm the new projection cases fail.**

  Run: npx vitest run tests/unit/timeline-validation.test.ts tests/integration/timelines.test.ts

  Expected: the integrated default overview passes its existing cases; chronological selector/cursor/row-shape cases fail until added.
- [ ] **Step 3: Extend the existing overview selector and projection in place.** Select event_at only for projection=chronological; parse its stored JSON through the existing EventAt contract before returning it. Keep the default projection, full-detail route, mutation responses, public routes, owner policy, D1 snapshot batch, and moderation visibility unchanged.
- [ ] **Step 4: Run focused schema and integration tests and confirm both projections pass.**

  Run: npx vitest run tests/unit/timeline-validation.test.ts tests/integration/timelines.test.ts

  Expected: default compatibility, owner privacy, projection-bound paging, same-batch version pinning, and complete 10,001-row paging pass.
- [ ] **Step 5: Run npm run check and commit this additive read contract only after it passes.**

  Run: npm run check

  Expected: the full repository check passes. Commit as feat: add chronological overview projection.

### Task 3: Integrate chronological tracks with the bounded editor and write lifecycle

**Files:**
- Modify: src/client/main.tsx
- Modify: src/client/timelines.tsx
- Modify: src/client/story-viewport.tsx
- Modify: src/client/styles.css
- Modify: tests/e2e/fixtures.ts (reuse the performance integration's large-timeline fixture; extend it only if it cannot seed date/instant/null values)
- Modify: tests/e2e/timeline.spec.ts

**Interfaces:**
- TimelineScreen receives authGeneration: number; src/client/main.tsx passes its current generation, following the existing Content and Tracking screens.
- Consume the integrated owner-paged overview and bounded detail-window APIs and the integrated minimal-write operation path. If those contracts are absent, this task is blocked by the preflight; do not add a parallel fetch/mutation path or change src/client/api.ts response semantics here.
- Use ChronologicalOverviewItem = Readonly<{ id: string; position: number; event_at: EventAt | null }> for the complete pinned projection. Pages stay (position, id) ordered, so this one chronological projection can also supply the story ID/ordinal index; avoid a duplicate full story-projection fetch. If an integrated caller already has both projections, combine only after matching Timeline ID and version.
- The viewport mode is story | chronological; track keys are story | calendar-date | exact-instant. Keep independent { view, extent, manual } state for each track. Story remains selected on first visit.
- Marker selection uses id; TimelineEditor maps it to (position, id) and requests/focuses the bounded editor window containing that ID. Never map by a date coordinate or chronological array index.
- Read ownership is (authGeneration, timelineId, readGeneration, pinnedVersion). Mutation ownership is (authGeneration, timelineId, operationId, expectedVersion) and is independent of read generation.
- Define TimelineMutationRecord = { operationId: string; timelineId: string; authGeneration: number; expectedVersion: number; status: "pending" | "committed"; committedVersion?: number }. TimelineScreen owns records above the keyed TimelineEditor so a record survives selecting another Timeline. The child registers a write before sending it and records 204 commitment through the parent before applying any current-screen patch; clear records on logout/current-generation authorization failure.

- [ ] **Step 1: Add failing browser cases using the integrated paged editor fixture.** Add a case named loads_the_complete_10000_row_chronological_overview_before_showing_markers that visits first, middle, and last rows, confirms no overview media fan-out, and asserts date and instant geometry nodes are bounded by occupied 48-pixel bins; a case named chronological_tracks_keep_date_precision_instant_utc_and_undated_items that checks the default story mode, stored labels/timezones, UTC instant labels, one aggregate Undated control, accessible track names, and explicit no-cross-lane-order statement; and a case named clipped_date_spans_have_unique_chooser_membership that checks exact half-open clipped-coverage counts for an offscreen-start span and multi-bin spans, one midpoint-bin membership per ID, and date/instant/Undated chooser pages capped at 100 choices. Also test stable-ID selection into the correct bounded story window at a 375-pixel viewport. The 10,001-row API paging case is owned by Task 2.
- [ ] **Step 2: Add failing state/race cases.** Add cases named preserves_all_three_manual_frames_across_mode_switches_and_resize, retains_drafts_and_field_focus_across_window_changes_and_conflicts, rejects_old_read_and_auth_generation_responses, acknowledges_date_edit_before_stale_read_reconciliation, and does_not_replay_append_after_chronological_409_or_timeline_switch. Assert first visit fits complete track bounds only after data and nonzero measurement; Fit all changes only its own track; separate story/date/instant frames survive mode switches, track switches, resize, append, page arrivals, and event-date edits; resize retains focal coordinate and units-per-pixel subject to span clamps; viewport gestures do not mutate event_at, position, or version; dirty caption/date/kind/time-zone values and focused field survive window changes and 409 refresh; current-generation 401/403 clears private editor state and an earlier-generation failure cannot clear a newer session; a date edit receiving 204 while a new read starts records exactly expected_version + 1 before reconciliation and updates/reindexes only the matching displayed version; a stale chronological/tail 409 after append cannot restore the pending picker selection or replay the committed asset; switching Timelines during a write cannot let its result alter the newly selected editor, and returning to the old Timeline does not replay the acknowledged append.
- [ ] **Step 3: Run focused browser tests and confirm the mode and race cases fail against the story-only viewport.**

  Run: npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop --project=mobile

  Expected: existing story viewport tests pass; new mode, ID mapping, paging, and chronological race cases fail before integration.
- [ ] **Step 4: Pass the access generation and load one complete pinned chronological projection.** In src/client/main.tsx and src/client/timelines.tsx, pass/capture authGeneration, Timeline ID, read generation, and pinned version. Request projection=chronological using the integrated overview route, fetch every cursor, and publish the index only after all pages share the same Timeline/version. Retry a transient failed page at the pinned version; on 409 discard the mixed snapshot and restart from a fresh first page. Show an incomplete/loading state until complete. Clear all private overview/detail/draft/picker/selection/mutation state on logout or current-generation authorization failure; old-generation failures cannot clear a newer session.
- [ ] **Step 5: Implement stable-ID selection and independent viewport tracks.** Extend the existing StoryViewport boundary and styles with the story/chronological mode control, keeping story default. Keep the story semantic list in `(position, id)` order. Render separate Calendar dates and Exact instants tracks with track-local zoom/pan/Fit all controls and independent frame state. First visit fits full track bounds only after the complete index loads and the track has a nonzero measurement; later visits restore its frame. Pan, zoom, Fit all, resize, page arrivals, appends, event-date edits, and mode switches preserve manual frames; resize preserves the focal coordinate and scale; Fit all changes only its own track; changing Timeline resets all three frames. Build date/instant indexes once per accepted snapshot; pan/zoom must use Task 1 bin aggregates and the integrated instant-point helper, never map or enumerate all visible rows. For dates, binary-search span coverage per bin and midpoint membership separately; render at most one aggregate mark per occupied 48-pixel bin with the exact `spanCoverageCount` and unique `itemCount`. Each band's clipped half-open interval contributes to every bin it intersects, including offscreen-start/end clipping; its stable ID belongs to only the bin containing the clipped pixel midpoint. Bins without midpoint members are noninteractive geometry; chooser entries are read only on activation, at most 100 per page, and retain full date/timezone. Keep exact instants in their UTC lane and render Undated as one aggregate control over all null events; only enumerate `(position, id)` choices when activated, in pages of at most 100. Make track labels, unique group count/date range, span-coverage meaning, stored timezone/precision, UTC instant labels, and the no-cross-lane-order statement available to keyboard and screen-reader users. Map marker/chooser selection back to the narrative ordinal by stable ID, using the `(position, id)` index. Viewport input never changes `event_at`, `position`, or Timeline version. Preserve current keyboard controls, focus visibility, reduced motion, vertical page scrolling, mobile layout, and browser magnification.
- [ ] **Step 6: Integrate date edits and appends with the performance design's mutation record.** Reuse its write function and operation registry. On a current-auth 204, record the captured operation's committed version expected_version + 1 in TimelineScreen's TimelineMutationRecord before awaiting any read, even if read generation changed or another Timeline is selected. Patch the projected event_at only when the displayed snapshot is exactly expected_version, rebuild affected indexes once, and retain the same selected ID, field focus, drafts, and manual frames. Mark a committed append and remove it from that Timeline's pending picker selections before reconciliation; a failed/stale tail or chronological page pauses later writes and never replays the append. When returning to a Timeline with a committed record, reconcile before enabling writes. A mutation 409 records no commit and uses the draft-preserving refresh path. Never apply an old Timeline/auth result to the current screen.
- [ ] **Step 7: Run focused unit and desktop/mobile browser suites and confirm all new cases pass.**

  Run: npx vitest run tests/unit/timeline-chronological.test.ts tests/unit/viewport.test.ts

  Run: npm run build:client && npx playwright test tests/e2e/timeline.spec.ts --project=desktop --project=mobile

  Expected: the existing 100-item interactive, reorder, refresh, touch, focus, and magnification cases pass; new 375-pixel mobile, track-frame, exact bin-aggregate/clipping, chooser, identity, draft, privacy, and race cases pass. The 10,000-row overview is complete, mounts no overview media, renders at most one date/instant group mark per occupied 48-pixel bin, and keeps 10,000 undated items in one aggregate control with paged choices; the API 10,001-row case remains an eleven-page proof.
- [ ] **Step 8: Run npm run check and commit the integrated client boundary only after it passes.**

  Run: npm run check

  Expected: the full repository check passes. Commit as feat: add chronological timeline overview.

## Evidence gate after source work

- Reuse the passing full npm run check from immediately before the final source commit if no source changed afterward. If a source fix is needed, rerun focused tests and the full check before a follow-up commit; do not repeat an identical full check.
- Measure the existing 100-item interactive case and chronological 10,000-record overview on at least one explicitly named physical desktop and one explicitly named physical phone/browser, following docs/superpowers/specs/2026-10-08-timeline-performance-design.md. Record actual hardware model/chip and memory, OS build, browser/version, viewport, device scale factor, display refresh, fixture revision, and cache state.
- For open, Fit all, pan, zoom, resize, append, and scroll, retain raw traces and report p50/p95 input-to-next-paint and frame intervals plus mounted image/video counts before and after scrolling. Keep the 100-interactive and 10,000-lightweight cases separate. Report measurements without an FPS/latency threshold; synthetic Playwright results are functional evidence, not phone-hardware performance. Missing device names, raw traces, or media counts leaves this evidence gate open.
- Attach the reproducible scenario and named-device evidence to the implementation review. Do not deploy or publish from this plan.
