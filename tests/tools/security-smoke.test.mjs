import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTargets, targets } from "../../scripts/security-smoke.mjs";

const requestId = `req_${"a".repeat(8)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(12)}`;

function fakeResponse(target, overrides = {}) {
  const headers = new Headers({
    "x-request-id": requestId,
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...overrides.headers,
  });
  return {
    status: overrides.status ?? target.status,
    headers,
    json: async () =>
      overrides.json ??
      (target.jsonStatus
        ? { status: target.jsonStatus }
        : { error: { code: target.errorCode } }),
  };
}

test("only reviews a fixed set of small, safe GET endpoints", async () => {
  const observed = [];
  await checkTargets(async (url, opts) => {
    observed.push([url, opts.method, opts.redirect]);
    return fakeResponse(targets.find((target) => target.url === url));
  });
  assert.deepEqual(
    observed,
    targets.map((target) => [target.url, "GET", "error"]),
  );
});

test("fails closed if unauthenticated access becomes available", async () => {
  await assert.rejects(
    checkTargets(async (url) => {
      const target = targets.find((entry) => entry.url === url);
      return fakeResponse(
        target,
        url.endsWith("/api/me") ? { status: 200 } : {},
      );
    }),
    /HTTP 200, expected 401/,
  );
});

test("fails if the static site loses its noindex protection", async () => {
  await assert.rejects(
    checkTargets(async (url) => {
      const target = targets.find((entry) => entry.url === url);
      return fakeResponse(
        target,
        target.noindex ? { headers: { "x-robots-tag": "index, follow" } } : {},
      );
    }),
    /missing noindex/,
  );
});
