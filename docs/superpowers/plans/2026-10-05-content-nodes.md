# Stable Content Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide durable owner-managed Timeline and external-reference identities independent of expiring distribution Links.

**Architecture:** Keep ContentNode policy separate from Timeline policy, combining them on each read with the more restrictive visibility. Add owner CRUD and server-rendered node pages; do not fetch external URLs or create edges in this slice.

**Tech Stack:** Existing TypeScript/Hono/D1/Zod/React/Vitest/Playwright dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-tracking-content-graph-design.md`, delivery slice3. Slice4 depends on these interfaces; provider tracking is independent.

## Global Constraints

- Stable node identity differs from Asset, Timeline, TimelineItem and Link identity. Expiring/disabling a Link leaves nodes intact.
- Initial node kinds are Timeline and owner-scoped external reference; Asset nodes are deferred until a durable grant is separately approved.
- Default private; unlisted URL-accessible/noindex; public indexable. Access requires both node and underlying content policy. Timeline/member moderation hides its node.
- HTTP(S) external references render escaped text/ordinary links; no fetch, embed, global URL deduplication or AI.
- English committed files/copy; no email or identity-provider details on public pages. No new dependencies, remote migrations or deployments.

## Review Focus

1. Public node referencing an unlisted/private Timeline cannot broaden access (Task1).
2. Cover/member moderation changes hide an existing node immediately (Task1).
3. Same URL entered by two owners must preserve distinct identities (Task1).
4. External titles/URLs containing HTML or credentials must not execute or disclose credentials (Task2).
5. Delayed owner writes/reads after logout cannot rehydrate node drafts (Task2).

---

### Task 1: Stable identity and effective access API

**Representative contract assertions:**

```ts
expect(await effectiveNode(db, publicNodeWithPrivateTimeline.id, otherOwner.id)).toBeNull();
expect((await effectiveNode(db, publicNodeWithUnlistedTimeline.id, null))?.visibility).toBe('unlisted');
```
Create both fixture nodes through ownerAPI and real local D1, including Timeline visibility.


**Files:** Create `migrations/0018_content_nodes.sql` (provisional; allocate the next unused number at execution), `src/graph/nodes.ts`, `src/routes/content-nodes.ts`, `tests/integration/content-nodes.test.ts`; modify `src/app.ts`, `src/routes/moderation.ts`. Read `src/moderation/availability.ts`, `src/routes/public-timeline.ts`, `src/timelines/model.ts` and their callers.

**Interfaces:** `ContentNode = {id:string;owner_id:string;kind:'timeline'|'external';visibility:'private'|'unlisted'|'public';timeline_id:string|null;url:string|null;title:string|null;created_at:string;updated_at:string;removed_at:string|null;moderation_blocked:number}`. `effectiveNode(db:D1Database, id:string, viewerId:string|null):Promise<{node:ContentNode;visibility:'private'|'unlisted'|'public'}|null>` returns null for inaccessible, removed or blocked underlying content. `publicNodePayload(node:ContentNode)` omits owner identity/auth fields. Owner POST/GET `/api/content-nodes`, GET/PATCH/DELETE `/api/content-nodes/:id`; deletion is reversible logical removal and never deletes Timeline/Asset/Link. POST target identity immutable; PATCH permits title/visibility and `{removed:false}` for owner restore only; removed nodes stay hidden from ordinary list/read. An explicit owner-only `GET /api/content-nodes?removed=true` lists removed references with the same keyset pagination, permitting restore after refresh; its cursor namespace is distinct from the default live list. It never changes public availability. POST Timeline requires source ownership, supports private Timeline nodes, unique live `(owner_id,timeline_id)`; duplicate and restore conflicting with a replacement live Timeline node return409 without changing either row. External nodes are not URL-deduplicated.

- [x] Write `effective_visibility_is_intersection`, `moderation_hides_node_and_metadata`, `foreign_timeline_creation_is_denied`, `same_url_different_owner_is_distinct`, `link_expiry_leaves_node`. Assert all9node/Timeline visibility combinations for owner/nonowner, unlisted noindex, blocked cover/item/node hiding (including external nodes), removed node404, owner-only removed listing and restore after refresh, live/removed cursor isolation, FK owner consistency, conflicting restore409 with both rows intact, and creation defaultprivate. Authentication401, foreign writes404, cross-origin403; no storage keys/emails in public payloads.
- [x] Run `npx vitest run tests/integration/content-nodes.test.ts`; observe missing nodeAPI failures.
- [x] Create constrained D1 rows/indexes and owner-bound keyset listing (default30/max100, cursor namespace `nodes.`, reject foreign-owner/invalid cursor). Use existing ID conventions with `cn_` UUID. Validate URLs through `linkUrlSchema` (max4096, HTTP(S), no userinfo); title nullable/max200 UTF-16 units, reject all C0/DEL for titles, preserving other Unicode. Copy underlying Timeline title only at read time under effective access; never store private Timeline title as external metadata.
- [x] Implement `effectiveNode` using the existing Timeline availability checks, including moderated cover and members; choose stricter visibility and require owner for private. External policy uses its own visibility. Mark removed or node-moderation-blocked nodes unavailable without cascading target deletion. Add role-protected GET/PATCH `/api/admin/content-nodes/:id` authoritative state and reasoned block/unblock, recording append-only node moderation events in the same migration; reuse existing admin guards and reason validation, with nonadmin403, stale-state/retry and immutable-audit integration assertions. Public payloads omit internal moderation details. Allocate the next unused migration number after rechecking the directory; 0013 and 0014 already belong to native analytics, provider tracking uses 0015 and its bounded-ticket correction uses 0016. Reporter UX provisionally uses 0017, and this plan provisionally uses 0018, but execution order may change these reservations; never overwrite another migration.
- [x] Re-run tests and local migration/rerun; run `npm run check`, then commit `Add stable ContentNode identities and effective visibility`.

### Task 2: Owner node management and safe public pages

**Files:** Create `src/graph/render.ts`, `src/routes/public-content-node.ts`, `src/client/content-nodes.tsx`, `tests/e2e/content-nodes.spec.ts`; modify `src/app.ts`, `src/routes/content-nodes.ts`, `src/client/main.tsx`, `src/client/styles.css`, `src/abuse/limits.ts`, `src/operations/preflight.ts`, `wrangler.jsonc`, `README.md`, `tests/e2e/start-server.mjs`, `tests/e2e/fixtures.ts`; extend the focused preflight unit test and node/abuse integration tests when exercising these interfaces.

**Interfaces:** `ContentNodesScreen({authGeneration:number}):React.JSX.Element` at `/content`; server GET/HEAD `/c/:id` uses `effectiveNode`, returns escaped standalone accessible page and no-store. Public pages never render authenticated application shell/account email. Owner management uses API routes above. Extend the owner detail GET `/api/content-nodes/:id` response to include `effective_visibility: private|unlisted|public|null` beside the existing `node`, derived through `effectiveNode(db,id,owner)`; null means currently unavailable. The UI loads this detail for the selected reference rather than reconstructing access policy from stored node visibility. Live/removed list and mutation payloads keep their existing contracts. Node removal control says it removes the reference, leaving original content intact, and exposes an owner-only removed-reference list and restore PATCH `{removed:false}`; Restore preserves target identity under Task1’s patch contract.

- [x] Write `private_nodes_require_owner`, `unlisted_node_has_noindex`, `external_title_is_inert`, `reference_removal_preserves_story_and_link`, `restore_removed_reference_after_refresh`, `logout_discards_delayed_node_result` on desktop/mobile. Assert malicious title renders text, dangerous URL400, no serverfetch, stable node URL after title/visibility edits and Linkexpiry; keyboard CRUD/retry/refresh, undo removal and no horizontal overflow. Assert owner detail effective visibility and unavailable state, private editor link, unknown `/c` route precedence and inherited per-IP limits. Private page may use existing requireUser session read; never redirects an unauthorized visitor to a revealing node title.
- [x] Run `npm run test:e2e -- tests/e2e/content-nodes.spec.ts`; observe missing UI/pages fail.
- [x] Implement management forms for existing owned Timeline or external URL/title and explicit visibility selector; display effective visibility when node/Timeline differ. Public external links use `rel="noopener noreferrer"`; Timeline links use canonical `/t/:id` for effectively public/unlisted nodes; an owner-only effectively private page links to the existing authenticated `/timelines/:id` editor, because the public Timeline viewer deliberately rejects private Timelines. HEAD follows same access/headers without body. Public indexability follows effective visibility; private/unlisted responses use noindex/no-store. No global content directory is introduced. Add `/c` and `/c/*` to Worker-first routing and the existing protected request-limit namespace; unknown node routes return Worker errors rather than the SPA shell. Anonymous public/unlisted reads remain available despite absent or invalid sessions; private reads check current owner session and return generic unavailable feedback without title disclosure.
- [x] Re-run focused tests serially, inspect desktop/mobile screenshots; document stable identity, reversible reference removal and Asset deferral.
- [x] Run `CI=true AGES_E2E_PORT=8811 AGES_E2E_TRACKING_PORT=8812 npm run check`, `git diff --check`; commit `Add safe ContentNode pages and owner management`. The optional tracking port override retains default8798 and existing localhost isolation, allowing validation alongside independent local services.

## Review and publication gate

Human design and plan approval gates are waived by the user. After the provider and reporter slices, isolate `feat/content-nodes` from current main, independently review effective access and rendering, publish/attach focused slice3 PR with screenshots and require green CI before merge. No graph edge endpoints/pages are included in this PR. User-approved reversible work covers local migration authoring/application; any live database application remains a distinct deployment gate.
