import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Asset } from "../../src/assets/model";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let session: string;
let other: string;
const date = "2026-01-01T00:00:00.000Z";
type Page = {
  assets: (Asset & { tags: string[] })[];
  next_cursor: string | null;
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
    `${origin}/api/assets${path}`,
    {
      ...init,
      headers: { Cookie: cookie, ...init.headers },
    },
    bindings,
  );
}
function tags(id: string, values: unknown, cookie = session, site = origin) {
  return request(`/${id}/tags`, cookie, {
    method: "PUT",
    headers: { Origin: site, "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
}
async function page(path = "", cookie = session): Promise<Page> {
  const response = await request(path, cookie);
  expect(response.status).toBe(200);
  return response.json();
}
async function seedAsset(
  id: string,
  status: Asset["status"] = "ready",
  owner = "owner_a",
  created = date,
) {
  const key = `test/${owner}/${id}`;
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: {
      contentType: "video/mp4",
      cacheControl: "public, max-age=999999",
    },
  });
  await env.DB.prepare(`INSERT INTO assets (id, owner_id, kind, status, original_name, mime_type,
    size_bytes, r2_key, etag, upload_expires_at, created_at, updated_at)
    VALUES (?, ?, 'video', ?, 'moment.mp4', 'video/mp4', 10, ?, ?, ?, ?, ?)`)
    .bind(id, owner, status, key, object?.etag, date, created, created)
    .run();
  return key;
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({
    error: { code, request_id: expect.stringMatching(/^req_/) },
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
}

describe("Owner asset library", () => {
  it("lists ready assets only and hides storage identities in list and detail", async () => {
    await seedAsset("ready");
    await seedAsset("foreign", "ready", "owner_b");
    for (const status of ["pending", "failed", "deleted", "purged"] as const)
      await seedAsset(status, status);
    const result = await page();
    expect(result.assets.map((a) => a.id)).toEqual(["ready"]);
    expect(result.next_cursor).toBeNull();
    for (const asset of [
      result.assets[0],
      ((await (await request("/ready")).json()) as { asset: Asset }).asset,
    ]) {
      expect(asset).toMatchObject({
        id: "ready",
        visibility: "private",
        tags: [],
      });
      for (const field of ["r2_key", "etag", "owner_id", "upload_expires_at"])
        expect(asset).not.toHaveProperty(field);
    }
    expect((await request("/pending")).status).toBe(200);
    expect((await request("/failed")).status).toBe(200);
    for (const id of ["deleted", "purged", "foreign", "missing"])
      await expectError(await request(`/${id}`), 404, "NOT_FOUND");
  });

  it("authenticates reads, media and tag writes without leaking foreign assets", async () => {
    await seedAsset("a");
    for (const path of ["", "/a", "/a/media"])
      await expectError(await request(path, ""), 401, "UNAUTHENTICATED");
    await expectError(
      await tags("a", { tags: [] }, ""),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(await request("/a", other), 404, "NOT_FOUND");
    await expectError(
      await tags("a", { tags: ["foreign"] }, other),
      404,
      "NOT_FOUND",
    );
  });

  it("paginates ties without gaps or duplicates while new uploads arrive ahead of the cursor", async () => {
    for (const id of ["a", "b", "c", "d"]) await seedAsset(id);
    const first = await page("?limit=2");
    expect(first.assets.map((a) => a.id)).toEqual(["d", "c"]);
    expect(first.next_cursor).toEqual(expect.any(String));
    await seedAsset("new", "ready", "owner_a", "2026-01-02T00:00:00.000Z");
    await seedAsset("z");
    const second = await page(`?limit=2&cursor=${first.next_cursor}`);
    expect(second.assets.map((a) => a.id)).toEqual(["b", "a"]);
    expect(second.next_cursor).toBeNull();
    expect((await page()).assets.map((a) => a.id)).toEqual([
      "new",
      "z",
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("defaults to thirty assets and caps an explicitly bounded page at one hundred", async () => {
    for (let i = 0; i < 101; i++)
      await seedAsset(`a${String(i).padStart(3, "0")}`);
    expect((await page()).assets).toHaveLength(30);
    expect((await page("?limit=100")).assets).toHaveLength(100);
    await expectError(await request("?limit=101"), 400, "INVALID_REQUEST");
  });

  it.each([
    "?limit=0",
    "?limit=-1",
    "?limit=1.5",
    "?limit=NaN",
    "?limit=",
    "?limit=2&limit=3",
    "?status=ready",
    "?tag=",
    "?tag=%0A",
    "?cursor=",
    "?cursor=garbage",
    "?cursor=e30",
    "?cursor=%FF",
  ])("rejects malformed or ambiguous query %s", async (query) => {
    await expectError(await request(query), 400, "INVALID_REQUEST");
  });

  it("rejects a cursor used by another owner or with a different exact tag filter", async () => {
    for (const id of ["a", "b"]) {
      await seedAsset(id);
      expect((await tags(id, { tags: ["trip"] })).status).toBe(200);
    }
    const cursor = (await page("?limit=1&tag=trip")).next_cursor;
    await expectError(
      await request(`?limit=1&tag=trip&cursor=${cursor}`, other),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await request(`?limit=1&cursor=${cursor}`),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await request(`?limit=1&tag=other&cursor=${cursor}`),
      400,
      "INVALID_REQUEST",
    );
  });
});

describe("Exact owner tags", () => {
  it("persists replacement, keeps exact case-sensitive filters literal, and isolates owners", async () => {
    await seedAsset("a");
    await seedAsset("b");
    await seedAsset("foreign", "ready", "owner_b");
    const literal = "x' OR 1=1 --";
    expect((await tags("a", { tags: ["Trip", literal] })).status).toBe(200);
    expect((await tags("b", { tags: ["trip"] })).status).toBe(200);
    expect((await tags("foreign", { tags: ["Trip"] }, other)).status).toBe(200);
    expect((await page("?tag=Trip")).assets.map((a) => a.id)).toEqual(["a"]);
    expect((await page("?tag=trip")).assets.map((a) => a.id)).toEqual(["b"]);
    expect(
      (await page(`?tag=${encodeURIComponent(literal)}`)).assets.map(
        (a) => a.id,
      ),
    ).toEqual(["a"]);
    expect(await (await request("/a")).json()).toMatchObject({
      asset: { tags: ["Trip", literal] },
    });
    expect((await tags("a", { tags: ["replacement"] })).status).toBe(200);
    expect((await page("?tag=Trip")).assets).toEqual([]);
    expect((await page("?tag=replacement")).assets.map((a) => a.id)).toEqual([
      "a",
    ]);
    expect((await tags("a", { tags: [] })).status).toBe(200);
    expect((await page("?tag=replacement")).assets).toEqual([]);
  });

  it.each([
    { tags: ["dup", "dup"] },
    { tags: [""] },
    { tags: ["   "] },
    { tags: ["bad\n"] },
    { tags: ["x".repeat(65)] },
    { tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) },
    { tags: [1] },
    { tags: "tag" },
    { tags: [], owner_id: "owner_b" },
    {},
  ])(
    "rejects invalid replacement without clearing previous tags: %j",
    async (body) => {
      await seedAsset("a");
      expect((await tags("a", { tags: ["saved"] })).status).toBe(200);
      await expectError(await tags("a", body), 400, "INVALID_REQUEST");
      expect(await (await request("/a")).json()).toMatchObject({
        asset: { tags: ["saved"] },
      });
    },
  );

  it("accepts bounded Unicode tags and round-trips their scoped cursor", async () => {
    for (const id of ["a", "b"]) {
      await seedAsset(id);
      expect(
        (
          await tags(id, {
            tags: [
              "旅行",
              "x".repeat(64),
              ...Array.from({ length: 18 }, (_, i) => `tag${i}`),
            ],
          })
        ).status,
      ).toBe(200);
    }
    const first = await page("?limit=1&tag=" + encodeURIComponent("旅行"));
    const second = await page(
      "?limit=1&tag=" +
        encodeURIComponent("旅行") +
        "&cursor=" +
        first.next_cursor,
    );
    expect(second.assets.map((asset) => asset.id)).toEqual(["a"]);
  });

  it.each(["deleted", "purged"] as const)(
    "rejects tag edits on %s assets",
    async (status) => {
      await seedAsset("a", status);
      await expectError(await tags("a", { tags: ["saved"] }), 404, "NOT_FOUND");
    },
  );

  it("rejects malformed JSON and cross-origin writes", async () => {
    await seedAsset("a");
    await expectError(
      await tags("a", { tags: [] }, session, "https://attacker.test"),
      403,
      "FORBIDDEN",
    );
    await expectError(
      await request("/a/tags", session, {
        method: "PUT",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{",
      }),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await request("/a/tags", session, {
        method: "PUT",
        body: JSON.stringify({ tags: [] }),
      }),
      403,
      "FORBIDDEN",
    );
  });

  it("commits concurrent replacements as complete sets without mixing their tags", async () => {
    await seedAsset("a");
    expect(
      (
        await Promise.all([
          tags("a", { tags: ["one", "two"] }),
          tags("a", { tags: ["three", "four"] }),
        ])
      ).map((r) => r.status),
    ).toEqual([200, 200]);
    const asset = (
      (await (await request("/a")).json()) as { asset: { tags: string[] } }
    ).asset;
    expect([
      ["one", "two"],
      ["four", "three"],
    ]).toContainEqual(asset.tags);
  });

  it("rolls back a replacement if storage rejects a later tag insert", async () => {
    await seedAsset("a");
    expect((await tags("a", { tags: ["saved"] })).status).toBe(200);
    await env.DB.exec(
      "CREATE TRIGGER fail_test_tag BEFORE INSERT ON asset_tags WHEN NEW.tag = 'fail' BEGIN SELECT RAISE(ABORT, 'test_failure'); END",
    );
    await expectError(
      await tags("a", { tags: ["accepted", "fail"] }),
      500,
      "INTERNAL_ERROR",
    );
    expect(await (await request("/a")).json()).toMatchObject({
      asset: { tags: ["saved"] },
    });
  });

  it("enforces ownership for direct database inserts and updates and preserves tags on migration rerun", async () => {
    await seedAsset("a");
    await expect(
      env.DB.prepare(
        "INSERT INTO asset_tags (asset_id, owner_id, tag) VALUES ('a', 'owner_b', 'forged')",
      ).run(),
    ).rejects.toThrow();
    expect((await tags("a", { tags: ["saved"] })).status).toBe(200);
    await expect(
      env.DB.prepare(
        "UPDATE asset_tags SET owner_id = 'owner_b' WHERE asset_id = 'a'",
      ).run(),
    ).rejects.toThrow();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await page("?tag=saved")).assets.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("Private R2 media", () => {
  it("streams the validated object with private cache policy instead of copying uploader cache headers", async () => {
    await seedAsset("a");
    const response = await request("/a/media");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "0123456789",
    );
    expect(response.headers.get("ETag")).toBeNull();
  });

  it.each(["pending", "failed", "deleted", "purged"] as const)(
    "does not serve %s media",
    async (status) => {
      await seedAsset("a", status);
      await expectError(await request("/a/media"), 404, "NOT_FOUND");
    },
  );

  it("does not serve foreign media even when asset visibility is public", async () => {
    await seedAsset("a");
    await env.DB.prepare(
      "UPDATE assets SET visibility = 'public' WHERE id = 'a'",
    ).run();
    await expectError(await request("/a/media", other), 404, "NOT_FOUND");
  });

  it("rejects missing or changed objects rather than serving unvalidated bytes", async () => {
    const key = await seedAsset("a");
    await env.MEDIA.put(key, "xxxxxxxxxx", {
      httpMetadata: { contentType: "video/mp4" },
    });
    await expectError(await request("/a/media"), 404, "NOT_FOUND");
    expect(
      (await request("/a/media", session, { method: "HEAD" })).status,
    ).toBe(404);
    await env.MEDIA.delete(key);
    await expectError(await request("/a/media"), 404, "NOT_FOUND");
  });

  it("fails closed if the object changes between metadata check and streamed read", async () => {
    const key = await seedAsset("a");
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementation(
      async (objectKey, options) => {
        await env.MEDIA.put(key, "xxxxxxxxxx", {
          httpMetadata: { contentType: "video/mp4" },
        });
        return get(objectKey, options);
      },
    );
    const response = await request("/a/media");
    expect(response.headers.get("Content-Length")).toBeNull();
    await expectError(response, 404, "NOT_FOUND");
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-999", "89", "bytes 8-9/10"],
    ["bytes=-99", "0123456789", "bytes 0-9/10"],
  ])("supports video range %s", async (range, body, contentRange) => {
    await seedAsset("a");
    const response = await request("/a/media", session, {
      headers: { Range: range },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(body);
  });

  it.each([
    "bytes=10-",
    "bytes=4-2",
    "bytes=-0",
    "bytes=1-2,4-5",
    "invalid",
    "bytes=NaN-",
    "bytes=9007199254740992-",
  ])(
    "rejects unsatisfiable or unsupported range %s with 416",
    async (range) => {
      await seedAsset("a");
      const response = await request("/a/media", session, {
        headers: { Range: range },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
  );

  it("rejects a same-content object replacement during the read by its R2 version", async () => {
    const key = await seedAsset("a");
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementation(
      async (objectKey, options) => {
        await env.MEDIA.put(key, "0123456789", {
          httpMetadata: { contentType: "video/mp4" },
        });
        return get(objectKey, options);
      },
    );
    await expectError(await request("/a/media"), 404, "NOT_FOUND");
  });

  it("returns complete media when If-Range cannot match an undisclosed validator", async () => {
    await seedAsset("a");
    const response = await request("/a/media", session, {
      headers: { Range: "bytes=2-5", "If-Range": '"unknown"' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "0123456789",
    );
  });

  it("HEAD reports full media metadata without reading a body and ignores Range", async () => {
    await seedAsset("a");
    const read = vi.spyOn(env.MEDIA, "get");
    const response = await request("/a/media", session, {
      method: "HEAD",
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});
