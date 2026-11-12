# Security operations baseline

This document distinguishes intended architecture from verified deployment.
Do not infer a production resource, database version, security rule, or rollout
from a checked-in Wrangler configuration alone.

## Runtime inventory and gaps (2026-11-12)

| Surface | Expected platform | Verification | Outstanding evidence |
| --- | --- | --- | --- |
| OKE app | Node 22.22.2, Wrangler local Worker emulator, local D1 (SQLite), R2 and KV on an `emptyDir` | GitOps/Dockerfile manifests | Current Pod image digest, running library/SQLite version, persistence after restart |
| Cloudflare app, `app.ages.tw` | Worker, D1, R2, KV | Public `/health` returned 200, anonymous `/api/me` returned 401 on 2026-11-12 | Exact published Worker revision, binding resource IDs, D1 `SELECT sqlite_version()`, schema migration ledger and recoverable backups |
| DEV brand site, `brand.ball-in.club` | Nginx 1.27 Alpine behind Cloudflare Tunnel | Public HTML returned 200 with `noindex` | Current Pod image digest, current WAF rule inventory |
| Cloudflare Pages brand site, `ages-brand.pages.dev` | Static HTML/CSS, no SQL database | Public HTML returned 200 with `noindex` | Custom-domain cutover, security-header acceptance |
| Apex `ages.tw` | Intended official site | Returned a sign-in-required page (HTTP 401) | Mapping to Pages and public acceptance |

The repository's named Worker `development`, `preview`, and `production`
environments still contain `REPLACE_*` resource IDs. They cannot be used as
proof that the running production Worker has the same package versions.
The production D1/SQLite engine is platform-managed; verify its **actual**
`sqlite_version()` using an authenticated, read-only Cloudflare D1 query. Do
not expose this on an unauthenticated endpoint.

## Active detection and prevention

1. `Security gates` runs on each PR/push and every Monday. The NPM audit blocks
   moderate-or-higher dependency advisories; Trivy blocks high/critical
   dependency and secret findings; CodeQL uses `security-extended`. The
   non-gating Trivy misconfiguration pass explicitly reports the existing
   writable-root DEV limitation without silently suppressing it.
2. `Safe public security smoke` runs daily and on demand. It issues exactly four
   small, unauthenticated GET requests and checks HTTPS response contracts,
   anonymous access controls, no-store API caching and static-site noindex.
   It does **not** fuzz, enumerate, authenticate, upload, or mutate data.
3. Application-level, database-backed rate limits already return 429 and
   `Retry-After` when exceeded. A new privacy-safe `security_event` is logged
   on active blocks, with `type=rate_limit_exceeded`, `action=blocked`, policy,
   request ID and limit; no IP address, token, user ID or raw URL is logged.
   Configure a centralized log alert for abnormal event volume by policy and
   source Worker, then validate using synthetic requests in local tests only.
4. Enable GitHub Dependabot alerts, security updates, and weekly dependency
   refreshes. Review security PRs; never grant CI a production deploy token.

## Cloudflare WAF rollout checklist

Before changing a zone, export the existing rules, preserve `app.ages.tw`,
`www`, email/DNS verification records and any current `oke.ball-in.club`
deny policy, and use a separate scoped Cloudflare API token.

- Verify that the Cloudflare Free Managed Ruleset is enabled for the relevant
  zone. Review Security Events for false positives before any new blocking.
- Consider a narrowly scoped rate-limiting rule on `/auth/` endpoints, starting
  with a threshold compatible with the existing D1 30/IP/minute auth limit.
  Free-plan rate limiting expression fields may not allow hostname matching;
  verify rule availability and the effect across subdomains before enabling it.
- Protect sensitive paths (for example `/.git` and `/.env`) with a zone-scoped
  custom WAF rule. Do not block `/.well-known` generically or deploy broad
  challenge rules that could disrupt crawlers, OAuth callbacks or real clients.
- Configure alerts for spikes in blocked/challenged traffic and unusual login
  failure rates. Decide notification recipient, retention, and response owner.
- Test a narrow rule in a safe environment first, evaluate challenge/deny
  counts, then enable production blocking with a recorded rollback path.

Cloudflare rule installation and alerts are **not** verified or enabled by
this repository. Requires Cloudflare account access and an explicit deployment
validation. No production DNS, Worker binding, or persistent D1 data is changed
by these CI/security checks.

## Outstanding hardening

- The OKE DEV Wrangler container uses a writable root filesystem and local
  `emptyDir`. Redesign writable mounts and validate with a read-only filesystem
  before enabling `readOnlyRootFilesystem`; a naive toggle breaks the emulator.
- Audit `nginxinc/nginx-unprivileged:1.27-alpine` and pinned `cloudflared` image
  digests for OS CVEs; update by tested GitOps PR, not moving tags.
- Verify real production Worker dependency versions and D1/R2/KV bindings via
  Cloudflare API. `npm audit` only applies to this repository's lockfile.
- Require backups and a tested point-in-time recovery procedure before real
  user data is entrusted to OKE local storage.
