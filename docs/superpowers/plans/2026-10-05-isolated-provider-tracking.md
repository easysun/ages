# Isolated Provider Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-level GA4, Meta Pixel, and GTM IDs with a consent-first tracking Worker that emits bounded Ages events and returns visitors through a freshly authorized Link continuation.

**Architecture:** Keep provider settings, Link opt-outs, and short-lived ticket state in D1; use a second Worker with only the tracking page and ticket-payload reader on a separate registrable domain. The app Worker alone consumes tickets and resolves the current Link target, including rechecking Asset grants for streaming. Reuse slice 1's `LinkTracking` and typed `ClickSource` contracts.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, React, Vitest/Cloudflare Workers runtime, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-tracking-content-graph-design.md` (delivery slice 2; slice 1 used migrations 0013 and 0014, so this plan provisionally reserves 0015. Recheck the migration directory before implementation; never overwrite an existing migration).

## Global Constraints

- The product does not connect to a lihi.io account.
- Store provider IDs per Ages account; IDs are public identifiers, not credentials.
- V1 accepts IDs only; no custom JavaScript, custom HTML, or arbitrary tag URL fields.
- Use a dedicated tracking origin on a separate registrable domain, with separate TLS, cookies, storage, and origin.
- The application origin never loads these tags; do not share app sessions, cookies, CORS access, API capabilities, or authenticated page content with the tracking origin.
- After consent, emit one fixed `ages_link_click` event with only the opaque link identifier, target kind, configured channel, and bounded UTM/custom scalar values.
- Complete the redirect through a server-validated ticket endpoint; tickets cannot be used to read Ages APIs or bypass target authorization.
- Local development can use two distinct loopback hostnames and synthetic IDs; tests must not require production DNS or vendor accounts.

## Review Focus

- A copied, expired, mismatched, or replayed ticket must fail closed; `tests/integration/tracking-flow.test.ts` covers read, final consume, expiry, and replay.
- Provider IDs, routing, and Link opt-outs must remain owner-scoped and bounded; `tests/integration/provider-settings.test.ts` covers malformed IDs, foreign owners, and per-Link disable behavior.
- The tracking page must expose only the event payload and public provider IDs, never a destination, app secret, cookie, or content metadata; `tests/integration/tracking-flow.test.ts` inspects stored and rendered payloads.
- Denied consent, skip, and timeout must make zero provider requests, and the ticket URL must be removed before provider scripts load; `tests/e2e/tracking.spec.ts` checks the DOM, request log, CSP, and referrer policy using local stubs.
- A final Asset continuation must recheck the live grant and retain normal range/HEAD streaming without accepting the consumed tracking ticket as a media credential; `tests/integration/tracking-flow.test.ts` covers revocation, replay, and stream semantics.

---

### Task 1: Persist and configure account providers

**Files:**
- Create: `migrations/0015_tracking_providers_tickets.sql` (account settings, Link opt-outs, and ticket table; do not use 0013 or 0014).
- Create: `src/tracking/providers.ts`
- Modify: `src/routes/me.ts`, `src/routes/links.ts`, `src/links/model.ts`
- Modify: `src/client/api.ts`, `src/client/main.tsx`, `src/client/styles.css`, `src/client/links.tsx`
- Create: `src/client/tracking-settings.tsx`
- Test: `tests/unit/tracking-provider-model.test.ts`, `tests/integration/provider-settings.test.ts`, `tests/e2e/tracking.spec.ts`

