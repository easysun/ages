# Ages

A Living Timeline for media and memories: upload once, organize by time, tell the story, share, and keep adding moments.

## Current scope

Foundation and Google authentication: TypeScript/Hono Worker, D1 identity/session schema, local R2/KV bindings, request IDs, structured errors, runtime validation, health checks, and CI. Uploads, timelines, and the React UI are subsequent PRs. See the [implementation plan](docs/implementation-plan.md) for sequencing, acceptance gates, and launch requirements.

## Local development

Install Node.js 22.22.2 (see `.node-version`) and npm. Foundation and automated tests need no Cloudflare account or secrets. Interactive Google sign-in needs the configuration below.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Wrangler serves `http://127.0.0.1:8787` using local D1, R2, and KV, with state in ignored `.wrangler/`. The root URL intentionally returns 404 until the web client is implemented.

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
| `npm run build` | Bundle to `dist/` using a dry run; does not deploy |
| `npm run check` | Run lint, types, all tests, and build |

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

New accounts receive provisional private-beta allowances: 1 GiB storage, 250 MiB maximum asset size, ten timelines, and 100 links. These are not published pricing. Upload will apply narrower per-media limits and reservation accounting. Returning sign-ins preserve existing quotas. Expired sessions/attempts are cleaned at login start; the hardening slice will also schedule cleanup. Real Google sign-in remains an external smoke gate; tests use locally signed synthetic tokens and mocked provider endpoints with real local D1.

Reference: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect). JWT verification uses the pinned, Workers-compatible `jose` package instead of custom signature code.

## API foundation

Every response includes `X-Request-ID`; errors use the same ID in their body and structured log. IDs are generated server-side. Raw request URLs, headers, cookies, bodies, exception messages, and secrets are not written to application logs. Logs retain the error code, matched route pattern, method, status, and duration.

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
