# Repository Guidelines

## Product Direction

The product is an editable, collaborative, reversible timeline for photos, video, audio, and text - not a generic cloud album, social feed, or file drop. Prioritize this MVP loop:

```text
upload -> infer time -> create timeline -> drag to reorder -> share
```

Do not build a full social feed before this loop is excellent. Every timeline item must keep these concepts separate:

- `occurred_at` - when the real-world event happened.
- `sort_key` - the narrative order chosen by the user.

Never overload one field for both meanings; users must be able to sort by reality and still tell a deliberate story.

## Project Structure & Module Organization

The repository is newly initialized and currently has no source, tests, assets, or build configuration. As it grows, use:

- `src/` - production code organized by feature or domain.
- `tests/` - tests mirroring the relevant `src/` paths.
- `assets/` - media, fixtures, and other non-code resources.
- `docs/` - design notes, API decisions, and operations guidance.

Keep domain modules cohesive and avoid placing application code at the root.

## Platform, API, and UI Design

Web is the first client, but APIs and domain models must also support native Android/iOS, responsive mobile clients, and future VR headset views. Keep contracts platform-neutral: use stable IDs, explicit timestamps and time zones, media metadata, permissions, pagination, and versioned endpoints. Do not encode DOM, browser, viewport, or URL-only assumptions into the API or core state.

UI must be responsive and accessible across desktop, tablet, and phone, with mouse, touch, and keyboard support and varied media aspect ratios. Prefer adaptive, reusable components over fixed desktop layouts. Future spatial views should consume the same timeline model rather than requiring a separate content model.

## Build, Test, and Development Commands

No package manifest or build system exists yet, so no canonical commands are available. When a toolchain is selected, document one predictable command each for installation, local development, formatting, building, and testing in this file and the README.

## Coding Style & Language

All committed source code, comments, identifiers, configuration, developer documentation, commit messages, branch names, and PR titles/descriptions must be in English. User-facing localization may use other languages when intentionally implemented. Follow the selected formatter and linter, do not mix tabs and spaces, and use descriptive `PascalCase` types, `camelCase` functions/variables, and lowercase `kebab-case` paths unless the ecosystem requires otherwise.

## Testing Guidelines

No test framework or coverage threshold is configured yet. Add behavior-focused tests under `tests/`. Any change that affects existing functionality requires a regression test and a passing full suite before merge. Use the naming convention required by the chosen framework, such as `*.test.*` or `test_*.py`.

## Branch, Commit, and Pull Request Guidelines

Keep commits small, atomic, focused, and written in imperative English (for example, `Add timeline item model`). Small, reversible changes may go directly to `main` after self-review and validation. Changes spanning many files, changes that are difficult to reverse, or other materially risky work must use a branch and PR. Any change affecting existing behavior must use a separate branch, include a regression test, and target the applicable release branch. Self-review and merging an approved PR into `main` are allowed; record validation results and screenshots or recordings for UI changes in the PR.

## Security & Configuration

Never commit credentials, tokens, private keys, or local `.env` files. Use environment variables and provide a sanitized `.env.example` when needed. Review dependencies for necessity and pin versions according to the chosen package manager.
