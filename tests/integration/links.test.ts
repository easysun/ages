import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let session: string;
let other: string;
type Link = {
  id: string;
  slug: string;
  active: boolean;
  expires_at: string | null;
};
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser();
  other = await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function request(path = "", cookie = session, init: RequestInit = {}) {
  return app.request(
    `${origin}/api/links${path}`,
    {
      ...init,
      headers: { Cookie: cookie, ...init.headers },
    },
    bindings,
  );
}
function create(body: unknown, cookie = session) {
  return request("", cookie, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patch(id: string, body: unknown, cookie = session) {
  return request(`/${id}`, cookie, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function link(body: unknown): Promise<Link> {
  const response = await create(body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { link: Link }).link;
}
function resolve(slug: string, method = "GET") {
  return app.request(`${origin}/s/${slug}`, { method }, bindings);
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Location")).toBeNull();
}
async function timeline(
  id: string,
  visibility = "unlisted",
  owner = "owner_a",
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO timelines(id,owner_id,title,visibility,created_at,updated_at) VALUES(?,?,'Story',?,?,?)",
  )
    .bind(id, owner, visibility, now, now)
    .run();
}

describe("Durable owner Links", () => {
  it("creates a normalized HTTP target and resolves anonymously without caching", async () => {
    const created = await link({
      target: { kind: "url", url: "https://example.test/path?q=hello#moment" },
      slug: "my-story",
    });
    expect(created).toMatchObject({
      active: true,
      expires_at: null,
      slug: "my-story",
    });
    expect(created).not.toHaveProperty("owner_id");
    for (const method of ["GET", "HEAD"]) {
      const response = await resolve(created.slug, method);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "https://example.test/path?q=hello#moment",
      );
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    const generated = await link({
      target: { kind: "url", url: "http://example.test" },
    });
    expect(generated.slug).toMatch(/^[a-z0-9-]{3,64}$/);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/media",
    "//example.test",
    "https://user:password@example.test",
    "https://example.test/\nheader",
  ])("rejects unsafe destination %s", async (url) => {
    await error(
      await create({ target: { kind: "url", url } }),
      400,
      "INVALID_REQUEST",
    );
  });
  it.each(["UPPER", "ab", "../private", "a/b", "bad slug", "x".repeat(65)])(
    "rejects ambiguous slug %s",
    async (slug) => {
      await error(
        await create({
          target: { kind: "url", url: "https://example.test" },
          slug,
        }),
        400,
        "INVALID_REQUEST",
      );
    },
  );
  it("preserves globally reserved slugs after deactivation and disallows retargeting", async () => {
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
      slug: "reserved",
    });
    expect((await patch(saved.id, { active: false })).status).toBe(200);
    await error(await resolve(saved.slug), 404, "NOT_FOUND");
    await error(
      await create(
        {
          target: { kind: "url", url: "https://other.test" },
          slug: saved.slug,
        },
        other,
      ),
      409,
      "CONFLICT",
    );
    for (const body of [
      { slug: "changed" },
      { target: { kind: "url", url: "https://other.test" } },
      {},
    ])
      await error(await patch(saved.id, body), 400, "INVALID_REQUEST");
    expect((await patch(saved.id, { active: true })).status).toBe(200);
    expect((await resolve(saved.slug)).headers.get("Location")).toBe(
      "https://example.test/",
    );
  });
  it("enforces expiry at the exact instant and revokes a previously resolved link immediately", async () => {
    const now = Date.now();
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
      expires_at: new Date(now + 60_000).toISOString(),
    });
    expect((await resolve(saved.slug)).status).toBe(302);
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    await error(await resolve(saved.slug), 404, "NOT_FOUND");
    expect((await patch(saved.id, { expires_at: null })).status).toBe(200);
    expect((await resolve(saved.slug)).status).toBe(302);
    expect((await patch(saved.id, { active: false })).status).toBe(200);
    await error(await resolve(saved.slug), 404, "NOT_FOUND");
  });
  it("rejects past or invalid expiration and unsupported grant fields", async () => {
    for (const expires_at of [
      "garbage",
      "2026-02-30T00:00:00Z",
      new Date(Date.now() - 1).toISOString(),
    ])
      await error(
        await create({
          target: { kind: "url", url: "https://example.test" },
          expires_at,
        }),
        400,
        "INVALID_REQUEST",
      );
    await error(
      await create({
        target: { kind: "url", url: "https://example.test" },
        password: "secret",
      }),
      400,
      "INVALID_REQUEST",
    );
  });
  it("isolates reads and writes, requires authentication and exact mutation origin", async () => {
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
    });
    await error(await request("", ""), 401, "UNAUTHENTICATED");
    await error(
      await create(
        { target: { kind: "url", url: "https://example.test" } },
        "",
      ),
      401,
      "UNAUTHENTICATED",
    );
    await error(await request(`/${saved.id}`, other), 404, "NOT_FOUND");
    await error(
      await patch(saved.id, { active: false }, other),
      404,
      "NOT_FOUND",
    );
    expect(await (await request("", other)).json()).toMatchObject({
      links: [],
      next_cursor: null,
    });
    await error(
      await request(`/${saved.id}`, session, {
        method: "PATCH",
        headers: {
          Origin: "https://attacker.test",
          "Content-Type": "application/json",
        },
        body: '{"active":false}',
      }),
      403,
      "FORBIDDEN",
    );
    await error(
      await request("", session, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{",
      }),
      400,
      "INVALID_REQUEST",
    );
    expect((await resolve(saved.slug)).status).toBe(302);
  });
  it("paginates tied timestamps and rejects foreign, invalid or repeated query cursors", async () => {
    const saved = [];
    for (let i = 0; i < 4; i++)
      saved.push(
        await link({ target: { kind: "url", url: "https://example.test" } }),
      );
    await env.DB.prepare(
      "UPDATE links SET created_at = '2026-01-01T00:00:00.000Z'",
    ).run();
    const first = (await (await request("?limit=2")).json()) as {
      links: Link[];
      next_cursor: string;
    };
    const second = (await (
      await request(`?limit=2&cursor=${first.next_cursor}`)
    ).json()) as { links: Link[]; next_cursor: null };
    expect(
      new Set([...first.links, ...second.links].map((row) => row.id)).size,
    ).toBe(4);
    expect(second.next_cursor).toBeNull();
    await error(
      await request(`?cursor=${first.next_cursor}`, other),
      400,
      "INVALID_REQUEST",
    );
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=1&limit=2",
      "?cursor=",
      "?cursor=e30",
      "?tag=trip",
    ])
      await error(await request(query), 400, "INVALID_REQUEST");
  });
  it("serializes quota races and counts inactive links so reserved slugs cannot bypass limits", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET link_limit = 1 WHERE user_id = 'owner_a'",
    ).run();
    const responses = await Promise.all([
      create({
        target: { kind: "url", url: "https://example.test" },
        slug: "first",
      }),
      create({
        target: { kind: "url", url: "https://example.test" },
        slug: "second",
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 403]);
    const winnerResponse = responses.find((r) => r.status === 201);
    if (!winnerResponse)
      throw new Error("Expected exactly one quota race winner");
    const winner = ((await winnerResponse.json()) as { link: Link }).link;
    await patch(winner.id, { active: false });
    await error(
      await create({ target: { kind: "url", url: "https://example.test" } }),
      403,
      "LINK_QUOTA_EXCEEDED",
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM links WHERE owner_id = 'owner_a'",
      ).first("n"),
    ).toBe(1);
  });
  it("guards immutable target and owner identities even for direct SQL callers", async () => {
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
    });
    await expect(
      env.DB.prepare("UPDATE links SET owner_id = 'owner_b' WHERE id = ?")
        .bind(saved.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE links SET slug = 'stolen' WHERE id = ?")
        .bind(saved.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE links SET target_url = 'https://other.test' WHERE id = ?",
      )
        .bind(saved.id)
        .run(),
    ).rejects.toThrow();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await resolve(saved.slug)).status).toBe(302);
  });
  it("retains slug reservations when a caller attempts to remove their owner account", async () => {
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
      slug: "forever",
    });
    await expect(
      env.DB.prepare("DELETE FROM users WHERE id = 'owner_a'").run(),
    ).rejects.toThrow();
    expect((await resolve(saved.slug)).status).toBe(302);
  });
  it("rejects Library cursors instead of silently skipping a different collection", async () => {
    const cursor = btoa(
      JSON.stringify({
        v: 1,
        owner: "owner_a",
        tag: null,
        created_at: "2026-01-01T00:00:00.000Z",
        id: "asset",
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    await error(await request(`?cursor=${cursor}`), 400, "INVALID_REQUEST");
  });
  it("fails closed if persisted expiration metadata is corrupt", async () => {
    const saved = await link({
      target: { kind: "url", url: "https://example.test" },
    });
    await env.DB.prepare("UPDATE links SET expires_at = 'invalid' WHERE id = ?")
      .bind(saved.id)
      .run();
    await error(await resolve(saved.slug), 404, "NOT_FOUND");
  });
});

describe("Authoritative Timeline Link resolution", () => {
  it("uses a stable canonical target across append and hides it as soon as visibility becomes private", async () => {
    await timeline("story");
    const saved = await link({
      target: { kind: "timeline", timeline_id: "story" },
    });
    expect((await resolve(saved.slug)).headers.get("Location")).toBe(
      `${origin}/t/story`,
    );
    await env.DB.prepare(
      "UPDATE timelines SET title = 'Extended', version = version + 1 WHERE id = 'story'",
    ).run();
    expect((await resolve(saved.slug)).headers.get("Location")).toBe(
      `${origin}/t/story`,
    );
    await env.DB.prepare(
      "UPDATE timelines SET visibility = 'private' WHERE id = 'story'",
    ).run();
    await error(await resolve(saved.slug), 404, "NOT_FOUND");
    await env.DB.prepare(
      "UPDATE timelines SET visibility = 'public' WHERE id = 'story'",
    ).run();
    expect((await resolve(saved.slug)).status).toBe(302);
  });
  it("rejects private or foreign Timeline targets and never weakens canonical authorization", async () => {
    await timeline("private", "private");
    await timeline("foreign", "public", "owner_b");
    for (const id of ["private", "foreign", "missing"])
      await error(
        await create({ target: { kind: "timeline", timeline_id: id } }),
        409,
        "CONFLICT",
      );
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM links").first("n"),
    ).toBe(0);
    await error(await resolve("missing"), 404, "NOT_FOUND");
  });
});
