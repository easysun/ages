# Ages Development Handoff

## Goal and scope

## Current session checkpoint — October 4, 2026

This section supersedes historical next steps and scheduling notes below.

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
