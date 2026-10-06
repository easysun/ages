# Public Content Reporting UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let visitors report visible Timelines and known Ages Links through an accessible flow that survives sign-in without disclosing private content or changing existing share behavior.

**Architecture:** Reuse the authenticated `POST /api/reports` contract and the existing SPA and server-rendered Timeline page. Store only a validated target kind/value on the existing one-use OAuth attempt, then redirect to a fixed `/report` route; keep report text in page memory only.

**Tech Stack:** Node.js 22, npm, TypeScript, Hono, Zod, React, Cloudflare Workers with D1, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-05-reporter-ux-design.md](../specs/2026-10-05-reporter-ux-design.md)

## Global Constraints

- Use TypeScript, npm, and the committed lockfile; add no dependency.
- Accept only report targets `{ kind: "timeline", timeline_id }` or `{ kind: "link", slug }`.
- Keep categories exactly `spam`, `abuse`, `copyright`, `illegal`, and `other`.
- Keep `detail` optional, defaulted to `""`, and at most 1000 characters.
- Require authentication and same-origin writes for report submission; recheck target eligibility at submission.
- Carry only a bounded report target through one-use OAuth state; never carry report detail or an arbitrary return URL.
- Preserve generic 404 behavior for private and unavailable content.
- Preserve `/s/:slug` redirects, existing optional provider consent, and raw-media GET/HEAD/range behavior.
- Leave existing owner Link controls and administrator moderation controls unchanged.
- Keep UI responsive and operable by keyboard, touch, and screen reader; keep source, tests, copy, and docs in English.

## Review Focus

- **Arbitrary OAuth return or replay:** integration coverage proves only a validated report target can be restored after one successful state-bound callback, with `next`, repeated, mismatched, expired, and replayed callback inputs rejected.
- **Private or unavailable target probing:** public page and report submission tests prove private, blocked, inactive, expired, and missing targets reveal no content and share one generic unavailable response.
- **Malformed Link input and oversized report details:** browser parsing rejects non-Ages URLs and invalid slugs without a request; the existing real-D1 API tests continue to reject invalid categories, control characters, extra fields, and details over 1000 characters.
- **Refresh, 401, and retry leakage:** browser tests prove refresh never resubmits or restores details, 401 clears details while retaining the target, and 429/5xx/network failures never auto-submit.
- **Mobile and keyboard use:** desktop and 375-pixel Playwright projects prove every field and action works by keyboard and the report page has no horizontal overflow.

---

### Task 1: Restore a validated report target after OAuth

**Files:**
- Create: `migrations/0017_oauth_report_target.sql`
- Modify: `src/moderation/model.ts`
- Modify: `src/routes/auth.ts`
- Test: `tests/integration/auth.test.ts`

Recheck the actual migration directory immediately before implementation and use the next unused number; other graph plans also hold provisional reservations. Migration `0017` is provisional after provider migrations `0015_tracking_providers_tickets.sql` and `0016_expand_tracking_ticket_event_json.sql`; if the ordered migration history changes before implementation, use the next forward-only number and update this filename before editing.

**Interfaces:**
- Produces `reportTargetSchema` and `ReportTarget` in `src/moderation/model.ts`:

```ts
type ReportTarget =
  | { kind: "timeline"; timeline_id: string }
  | { kind: "link"; slug: string };
```

- OAuth start accepts either no query parameters or exactly one `report_kind` and one `report_value`. `report_kind` is `timeline` or `link`; the value is validated as the corresponding existing target identifier. Any other, missing, repeated, or malformed parameter returns the existing `INVALID_REQUEST` response before an OAuth attempt is created.
- Existing `oauth_attempts` rows store nullable `report_target_kind` and `report_target_value`. Their constraints bound the kind to `timeline|link` and the value to 1–100 characters; the route enforces the stricter Link slug expression and all-or-none pairing.
- Callback continues to consume state, browser binding, verifier, and nonce exactly once. It redirects to `/` when there is no report target, or constructs only `/report?kind=timeline&timeline_id=...` or `/report?kind=link&slug=...` from the stored validated fields.

- [x] **Step 1: Add failing OAuth continuation tests**

In `tests/integration/auth.test.ts`, add tests that start OAuth with each valid target, assert the target is stored on the attempt, complete the fake Google callback, and assert the 303 `Location` is the exact internal report route. Assert no report event or report text is created. Keep the existing no-target redirect-to-`/` assertion. Add invalid cases for arbitrary `next`, one-sided pairs, repeated keys, Timeline IDs over 100 characters, and Link slugs outside `[a-z0-9-]{3,64}`; assert 400 and zero OAuth attempts. Extend the state replay case to prove a restored target is available only to the callback that consumes the attempt.

