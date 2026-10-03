# Living Timeline Implementation Plan

## Product contract

Build a durable story that users return to extend. The first product milestone is: sign in, upload three photos directly to R2, see the library, create a timeline, add all three, reorder, edit dates and captions, publish unlisted, inspect server-rendered OG metadata, then return and append a fourth photo without changing the share URL.

The north star is Monthly Active Timelines: distinct timelines receiving at least one new item in a calendar month. Track activation (three uploads and three items in a timeline), first share, viewer conversion, four-week append retention, items per active timeline, and share-to-view ratio. Define event deduplication and reporting timezone before adding analytics.

## Accepted architecture

- TypeScript, npm, Hono, and Zod on Cloudflare Workers; React when client work begins.
- D1 is authoritative for identity, ownership, quotas, timelines, and sharing policies. R2 stores media. KV is a disposable cache, never an authorization or quota ledger.
- Browser uploads binary directly using short-lived, object-specific R2 PUT capabilities. Workers handle intent, authorization, validation, completion, API, and SSR.
- Keep API contracts usable by web, Android, iOS, and VR. Native clients will need an explicit authentication flow; browser cookies alone are not a native API design.
- Use responsive layouts, touch and keyboard alternatives to dragging, semantic controls, and reduced-motion support. Do not implement native or VR clients in the MVP.
- Timeline navigation supports resolution-independent zoom and automatic initial framing. Keep viewport math independent of React and storage; distinguish story order from chronological scale. See [viewport design](timeline-viewport.md) for rendering, accessibility, extraction, and verification gates. Do not promise raster detail beyond the source resolution.
- Use explicit local, development, preview, and production configuration. Provision cloud resources and deploy only after selecting the account and target environment.

## Domain invariants

1. Asset identity and media metadata are separate from TimelineItem narrative metadata and Link distribution policies. Reusing media never duplicates the R2 object.
2. `Asset.captured_at`, `TimelineItem.event_at`, and `TimelineItem.position` have different meanings. The latter two replace the earlier `occurred_at`/`sort_key` proposal.
3. Preserve date precision: a date-only event must not silently become midnight UTC. Before the timeline migration, specify date-only versus instant semantics and original timezone metadata. Unknown capture time stays unknown.
4. Timelines default to private. Unlisted URLs permit viewing but carry `noindex`; public permits indexing. Private OG and media responses must not disclose content or enter public caches.
5. Every semantic timeline mutation increments its version. Reorder validates the complete unique item set and atomically compares the version, changes positions, and increments the version. A conditional UPDATE affecting zero rows is not a SQL error; D1 batch rollback alone does not implement this guard. Test concurrent writers.
6. Upload quota reservations count pending intents as well as completed storage. Finalization and release of reservations must be atomic and idempotent. A reusable PUT URL must not permit mutation of an already validated object; freeze the verified version or promote it from a staging key before marking ready.
7. Removing a timeline item or link never deletes media. Referenced asset deletion requires explicit confirmation; trash is recoverable for 30 days. Do not silently expire authenticated memories.
8. Ownership applies to covers, tags, linked targets, OG assets, and item associations, not only primary objects. Foreign keys alone do not enforce cross-user ownership.
9. Product URLs are stable logical identifiers. Retired public slugs remain reserved. Storage URLs are not a permanence contract. Slug edits must retain aliases or be disallowed after publication.
10. A restricted link cannot become an unrestricted redirect to private content. Carry a scoped grant through viewer and media requests, rechecking authoritative state. Revocation must not be defeated by stale KV entries.

## Delivery sequence and acceptance gates

Each row is a separate reviewable PR. New foundation features target `main`; changes to released behavior target the applicable release branch with regression tests. Do not create a single MVP-sized PR.

| Stage | Deliverable | Binary acceptance gate |
| --- | --- | --- |
| 01 Foundation | Worker, bindings, identity schema baseline, error/request-ID middleware, validation, local tooling, CI | Empty migration and rerun pass; health returns 200; malformed JSON returns standardized 400; unexpected exceptions leak no details; lint/types/tests/build pass |
| 02 Auth | Google OAuth only, state, PKCE, one-use login attempts, hashed opaque sessions, quotas, logout, `/api/me` | State mismatch/replay, expired/tampered sessions fail; logout invalidates immediately; cookie mutations enforce origin/CSRF policy; provider identity binds by issuer and subject |
| 03 Direct upload | Intent, reservation, presigned PUT, completion, file validation, orphan cleanup | Owner/size/signature/expiry errors fail; concurrent reservations cannot exceed quota; double completion counts once; post-completion PUT cannot change served media |
| 04 Library | Owner-scoped cursor API, tags, references, trash/restore, minimal responsive React library | Cross-user reads/writes fail; pagination stable; tag filtering persists; referenced delete conflicts; restore works; media stays outside Worker upload bodies |
| 05 Timeline domain | Timeline/item APIs, independent story metadata, versions, atomic order | One Asset reused in two timelines has independent captions; stale and concurrent edits conflict; invalid/duplicate/missing item sets make no changes; item removal preserves Asset |
| 06 Editor | Desktop library and canvas, mobile Add moments, keyboard/touch reorder, date/caption, cover, visibility, scalable viewport and auto-fit | 100 items reorder; reload preserves state; conflicts visibly refetch; zoom preserves focus and data; initial framing respects readability; manual navigation survives resize/append; mobile and keyboard flows pass Playwright |
| 07 Public timeline | Responsive SSR viewer, canonical URL, basic OG, authorized media delivery | Public HTML contains escaped OG without JS; unlisted has noindex; private page, cover, media and cache never leak; appending preserves URL |
| 08 Distribution | URL/asset/timeline links, 302 resolution, reserved slugs, client QR | Inactive/expired links fail; collisions return 409; only safe HTTP(S) destinations; restricted access cannot be bypassed through canonical/media URLs |
| 09 Abuse controls | Endpoint rate limits, report/takedown, cleanup, secret-safe logs | Invalid signatures, enumeration, intent floods and disabled content fail; cleanup is retry-safe; anonymous creation remains disabled |
| 10 Operations | Preview/prod provisioning, binding/migration preflight, recovery/rollback, smoke tests, alerts | CI green; cloud smoke and recovery rehearsal pass; missing resources/migrations block deployment; 250 MB direct upload verified |

