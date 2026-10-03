# Ages Development Handoff

## Goal and scope

## Public Timeline checkpoint — October 4, 2026

This is the current checkpoint for isolated `feat/public-timeline` at `/Users/bay/.codex/worktrees/public-timeline/ages`. Earlier Root, Timeline, and Library checkpoints are preserved below.

### Last three checkpoints

1. Created the isolated branch at reviewed Timeline commit `cf7ab6a`. Installed the committed dependencies with `npm ci --cache /private/tmp/ages-npm-cache --prefer-offline` (zero reported vulnerabilities). All 26 new public SSR/media integration tests failed before implementation against missing routes and cache-policy behavior.
2. Added escaped Hono HTML SSR at `/t/:id`, same-owner item/cover authorization for `/t/:id/media/:assetId`, and reusable `src/media/stream.ts`. All 26 tests passed; full check passed 178 tests, lint, types, and Worker dry-run build. Local migrations 0001–0003 plus 0005 and rerun passed. Actual local HTTP and desktop/375-pixel browser inspection showed synthetic media loaded, and mobile document scroll width equaled the 375-pixel viewport. Implementation commit: `7a79c3f`.
3. Merged announced `origin/main` at `2b9870a`, preserving Library and Timeline route/docs/checkpoints, and routed owner Library media through the shared helper; removed its duplicate range implementation. Combined full check passed 237 tests in 12 files, lint, types, and dry-run build. The 59 Library tests also passed separately. A fresh local D1 database applied 0001–0005 in order; rerun reported no migrations to apply. Whitespace checks passed. Integration merge: `e519001`.

### Contract and remaining gates

- Canonical and OG origins come from configured APP_ORIGIN, never request Host/query input. Story order follows item position. Date-only labels retain their calendar precision; instants display in their named timezone. HTML uses escaped interpolation with no executable script. Unlisted emits noindex; public emits index; private/missing content and media return generic 404 even for owner cookies.
- Media access depends on current timeline visibility, same-owner ready/undeleted asset, and an actual item or cover association. Private Asset visibility is not rewritten to share through a timeline. The shared streaming helper authorizes nothing; callers authorize first. Both Library and viewer keep private/no-store/nosniff, conditional R2 ETag reads, MIME/size checks, and R2 head/read version consistency. No KV caching, private grants, Links, or QR codes were added.
- Screenshot evidence: `/private/tmp/ages-proof/public-desktop.jpg` and `/private/tmp/ages-proof/public-mobile.jpg`; local HTTP capture: `/private/tmp/ages-public-preview.html` and `.headers`. Preview uses synthetic assets only in ignored local state, with temporary fixture files outside the repository. No fixture data was added to runtime source.
- Next: root independently reviews this public-viewer branch, integrates it using a normal merge (the Library helper refactor is in merge commit e519001), reruns combined checks with other slices, and handles focused PR/CI/merge. This implementer did not push, publish a PR, merge to main, or deploy. No cloud smoke or crawler behavior is claimed.
- Interactive React Library/editor, mobile/keyboard browser regression tests, Timeline viewport integration/performance, large-story virtualization, real direct-upload/Google-login/cloud smoke, scheduled cleanup, rate limits, and abuse controls remain open. Link distribution and recoverable asset trash/restore are separately owned worktrees; do not edit their files or migration 0006 from this branch.

## Root integration checkpoint — October 4, 2026

- PR #5 passed independent Library review (59 tests rerun) and latest GitHub CI, then merged into main as `88919b5`. Root main was fast-forwarded without changing the original checkout.
- Root integrated Timeline commit `cf7ab6a` onto updated main as `80c1539` on `feat/timeline-api`, preserving both route sets and both README/HANDOFF sections. Independent Timeline review reran all 152 tests and found no blockers. Known limits remain the 1,000-ID reorder bound and a permissive list cursor contract; SQL ownership still applies.
- Fresh combined `npm run check` passed lint, types, 211 tests in 11 files, and Worker dry-run build. Local migration 0005 applied after 0004; rerun reported no migrations to apply. No deployment occurred. Next: publish the focused Timeline API PR, verify CI, merge, then integrate the remaining product slices.
- Isolated writers now own React Library at `/Users/bay/.codex/worktrees/react-library/ages`, public Timeline SSR at `/Users/bay/.codex/worktrees/public-timeline/ages`, and recoverable Asset trash/restore at `/Users/bay/.codex/worktrees/asset-trash/ages`. Their commits and acceptance gates remain pending. Keep the three earlier checkpoints below intact.
- The reset continuation remains scheduled once at 2026-10-04 04:56:52 Asia/Taipei with exact prompt `繼續執行`. Cloud bindings/login, real browser R2 upload, 250 MB upload, editor integration, sharing, abuse controls, and operations gates remain open; the MVP is not complete.

