# React Library active checkpoint

Worktree: `/Users/bay/.codex/worktrees/react-library/ages`; branch: `feat/react-library`; base: `3590b41`. Backend Library commits were cherry-picked as `fd306a2` and `5f821f2`; backend source/migrations are unchanged by the client writer. Do not deploy, push, or merge this client slice without root coordination.

## Last three client checkpoints

1. Exact registry versions installed: React/ReactDOM19.3.0, Vite8.3.2, React plugin6.1.1, Playwright1.63.0. Real local Wrangler HTTP fixtures seed users, hashed sessions, and PNGs into isolated `.wrangler/e2e`. Four desktop browser tests failed at missing UI before product implementation; the initial missing browser executable failure was not counted as RED.
2. Implemented one-origin Vite/static-assets client: auth landing, ready Library/media, selection, upload/retry, tags/filter, pagination, and responsive native detail dialog. Kept Worker and browser TypeScript configurations separate. Detail response/edit race was independently reproduced with a delayed real response (expected disabled, received enabled), then fixed by waiting for authoritative metadata before editing.
3. Pagination/filter race was independently reproduced (expected0 cards, received1), then fixed by aborting the page request when its tag changes and ignoring aborted results. Further observed-RED regressions exposed unwanted exact-tag space trimming (expected ` Coast `, received `Coast`) and completed uploads mislabeled as failed when quota refresh failed. Both were fixed. Deferred focus restoration was replaced with synchronous restoration, and keyboard/tag/quota scenarios passed six repeated desktop cases. Final `npm run check` exited0 on October4 after reset: lint and all TypeScript configs passed (existing nonfatal Library style info remains),189/189 runtime tests passed, client and dry-run Worker builds passed,22/22 actual HTTP desktop/375px mobile Chromium cases passed in1.1minutes. Final library/landing/detail screenshots were inspected.

## Files and exact next step

Client files are `src/client/`, `vite.config.ts`, `tsconfig.client.json`; tests are `tests/e2e/` and `playwright.config.ts`. Config changes: package/lock, Wrangler assets, separate TS includes, CI browser installation, README/implementation plan. No production auth or upload fixture backdoors exist.

Next: root should review the committed client slice against the already reviewed Library API, integrate the client commit onto updated main, and handle the PR/CI flow. The client writer must not push, create a PR, or merge. Screenshots are ignored artifacts at `test-results/library-desktop.png`, `test-results/library-mobile.png`, and matching landing/details files in this worktree. No application-code edits followed final verification; only this handoff and API-response documentation wording were finalized. Live Google OAuth and R2 S3/browser/CORS signatures remain unverified cloud gates. No timeline/editor/share/delete UI is implemented.

# Ages Development Handoff

## Goal and scope

## Current session checkpoint — Library API, October 4, 2026

This section supersedes historical next steps below. Earlier checkpoints remain intact for context.

- Library implementation is committed as `8dfa0b0` on `feat/library-api` in `/Users/bay/.codex/worktrees/7026/ages`, based on `410199478bd9d03f33c956bd0881baca964cbbfa`. Root verified viewport PR #4 merged into `origin/main` as `3590b41`; root will integrate that merge before publishing the Library PR. This implementer did not push, publish, merge, or deploy.
- Library provides authenticated owner-only `GET /api/assets` (ready assets, descending created_at/id keyset cursor scoped to owner and exact tag, default 30/max 100), live asset detail, validated private R2 `GET`/`HEAD` media with single byte ranges, and same-origin transactional exact tag replacement. Tags are bounded at 20 distinct nonblank strings of 64 UTF-16 code units. Asset payloads hide storage keys/ETags; conditional media reads also check size/MIME and version consistency. Migration `0004_asset_tags.sql` adds only tags and ownership/count guards.
- TDD evidence: initial Library run failed 46 tests with eight existing error-path passes; all initial 54 passed after implementation. Expanded regression observed stale Content-Length on media rejection (one failure/58 passes), then passed after delaying success headers. Fresh full `npm run check` passed lint, typechecks, 189 tests (59 Library tests), and dry-run build. Local migration 0004 applied successfully; rerun reported `No migrations to apply!`; `git diff --check` and staged whitespace checks passed.
- Next: root reviews the immutable Library commit, integrates updated main, publishes its focused PR, checks CI, and merges if approved. A separately isolated `feat/timeline-domain` checkout owns migration 0005; do not edit or switch its files. There is no Library UI or browser smoke test yet. Do not enable trash/delete/restore until real TimelineItem and cover references enforce tested deletion guards; never substitute a synthetic reference count.
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