Stages 02-08 may run only in local/development/controlled preview until the launch gate is met. Add ownership checks and upload validation in their owning slice; hardening is not permission to ship insecure earlier stages.

## Scope and deferred work

P0 includes durable ownership, image/video upload, tags, independent timeline items, dates/captions, ordering, continuous append, three visibility modes, public SSR/OG, canonical URLs, and standalone shortening. Preserve audio/text extensibility without inventing a transcoding pipeline.

P1 includes EXIF extraction and auto-sort, create-from-selection, year/month navigation, milestones, password/expiry/view limits, invite-only grants, custom OG, basic analytics, anniversaries, and slideshow. Basic link expiry is included earlier because resolution must reject it correctly.

P2 includes collaboration, comments/reactions, profiles/follow/feed, AI curation, generated video, maps, native clients, custom domains, and public developer API. Do not install AI SDKs or video infrastructure before those features are selected.

## Verification and release policy

Use real local Workers bindings for integration tests; no cloud account is required for Foundation. Test failure paths and invariants, not implementation snapshots. Add browser tests with the first client. Every PR records checks, migration effects, API changes, and UI screenshots where relevant.

Before beta, exercise the complete three-photo loop, a fourth-photo append, two-timeline reuse, private/unlisted/public sharing, mobile interaction, refresh persistence, trash/restore, quota races, rate limits, OG escaping, and link revocation. Rehearse D1 recovery and R2 retention separately; a database backup does not back up objects.

## External inputs and evidence

The supplied research is product input. Its opaque citation IDs are not independently usable references. Pricing, competitor limits, and proposed Free/Creator/Pro quotas are hypotheses, not implementation constants or commitments. Recheck official sources before budget or commercial decisions.

Implementation references: [Workers local development](https://developers.cloudflare.com/workers/local-development/), [environment configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

Inputs needed for external integration: GitHub repository URL; Cloudflare account and isolated resource IDs; preview/production domain; Google OAuth application and redirect URIs. Secrets go into platform secret management or ignored local configuration, never chat or committed files.

## Execution status

- Stage 01 was reviewed and merged into `main` in [PR #1](https://github.com/easysun/ages/pull/1). Local clean install, migration/rerun, lint, types, 27 runtime tests, Worker build, HTTP smoke checks, and GitHub CI passed.
- Stage 02 was reviewed and merged in [PR #2](https://github.com/easysun/ages/pull/2). Local migration/upgrade/rerun, lint, typecheck, 70 tests, dry-run build, and GitHub CI passed. Credentialed Google sign-in remains an external smoke gate.
- Stage 03 is implemented in [PR #3](https://github.com/easysun/ages/pull/3): signed create-only R2 PUT, atomic quota reservation/completion, bounded format/image-metadata validation, and cleanup helpers. Clean install, local migration/rerun, lint, types, 105 tests, and dry-run build passed. Live cloud upload, scheduled cleanup, and abuse gates remain open.
- Stage 05 has an isolated Timeline domain implementation: owner-only timeline/item APIs, explicit calendar/instant event dates, independent story metadata, guarded optimistic versions, atomic complete-set ordering, quota enforcement, and item/cover asset reference protection. Local verification is recorded in the feature handoff; PR integration and the editor/public viewer remain open.
- Stage 06 has a dependency-free viewport math foundation with 16 tests for fit, anchored zoom, pan, resize, coordinate precision, and invalid inputs. There is no React renderer or gesture integration yet; this does not complete the editor acceptance gate.
- Stage 04 owner-scoped Library APIs are implemented locally: ready-asset keyset listing, live-asset detail, private validated R2 streaming/HEAD/ranges, and transactional exact tags with migration 0004. The Library tests use real local D1/R2; UI and cloud smoke are unfinished. Reference-aware trash/restore and a separate owner trash list are implemented against real TimelineItem/cover guards, with a 30-day restore deadline and retained R2 bytes/tags/quota. Scheduled purge remains deferred.
- Stages 04-10 still require their remaining product implementations. Cloud upload smoke, scheduled cleanup, and rate-limit hardening remain required before public beta.
- The remote is `https://github.com/easysun/ages`. No released branch, cloud deployment, or business UI exists yet.
