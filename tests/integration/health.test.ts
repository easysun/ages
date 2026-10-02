import { applyD1Migrations, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Worker health", () => {
  it("boots the actual Worker entry point without requiring database availability", async () => {
    const response = await exports.default.fetch("https://ages.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "ages" });
    expect(response.headers.get("X-Request-ID")).toMatch(/^req_/);
  });

  it("fails readiness until migrations have been applied", async () => {
    const response = await exports.default.fetch(
      "https://ages.test/health/ready",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("checks migrated D1 plus real local R2 and KV bindings without writing probe data", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const response = await exports.default.fetch(
      "https://ages.test/health/ready",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", service: "ages" });
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
    expect((await env.LINK_CACHE.list()).keys).toHaveLength(0);
  });

  it("fails readiness with a missing binding without exposing connection details", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const response = await createApp().request(
      "/health/ready",
      {},
      { ...env, MEDIA: undefined },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("TypeError");
  });

  it("keeps the public surface limited to health and not-found responses", async () => {
    const response = await exports.default.fetch(
      "https://ages.test/api/test-validation",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
