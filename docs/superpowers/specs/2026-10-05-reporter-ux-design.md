# Public Content Reporting UX

**Status:** Design authorized under the user's October 5, 2026 blanket approval; root self-review completed before implementation.

## Outcome

Visitors can report a visible public or unlisted Timeline from its rendered page, or report an Ages short Link from a dedicated companion page. A visitor must sign in before submitting. Sign-in returns them to the exact bounded report target, and the report page never loads or reveals the target's private content.

The existing authenticated report endpoint and administrator moderation controls remain the source of truth. This design adds no report lifecycle, review queue, role, or takedown behavior.

## Existing report contract

`POST /api/reports` requires an authenticated session and a same-origin write. Its strict JSON body is:

```json
{
  "target": { "kind": "timeline", "timeline_id": "<id>" },
  "category": "spam",
  "detail": ""
}
```

The only target forms are `{ kind: "timeline", timeline_id }` and `{ kind: "link", slug }`. Timeline IDs contain 1–100 characters. Link slugs match `[a-z0-9-]{3,64}`. The five category values are `spam`, `abuse`, `copyright`, `illegal`, and `other`. `detail` is optional, defaults to the empty string, allows tab/newline/carriage return among control characters, and has a maximum length of 1000. Extra body fields are rejected.

The server accepts only currently visible public or unlisted Timelines and currently eligible public Links. Ineligible, private, missing, blocked, inactive, or expired targets all return the same privacy-preserving 404. New and deduplicated reports both return `{ report: { id, status: "received" } }`; their HTTP statuses are 201 and 200 respectively. The existing per-reporter rate limit returns 429 with `Retry-After`. Unauthenticated requests return 401, foreign-origin writes return 403, and invalid bodies return 400. Report details and session secrets are not written to request logs.

## Entry points and flow

### Timeline shares

The server-rendered `/t/:id` page adds a semantic `Report this Timeline` link in its footer, targeting `/report?kind=timeline&timeline_id=<id>`. The same footer links to the general `/report` companion for a visitor who needs to report an Ages Link. The CTA appears only on a page that already passed the public/unlisted visibility check. Its label and URL include no title, caption, media URL, or other content.

### Link shares

`/s/:slug` retains its current resolver behavior: ordinary URL and Timeline Links redirect directly, provider-enabled Links use the existing consent flow, and Asset Links retain their authorized media delivery. The visitor reporting feature adds no interstitial and does not change these responses.

The React application exposes a public `/report` companion, linked from its public landing page and from the Timeline footer. It accepts a slug, a relative `/s/<slug>` path, or a full Ages short-link URL. Resolve a relative short-link path against the current Ages origin. A full URL is accepted only when its origin is the current Ages origin and its path is exactly `/s/<valid-slug>` and it has no URL credentials; query and fragment values are ignored. A plain slug must match the existing slug expression. Once selected, the target is represented as `/report?kind=link&slug=<slug>` so a refresh can keep the selected target without storing report text. Visitors reporting a redirect or raw-media Link can paste the short URL they received into this companion.

The companion never fetches a Link's target or renders a Timeline, Asset, external destination, or owner information. Its visible target summary is limited to “Timeline” or “Ages Link” and the submitted identifier. This gives visitors a reporting entry that preserves the short-link and raw-media contracts while keeping target eligibility authoritative at submission time.

### Sign-in continuation

An anonymous visitor sees the report target and a `Continue with Google` action before entering category or detail. Starting OAuth sends only a typed target pair, such as `report_kind=timeline&report_value=<id>` or `report_kind=link&report_value=<slug>`. `/auth/google` validates the pair against the existing target bounds and stores it on the existing short-lived `oauth_attempts` row. It does not accept a `next`, `return`, or arbitrary URL parameter. A normal sign-in with no report target still returns to `/`.

The callback consumes the existing state, browser cookie, PKCE verifier, and nonce once. When the row contains a report target, it constructs a same-origin `/report` URL using that validated kind/value and redirects there. The callback does not accept a return URL from Google or the browser. The only additional database state is the bounded target kind and value on the already single-use OAuth attempt; no category, detail, or content is stored. Cancelling OAuth or failing state validation creates no report.

### Report submission and feedback

After `/api/me` confirms a session, the page shows a labeled category select with the five existing values, an optional detail textarea capped at 1000 characters, a live character count, and a submit button. A native form, fieldset/legend where useful, visible labels, keyboard-operable controls, and announced status/error regions support keyboard, touch, and screen-reader use.

The client submits the exact existing body to `POST /api/reports`; it does not retry automatically. Both 200 and 201 show the same neutral confirmation: “Thank you. Your report has been received.” A 404 says the share is unavailable and cannot distinguish private, blocked, expired, and missing targets. A 401 or 403 clears category/detail and shows a sign-in action carrying only the validated target. A 429, 5xx, or network failure keeps the current form draft and offers manual retry. Logout, authentication-generation changes, target changes, and unmount invalidate pending submissions and clear category/detail. Late ordinary responses cannot restore old drafts or receipts, while even a stale 401/403 clears drafts before ordinary response-generation filtering. A browser refresh never resubmits; report text is not stored in a URL, cookie, local storage, or session storage.

## Boundaries and privacy

- Do not change `/api/reports`, `src/moderation/reports.ts`, report persistence, rate limits, or report deduplication.
- Do not change `/api/admin/*`, `src/client/moderation.tsx`, owner Link controls, or administrator controls.
- Keep `/s/:slug` redirects and existing optional provider consent, Timeline canonical URLs, and Asset Link GET/HEAD/range semantics intact.
- Reuse the existing public Timeline and SPA routes; do not add a dependency or a new moderation backend.
- The only new server persistence supports a validated report target across the existing one-use OAuth callback. It carries no report text or target content.
- Treat Timeline IDs and Link slugs as identifiers, never as authorization grants. The current API rechecks visibility and Link eligibility when the report is submitted.
- Keep private target responses indistinguishable from missing, blocked, inactive, and expired target responses.

## Acceptance checks

1. A public and an unlisted Timeline expose an accessible report link; a private Timeline remains a 404 with no report UI or content disclosure.
2. A visitor can report either target type after signing in. The OAuth callback restores only a strict Timeline ID or Link slug and rejects arbitrary redirects, malformed pairs, repeated parameters, state mismatch, and callback replay.
3. The report form uses the existing five values, accepts optional detail through 1000 characters, displays a count, and shows the same confirmation for 200 and 201.
4. Ineligible targets show a generic unavailable message. A 401 or 403 clears report text while preserving only the safe target; 429, 5xx, and network failures do not auto-submit again.
5. Reloading the report page does not submit a report or restore report text. The selected target remains when it is represented in the validated report URL.
6. Desktop and 375-pixel mobile browser checks cover keyboard-only use, focus and status announcements, and no horizontal overflow.
7. Existing administrator reports, blocking controls, direct short-link redirects, and raw-media Link delivery continue to pass their regression suites.

## Decisions and known boundary

The short-link and raw-media response has no Ages-rendered control. This design exposes the companion from Ages-owned public pages and lets a visitor paste the known short URL or slug. Adding a mandatory interstitial or changing raw-media delivery would alter the existing share contract and is outside this design.