**Interfaces:**
- Consumes: slice 1's `LinkTracking` and `ClickSource`; `LinkTracking` remains `{ tags: string[]; channels: string[]; utm: Partial<Record<five UTM keys, string>>; custom: { key: string; value: string }[] }`.
- Produces: `TrackingProviderSettings = { ga4_measurement_id: string | null; meta_pixel_id: string | null; gtm_container_id: string | null; ga4_route: "direct" | "gtm"; meta_route: "direct" | "gtm" }`; `EnabledProviders = {ga4:{id:string;route:'direct'|'gtm'}|null;meta:{id:string;route:'direct'|'gtm'}|null;gtm:{id:string}|null}` contains only enabled public IDs. GA4 IDs match `^G-[A-Z0-9]{1,20}$`, Meta IDs `^[0-9]{1,30}$`, and GTM IDs `^GTM-[A-Z0-9]{1,20}$`; reject whitespace, script metacharacters and extra properties. Defaults route direct; a gtm route requires an enabled GTM ID and never also dispatches directly. Export `getTrackingProviders(db: Bindings["DB"], ownerId: string): Promise<TrackingProviderSettings>` and `resolveLinkProviders(db: Bindings["DB"], linkId: string, ownerId: string): Promise<EnabledProviders>`. Read/write account settings at `GET|PUT /api/me/tracking/providers`, and Link opt-outs at `PUT /api/links/:id/tracking/providers`.

- [x] **Step 1: Write failing validation and owner-isolation tests** for `G-…`, numeric Meta Pixel, and `GTM-…` IDs; direct/GTM routing; GTM-required routing; full replacement of account IDs; anonymous401, foreign404, cross-origin403; foreign account/link access; and an unset account returning all providers disabled.
- [x] **Step 2: Run the focused tests and confirm they fail** because provider settings and routes do not exist.

Run: `npm exec vitest -- run tests/unit/tracking-provider-model.test.ts tests/integration/provider-settings.test.ts`
Expected: FAIL on missing schemas/routes/table.

- [x] **Step 3: Add the next unused migration (provisionally 0015) and implement provider schemas/routes.** Create `tracking_provider_settings` keyed by `user_id` with the five fields above; create `tracking_tickets` keyed by `token_hash` with `link_id`, `target_kind`, bounded event/provider JSON, `expires_at`, and nullable `consumed_at`; store no destination or credential. Add `allow_ga4`, `allow_meta_pixel`, and `allow_gtm` Link flags defaulting to enabled, so new account IDs apply to old and new Links unless their owner opts out. Return no credentials. New account routes explicitly use requireUser, private/no-store and assertSameOrigin for writes; do not assume the existing GET /api/me guard protects sibling routes. Link routes retain their existing guards. Add an accessible settings screen at `/settings/tracking` and per-Link provider toggles to slice1’s Links screen (`src/client/links.tsx`, add it to the file map), with GET `/api/links/:id/tracking/providers` returning the three allow flags. Account settings and opt-out drafts clear on logout/revoked access; browser tests cover refresh, ordinary save failure and delayed401/403.
- [x] **Step 4: Re-run the focused tests and verify the settings flow.**

Run: `npm exec vitest -- run tests/unit/tracking-provider-model.test.ts tests/integration/provider-settings.test.ts`
Expected: PASS; account and Link reads/writes stay owner-bound, and direct/GTM routing is unambiguous.

- [x] **Step 5: Run `npm run check`, then commit the settings slice** with message `feat: configure account tracking providers`.

### Task 2: Add isolated ticket page and consent-gated provider events

**Files:**
- Create: `src/tracking/tickets.ts`, `src/tracking/interstitial.ts`, `src/tracking/index.ts`, `src/tracking/config.ts`, `wrangler.tracking.jsonc`
- Modify: `src/app.ts`, `src/routes/links.ts`, `src/bindings.ts`, `src/client/tracking-settings.tsx`, `src/client/links.tsx`, `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/start-server.mjs`
- Create: `tests/integration/tracking-flow.test.ts`, `tests/e2e/tracking.spec.ts`

