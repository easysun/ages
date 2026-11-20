import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { createTrackingApp } from "../../src/tracking/index";

const origin = "https://events.tracking.example";
const app = createTrackingApp();
const token = "a".repeat(64);
const initialTime = Date.parse("2026-11-20T00:00:15.000Z");
const bindings = {
  DB: env.DB,
  APP_ENV: "production",
  APP_ORIGIN: "https://app.example",
  TRACKING_ORIGIN: origin,
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(initialTime);
});
afterEach(() => vi.useRealTimers());

function request(ip: string, forwarded = "") {
  return app.request(
    `${origin}/${token}`,
    {
      headers: { "CF-Connecting-IP": ip, "X-Forwarded-For": forwarded },
    },
    bindings,
  );
}

it("limits random valid-format tickets per trusted IP with an atomic shared bucket", async () => {
  const bucket = Math.floor(initialTime / 60_000) * 60_000;
  const scope = await hashToken("tracking:203.0.113.1");
  await env.DB.prepare(
    "INSERT INTO rate_limits (scope_hash,bucket,count,expires_at) VALUES (?,?,?,?)",
  )
    .bind(scope, bucket, 599, bucket + 3_660_000)
    .run();

  const results = await Promise.all(
    Array.from({ length: 11 }, (_, i) =>
      request("203.0.113.1", `198.51.100.${i}`),
    ),
  );
  expect(results.filter((r) => r.status === 404)).toHaveLength(1);
  expect(results.filter((r) => r.status === 429)).toHaveLength(10);
  const limited = results.find((r) => r.status === 429);
  expect(limited?.headers.get("Retry-After")).toBe("45");
  expect(limited?.headers.get("Cache-Control")).toBe("no-store");
  expect(limited?.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(limited?.headers.get("Set-Cookie")).toBeNull();
  expect(limited?.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect((await request("203.0.113.2")).status).toBe(404);
  const malicious = await app.request(
    `${origin}/%22%3E%3Cscript%3E`,
    {
      headers: { "CF-Connecting-IP": "203.0.113.1" },
    },
    bindings,
  );
  expect(malicious.status).toBe(429);
  expect(await malicious.text()).not.toContain("<script>");

  const stored = JSON.stringify(
    (await env.DB.prepare("SELECT * FROM rate_limits").all()).results,
  );
  expect(stored).not.toContain("203.0.113.1");
  expect(stored).not.toContain(token);
  vi.setSystemTime(initialTime + 45_000);
  expect((await request("203.0.113.1")).status).toBe(404);
});

it("requires the Cloudflare client IP outside local development", async () => {
  const response = await app.request(`${origin}/${token}`, {}, bindings);
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Set-Cookie")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Continue without analytics");
  expect(html).not.toContain("<script");
});
