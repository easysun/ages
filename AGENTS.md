# Repository Guidelines

## Product Direction

The product centers on Living Timelines for photos, video, audio, and text. Upload acquires users; continued additions create lasting value. Short links, raw media, OG previews, and QR codes are distribution capabilities. Prioritize this MVP loop:

```text
login -> upload -> library -> timeline -> reorder and describe -> share -> append
```

Do not build a full social feed before this loop is excellent. Keep Asset, TimelineItem, Timeline, and Link as separate entities. One Asset may appear in multiple Timelines with independent story metadata. Keep these concepts separate:

- `Asset.captured_at` - original media capture time.
- `TimelineItem.event_at` - the user-defined event date/time.
- `TimelineItem.position` - the narrative order chosen by the user.

These names supersede the earlier `occurred_at` and `sort_key` proposal. Removing a TimelineItem or Link must never delete its Asset. New Assets and Timelines are private; unlisted means URL-accessible, with no indexing. Anonymous creation is disabled at launch. Authenticated memories must not expire silently due to inactivity. See `docs/implementation-plan.md` for stages and acceptance gates.

## Project Structure & Module Organization

Use these boundaries as the project grows:

- `src/` - production code organized by feature or domain.
- `tests/` - tests mirroring the relevant `src/` paths.
- `migrations/` - ordered, forward-only D1 SQL migrations.
- `tests/fixtures/` - synthetic test data, never private user media.
- `docs/` - design notes, API decisions, and operations guidance.

Keep domain modules cohesive and avoid placing application code at the root.

## Platform, API, and UI Design

Web is the first client, but APIs and domain models must also support native Android/iOS, responsive mobile clients, and future VR headset views. Keep contracts platform-neutral: use stable IDs, explicit timestamps and time zones, media metadata, permissions, pagination, and versioned endpoints. Do not encode DOM, browser, viewport, or URL-only assumptions into the API or core state.

UI must be responsive and accessible across desktop, tablet, and phone, with mouse, touch, and keyboard support and varied media aspect ratios. Prefer adaptive, reusable components over fixed desktop layouts. Future spatial views should consume the same timeline model rather than requiring a separate content model.

## Build, Test, and Development Commands

Use Node.js 22 and npm with the committed lockfile. Run `npm ci`, `npm run db:migrate:local`, then `npm run dev`. Before committing, run `npm run check` (lint, typecheck, unit/integration tests, build). Use `npm run format` for Biome formatting. `npm run build` only creates a local Worker bundle. See the README for environment setup.

## Coding Style & Language

All committed source code, comments, identifiers, configuration, developer documentation, commit messages, branch names, and PR titles/descriptions must be in English. User-facing localization may use other languages when intentionally implemented. Follow the selected formatter and linter, do not mix tabs and spaces, and use descriptive `PascalCase` types, `camelCase` functions/variables, and lowercase `kebab-case` paths unless the ecosystem requires otherwise.

## Testing Guidelines

Use Vitest with the Cloudflare Workers runtime and name tests `*.test.ts`. Add behavior-focused tests under `tests/`; integration tests must exercise real local D1/R2/KV bindings. Any change affecting existing functionality requires a regression test and a passing full suite before merge. No arbitrary coverage percentage is mandated. Add Playwright browser tests when the React client is introduced, including mobile, keyboard interaction, and refresh persistence.

## Branch, Commit, and Pull Request Guidelines

Keep commits small, atomic, focused, and written in imperative English (for example, `Add timeline item model`). Small, reversible changes may go directly to `main` after self-review and validation. Changes spanning many files, changes that are difficult to reverse, or other materially risky work must use a branch and PR. Any change affecting existing behavior must use a separate branch, include a regression test, and target the applicable release branch. Self-review and merging an approved PR into `main` are allowed; record validation results and screenshots or recordings for UI changes in the PR.

Use `feat/`, `fix/`, or `docs/` branch prefixes. Before a release exists, new foundation work targets `main`. Once a release branch exists, confirm the affected release and target it for behavior changes; do not guess a release branch. If no remote is configured, finish local validation and retain the branch, reporting that publishing the PR remains blocked. Never treat that as permission to merge a required PR locally.

## Security & Configuration

Never commit credentials, tokens, private keys, or local `.env` files. Use environment variables and provide a sanitized `.env.example` when needed. Review dependencies for necessity and pin versions according to the chosen package manager.
