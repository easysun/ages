# Incoming Reference Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Do not claim there are no incoming relationships while visible backlinks are rendered.

**Architecture:** Preserve both incoming collections and their privacy rules. Show the existing empty message only after loading finishes and both the visible incoming and owner review collections are empty.

**Tech Stack:** React, TypeScript, Playwright against local D1/R2.

**Spec:** docs/superpowers/specs/2026-10-04-tracking-content-graph-design.md; actual cloud acceptance reproduced the contradictory empty message for a same-owner private edge.

## Global Constraints

- Scope only src/client/content-edges.tsx and tests/e2e/content-edges.spec.ts plus this plan. No API, permission, loading, routing, or style changes.
- Existing empty message remains for a truly empty node; visible backlinks must never coexist with it.
- No dependencies, installation, cloud writes, deployments or changes to unrelated HANDOFF.md.

## Review Focus

- Same-owner private relations can yield visible incoming references with an empty review collection; test this against real local API state.
- Reload must retain the backlink and suppress the false empty message.
- A genuinely empty target must still show the original empty message.

### Task 1: Correct the incoming empty-state condition

**Files:** Modify src/client/content-edges.tsx and tests/e2e/content-edges.spec.ts.

- [x] Add a behavior regression named same_owner_incoming_reference_has_no_empty_state. Seed a synthetic owner, two private nodes and first verify the empty target message; create an edge via existing real API helpers, refresh the target, assert visible source title and no empty message, then reload/select target and repeat. Assert incoming-review API is empty so the case cannot silently lose its premise.
- [x] Run the new Playwright test on desktop and mobile; record RED on the old render guard.
- [x] Add the minimal incoming.length empty condition to the existing empty-state guard; do not alter privacy or review behavior.
- [x] Run the new test GREEN, then npm run check once. Save finite logs and synthetic UI screenshot proof under ignored artifacts.
- [x] Freeze two file hashes and obtain independent spec/code review before root commits, pushes and creates a PR against main. Do not commit or modify other files.

## Verification outcome

The local full check completed with two unrelated desktop timeouts during verified lid/maintenance sleep (595 and 927 seconds); all other321 browser cases passed with one existing skip. The exact two affected tests passed on a focused rerun. No timeout was increased. Both new desktop/mobile regression cases pass. Final-tree CI is required before merge; no local full-command success is claimed. The branch integrates main2a534a8 (reviewed recovery tooling, CI green), with no changes to the app paths under test beyond this guard.
