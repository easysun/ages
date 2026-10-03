# Ages

A Living Timeline for media and memories: upload once, organize by time, tell the story, share, and keep adding moments.

## Current scope

Foundation, Google authentication, direct upload, owner-scoped Asset Library and Timeline APIs, public Timeline SSR, reference-aware trash/restore, immutable URL/Timeline/Asset Links, and a responsive React Library client are implemented. The Worker has D1 identity/assets/tags, local R2/KV bindings, structured errors, runtime validation, health checks, and CI. Timeline editing, QR controls, and cloud release gates remain subsequent slices. See the [implementation plan](docs/implementation-plan.md) for sequencing, acceptance gates, and launch requirements.

## Local development

Install Node.js 22.22.2 (see `.node-version`) and npm. Foundation and automated tests need no Cloudflare account or secrets. Interactive Google sign-in needs the configuration below.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Wrangler serves `http://127.0.0.1:8787` using local D1, R2, and KV, with state in ignored `.wrangler/`. The root URL opens the sign-in landing page or authenticated Library. `/library?tag=Coast` is refresh-safe. The client and APIs share the Worker origin.

```sh
curl -i http://127.0.0.1:8787/health
curl -i http://127.0.0.1:8787/health/ready
```

`/health` is liveness (200, independent of storage). `/health/ready` checks the migrated users table and reads R2/KV without writing probe objects; missing migration/bindings return a generic 503. Readiness performs storage operations and is intended for low-frequency checks, not a user-facing polling loop.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact lockfile dependencies |
| `npm run dev` | Start the local-only Worker |
| `npm run db:migrate:local` | Apply unapplied SQL migrations to local D1 |
| `npm run types` | Generate ignored runtime/binding types from Wrangler |
| `npm run lint` / `npm run format` | Check / fix Biome formatting and lint |
| `npm run typecheck` | Check Worker, test, and tool configurations |
| `npm run test:unit` | Test validation, error, and logging contracts |
| `npm run test:integration` | Test Worker entry point and actual local storage |
| `npm test` | Run all Vitest tests in workerd |
| `npm run build` | Build React assets into `dist/client` and dry-run Worker bundle into `dist/worker`; does not deploy |
| `npm run check` | Build the client, run lint/types, runtime tests, dry-run Worker build, and desktop/mobile browser tests |
| `npm run dev:client` | Watch and rebuild client assets alongside `npm run dev` |
| `npm run test:e2e` | Build and test the real local Worker/client with isolated D1/R2 fixtures |

Tests use isolated local storage, separate from the development database. Migration tests exercise a fresh database, reruns with preserved data, constraints, and batch rollback. JSON parser tests register test-only routes; no public echo or exception endpoint is deployed.

## Google authentication

Create a Google OAuth **Web application** client and register the exact redirect URI `http://127.0.0.1:8787/auth/google/callback` for local development. Copy `.dev.vars.example` to ignored `.dev.vars`, then set the client ID and secret there. Never paste secrets into chat, commits, or PRs. Each deployed environment needs its own `APP_ORIGIN` and registered HTTPS redirect URI; supply credentials through platform secrets.

| Route | Contract |
| --- | --- |
| `GET /auth/google` | Start a ten-minute, browser-bound Google OIDC/PKCE attempt |
| `GET /auth/google/callback` | Consume the attempt once, verify the ID token, rotate the session, redirect to `/` |
| `GET /api/me` | Return the authenticated `user` and `quota`; otherwise 401 |
| `POST /auth/logout` | Revoke immediately and clear the cookie; idempotent 204 |

`APP_ORIGIN` is a canonical origin without a trailing slash. HTTP is accepted only for loopback hosts in `local`. Logout requires an exact `Origin` header; missing, null, or foreign origins are rejected. Future browser mutation endpoints must reuse this policy. No bearer-token/native sign-in endpoint is implemented yet.

Sessions are random 256-bit tokens with a seven-day lifetime; D1 stores only SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, host-only, and Secure with the `__Host-` prefix outside `local`. State and browser bindings are hashed; short-lived PKCE verifiers remain server-side. The callback verifies signature, issuer, audience, authorized party, expiry, and nonce. No Google access/refresh tokens are persisted or returned. Accounts bind to Google subject, never implicitly to an email match; conflicting email ownership does not transfer an account.

