import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { hashToken, pkceChallenge } from "../../src/auth/crypto";
import { cleanupAuth } from "../../src/auth/session";
import type { Bindings } from "../../src/bindings";

const origin = "https://ages.test";
const bindings: Bindings = {
  ...env,
  APP_ENV: "local",
  APP_ORIGIN: origin,
  GOOGLE_CLIENT_ID: "synthetic-client",
  GOOGLE_CLIENT_SECRET: "synthetic-secret",
};
const app = createApp();
const logs = vi.fn();
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let claims: Record<string, unknown>;
let badSignature: boolean;
let providerStatus: number;
const exchanges: URLSearchParams[] = [];

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  wrongKeys = await generateKeyPair("RS256");
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  claims = {};
  badSignature = false;
  providerStatus = 200;
  exchanges.length = 0;
  vi.spyOn(console, "info").mockImplementation(logs);
  vi.spyOn(console, "error").mockImplementation(logs);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            kid: "test-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }
    if (url !== "https://oauth2.googleapis.com/token") {
      throw new Error("Unexpected outbound request");
    }
    const body = new URLSearchParams(String(options?.body));
    exchanges.push(body);
    if (providerStatus !== 200) {
      return Response.json(
        { error: "provider-private-detail" },
        { status: providerStatus },
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: "https://accounts.google.com",
      aud: "synthetic-client",
      sub: "google-subject-a",
      email: "person@example.test",
      email_verified: true,
      name: "Story Owner",
      iat: now,
      exp: now + 3600,
      // Synthetic authorization codes identify the expected nonce in this fake provider.
      nonce: body.get("code"),
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(badSignature ? wrongKeys.privateKey : keys.privateKey);
    return Response.json({
      id_token: token,
      access_token: "provider-private-token",
    });
  });
});

function request(path: string, init: RequestInit = {}, config = bindings) {
  return app.request(
    `${origin}${path}`,
    {
      ...init,
      headers: { "CF-Connecting-IP": "203.0.113.1", ...init.headers },
    },
    config,
  );
}

function cookie(response: Response, name: string) {
  const pair = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")[0];
  if (!pair) throw new Error(`Missing ${name} cookie`);
  return pair;
}

async function start(config = bindings, query = "") {
  const response = await request(`/auth/google${query}`, {}, config);
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get("Location") ?? "");
  const prefix = config.APP_ENV === "local" ? "" : "__Host-";
  return {
    response,
    url,
    config,
    cookie: cookie(response, `${prefix}ages_oauth`),
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
  };
}

async function callback(
  attempt: Awaited<ReturnType<typeof start>>,
  session = "",
  extraQuery = "",
) {
  const query = new URLSearchParams({
    state: attempt.state,
    code: attempt.nonce,
  }).toString();
  return request(
    `/auth/google/callback?${query}${extraQuery ? `&${extraQuery}` : ""}`,
    {
      headers: { Cookie: `${attempt.cookie}${session ? `; ${session}` : ""}` },
    },
    attempt.config,
  );
}

async function login() {
  const attempt = await start();
  const response = await callback(attempt);
  expect(response.status).toBe(303);
  return cookie(response, "ages_session");
}

async function count(
  table:
    | "users"
    | "sessions"
    | "oauth_identities"
    | "oauth_attempts"
    | "report_events"
    | "usage_quotas",
) {
  return env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(
    "count",
  );
}