**Interfaces:**
- Consumes: Task 1's `EnabledProviders`; slice 1's `getLinkTracking(db, linkId): Promise<LinkTracking>` and `clickSource(request, now, channels): ClickSource`.
- Produces: `createTrackingTicket(db: Bindings["DB"], link: Link, tracking: LinkTracking, source: ClickSource, providers: EnabledProviders, now: Date): Promise<{ token: string; expiresAt: string }>`; `readTrackingTicket(db: Bindings["DB"], token: string, now: Date): Promise<TrackingTicketView | null>`; `consumeTrackingTicket(db: Bindings["DB"], token: string, now: Date): Promise<{ linkId: string; targetKind: "url" | "timeline" | "asset" } | null>`. `TrackingTicketView = { providers: EnabledProviders; event: { event_name: "ages_link_click"; link_id: string; target_kind: "url" | "timeline" | "asset"; channel: string; utm: LinkTracking["utm"]; custom: LinkTracking["custom"] } }`. A ticket expires after 300 seconds. Hash a cryptographically random token in D1; the view contains only public provider IDs/routing and the fixed event payload.

- [x] **Step 1: Write failing integration and browser tests** for: provider-enabled valid GET creates one ticket and redirects to the tracking origin; no-provider GET preserves current delivery; HEAD creates no ticket or count; repeated tracking-page reads do not consume; payload omits destination/secrets; direct versus GTM routing dispatches exactly once; ticket URL is stripped before any provider request; denied, skip, and 10-second unanswered consent make zero provider requests; provider load failure still submits continuation. Include a local third-origin destination and no-JavaScript continuation regression proving the strict form-action policy does not prevent the final external navigation. The app final consumer and no-loop continuation from Task3 must be introduced with Task2’s resolver activation so intermediate commits stay usable; Task3 extends adversarial tests and release gates rather than leaving redirects pointing to a missing route. Bound tag initialization after consent at2seconds before automatic continuation; the visitor can always continue immediately.
- [x] **Step 2: Run the focused tests and confirm the expected failures.**

Run: `npm exec vitest -- run tests/integration/tracking-flow.test.ts`
Expected: FAIL because the ticket Worker and consent route are absent.

- [x] **Step 3: Implement the ticket and tracking Worker.** Use app HTTP origin `http://127.0.0.1:8797` and portable tracking HTTP origin `http://localhost:8798` in local tests, with each Worker bound to127.0.0.1 on its own port. Platforms that support it may also use tracking host127.0.0.2; macOS here cannot bind that alias. Only tracking configuration accepts these tracking loopback choices and requires its cookie hostname to differ from APP_ORIGIN; different ports on the same hostname do not isolate cookies. Verify actual Origin and absence of the app session cookie. Preserve the existing appOrigin allowlist and configurable app E2E port. Start both local Workers serially from the existing Playwright server fixture. Task2 adds the tracking Worker config with only its ticket D1 binding; Task3 extends its release gates. Permit its only page route to read a bounded ticket view; serve no session cookie, app API, app assets, or CORS. The page includes an escaped ordinary POST continuation form that works without JavaScript; optional vendor code is absent by default. The page starts denied, calls `history.replaceState` to remove the ticket URL before provider code can load, and dynamically loads only configured Google/Meta scripts after Allow. Send one fixed `ages_link_click` with the opaque Link ID, target kind, configured channel label or `Other`, and bounded `LinkTracking.utm`/`custom`; never include referrer host, destination, Timeline/Asset data, or arbitrary owner code. Apply `Referrer-Policy: strict-origin` to the consent document so ordinary cross-origin POST forms preserve the exact tracking Origin; `no-referrer` makes that Origin null in browsers. Request bootstrap-owned vendor scripts with explicit no-referrer policy. Vendor-managed requests may reveal only the fixed tracking origin, never a ticket path/query or app URL. The app continuation document retains `Referrer-Policy: no-referrer` before external navigation. Verify actual form Origin and request referrers in JavaScript and no-JavaScript browser tests. Apply no-store, nosniff and restrictive CSP: default-src none; nonce-only inline bootstrap, scripts limited to `https://www.googletagmanager.com`, `https://connect.facebook.net`; connect/img limited to those origins plus `https://www.google-analytics.com`, `https://region1.google-analytics.com`, `https://www.facebook.com`; form-action only the app continuation endpoint’s origin, base-uri none, frame-ancestors none. No app-origin connect/script/img/frame grants; unsupported GTM suppliers fail under this policy. Escape JSON against closing script tags. Disable GA default pageviews in bootstrap with documented `send_page_view: false`. Enhanced Measurement is controlled by the GA property and cannot be disabled by that flag; require owners to disable it in GA4 settings before provider production use, explain this requirement in the account settings UI, and retain observed real-provider event checks as a production gate. Never invent an unsupported bootstrap option or treat stub tests as proof of vendor configuration; do not call Pixel PageView; use fixed sanitized tracking-page location/referrer metadata with no ticket or app URL. Test injection strings in literal parameters and automatic SDK page-location leakage. GA4 custom data must be usable scalar parameters within its limits: normal ASCII `[A-Za-z0-9_]` keys up to33 characters map to `ages_c_<key>`; other exact keys map to `ages_h_<first32 SHA256 hexadecimal characters>`. Do not split an opaque record into arbitrary chunks or spread owner keys into SDK options. Keep three fixed fields, five UTM fields and ten custom values bounded to18 data parameters; names≤40 and literalvalues≤100. Show an original-key to GA-parameter lookup in Link tracking settings for custom-dimension setup. GTM/Meta retain their supported bounded literal structure. Cover maximum inputs, Unicode/long keys, stable reorder and SDK control-name collisions. All tags execute only after consent. In tests, fulfill exact provider requests with local Playwright fixtures so no vendor network is reached; do not add a provider-stub origin to deployed Worker bindings.
- [x] **Step 4: Re-run integration and browser tests.**