New accounts receive provisional private-beta allowances: 1 GiB storage, 250 MiB maximum asset size, ten timelines, and 100 links. These are not published pricing. Upload applies narrower per-media limits and reservation accounting. Returning sign-ins preserve existing quotas. Expired sessions/attempts are cleaned at login start; the hardening slice will also schedule cleanup. Real Google sign-in remains an external smoke gate; tests use locally signed synthetic tokens and mocked provider endpoints with real local D1.

Reference: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect). JWT verification uses the pinned, Workers-compatible `jose` package instead of custom signature code.

## Responsive Library client

The React client is built with Vite and served through Wrangler static assets. API, auth, health, Timeline (`/t`), and short-link (`/s`) paths always reach Hono, including unknown paths in those namespaces; browser navigation falls back to the client HTML. New static output and Worker bundles stay separate. No external site hosting or deployment is part of the local build.

Sign-in uses the existing Google route. The authenticated Library shows private photos/videos, exact tag filters, cursor pagination, keyboard selection, storage use, and a responsive detail dialog with tag editing. Add moments sends the original File directly to the returned signed R2 PUT URL, then finalizes through JSON. Upload retries check completion first, preserving an upload whose PUT response was lost. Metadata and binary media keep their existing separate APIs. Timeline editing and sharing remain subsequent slices; there are no destructive asset controls.

Before running `npm run check` for the first time, install the browser with `npx playwright install chromium` (CI installs Chromium and system dependencies). Browser tests run the built client through actual HTTP at `http://127.0.0.1:8791`, with `.wrangler/e2e` persistence and synthetic users, hashed sessions, and PNG media seeded by local Wrangler CLI commands. Session cookies are injected only by Playwright fixtures, with no production authentication or fixture endpoint. Tests cover anonymous gating, foreign asset isolation, real media, tag persistence, pagination, desktop keyboard controls, 375-pixel touch layouts, request races (including upload/filter and upload/sign-out), upload recovery, focus restoration after tag edits, and API/client routing. Test screenshots and traces are written to ignored `test-results/`.

Local upload browser scenarios simulate only the signed R2 transport: Playwright intercepts the synthetic S3 hostname, checks the PUT headers and binary body, seeds that object into local R2, and calls the real completion API. These are **simulated upload transport** checks, not evidence of cloud signature enforcement or CORS. Actual Google sign-in and live browser PUT remain the existing credentialed cloud smoke gates.

## Direct media upload

1. Authenticated clients send JSON to `POST /api/assets/upload-intent`: `filename`, `mime_type`, `size_bytes`, and optional offset-qualified `captured_at`.
2. A 201 response returns a private pending `asset` and `upload` containing `method`, `url`, `headers`, and `expires_at`. Send the original File/Blob directly to that R2 URL, not through the Worker.
3. Call `POST /api/assets/:id/complete` after PUT succeeds. A 200 response contains the ready asset; retries and simultaneous completions count storage once.

Both API mutations require the session cookie and exact same-origin policy. The URL lasts ten minutes and signs the object path, Content-Type, exact Content-Length, and **If-None-Match: \***. Clients must send every returned header. Browsers calculate Content-Length from the File/Blob; do not set it manually or wrap the file in FormData. A second PUT returns a precondition failure instead of overwriting media. If a PUT response was lost, attempt completion before starting a replacement intent. Never log or persist the signed URL.

Allowed media: JPEG, PNG, WebP, GIF (up to 25 MiB), MP4 and WebM (up to 250 MiB), additionally capped by account limits. Completion checks object size, stored MIME, ETag, format signatures, and image dimensions using at most 256 KiB. Images must have readable headers within that sample, sides at most 30,000 pixels, and at most 100 million pixels. This is metadata validation, not a full decoder, antivirus scan, or video codec/transcoding guarantee. Audio and arbitrary files remain disabled.

Live pending/failed intents reserve quota until their capability expires; ready assets count in `storage_used_bytes`. `/api/me` also reports `storage_reserved_bytes`. Invalid uploaded objects require a new intent, not an overwrite. Missing objects can retry completion until expiry. `cleanupExpiredUploads` releases expired intents and purges abandoned objects only after a 24-hour grace period, in cursor batches; scheduling and orphan reconciliation belong to the hardening slice. Never enable public uploads before rate limits, cleanup scheduling, and abuse controls are verified.

### R2 environment requirements

