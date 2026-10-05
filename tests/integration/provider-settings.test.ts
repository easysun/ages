import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import { resolveLinkProviders } from "../../src/tracking/providers";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let session: string;
let other: string;

const emptySettings = {
  ga4_measurement_id: null,
  meta_pixel_id: null,
  gtm_container_id: null,
  ga4_route: "direct",
  meta_route: "direct",
};

function request(path: string, cookie = session, init: RequestInit = {}) {
  return app.request(
    `${origin}${path}`,
    { ...init, headers: { Cookie: cookie, ...init.headers } },
    bindings,
  );
}

function account(body?: unknown, cookie = session, requestOrigin = origin) {
  return request("/api/me/tracking/providers", cookie, {
    ...(body === undefined ? {} : { method: "PUT" }),
    headers:
      body === undefined
        ? {}
        : { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function linkProviders(
  id: string,
  body?: unknown,
  cookie = session,
  requestOrigin = origin,
) {
  return request(`/api/links/${id}/tracking/providers`, cookie, {
    ...(body === undefined ? {} : { method: "PUT" }),
    headers:
      body === undefined
        ? {}
        : { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createLink(cookie = session) {
  const response = await request("/api/links", cookie, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      target: { kind: "url", url: "https://example.test/story" },
      slug: `story-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { link: { id: string } }).link.id;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser("owner_a");
  other = await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("owner tracking provider settings", () => {
  it("returns disabled defaults and replaces every account field", async () => {
    const initial = await account();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toContain("no-store");
    expect(await initial.json()).toEqual({ providers: emptySettings });

    const configured = {
      ga4_measurement_id: "G-ABC123",
      meta_pixel_id: "1234567890",
      gtm_container_id: "GTM-ABC123",
      ga4_route: "gtm",
      meta_route: "direct",
    };
    expect((await account(configured)).status).toBe(200);
    expect(await (await account()).json()).toEqual({ providers: configured });

    const replaced = {
      ...emptySettings,
      ga4_measurement_id: "G-NEW456",
    };
    expect((await account(replaced)).status).toBe(200);
    expect(await (await account()).json()).toEqual({ providers: replaced });
  });

  it("requires authentication and same-origin account writes", async () => {
    await expectError(await account(undefined, ""), 401, "UNAUTHENTICATED");
    await expectError(
      await account(emptySettings, "", origin),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(
      await account(emptySettings, session, "https://attacker.test"),
      403,
      "FORBIDDEN",
    );
  });

  it("rejects malformed IDs and never returns another owner’s account", async () => {
    for (const invalid of [
      { ...emptySettings, ga4_measurement_id: "G-ABC<script>" },
      { ...emptySettings, meta_pixel_id: "123 456" },
      { ...emptySettings, gtm_container_id: "GTM-ABC;alert(1)" },
      { ...emptySettings, ga4_route: "gtm" },
      { ...emptySettings, unexpected: true },
    ]) {
      expect((await account(invalid)).status).toBe(400);
    }

    const privateSettings = {
      ...emptySettings,
      ga4_measurement_id: "G-PRIVATE1",
    };
    await account(privateSettings);
    expect(await (await account(undefined, other)).json()).toEqual({
      providers: emptySettings,
    });
  });

  it("returns default Link opt-ins and keeps Link reads and writes owner-bound", async () => {
    const id = await createLink();
    const defaults = {
      allow_ga4: true,
      allow_meta_pixel: true,
      allow_gtm: true,
    };
    expect(await (await linkProviders(id)).json()).toEqual({
      providers: defaults,
    });

    const optOut = {
      allow_ga4: false,
      allow_meta_pixel: true,
      allow_gtm: false,
    };
    expect((await linkProviders(id, optOut)).status).toBe(200);
    expect(await (await linkProviders(id)).json()).toEqual({
      providers: optOut,
    });
    await expectError(
      await linkProviders(id, undefined, ""),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(
      await linkProviders(id, optOut, ""),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(
      await linkProviders(id, undefined, other),
      404,
      "NOT_FOUND",
    );
    await expectError(await linkProviders(id, optOut, other), 404, "NOT_FOUND");
    await expectError(
      await linkProviders(id, optOut, session, "https://attacker.test"),
      403,
      "FORBIDDEN",
    );
    expect(await (await linkProviders(id)).json()).toEqual({
      providers: optOut,
    });
  });

  it("resolves only enabled providers and suppresses GTM routes after Link opt-out", async () => {
    const id = await createLink();
    await account({
      ga4_measurement_id: "G-ABC123",
      meta_pixel_id: "1234567890",
      gtm_container_id: "GTM-ABC123",
      ga4_route: "gtm",
      meta_route: "direct",
    });

    expect(await resolveLinkProviders(env.DB, id, "owner_a")).toEqual({
      ga4: { id: "G-ABC123", route: "gtm" },
      meta: { id: "1234567890", route: "direct" },
      gtm: { id: "GTM-ABC123" },
    });

    await linkProviders(id, {
      allow_ga4: true,
      allow_meta_pixel: true,
      allow_gtm: false,
    });
    expect(await resolveLinkProviders(env.DB, id, "owner_a")).toEqual({
      ga4: null,
      meta: { id: "1234567890", route: "direct" },
      gtm: null,
    });
    expect(await resolveLinkProviders(env.DB, id, "owner_b")).toEqual({
      ga4: null,
      meta: null,
      gtm: null,
    });
  });

  it("keeps a Link with no account configuration fully disabled", async () => {
    const id = await createLink();
    expect(await resolveLinkProviders(env.DB, id, "owner_a")).toEqual({
      ga4: null,
      meta: null,
      gtm: null,
    });
  });
});
