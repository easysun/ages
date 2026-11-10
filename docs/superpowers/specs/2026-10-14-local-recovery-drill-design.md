# Local Recovery Drill Design

**Goal:** Provide one reproducible synthetic-only local command that backs up and restores D1 schema/data and its associated R2 object into isolated local resources, then verifies the restored relationship, D1 metadata, quota, and object bytes.

**Operator command:** `npm run recovery:drill`

**Status:** Design for implementation. This is a local operations tool and does not close Stage 10’s Cloudflare recovery gate.

## Context and success criteria

Stage 10 requires a D1/R2 recovery rehearsal. The implementation plan explicitly says to rehearse D1 recovery and R2 retention separately because a database backup does not contain objects. The prior local probe established that Wrangler 4.147.0 supports schema-only `d1 export --no-data` and data-only `--no-schema`, and confirmed that replaying one combined export can fail when a Timeline insert precedes its composite parent index.

A clean normal run must pass using synthetic data. It applies current migrations to source D1, seeds one synthetic user/quota, ready Asset, private Timeline and TimelineItem, and writes one synthetic PNG to source R2. It exports schema and data separately, backs up R2 independently, restores both services into distinct local stores, and verifies one joined row on each side. Selected D1 fields must be equal, including quota, Asset MIME/size/capture date/visibility, Timeline visibility, and TimelineItem date-only `event_at`. Original, backup, and restored object byte counts and SHA-256 hashes must match. The restore command must pass the source D1 `mime_type` through R2 `put --content-type`; restored D1 MIME must equal source D1 MIME.

The installed R2 CLI exposes get and put but no metadata readback or HEAD command. The drill therefore cannot independently verify the stored R2 HTTP Content-Type after restore. It records that limitation instead of treating the `--content-type` argument as metadata readback.

## Approaches considered

1. **Manual Wrangler command recipe:** little code, but makes persistence paths, unique resources, ordering, and comparison error-prone for each operator.
2. **Adapt the old throwaway runner:** it contains useful evidence but duplicates a large one-off harness.
3. **Small Node ESM CLI around pinned Wrangler:** recommended. It keeps the supported command sequence exact, testable, and dependency-free while leaving all state in one unique ignored run directory.

## Architecture and workflow

The CLI locates the repository from its module path and exclusively creates a unique UTC-timestamp/UUID directory below `.wrangler/recovery-drills/`. It verifies the fixed output parent remains inside the repository and has no symlinked path component, then refuses an existing file, directory, or symlink at the target. It offers no CLI arguments or arbitrary output path, rejects unknown arguments before writing, never overwrites or deletes a run, and preserves partial evidence on failure. Internal run IDs must be single path components, excluding empty values, separators, dot, and dot-dot. Parent-path checks operate below the canonical repository root so platform aliases above that root do not reject valid test-owned directories.

It creates minimal `source/` and `restored/` Wrangler configs with distinct local D1 UUIDs and unique lowercase R2 bucket names. Every resource command uses the explicit scratch config, `--local`, and `--env ""`. Commands supporting `--persist-to` use their matching scratch persistence directory. Wrangler 4.147.0 D1 export has no `--persist-to` option, so each export uses the config-relative local state by running with its config inside the matching scratch directory. No ancestor Wrangler config is loaded; root dev, E2E, and Vitest persistence is not used.

The CLI invokes the repository’s installed Wrangler entry point with Node `execFileSync`, argument arrays, and no shell. Resource argv builders reject remote flags, unsupported command families, and caller-supplied config/environment/persistence overrides instead of relying on flag precedence. The child environment preserves host `HOME`, `TMPDIR`, and `CODEX_HOME`; known Wrangler auth keys are removed only from that child when present: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CLOUDFLARE_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_API_KEY`, `CF_EMAIL`, and `CF_ACCOUNT_ID`. Set child values `DO_NOT_TRACK=true`, `WRANGLER_HIDE_BANNER=true`, `WRANGLER_SEND_METRICS=false`, and a scratch `WRANGLER_LOG_PATH`. Never print environment values. Seed and verification SQL live in run-local files, so command argv logs contain file paths rather than SQL text. Structured logs retain argv and exit/signal status, synthetic counts, hashes, comparisons, and final status; they omit query rows, full CLI output, and credentials.

The run sequence is: apply migrations to source D1; write a fixed 69-byte 1×1 PNG (SHA-256 `d3c936ebdd73f46e6422d5946044c99d524554082272019ab738800318b04892`) to source R2 as `image/png`; seed one generated synthetic user and quota (`storage_limit_bytes=1048576`, `max_asset_bytes=262144`, `timeline_limit=10`, `link_limit=10`); insert a pending 69-byte private image Asset named `probe-image.png`, transition it to ready so the existing trigger sets quota usage to 69 bytes, and set `captured_at=2026-10-12T06:30:00.000Z`, dimensions 1×1, and an R2 key under `originals/<user-id>/<asset-id>/`. Insert a private `Synthetic recovery timeline` and one `Synthetic recovery item` at position 0 with date-only `event_at={\"kind\":\"date\",\"date\":\"2026-10-13\",\"calendar\":\"iso8601\",\"time_zone\":\"Asia/Taipei\"}`. Use generated IDs and fixed timestamps/metadata only. Query one allowlisted source join from a run-local SQL file; export schema with `--no-data` and rows with `--no-schema`; retrieve the source object; restore schema before rows into fresh D1; put the R2 backup into the fresh bucket using the D1 MIME; then repeat the join and compare values and hashes.

The D1 projection includes quota limits/usage, Asset ID/status/name/MIME/size/R2 key/capture date/dimensions/visibility, Timeline ID/title/visibility, and TimelineItem ID/Asset association/position/caption/event value. It requires exactly one joined row and checks that quota usage and object size equal the synthetic Asset size. The report is PASS only if every command and comparison succeeds. Any failure halts the run, preserves artifacts, writes a FAIL report when possible, and exits nonzero.

## Safety boundaries and non-goals

- No Cloudflare account/API calls, remote resources, `--remote`, deployment, production data, or cloud backup claim.
- No SQL text rewriting, manual SQL splitting, or foreign-key disabling.
- No deletion, overwrite, new migrations, migration of existing stores, application API, binding, dependency, or product behavior changes. Current migrations apply only to the newly allocated synthetic source database.
- No independent R2 HTTP metadata readback, D1/R2 point-in-time consistency, Time Travel, retention, RPO/RTO, cutover, or production rollback proof. D1 and R2 are backed up and restored separately.

## Test and operations design

Use Node’s built-in `node:test` for tool-specific guards because the CLI launches Wrangler child processes and must not run in the Worker/Vitest persistence harness. Tests cover refusal of existing/symlink paths, scratch-only config/argv selection, local-only commands, unchanged host path variables, child-only credential removal, failure short-circuiting without false PASS, and field comparisons for quota, captured date, event date, both visibility values, MIME, relationship, size, and hash.

Run `node --test tests/tools/recovery-drill.test.mjs` for the guard suite, then `npm run recovery:drill` for the clean local end-to-end drill. Include the guard suite in `npm run check`; run the full repository check before committing implementation. The normal drill uses the supported split export and should pass. A combined-export foreign-key failure may be a separate regression fixture, never the normal drill’s expected result.