- [x] **Step 2: Run the focused tests and confirm they fail for the missing continuation**

Run: `npm exec -- vitest run tests/integration/auth.test.ts`

Expected: the new target-storage/redirect assertions fail because the current attempt schema has no report target and the callback always redirects to `/`.

- [x] **Step 3: Add the additive migration and shared target schema**

Add nullable `report_target_kind` and `report_target_value` columns in `migrations/0017_oauth_report_target.sql`, with the bounds stated above. Extract the existing two-way target union in `src/moderation/model.ts` as `reportTargetSchema` and use it from `reportSchema` so API and OAuth validation cannot drift.

- [x] **Step 4: Store and restore only the validated target in `src/routes/auth.ts`**

Validate the exact OAuth-start query before creating the attempt; insert its kind/value with the existing hashed state, browser hash, verifier, nonce, and expiry. Extend `DELETE ... RETURNING` to consume the target fields with the attempt. After successful identity exchange and session creation, build the fixed `/report` route from those returned fields with `URLSearchParams`; retain `/` for ordinary sign-in. Never use a caller-supplied path as a redirect.

- [x] **Step 5: Run the focused auth integration suite**

Run: `npm exec -- vitest run tests/integration/auth.test.ts`

Expected: PASS, including existing PKCE, origin, expiry, mismatch, replay, and provider-claim cases.

- [x] **Step 6: Run `npm run check`, then commit the OAuth continuation slice**

```bash
git add migrations/0017_oauth_report_target.sql src/moderation/model.ts src/routes/auth.ts tests/integration/auth.test.ts
git commit -m "feat: preserve report targets through sign-in"
```

### Task 2: Add accessible Timeline and Link reporting surfaces

**Files:**
- Create: `src/client/reporter.tsx`
- Create: `tests/e2e/reporting.spec.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/main.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/timeline/render.ts`
- Test: `tests/integration/public-timeline.test.ts`

**Interfaces:**
- `src/client/api.ts` exports client types `ReportTarget`, `ReportCategory`, and `ReportReceipt`; the target union matches Task 1 and the category union is the exact five-value endpoint enum.
- `ReporterScreen({ authenticated, authGeneration }: { authenticated: boolean; authGeneration: number })` in `src/client/reporter.tsx` renders the public companion and, once authenticated, the report form. It reads only `/report` target query values or a visitor-entered Ages Link URL/slug and submits `{ target, category, detail }` through `api` and `jsonBody` to `/api/reports`.
- The `/report` URL form is strict: Timeline targets use `kind=timeline&timeline_id=...`; Link targets use `kind=link&slug=...`. A full Link URL must have the current origin and exact `/s/<slug>` path. For pasted short-link URLs or relative `/s/<slug>` paths, query and fragment are ignored, including repeated query values. For canonical `/report` URLs, accept only the exact target-specific key pair once each and reject duplicate/extra keys. Reject other origins, credentials, paths, and malformed identifiers without a report request.
- `renderTimeline` adds `Report this Timeline` (`/report?kind=timeline&timeline_id=<id>`) and `Report an Ages Link` (`/report`) anchors to its footer. `App` routes `/report` for both signed-in and anonymous visitors and adds a `Report an Ages Link` entry to the public landing page.
- Form values are exactly the existing category enum and optional detail capped at 1000. Target may remain in the report URL; category and detail never enter the URL or browser storage.

- [x] **Step 1: Add a failing SSR affordance regression**

In `tests/integration/public-timeline.test.ts`, assert that both public and unlisted Timeline HTML contain the correctly encoded `Report this Timeline` and `/report` companion links, and that the private/missing response still contains neither report affordance nor Timeline content.

- [x] **Step 2: Add the reporting browser cases before implementing the client**

Create `tests/e2e/reporting.spec.ts` with these behavior tests:

1. `timeline footer opens the report form and shows a neutral receipt`: seed a visible Timeline, activate the SSR link, assert the five exact category options, and submit optional detail. Assert the first real submission returns 201, then reload and manually submit the same target/version again; assert it returns 200 and shows the identical neutral confirmation. The reload itself must not POST.
2. `anonymous visitors carry only the target through sign-in`: start from a Timeline target and from a valid Link slug; assert the Google link contains only `report_kind` and `report_value`, with no category/detail or arbitrary redirect.
3. `the Link companion accepts only same-origin short URLs or slugs`: accept a full same-origin short URL, relative `/s/<slug>`, and a valid slug, preserve the target on refresh, and reject another origin, another path, duplicate/extra canonical report query keys, and invalid slugs without POSTing.
4. `unavailable targets show no visibility or content details`: submit a private or missing Timeline and assert one generic unavailable message with no title or media metadata.
5. `401 clears report text while retryable failures keep it`: mock 401, 403, 429, 503, and a network failure; assert 401/403 clears the form text but keeps the target, retryable failures keep the draft, and none auto-submit.
6. `target switches, logout and stale authorization cannot restore report details`: delay a submission across target/auth-generation changes and confirm late success cannot restore receipts or drafts; delayed401/403 clears current sensitive drafts.
7. `keyboard submission and refresh do not leak or repeat details`: fill and submit using labels and keyboard only, verify a refresh produces no POST and no restored detail, and confirm the page fits a 375-pixel viewport without horizontal overflow.