## Timeline domain checkpoint — October 4, 2026

This section describes the isolated `feat/timeline-domain` worktree at `/Users/bay/.codex/worktrees/timeline-domain/ages`, based on `3590b41`. It supersedes historical next steps for this branch only. Library is a parallel slice; no Library or original-checkout files were edited here.

### Last three checkpoints

1. Read the repository contracts and approved Timeline design, created the isolated branch, and installed the committed dependencies with `npm ci --prefer-offline` (zero reported vulnerabilities). Twelve behavior-focused real D1 tests failed against the missing Timeline routes before implementation.
2. Added migration `0005_timelines.sql`, strict named-zone calendar/instant schemas, owner-only routes, and token/version-guarded D1 mutation batches. The initial 12 tests passed; the first full check passed lint, types, all 142 then-current tests, and the local dry-run Worker build. Subsequent edge coverage passed for foreign IDs, sparse/empty order, mixed mutation races, direct SQL guards, and released cover references.
3. Regression tests exposed the storage-specific quota message and Intl accepting numeric offsets as timezone names. Both failed before their fixes; the final Timeline suite has 18 real D1 tests and four pure date-schema tests. Fresh full verification passed 152 tests, lint, types, and local dry-run build. Local migration application (0001–0003 and 0005) and rerun passed; whitespace validation passed. No cloud changes, push, PR, or merge occurred.

### Decisions and integration boundary

- Timeline/Item IDs are opaque stable IDs. API fields use `event_at` and `position`; captions/date metadata are independent of Asset capture time. Dates preserve calendar precision; instants normalize to UTC milliseconds and retain their named timezone.
- Every valid mutation advances version once. A first conditional timeline UPDATE generates an internal token; every dependent item write and response SELECT requires that token, new version, and owner. Stale zero-row CAS attempts cannot alter item rows, timestamps, or tokens. A later SQL failure rolls the whole batch back.
- Composite owner foreign keys, readiness triggers, immutable association identities, and asset reference triggers include both item references and covers. Removing an item never deletes Asset. Timeline quota checks run inside SQL and have a database trigger for direct SQL callers.
- Unique nonnegative item positions can have gaps after removal; two-phase complete-set reorder parks positions above the occupied range before assigning zero-based final positions. Reorder accepts at most 1,000 IDs and shares the existing 64 KiB metadata request limit. Append does not impose a product item cap; larger ordering/pagination policies remain future work.
- API reads remain owner-only even for public/unlisted metadata. Public rendering/media authorization, React UI, native auth, sharing/links, browser accessibility, viewport integration, and live cloud gates are not implemented by this slice.
- Library integration must account for `asset_referenced_by_timeline` on trash/purge/delete and count both `timeline_items` and `timelines.cover_asset_id` references. Migration 0004 belongs to Library; 0005 is independently additive and must be applied after 0004 in the combined branch.

### Exact remainder

Root should independently review the committed Timeline slice, integrate it after Library 0004, resolve shared route/docs/error-file changes, and rerun full check plus fresh migration/rerun with both migrations. This branch must not push, publish a PR, merge, or deploy. The same reviewer is next assigned to read-only Library review at commits `8dfa0b0` and `d87be1b` in `/Users/bay/.codex/worktrees/7026/ages`; report concrete blockers without editing that checkout.



## Current session checkpoint — Library API, October 4, 2026

This section supersedes historical next steps below. Earlier checkpoints remain intact for context.