Run: `npm exec vitest -- run tests/integration/tracking-flow.test.ts && npm exec playwright -- test tests/e2e/tracking.spec.ts`
Expected: PASS; the test request log contains no provider calls before consent or on skip/timeout, and one bounded event on consent.

- [x] **Step 5: Run `npm run check`, then commit the isolated consent flow** with message `feat: add isolated consent tracking flow`.

### Task 3: Verify live continuation authorization and gate releases

**Files:**
- Modify: `src/cleanup.ts`, `src/operations/preflight.ts`, `scripts/release-preflight.mjs`, `package.json`, `.dev.vars.example`, `wrangler.jsonc`
- Inspect and modify only if an adversarial test demonstrates a defect: `src/routes/links.ts`, `src/app.ts` (Task 2 already implements continuation and media routing).
- Modify: `wrangler.tracking.jsonc`
- Test: `tests/integration/tracking-flow.test.ts`, `tests/unit/preflight.test.ts`

**Interfaces:**
- Consumes: Task 2's `consumeTrackingTicket`; existing Link resolver checks and `streamAssetMedia` grant recheck.
- Produces: app-side `POST /s/continue` that consumes a ticket once, rechecks Link active/expiry/moderation and current target visibility/grant, then continues; Asset Links continue at a dedicated `/s/:slug/media` route that performs the existing per-request grant checks and supports GET, HEAD, Range, and conditional requests without counting or creating tickets.

- [x] **Step 1: Add failing tests** for ticket replay/mismatched state, Link deactivation/expiry/moderation after ticket view, Timeline visibility changes, Asset grant revocation, repeated range/HEAD/conditional media reads, continuation making no second click count, and an attempted `?skip_tracking` bypass. Add preflight tests that reject equal domains, declared subdomains, wrong-origin declarations and extra tracking Worker bindings; those new gate assertions supply the expected RED cycle.
- [x] **Step 2: Run the focused flow tests and confirm failure.**

Run: `npm exec vitest -- run tests/integration/tracking-flow.test.ts tests/unit/preflight.test.ts`
Expected: new preflight assertions FAIL because provider release gates are absent; existing continuation assertions from Task2 remain passing. If adversarial flow tests reveal a defect, observe that failure before fixing it; never weaken an already passing authorization check.

