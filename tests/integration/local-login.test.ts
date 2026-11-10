import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";

const origin = "http://127.0.0.1:8787";
const bindings: Bindings = {
  ...env,
  APP_ENV: "local",
  APP_ORIGIN: origin,
  LOCAL_LOGIN_ENABLED: "true",
};
const app = createApp();
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function login(config = bindings, headers: Record<string, string> = {}) {
  return app.request(
    `${config.APP_ORIGIN}/auth/local`,
    {
      method: "POST",
      headers: { Origin: config.APP_ORIGIN ?? "", ...headers },
    },
    config,
  );
}
function session(response: Response) {
  return response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
}

describe("explicit local test login", () => {
  it("creates a normal account without OAuth credentials and stores only a session hash", async () => {
    const response = await login();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/library");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    const profile = await app.request(
      `${origin}/api/me`,
      {
        headers: { Cookie: session(response) },
      },
      bindings,
    );
    expect(profile.status).toBe(200);
    const payload = (await profile.json()) as { user: { plan: string } };
    expect(payload.user.plan).toBe("free");
    const row = await env.DB.prepare("SELECT token_hash FROM sessions").first<{
      token_hash: string;
    }>();
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session(response)).not.toContain(row?.token_hash);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM oauth_identities",
      ).first("count"),
    ).toBe(0);
  });
  it("preserves the account and quota while rotating and revoking the previous session", async () => {
    const first = await login();
    await env.DB.prepare("UPDATE usage_quotas SET timeline_limit = 7").run();
    const second = await login(bindings, { Cookie: session(first) });
    expect(second.status).toBe(303);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(
        "count",
      ),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT timeline_limit FROM usage_quotas").first(
        "timeline_limit",
      ),
    ).toBe(7);
    const old = await app.request(
      `${origin}/api/me`,
      { headers: { Cookie: session(first) } },
      bindings,
    );
    expect(old.status).toBe(401);
    const logout = await app.request(
      `${origin}/auth/logout`,
      { method: "POST", headers: { Origin: origin, Cookie: session(second) } },
      bindings,
    );
    expect(logout.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(
        "count",
      ),
    ).toBe(0);
  });
  it.each(["development", "preview", "production"] as const)(
    "is unavailable in %s even when the flag is set",
    async (APP_ENV) => {
      const config = { ...bindings, APP_ENV, APP_ORIGIN: "https://localhost" };
      const response = await login(config, {
        "CF-Connecting-IP": "203.0.113.1",
      });
      expect(response.status).toBe(404);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(
          "count",
        ),
      ).toBe(0);
    },
  );
  it("requires explicit opt-in and a loopback hostname", async () => {
    const disabled = { ...bindings };
    delete disabled.LOCAL_LOGIN_ENABLED;
    for (const config of [
      disabled,
      { ...bindings, LOCAL_LOGIN_ENABLED: "false" },
      { ...bindings, APP_ORIGIN: "https://ages.test" },
    ])
      expect((await login(config)).status).toBe(404);
  });
  it("rejects missing or foreign Origin and cross-site requests", async () => {
    for (const headers of [
      { Origin: "" },
      { Origin: "https://foreign.test" },
      { "Sec-Fetch-Site": "cross-site" },
    ])
      expect((await login(bindings, headers)).status).toBe(403);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(
        "count",
      ),
    ).toBe(0);
  });
});
