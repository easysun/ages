# Android Brave Source Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize the exact installed Android Brave tuple for diagnostic crosswalk analysis while preserving formal gates.

**Architecture:** Add one strict observation validator and a distinct internal profile to the existing analyzer. Reuse established crosswalk semantics and protocol compatibility with a separate Android methodScope. The existing CLI forwards observations without production changes.

**Tech Stack:** Node.js 22+, native Node test runner, existing Chromium trace tools.

**Spec:** docs/superpowers/specs/2026-10-25-android-brave-source-profile-design.md

## Global Constraints

- Follow the spec's exact observation contract, including every pinned value and exact field set.
- FormalActionStatus always remains unavailable and formalActionSamples empty.
- Do not add Android to version-two or version-three observer allowlists; reject Android profile selection with version-three evidence.
- No dependencies, production application changes, raw/device evidence commits, or deployment.
- Preserve existing desktop profile behavior and existing int64 parsing.
- Never run npm install or npm ci locally: node_modules is shared.
- Preserve modified HANDOFF.md; stage only explicitly owned files. All committed text is English.

## Review Focus

- Desktop identity substituted into Android observations must reject.
- Missing/unknown/type-confused nested identity fields and extra artifact names must reject.
- Reduced mobile UA must not substitute for independently pinned OS metadata.
- Signed interaction limits and fallback endpoint checks must remain enforced.
- Observer evidence must not unlock Android attribution or formal samples; CLI output must remain redacted.

### Task 1: Add the diagnostic Android profile and behavior tests

**Files:**
- Modify: scripts/chromium-trace-metrics.mjs
- Test: tests/tools/chromium-trace-metrics.test.mjs
- Test: tests/tools/chromium-trace-cli.test.mjs

**Interfaces:**
- Consumes: analyzeTrace(trace, traceRecord, segments, sourceObservations, observerEvidence), parseTrace(text), existing CLI manifest browser observations.
- Produces: internal android-brave15585 profile and diagnostic crosswalk output conforming to the linked spec. No new exported API.

- [x] **Step 1: Write failing contract tests.** Read the spec first and copy its pinned values verbatim into independent fixtures. Add valid Android synthetic crosswalk and CLI tests asserting one candidate, Android methodScope, own probe gate, unavailable formal status, empty samples. Add mutation tests for every required field, changed type/value, unknown field at each nested object, desktop substitution, missing/extra artifact, wrong/mobile-conflicting UA, OS mismatch. Assert version-three selection rejection and version-two observer exclusion. Add signed ID/offset boundary and invalid fallback endpoint tests for this profile. Assert output excludes private marker/path data.
- [x] **Step 2: Verify RED.** Run focused new tests with the native Node runner; record the expected unsupported-profile failure before implementation. Ensure rejection tests cannot pass merely because the valid fixture is invalid.
- [x] **Step 3: Implement minimum recognition.** Read the target file and immediate profile/crosswalk callers. Add strict validator/select branch, signed semantics membership, Android scope/gates. Reuse diagnostic catalog compatibility only. Preserve observer allowlists and reject Android when version-three evidence is active. Do not refactor parser or unrelated profiles.
- [x] **Step 4: Verify GREEN.** Run focused new tests then npm run test:trace-metrics. Run npm run check once before committing, record exact results/log paths. Existing desktop and observer tests must still pass. No install commands.
- [x] **Step 5: Self-review and commit.** Inspect diff, ensure only the three code/test files plus these two documents are staged. Use command-scoped git identity easysun / 5380578+easysun@users.noreply.github.com. Commit `Add diagnostic Android Brave source profile`. Do not push or merge. Write report including RED/GREEN commands, relevant outputs, full-check results, changed files and concerns.