Run the focused tests to establish the expected initial failures:

```bash
npm exec -- vitest run tests/integration/public-timeline.test.ts
npm run test:e2e -- tests/e2e/reporting.spec.ts --project=desktop
```

Expected: the SSR assertions fail because the links are absent; the browser cases fail because `/report` currently renders the landing page or has no report form.

- [x] **Step 3: Define the browser API types and reporter component**

Add the exact target/category/receipt types to `src/client/api.ts`. In `src/client/reporter.tsx`, parse the query using the target-specific key pair, and parse pasted Link input only as specified above. When a visitor selects a target, replace the URL with its canonical `/report` form so refresh retains the target. Show only the target kind and identifier; do not fetch or render content.

- [x] **Step 4: Implement authentication, form, and feedback behavior**

Render a sign-in action before category/detail for anonymous visitors. Build its URL from the validated target using only `report_kind` and `report_value`. For authenticated visitors, render a labeled native category select, optional labeled textarea with `maxLength={1000}` and live count, and a submit button. Use the existing `api`/`jsonBody` helper. Treat 200 and 201 identically; use generic 404 copy; on 401/403 clear category/detail and switch to the sign-in state; keep the draft for 429, 5xx, and network errors; never automatically retry. Announce confirmation/errors with `role="status"` or `role="alert"`. Clear form text on logout, auth-generation changes, target changes and unmount; invalidate pending results. Apply authorization-error clearing before ordinary stale-response generation checks. Prevent concurrent duplicate submissions. Do not persist form text.

- [x] **Step 5: Mount the report route and add server-rendered entry links**

In `src/client/main.tsx`, mount `ReporterScreen` on `/report` for either session state and add the companion link to the anonymous landing page. In `src/timeline/render.ts`, add the two accessible footer links while retaining the existing canonical URL, robots metadata, and escaped Timeline content. Keep all changes in the existing client routing and Timeline renderer; do not modify `/s/:slug` resolution or raw Asset streams.

- [x] **Step 6: Add responsive reporter styling**

Add focused rules in `src/client/styles.css` for a readable narrow form, full-width controls where needed, wrapping identifiers, and visible focus. Reuse the existing color and spacing variables. Do not change administrator or owner-control styles.

- [x] **Step 7: Run focused integration and browser tests**

Run:

```bash
npm exec -- vitest run tests/integration/public-timeline.test.ts tests/integration/moderation.test.ts tests/integration/links.test.ts tests/integration/asset-links.test.ts
npm run test:e2e -- tests/e2e/reporting.spec.ts
```

Expected: PASS in desktop and mobile projects. The existing API tests continue to pin categories, detail bounds, privacy-preserving 404, deduplication, and rate limits; existing Link tests continue to pin 302 and raw-media semantics.

- [x] **Step 8: Run `npm run check`, then commit the reporter surfaces**

```bash
git add src/client/reporter.tsx src/client/api.ts src/client/main.tsx src/client/styles.css src/timeline/render.ts tests/integration/public-timeline.test.ts tests/e2e/reporting.spec.ts
git commit -m "feat: add visitor content reporting"
```

## Final verification and review gate

- [x] Confirm the final HEAD has a passing `npm run check` from the last task; run it if subsequent code changed. Expected: client and Worker builds, Biome lint, all typechecks, Vitest unit/integration tests, and Playwright desktop/mobile suites pass.
- [x] Run `git diff --check`. Expected: no whitespace errors.
- [x] Review the complete branch diff for accidental changes to `src/routes/links.ts`, `src/moderation/reports.ts`, `src/routes/moderation.ts`, `src/client/moderation.tsx`, owner Link controls, or unrelated in-progress work. Confirm the migration is additive and forward-only.
- [ ] Capture desktop and mobile screenshots of the public Timeline footer and Link report companion; include them with validation results in the PR.
- [ ] Self-review and request an independent code review. Open one `feat/public-reporting-ux` PR targeting `main` (no released branch exists), include the focused and full-check results and UI evidence, and require independent code-review approval and passing GitHub CI before merging. Human design and plan approval gates are waived by the user. Do not deploy as part of this change.