- [x] **Step 3: Verify Task2’s atomic consumption and fix only demonstrated authorization defects.** POST continuation accepts only one token field within a4KiB body and requires the configured tracking Origin; it does not use app login cookies or app same-origin mutation guard. Never permit it to mutate account/content state. For external URL targets, return a tiny app-origin no-store HTML document with a correctly escaped meta-refresh and ordinary fallback anchor after successful consume/live checks. Chromium can block a POST redirect chain to an external origin under the tracking page's strict form-action policy; do not relax that policy or add app CORS. The app continuation document contains no vendor scripts, credentials or ticket, and works without JavaScript. Cover this with a local third-origin browser fixture; an app-origin destination alone cannot catch this defect. Consume with one conditional D1 update bound to token hash and expiry, then apply all live target checks. A consumed token cannot serve media or continue again. URL targets reuse slice1 applyLinkParameters(destination,tracking,applicationOrigin); Asset continuation media is always a live Link grant, not a ticket credential. The tracking Worker selects only ticket-view columns; it never exposes a generic D1 query or app route. Do not redirect to `/s/:slug` from continuation, which would re-enter tracking. Preserve current GET/HEAD behavior when providers are disabled; HEAD never counts, tickets, or displays consent. Add no query flag that bypasses provider routing. Configure the tracking Worker with only its own entry point and D1 binding; keep app sessions, R2, KV, and static app content off that Worker.
- [x] **Step 4: Add release configuration and preflight checks.** Retain Task2’s portable two distinct loopback hostnames and synthetic IDs locally; HEAD remains direct for every target. Include expired/consumed ticket cleanup in `src/cleanup.ts` using the existing bounded scheduled cleanup pattern; test a bounded batch and retained live tickets; remove only short-lived ticket rows, never native aggregate history. Verify Task2’s `wrangler.tracking.jsonc` has a separate Worker entry point and only the ticket D1 binding. For named releases require an explicit HTTPS tracking origin and tracking Worker custom-domain route, reject a tracking Worker name equal to the app Worker name, and allow exactly the declared tracking custom-domain route with no extra or legacy route declarations. Require distinct declared `APP_REGISTRABLE_DOMAIN` and `TRACKING_REGISTRABLE_DOMAIN` values; fail preflight if origins/domains match, either declared domain is a subdomain of the other, an origin is outside its declared domain, or the tracking Worker has app bindings/assets. These checks do not prove registrable-domain boundaries: an operator must verify declared domains against the Public Suffix List before provisioning/production approval. Do not claim DNS/TLS or actual isolation from declared strings alone. Keep DNS/TLS provisioning, origin/cookie isolation, and observed post-consent test events as explicit production gates.
- [x] **Step 5: Run focused preflight and all required repository checks.** Unit tests use stubbed Cloudflare API fetches only; provider tests use local in-process stubs only and never call vendor networks.

Run: `npm exec vitest -- run tests/integration/tracking-flow.test.ts tests/unit/preflight.test.ts && npm run check`
Expected: PASS; preflight rejects same-domain and stub-enabled release configs, and the full project check passes.

- [x] **Step 6: Commit the authorized-release gate** with message `feat: gate tracking tickets on live link grants`.

## Review and publication gate

Human design and plan approval gates are waived by the user; independent code review remains required. Execute in isolated `feat/isolated-provider-tracking` after slice1 merge, preserving its interfaces. Independent whole-branch review checks no app-origin provider access, fixed payload/SDK metadata, direct-versus-GTM dispatch, atomic ticket replay and media continuation grants. Run full `CI=true AGES_E2E_PORT=8797 npm run check`, local migration/rerun, and whitespace checks before publication; attach a focused PR with synthetic consent screenshots and require green CI before merge. Production deployment, external DNS/TLS and real provider account validation remain separate credentialed gates.