describe("Google OAuth browser flow", () => {
  it("fails closed without provider configuration and does not create attempts", async () => {
    const response = await request(
      "/auth/google",
      {},
      { ...env, APP_ENV: "local" },
    );
    expect(response.status).toBe(503);
    expect(await count("oauth_attempts")).toBe(0);
  });

  it("binds state to a short-lived browser cookie, nonce, and S256 PKCE challenge", async () => {
    const attempt = await start();
    const row = await env.DB.prepare("SELECT * FROM oauth_attempts").first<{
      state_hash: string;
      browser_hash: string;
      verifier: string;
      nonce: string;
      expires_at: string;
    }>();
    expect(attempt.url.origin).toBe("https://accounts.google.com");
    expect(attempt.url.searchParams.get("scope")).toBe("openid email profile");
    expect(attempt.url.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/google/callback`,
    );
    expect(attempt.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(row?.state_hash).toBe(await hashToken(attempt.state));
    expect(row?.browser_hash).toBe(
      await hashToken(attempt.cookie.split("=")[1] ?? ""),
    );
    expect(row?.nonce).toBe(attempt.nonce);
    expect(attempt.url.searchParams.get("code_challenge")).toBe(
      await pkceChallenge(row?.verifier ?? ""),
    );
    expect(Date.parse(row?.expires_at ?? "") - Date.now()).toBeGreaterThan(
      590_000,
    );
    expect(attempt.response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(attempt.response.headers.get("Set-Cookie")).toContain(
      "SameSite=Lax",
    );
    expect(attempt.response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(attempt.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    {
      kind: "timeline",
      value: "timeline-a1",
      target: "/report?kind=timeline&timeline_id=timeline-a1",
    },
    {
      kind: "link",
      value: "public-link-a1",
      target: "/report?kind=link&slug=public-link-a1",
    },
    {
      kind: "timeline",
      value: "timeline/a&next=attacker",
      target:
        "/report?kind=timeline&timeline_id=timeline%2Fa%26next%3Dattacker",
    },
  ])(
    "restores a validated $kind report target after sign-in",
    async ({ kind, value, target }) => {
      const query = new URLSearchParams({
        report_kind: kind,
        report_value: value,
      });
      const attempt = await start(bindings, `?${query}`);
      const stored =
        await env.DB.prepare(`SELECT report_target_kind, report_target_value
        FROM oauth_attempts WHERE state_hash = ?`)
          .bind(await hashToken(attempt.state))
          .first<{
            report_target_kind: string | null;
            report_target_value: string | null;
          }>();
      const response = await callback(attempt);

      expect(stored).toEqual({
        report_target_kind: kind,
        report_target_value: value,
      });
      expect(attempt.url.searchParams.has("report_kind")).toBe(false);
      expect(attempt.url.searchParams.has("report_value")).toBe(false);
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(target);
      expect(await count("report_events")).toBe(0);
    },
  );

  it.each([
    ["an arbitrary next URL", "next=https%3A%2F%2Fattacker.test"],
    ["a missing report value", "report_kind=timeline"],
    ["a missing report kind", "report_value=timeline-a1"],
    [
      "a repeated report kind",
      "report_kind=timeline&report_kind=link&report_value=timeline-a1",
    ],
    [
      "a repeated report value",
      "report_kind=link&report_value=first-link&report_value=second-link",
    ],
    [
      "an extra query parameter",
      "report_kind=timeline&report_value=timeline-a1&extra=value",
    ],
    [
      "a malformed percent escape",
      "report_kind=timeline&report_value=timeline%ZZ",
    ],
    [
      "a Timeline identifier over 100 characters",
      `report_kind=timeline&report_value=${"x".repeat(101)}`,
    ],
    [
      "a Link slug outside the allowed expression",
      "report_kind=link&report_value=Bad_Slug",
    ],
  ])(
    "rejects %s before creating an OAuth attempt",
    async (_description, query) => {
      const response = await request(`/auth/google?${query}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
      expect(await count("oauth_attempts")).toBe(0);
    },
  );

  it("uses host-only Secure cookies outside local development", async () => {
    const attempt = await start({ ...bindings, APP_ENV: "production" });
    const response = await callback(attempt);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    const session = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-ages_session="));
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Path=/");
    expect(session).not.toContain("Domain=");
  });

  it("rejects an untrusted request host and insecure production origin", async () => {
    expect(
      (await app.request("https://attacker.test/auth/google", {}, bindings))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "/auth/google",
          {},
          {
            ...bindings,
            APP_ENV: "production",
            APP_ORIGIN: "http://ages.test",
          },
        )
      ).status,
    ).toBe(503);
  });

  it("does not exchange a code with a missing or mismatched browser binding", async () => {
    const attempt = await start();
    for (const browserCookie of ["", `ages_oauth=${"x".repeat(43)}`]) {
      const response = await request(
        `/auth/google/callback?state=${attempt.state}&code=stolen`,
        {
          headers: { Cookie: browserCookie },
        },
      );
      expect(response.status).toBe(400);
    }
    expect(exchanges).toHaveLength(0);
    expect((await callback(attempt)).status).toBe(303);
  });

  it("rejects mismatched and expired state before contacting Google", async () => {
    const attempt = await start();
    expect((await callback({ ...attempt, state: "z".repeat(43) })).status).toBe(
      400,
    );
    await env.DB.prepare(
      "UPDATE oauth_attempts SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    expect((await callback(attempt)).status).toBe(400);
    expect(exchanges).toHaveLength(0);
    expect(await count("sessions")).toBe(0);
  });

  it("consumes even a denied callback so it cannot be retried with another code", async () => {
    const attempt = await start();
    const denied = await request(
      `/auth/google/callback?state=${attempt.state}&error=access_denied`,
      {
        headers: { Cookie: attempt.cookie },
      },
    );
    expect(denied.status).toBe(400);
    expect(await count("oauth_attempts")).toBe(0);
    expect((await callback(attempt)).status).toBe(400);
    expect(exchanges).toHaveLength(0);
  });

  it.each([
    {
      label: "identical state values",
      extraQuery: (attempt: Awaited<ReturnType<typeof start>>) =>
        `state=${attempt.state}`,
    },
    {
      label: "different state values",
      extraQuery: () => `state=${"z".repeat(43)}`,
    },
    {
      label: "identical code values",
      extraQuery: (attempt: Awaited<ReturnType<typeof start>>) =>
        `code=${attempt.nonce}`,
    },
    {
      label: "different code values",
      extraQuery: () => "code=another-code",
    },
    {
      label: "identical provider metadata values",
      extraQuery: () => "scope=openid&scope=openid",
    },
  ])(
    "rejects duplicate callback $label before consuming the attempt",
    async ({ extraQuery }) => {
      const attempt = await start();
      const response = await callback(attempt, "", extraQuery(attempt));

      expect(response.status).toBe(400);
      expect(
        response.headers
          .getSetCookie()
          .some(
            (value) =>
              value.startsWith("ages_oauth=;") && value.includes("Max-Age=0"),
          ),
      ).toBe(true);
      expect(await count("oauth_attempts")).toBe(1);
      expect(await count("sessions")).toBe(0);
      expect(await count("report_events")).toBe(0);
      expect(exchanges).toHaveLength(0);
    },
  );

  it.each([
    ["an absolute next URL", "next=https%3A%2F%2Fattacker.test"],
    ["an empty next value", "next="],
  ])(
    "rejects %s before consuming the OAuth attempt",
    async (_description, extraQuery) => {
      const attempt = await start();
      const response = await callback(attempt, "", extraQuery);

      expect(response.status).toBe(400);
      expect(
        response.headers
          .getSetCookie()
          .some(
            (value) =>
              value.startsWith("ages_oauth=;") && value.includes("Max-Age=0"),
          ),
      ).toBe(true);
      expect(await count("oauth_attempts")).toBe(1);
      expect(await count("sessions")).toBe(0);
      expect(await count("report_events")).toBe(0);
      expect(exchanges).toHaveLength(0);
    },
  );

  it("allows unique provider metadata without using it as a redirect", async () => {
    const attempt = await start();
    const response = await callback(
      attempt,
      "",
      "scope=openid&authuser=0&prompt=consent",
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(await count("oauth_attempts")).toBe(0);
    expect(await count("sessions")).toBe(1);
    expect(exchanges).toHaveLength(1);
  });

  it("permits only one of two simultaneous callbacks and rejects later replay", async () => {
    const attempt = await start(
      bindings,
      "?report_kind=timeline&report_value=timeline-replay-a1",
    );
    const responses = await Promise.all([callback(attempt), callback(attempt)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      303, 400,
    ]);
    expect(exchanges).toHaveLength(1);
    expect(await count("sessions")).toBe(1);
    expect(await count("oauth_attempts")).toBe(0);
    expect(
      responses
        .find((response) => response.status === 303)
        ?.headers.get("Location"),
    ).toBe("/report?kind=timeline&timeline_id=timeline-replay-a1");
    expect((await callback(attempt)).status).toBe(400);
    const exchange = exchanges[0];
    expect(exchange?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pkceChallenge(exchange?.get("code_verifier") ?? "")).toBe(
      attempt.url.searchParams.get("code_challenge"),
    );
    expect(exchange?.get("client_secret")).toBe("synthetic-secret");
    expect(exchange?.get("redirect_uri")).toBe(
      `${origin}/auth/google/callback`,
    );
  });

  it.each([
    { iss: "https://attacker.test" },
    { aud: "other-client" },
    { azp: "other-client" },
    { nonce: "wrong-nonce" },
    { exp: 1 },
    { iat: 1 },
    { email_verified: false },
    { sub: "" },
    { email: "invalid" },
    { aud: ["synthetic-client", "other-client"] },
  ])(
    "rejects invalid identity claims without provisioning an account: %j",
    async (override) => {
      claims = override;
      expect((await callback(await start())).status).toBe(401);
      expect(await count("users")).toBe(0);
      expect(await count("sessions")).toBe(0);
    },
  );

  it("cryptographically rejects a token signed by a different key", async () => {
    badSignature = true;
    expect((await callback(await start())).status).toBe(401);
    expect(await count("users")).toBe(0);
  });

  it.each([400, 500])(
    "redacts provider failures and makes failed attempts one-use: %s",
    async (status) => {
      providerStatus = status;
      const attempt = await start();
      const response = await callback(attempt);
      expect(response.status).toBe(status === 400 ? 401 : 503);
      expect(await response.text()).not.toContain("provider-private");
      expect((await callback(attempt)).status).toBe(400);
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(
        /synthetic-secret|provider-private|stolen/,
      );
    },
  );
});

describe("Account identity and sessions", () => {
  it("stores only a hash, returns safe identity and quota, and never returns provider tokens", async () => {
    const session = await login();
    const raw = session.split("=")[1] ?? "";
    const row = await env.DB.prepare("SELECT * FROM sessions").first();
    expect(row?.token_hash).toBe(await hashToken(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    const response = await request("/api/me", { headers: { Cookie: session } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: {
        email: "person@example.test",
        display_name: "Story Owner",
        plan: "free",
      },
      quota: {
        storage_limit_bytes: 1024 ** 3,
        storage_used_bytes: 0,
        timeline_limit: 10,
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const logText = JSON.stringify(logs.mock.calls);
    expect(logText).not.toContain(raw);
    expect(logText).not.toMatch(
      /provider-private|synthetic-secret|person@example/,
    );
  });

  it("rejects absent, malformed, tampered, and expired session cookies", async () => {
    for (const token of [
      "",
      "ages_session=invalid",
      `ages_session=${"a".repeat(43)}`,
    ]) {
      expect(
        (await request("/api/me", { headers: { Cookie: token } })).status,
      ).toBe(401);
    }
    const session = await login();
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    expect(
      (await request("/api/me", { headers: { Cookie: session } })).status,
    ).toBe(401);
  });

  it("keeps ownership and existing quota when the same Google subject changes email", async () => {
    const session = await login();
    const owner = await env.DB.prepare("SELECT id FROM users").first("id");
    await env.DB.prepare(
      "UPDATE usage_quotas SET storage_used_bytes = 1234, timeline_limit = 25",
    ).run();
    claims = { email: "renamed@example.test", name: "New Display Name" };
    const response = await callback(await start(), session);
    expect(response.status).toBe(303);
    expect(await env.DB.prepare("SELECT id FROM users").first("id")).toBe(
      owner,
    );
    expect(await count("users")).toBe(1);
    expect(await count("sessions")).toBe(1);
    expect(
      (await request("/api/me", { headers: { Cookie: session } })).status,
    ).toBe(401);
    const me = await request("/api/me", {
      headers: { Cookie: cookie(response, "ages_session") },
    });
    expect(await me.json()).toMatchObject({
      user: { email: "renamed@example.test", display_name: "New Display Name" },
      quota: { storage_used_bytes: 1234, timeline_limit: 25 },
    });
  });

  it("never implicitly links a different Google subject sharing an existing email", async () => {
    await login();
    claims = { sub: "google-subject-b", name: "Impersonator" };
    expect((await callback(await start())).status).toBe(403);
    expect(await count("users")).toBe(1);
    expect(await count("oauth_identities")).toBe(1);
    expect(await count("sessions")).toBe(1);
    expect(
      await env.DB.prepare("SELECT display_name FROM users").first(
        "display_name",
      ),
    ).toBe("Story Owner");
  });

  it("creates only one account and quota during concurrent first-time sign-ins", async () => {
    const first = await start();
    const second = await start();
    const responses = await Promise.all([callback(first), callback(second)]);
    expect(responses.map((response) => response.status)).toEqual([303, 303]);
    expect(await count("users")).toBe(1);
    expect(await count("oauth_identities")).toBe(1);
    expect(await count("usage_quotas")).toBe(1);
    expect(await count("sessions")).toBe(2);
  });

  it("rejects missing, null, and foreign origins without destroying the session", async () => {
    const session = await login();
    for (const requestOrigin of [undefined, "null", "https://attacker.test"]) {
      const headers: Record<string, string> = { Cookie: session };
      if (requestOrigin) headers.Origin = requestOrigin;
      expect(
        (await request("/auth/logout", { method: "POST", headers })).status,
      ).toBe(403);
    }
    expect(
      (
        await request("/auth/logout", {
          method: "POST",
          headers: {
            Cookie: session,
            Origin: origin,
            "Sec-Fetch-Site": "cross-site",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/me", { headers: { Cookie: session } })).status,
    ).toBe(200);
  });

  it("invalidates logout immediately, clears the cookie, and is idempotent", async () => {
    const session = await login();
    const options = {
      method: "POST",
      headers: { Cookie: session, Origin: origin },
    };
    const response = await request("/auth/logout", options);
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(
      (await request("/api/me", { headers: { Cookie: session } })).status,
    ).toBe(401);
    expect((await request("/auth/logout", options)).status).toBe(204);
    expect(await count("sessions")).toBe(0);
  });

  it("cleans expired sessions and attempts without deleting active sessions or memories", async () => {
    await login();
    await start();
    await env.DB.prepare(
      "UPDATE oauth_attempts SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    await cleanupAuth(bindings);
    expect(await count("oauth_attempts")).toBe(0);
    expect(await count("sessions")).toBe(1);
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    await cleanupAuth(bindings);
    await cleanupAuth(bindings);
    expect(await count("sessions")).toBe(0);
    expect(await count("users")).toBe(1);
    expect(await count("usage_quotas")).toBe(1);
  });
});