- Library implementation is committed as `8dfa0b0` on `feat/library-api` in `/Users/bay/.codex/worktrees/7026/ages`. Root integrated viewport PR #4's main merge `3590b41` with normal merge `0c98fca`, pushed the branch, and created [PR #5](https://github.com/easysun/ages/pull/5). No deployment occurred.
- Library provides authenticated owner-only `GET /api/assets` (ready assets, descending created_at/id keyset cursor scoped to owner and exact tag, default 30/max 100), live asset detail, validated private R2 `GET`/`HEAD` media with single byte ranges, and same-origin transactional exact tag replacement. Tags are bounded at 20 distinct nonblank strings of 64 UTF-16 code units. Asset payloads hide storage keys/ETags; conditional media reads also check size/MIME and version consistency. Migration `0004_asset_tags.sql` adds only tags and ownership/count guards.
- TDD evidence: initial Library run failed 46 tests with eight existing error-path passes; all initial 54 passed after implementation. Expanded regression observed stale Content-Length on media rejection (one failure/58 passes), then passed after delaying success headers. Fresh full `npm run check` passed lint, typechecks, 189 tests (59 Library tests), and dry-run build. Local migration 0004 applied successfully; rerun reported `No migrations to apply!`; `git diff --check` and staged whitespace checks passed.
- Root independently reran `npm run check` after main integration: 189 tests passed, lint/types/dry-run build passed, and local migration rerun reported no migrations to apply. PR #5 awaits independent review and CI before merge. Timeline implementation owns `/Users/bay/.codex/worktrees/timeline-domain/ages`, branch `feat/timeline-domain`, and migration 0005. React Library implementation owns `/Users/bay/.codex/worktrees/react-library/ages`, branch `feat/react-library`, and is integrating the Library commits. These are isolated writers; do not edit or switch their files. Their browser and domain gates are not yet verified. Do not enable trash/delete/restore until real TimelineItem and cover references enforce tested deletion guards; never substitute a synthetic reference count.
- Cloud gates remain open: root verified `wrangler whoami` reports `You are not authenticated. Please run wrangler login.` Environment bindings are placeholders. No credentialed Google login, real browser R2 upload, cloud deployment, or 250 MB upload has been verified. Scheduling cleanup, orphan reconciliation, rate limits, and abuse controls remain required before public beta. Viewport renderer/lifecycle/gestures/mobile/keyboard/accessibility/performance gates remain unfinished.

## Previous session checkpoint — October 4, 2026

This historical section has been superseded by the Library checkpoint above.

- Active chat/worktree: `01a10287-0b6c-7ca3-848b-f92e33d8ff11`, `/Users/bay/.codex/worktrees/7026/ages`. Preserve the separate original checkout at `/Users/bay/dev/easysun/ages`, including its uncommitted HANDOFF update.
- Usage API reports the five-hour reset at 2026-10-04 04:55:52 Asia/Taipei. Single-run same-chat heartbeat `continue-ages-after-usage-reset` is ACTIVE at 04:56:52, exact prompt `繼續執行`. Creation, view, and saved configuration were verified. The machine and desktop app must remain running for local work.
- PR #3 merged into `main` as `8b32fed`; local main fast-forwarded. Independent upload review found quadratic JPEG parsing. Fix `dea96e4` uses a linear offset walk; a deterministic copy-budget test failed at 34,358,820,872 copied bytes before the fix and passed after. Integration tests verify 422, failed state, and unchanged completed quota. Final full check passed 114 tests, lint, types, and dry-run build; GitHub CI passed. Local migrations 0001–0003 and rerun passed. No deployment occurred.
- The independently approved viewport core is carried on `feat/viewport-core` using cherry-picked `865f5ca` and `aea4660`, preserving the original viewport branch. Full combined check passed 130 tests, lint, types, and dry-run build. Renderer, gestures, lifecycle, accessibility, and performance gates remain unfinished.
- Next: publish a viewport-only PR against updated main, verify CI and merge, then implement owner-scoped Library listing/detail/media and tags. Trash/delete must wait for real timeline associations and reference guards. Continue the remaining MVP stages; do not mark the goal complete while browser/cloud gates remain open.
- GitHub CLI still lacks this private repository's access. SSH fetch/push and the signed-in Brave session work. Use supported browser interaction for PR management; do not extract browser credentials.

## Historical goal and scope

Deliver the Living Timeline MVP in reviewable vertical slices. The latest requirement adds resolution-independent timeline zoom, initial auto-fit, and a possible reusable React component. Parallel research is authorized. A local sibling repository under `/Users/bay/dev/easysun/` is allowed when justified, but no extraction or public release has been selected.

Read `AGENTS.md` without modifying it, then `docs/implementation-plan.md` and `docs/timeline-viewport.md`. All repository content and Git/PR metadata must be English. Preserve independent Asset, TimelineItem, Timeline, and Link semantics. Do not deploy or publish a library without the required environment and release decisions.