Keep the bucket private: disable public `r2.dev` access and do not expose a public bucket domain. Configure `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` for an isolated cloud environment whose `MEDIA` binding refers to that same bucket. Store keys through platform secrets. Bucket CORS must allow the exact app origin, PUT, Content-Type, If-None-Match, and Content-Length; optionally expose ETag. Do not use wildcard origins as a substitute for configuration.

Local tests use real simulated D1/R2 and synthetic signing credentials. Wrangler's local R2 binding is not a public S3 endpoint; the app intentionally has no binary proxy fallback. A real browser direct-upload smoke test needs isolated cloud bindings, credentials, and CORS. Before release, verify a 250 MB PUT, signed-header tampering rejection, duplicate PUT rejection, expiry, and completion against real R2.

References: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [conditional PutObject support](https://developers.cloudflare.com/r2/api/s3/api/), and [bucket CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## Asset Library

All Library endpoints require a valid session cookie. They return `private, no-store` responses with `nosniff`; visibility never permits a foreign user to access these owner endpoints.

| Route | Contract |
| --- | --- |
| `GET /api/assets` | Ready assets, ordered by `created_at DESC, id DESC`, with `tags` and `next_cursor` |
| `GET /api/assets/trash` | Owner-only deleted assets with tags and a collection-scoped keyset cursor |
| `POST /api/assets/:id/trash` | Strict empty JSON `{}` moves an unreferenced owned ready asset to recoverable trash |
| `POST /api/assets/:id/restore` | Strict empty JSON `{}` restores retained, validated media before the 30-day deadline |
| `GET /api/assets/:id` | Owned asset metadata and tags; pending/failed uploads remain inspectable; deleted/purged assets return 404 |
| `GET /api/assets/:id/media` | Stream the validated ready asset from private R2; missing/changed objects return 404 |
| `HEAD /api/assets/:id/media` | Validated full media metadata without reading a body; ignores Range |
| `PUT /api/assets/:id/tags` | Replace the complete tag set atomically using JSON `{ "tags": ["Travel"] }`; exact same-origin policy applies |

Listing accepts only `limit` (default 30, maximum 100), an exact case-sensitive `tag`, and the opaque `cursor` returned by the previous page. Keep the same tag filter when continuing; cursors from another owner or filter return standardized 400. New uploads ahead of the cursor do not shift older pages. This is keyset pagination, not a frozen snapshot of later completions or tag edits.

Tags preserve their exact spelling and spaces. Supply at most 20 distinct nonblank strings, each at most 64 UTF-16 code units, without ASCII control characters. Duplicate tags, unknown body fields, invalid strings, and malformed JSON return standardized 400 without altering saved tags. An empty array clears the set. Tag ownership is also enforced by database triggers in additive migration `0004_asset_tags.sql`.

Asset JSON excludes owner IDs, R2 keys, ETags, and upload expiry. Media responses use authoritative MIME/size and conditional ETag reads, checking R2 version consistency between metadata and streaming. Uploader cache headers are never copied. Single byte ranges return 206 with Content-Range; unsupported or unsatisfiable ranges return 416 with `bytes */<size>`. Storage validators are not exposed, so If-Range requests receive the complete representation.

Trash and restore require the same-origin policy and return the normal asset/tag shape. Trashing a real timeline item, cover, or active Asset Link reference returns 409 without changing the asset or media; removing a reference never deletes its asset. Repeated trash of an owned deleted asset and repeated restore of a ready asset are idempotent, including timestamps. Pending/failed assets return 409; missing, foreign, and purged assets return 404.

Trash retains the R2 bytes, tags, and charged storage quota. Restore requires the retained object's validated ETag, size, and MIME, and clears `deleted_at` only before `deleted_at + 30 × 24 hours`; exactly at that deadline and later it returns 409. Expired trash remains visible and charged until a future scheduled purge. Additive migration `0007_asset_trash_generation.sql` assigns an internal generation token to existing deleted assets; every new trash gets a fresh token, and restore compares and clears it. The token is never returned in asset JSON. Distinct trash operations remain distinguishable even when their timestamps are identical. No physical deletion or purge endpoint is enabled, and these mutations never write or delete R2 objects. The trash list accepts only `limit` and `cursor`, uses the same creation-time/ID ordering, and rejects cursors from the ready collection or another owner. Restoring removes the item from the trash list. The responsive Library UI exercises ready assets through actual local HTTP browser tests; trash/restore controls remain a later UI slice.

## Timeline domain

All `/api/timelines` routes require authentication and scope reads to the owner, including timelines marked public or unlisted. Public viewing uses the separate `/t/:id` routes below. Mutations require the exact same-origin policy and strict JSON bodies.

| Route | Contract |
| --- | --- |
| `POST /api/timelines` | `{title}` creates a private timeline at version 1, subject to the account timeline quota |
| `GET /api/timelines?limit=50&cursor=...` | Owner list in creation-time/ID descending order; `limit` is 1–100; returns `timelines` and nullable `next_cursor` |
| `GET /api/timelines/:id` | Return `timeline` including story items in narrative position order |
| `PATCH /api/timelines/:id` | `expected_version` plus one or more of `title`, `visibility`, nullable `cover_asset_id` |
| `POST /api/timelines/:id/items` | `expected_version`, `asset_id`, optional `caption` and nullable `event_at`; append with a new independent item ID |
| `PATCH /api/timelines/:id/items/:itemId` | `expected_version` plus `caption` and/or nullable `event_at` |
| `DELETE /api/timelines/:id/items/:itemId` | JSON `{expected_version}` removes only that item, never its asset |
| `PUT /api/timelines/:id/order` | `expected_version` and the complete unique `item_ids` list, up to 1,000 IDs |

Mutations return the updated `timeline` and advance its version once. Stale/concurrent versions and unavailable associations return 409; malformed or incomplete reorder sets return 400 without changes. Owner mismatches return 404. Every dependent D1 write and returned result is gated by a fresh internal mutation token; a zero-row version comparison cannot modify item rows. The response reads belong to that same transaction. Tokens and owner IDs are not returned.

An asset may appear in multiple timelines or multiple items with independent captions and event dates. Covers and items require owned, ready, undeleted assets. Database ownership constraints and reference triggers protect assets from trash, purge, or physical deletion while referenced. Item removal leaves narrative position gaps; a complete reorder assigns positions from zero. No timeline deletion endpoint, interactive editor, or Link resolver is implemented.

`event_at` is either null, `{"kind":"date","date":"2024-02-29","time_zone":"Asia/Taipei","calendar":"iso8601"}`, or `{"kind":"instant","instant":"2026-10-04T08:30:00.000Z","time_zone":"Asia/Taipei"}`. Calendar dates retain their precision and named timezone without conversion to midnight UTC. Offset-qualified instants normalize to UTC millisecond timestamps while retaining the named presentation timezone. Numeric offset strings are not timezone names. These values never rewrite asset capture timestamps.

## Short Links

Link ownership is independent of the target. Authenticated, same-origin `POST /api/links` accepts `{ "target": { "kind": "url", "url": "https://example.com" }, "slug": "optional-name", "expires_at": null }` an owned public/unlisted Timeline target `{ "kind": "timeline", "timeline_id": "tl_..." }`, or an owned ready, undeleted Asset target `{ "kind": "asset", "asset_id": "as_..." }`. Only HTTP(S) URLs without embedded credentials or control characters are accepted. Slugs contain 3–64 lowercase ASCII letters, digits, or hyphens; omitted slugs are generated. Collisions return 409. Target, slug, and owner are immutable.

Owner-only `GET /api/links` lists links with descending creation-time/ID keyset pagination (default 30, maximum 100), and `GET /api/links/:id` returns details. Cursors are bound to the owner and Link collection. `PATCH /api/links/:id` changes only `active` and nullable future UTC `expires_at`. Inactive links continue to count toward the account limit and retain their slugs. There is no Link deletion endpoint. Additive migration `0008_distribution_links.sql` copies every existing Link from migration 0006 into the canonical `distribution_links` table without changing IDs, targets, flags, deadlines, timestamps, or quota accounting, then freezes the old `links` table as a read-only archive. A permanent global slug ledger prevents reuse even if a Link row is later removed.

Anonymous `GET`/`HEAD /s/:slug` resolves active, unexpired URL/Timeline Links with a 302 and no-store policy. Timeline targets recheck authoritative visibility on every resolution, then redirect to the stable canonical `/t/:id` URL. Making the Timeline private immediately blocks subsequent resolutions. Basic Link expiry controls this alias, not the independent public target URL. Asset Links serve raw media directly at `/s/:slug`, including HEAD and single byte ranges, using the same validated R2 streaming helper as Library and Timeline media. Each request checks the current active/expiry grant and same-owner ready, undeleted Asset; it rechecks after R2 metadata and body inspection before emitting success headers or bytes. Missing, expired, revoked, or invalid grants return 404. The Asset stays private, and owner APIs still require authentication; no storage URL or validator is exposed.

Every active Asset Link blocks trash, including an expired Link, until its owner explicitly deactivates it. Creation and reactivation are guarded transactionally against unavailable Assets; trash also checks actual Link references and has a database trigger guard. Deactivation changes only the Link, preserving Asset bytes, tags, and storage quota. Inactive Link foreign keys keep Asset rows intact while future purge changes their state. QR UI, passwords, and private Timeline grants remain separate slices; unsupported grant fields are rejected.

## Public Timeline viewer

`GET /t/:id` renders a responsive, script-free HTML story in narrative order with escaped title/captions, canonical URL, and basic Open Graph metadata. The configured `APP_ORIGIN` supplies canonical and OG origins; request Host headers and query strings do not change them. Appending an item keeps the same `/t/:id` URL. Image covers, or the first image item when no image cover is selected, supply the scoped OG image. Video-only stories do not advertise video bytes as an OG image.

Public timelines emit `index, follow`. Unlisted timelines emit `noindex, nofollow` in both HTML and `X-Robots-Tag`. Private and missing timelines return the same generic 404 without title, captions, OG, or cover metadata, including when an owner cookie is present. Owner viewing/editing remains available through authenticated APIs; private viewer grants are not implemented.

`GET`/`HEAD /t/:id/media/:assetId` authorizes against current D1 visibility and actual item or cover membership on every request. Assets must belong to that timeline's owner and be ready and undeleted. Asset visibility alone grants no access. Removing the association or making the timeline private immediately blocks subsequent media requests, even after an earlier successful fetch. A shared asset may remain available through a different authorized timeline.

The public media route and owner Library route reuse `streamAssetMedia` for validated R2 ETag/MIME/size checks, metadata/read version consistency, direct streaming, single byte ranges, HEAD, and 416 handling. The helper grants no access; each route enforces its own authorization first. All HTML and media responses currently use `private, no-store` plus `nosniff`; no KV or public response cache is enabled. Content-Security-Policy permits only same-origin media and the static inline style.

Local verification includes real D1/R2 HTTP tests and desktop/375-pixel browser inspection with synthetic media. This is a static viewer; automated interactive editor/mobile/keyboard tests, viewport gestures, large-story virtualization, real crawler smoke, and cloud deployment remain separate gates. No Link entity, private grants, QR codes, or deployment is included here.


## API foundation

Every API response includes `X-Request-ID`; errors use the same ID in their body and structured log. IDs are generated server-side. Raw request URLs, headers, cookies, bodies, exception messages, and secrets are not written to application logs. Logs retain the error code, matched route pattern, method, status, and duration.

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request.",
    "request_id": "req_<uuid>"
  }
}
```

API metadata bodies are limited to 64 KiB. New JSON endpoints must call `parseJson(context, schema)` with a strict Zod schema, producing standard 400 responses for malformed JSON or invalid fields. Large binary uploads will go directly to R2. Responses default to `Cache-Control: no-store`; public content caching requires an explicit policy in the sharing slice.

## Environments and migrations

`wrangler.jsonc` contains a local default plus independent `development`, `preview`, and `production` bindings. The local UUIDs are simulator-only placeholders. Named environments contain explicit `REPLACE_*` markers and cannot be used until real, distinct D1/R2/KV resources are selected. Never copy production bindings into local development. No cloud resources have been provisioned.

Migrations are numbered SQL files under `migrations/`; Wrangler records applied migrations in `d1_migrations`. Rerun the migration command, not individual SQL files. Never edit a migration already applied to a shared environment. The initial migration only establishes users, hashed sessions, and quotas; later domain schemas belong to their feature PRs. Quota reservations arrive with upload, before issuing any upload capability.

Keep secrets in ignored `.dev.vars` for local work and Wrangler/platform secrets in deployed environments. Do not commit tokens or cloud credentials. Remote migrations and deployment are explicit operational actions; the operations PR will add resource/migration preflight, rollback, backups, and cloud smoke gates. CI currently verifies without deployment credentials.

## Contributing

Follow [AGENTS.md](AGENTS.md): English repository content and PR metadata, atomic commits, separate feature PRs, and regression tests for existing behavior. Client localization can use other languages. The planned React client must support responsive desktop/mobile layouts and keyboard/touch input. API/domain code must stay independent of browser rendering.
