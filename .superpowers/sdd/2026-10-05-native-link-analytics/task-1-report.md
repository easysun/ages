# Task 1: Native Link Tracking Configuration

Status: DONE

Implemented owner-managed Link tracking settings with exact Link tags and channel labels, five UTM fields, and bounded custom query parameters. Added migration `0013_link_analytics.sql`, authenticated owner-only GET/PUT endpoints, the `getLinkTracking` and `applyLinkParameters` helpers, and exact tag filtering on the Link library with the existing `links.` cursor namespace. Missing settings read as empty collections. Replacement runs as one D1 batch and rolls back completely when an insert fails. Application-origin destinations remain unchanged; external URLs use `URL.searchParams.set`, preserving unrelated fields and fragments.

## Test-first evidence

- RED: `npx vitest run tests/unit/link-tracking.test.ts tests/integration/link-analytics.test.ts` initially stopped at import time because the new tracking module did not exist. After adding a temporary no-op seam, the same command reached assertions and produced 7 failures out of 9 tests: the route returned 404, valid settings were rejected, configured UTM values were not applied, and `javascript:` was not rejected. The temporary seam was replaced by the implementation and is not present in the final change.
- GREEN: `npx vitest run tests/unit/link-tracking.test.ts tests/integration/link-analytics.test.ts tests/integration/links.test.ts` passed: 3 files, 39 tests.
- The integration coverage includes anonymous and foreign-owner denial, cross-origin mutation denial, missing-setting defaults, full replacement and rollback, 20/21 tag and channel boundaries, exact Unicode/case/space/C1 filtering and cursor binding, 10/11 custom parameters, 40/41 key and 100/101 value boundaries, all five UTM fields, reserved keys, control characters, and application-origin URL Link bypass.

## Migration and full check

- `npm run db:migrate:local` applied `0013_link_analytics.sql` successfully. A second run reported `No migrations to apply!`.
- `CI=true AGES_E2E_PORT=8797 npm run check` completed with exit code 0. Client build, lint, type generation and typecheck, unit/integration suite, Worker dry-run build, and Playwright completed. Vitest reported 20 files and 383 tests passed. Playwright reported 93 passed and 1 skipped in 5.5 minutes; the desktop native-touch case was skipped and its mobile counterpart passed.
- Lint exited successfully with one informational `useTemplate` finding in untouched `tests/integration/library.test.ts` and one `noDescendingSpecificity` warning in untouched `src/client/styles.css`.
- `npx biome check` on the seven changed source/test files and `git diff --check` both passed after formatting.

## Self-review

- Link creation, PATCH behavior, and public Link resolution were left unchanged; tracking configuration is not included in Link payloads or public resolution responses.
- The migration uses composite Link identity foreign keys and binary exact tag/channel keys. No provider or content-graph work was included.
- The pre-existing `HANDOFF.md` modification and untracked plans/spec files were left untouched.