## Last three checkpoints

1. Foundation PR #1 and authentication PR #2 merged into `main`; authentication passed 70 local tests and GitHub CI. Main reached `316484f` before upload work.
2. Direct upload uses signed `If-None-Match: *` and exact size/type constraints, atomic reservations, idempotent accounting, bounded metadata validation, and retry-safe cleanup helpers. Local migration 0003 and rerun passed.
3. `feat/direct-upload` was committed and pushed as `14250d5`, `6cebab6`, and `e907b1b`. PR #3 is open with one successful GitHub CI check. The local viewport core adds 16 tests. Independent review identified missing magnification/resize-limit assertions; strengthening them made deliberate broken variants fail six tests. Restoring the implementation passed all 121 tests, lint, types, dry-run build, and whitespace checks. The viewport renderer and gestures are not implemented.

## Current files and verification

Upload implementation: `src/assets/`, `src/routes/uploads.ts`, `migrations/0003_assets.sql`, upload tests, quota reporting, bindings, README, and lockfile. PR: https://github.com/easysun/ages/pull/3. Local viewport changes are `src/timeline/viewport.ts`, `tests/unit/viewport.test.ts`, `docs/timeline-viewport.md`, `docs/implementation-plan.md`, and this handoff; keep them out of the upload PR.

Run `npm ci --cache /private/tmp/ages-npm-cache`, then `WRANGLER_LOG_PATH=/private/tmp/ages-wrangler-logs npm run check`. Tests use real simulated Workers bindings, not live cloud services. Browser UI does not exist yet. No live Google login or real R2 browser upload is verified; no deployment occurred.

## Exact next steps

1. Collect the native upload review from `01a1015b-5ef1-7b70-ba3d-00e6e5c7204f`. Viewport reviewer `01a1015d-1966-7383-85bf-66ba049b446a` completed; its two assertion gaps are fixed and mutation-tested. A prior connector-based worker attempt failed and produced no review; do not claim it succeeded. Resolve concrete defects with regression tests, then merge PR #3 if green. Synchronize local `main` by fast-forward only.
2. Put the tested viewport core and its documented acceptance gates on a separate branch/PR. The React renderer/gestures and performance claims remain stage 06 work. Do not preemptively split repositories.
3. Resume stage 04: owner-scoped Asset Library APIs, tags, trash/restore, and the first responsive React client. Continue separate PRs toward the three-photo/share/fourth-photo loop. There is no release branch yet; foundation PRs target `main`.

## External gates and automation limits

- Cloudflare account, isolated resource bindings, domain, and Google OAuth configuration are still needed for credentialed smoke tests. Secrets belong in ignored local files or platform secret storage, never chat.
- Real R2 tests must validate browser Content-Length signing, CORS, immutable PUT behavior, expiry, and a 250 MB upload. Public beta also requires scheduled cleanup, orphan reconciliation, rate limits, and abuse controls.
- Git identity is `easysun`; SSH push works. The available GitHub CLI/connector identity lacks repository access; the existing Brave session is signed in as the owner and was used for PRs.
- No reset-plus-one-minute continuation schedule exists. Actual usage reset time was not accessible, and computer access to the Codex app was denied. Do not bypass that denial or invent a reset time. The goal tool most recently reported `usageLimited`; it cannot be resumed by an assistant status update.

## Execution decisions

- The user explicitly directs autonomous reversible work and authorizes branch/PR/self-merge. Preserve that instruction when skills offer optional integration menus; do not repeatedly ask for the same authority.
- Newly available Superpowers verification/review workflows are in use. Previously written code predates the TDD skill becoming available; do not rewrite verified user work merely to simulate test-first history. New feature/fix tests must be observed failing before implementation.
- Existing feature work remains in the current checkout; reviewers are read-only against explicit scopes. Before introducing parallel writers, isolate their work and agree non-overlapping paths.
- Library reference/delete protection requires actual timeline association semantics. Sequence that dependency explicitly; never fake a reference count or enable destructive library controls before the dependency guard is tested.
- Viewport review disposition: magnification and resize-bound assertions are required contract coverage and were fixed together. Extreme floating-point input ranges remain unsupported rather than promising infinite precision; adapters must choose appropriate logical units/minimum spans. Browser lifecycle, rendering, gestures, accessibility, and performance were explicitly outside the headless review and remain required integration gates, not waived requirements.
