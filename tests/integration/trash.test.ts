import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Asset } from "../../src/assets/model";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
const now = Date.parse("2026-10-04T00:00:00.000Z");
const retention = 30 * 24 * 60 * 60 * 1000;
let session: string;
let other: string;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  session = await seedUser();
  other = await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());
function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = session,
  site = origin,
) {
  return app.request(
    `${origin}/api/assets${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        Origin: site,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}
async function seedAsset(
  id = "a",
  status: Asset["status"] = "ready",
  owner = "owner_a",
) {
  const key = `synthetic/${owner}/${id}`;
  const stamp = new Date().toISOString();
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  await env.DB.prepare(`INSERT INTO assets (id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,etag,upload_expires_at,created_at,updated_at)
    VALUES (?,?,'video','synthetic.mp4','video/mp4',10,?,?,?, ?,?)`)
    .bind(id, owner, key, object?.etag, stamp, stamp, stamp)
    .run();
  if (status !== "pending")
    await env.DB.prepare("UPDATE assets SET status=? WHERE id=?")
      .bind(status === "failed" ? "failed" : "ready", id)
      .run();
  if (status === "deleted" || status === "purged")
    await env.DB.prepare(
      "UPDATE assets SET status='deleted',deleted_at=?,trash_generation=lower(hex(randomblob(16))) WHERE id=?",
    )
      .bind(stamp, id)
      .run();
  if (status === "purged")
    await env.DB.prepare("UPDATE assets SET status='purged' WHERE id=?")
      .bind(id)
      .run();
  return { key, version: object?.version, etag: object?.etag };
}
async function row(id = "a") {
  return env.DB.prepare("SELECT * FROM assets WHERE id=?")
    .bind(id)
    .first<Asset>();
}
async function used() {
  return env.DB.prepare(
    "SELECT storage_used_bytes FROM usage_quotas WHERE user_id='owner_a'",
  ).first("storage_used_bytes");
}
async function tags(id = "a") {
  return request(`/${id}/tags`, "PUT", { tags: ["trip", "旅行"] });
}
async function timeline() {
  const response = await app.request(
    `${origin}/api/timelines`,
    {
      method: "POST",
      headers: {
        Cookie: session,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Story" }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ timeline: { id: string; version: number } }>())
    .timeline;
}
function timelineRequest(path: string, method: string, body: unknown) {
  return app.request(
    `${origin}/api/timelines${path}`,
    {
      method,
      headers: {
        Cookie: session,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}
async function assertObject(key: string, version: string | undefined) {
  const object = await env.MEDIA.get(key);
  expect(object?.version).toBe(version);
  expect(await object?.text()).toBe("0123456789");
}

describe("Owner asset trash and restore", () => {
  it("trashes and restores without changing media, tags, quota or idempotent timestamps", async () => {
    const object = await seedAsset();
    expect((await tags()).status).toBe(200);
    expect(await used()).toBe(10);
    const response = await request("/a/trash", "POST", {});
    expect(response.status).toBe(200);
    const payload = await response.json<{
      asset: Asset & { tags: string[] };
    }>();
    expect(payload.asset).toMatchObject({
      status: "deleted",
      deleted_at: new Date(now).toISOString(),
      tags: ["trip", "旅行"],
    });
    for (const key of ["owner_id", "r2_key", "etag", "upload_expires_at"])
      expect(payload.asset).not.toHaveProperty(key);
    const trashed = await row();
    vi.setSystemTime(now + 1000);
    expect((await request("/a/trash", "POST", {})).status).toBe(200);
    expect(await row()).toEqual(trashed);
    expect((await request("/a")).status).toBe(404);
    expect((await request("/a/media")).status).toBe(404);
    expect(
      (await (await request("")).json<{ assets: unknown[] }>()).assets,
    ).toEqual([]);
    await assertObject(object.key, object.version);
    expect(await used()).toBe(10);
    const restored = await request("/a/restore", "POST", {});
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      asset: { status: "ready", deleted_at: null, tags: ["trip", "旅行"] },
    });
    const ready = await row();
    vi.setSystemTime(now + 2000);
    expect((await request("/a/restore", "POST", {})).status).toBe(200);
    expect(await row()).toEqual(ready);
    expect((await request("/a/media")).status).toBe(200);
    expect(await used()).toBe(10);
    await assertObject(object.key, object.version);
  });
  it("enforces ownership, authentication, same origin and strict empty mutation bodies", async () => {
    await seedAsset();
    for (const action of ["trash", "restore"]) {
      expect((await request(`/a/${action}`, "POST", {}, other)).status).toBe(
        404,
      );
      expect((await request(`/missing/${action}`, "POST", {})).status).toBe(
        404,
      );
      expect((await request(`/a/${action}`, "POST", {}, "")).status).toBe(401);
      expect(
        (
          await request(
            `/a/${action}`,
            "POST",
            {},
            session,
            "https://foreign.test",
          )
        ).status,
      ).toBe(403);
      expect(
        (await request(`/a/${action}`, "POST", { owner_id: "owner_b" })).status,
      ).toBe(400);
      expect((await request(`/a/${action}`, "POST")).status).toBe(400);
    }
    expect((await row())?.status).toBe("ready");
    expect(await used()).toBe(10);
  });
  it.each(["pending", "failed", "purged"] as const)(
    "rejects %s mutations without any state change",
    async (status) => {
      await seedAsset("a", status);
      const before = await row();
      for (const action of ["trash", "restore"])
        expect((await request(`/a/${action}`, "POST", {})).status).toBe(
          status === "purged" ? 404 : 409,
        );
      expect(await row()).toEqual(before);
    },
  );
  it.each([-1, 0, 1])(
    "enforces the exact thirty-day expiry boundary at offset %sms",
    async (offset) => {
      const object = await seedAsset("a", "deleted");
      await env.DB.prepare("UPDATE assets SET deleted_at=? WHERE id='a'")
        .bind(new Date(now - retention + offset).toISOString())
        .run();
      const before = await row();
      const response = await request("/a/restore", "POST", {});
      expect(response.status).toBe(offset > 0 ? 200 : 409);
      if (offset <= 0) expect(await row()).toEqual(before);
      else expect((await row())?.deleted_at).toBeNull();
      expect(await used()).toBe(10);
      await assertObject(object.key, object.version);
    },
  );
  it.each(["missing", "bytes", "mime", "size"])(
    "fails restoration closed for %s retained media",
    async (change) => {
      const object = await seedAsset("a", "deleted");
      const before = await row();
      if (change === "missing") await env.MEDIA.delete(object.key);
      else
        await env.MEDIA.put(
          object.key,
          change === "bytes"
            ? "xxxxxxxxxx"
            : change === "size"
              ? "short"
              : "0123456789",
          {
            httpMetadata: {
              contentType: change === "mime" ? "image/png" : "video/mp4",
            },
          },
        );
      expect((await request("/a/restore", "POST", {})).status).toBe(409);
      expect(await row()).toEqual(before);
      expect(await used()).toBe(10);
    },
  );
  it("checks expiry again after slow R2 metadata verification", async () => {
    await seedAsset("a", "deleted");
    await env.DB.prepare("UPDATE assets SET deleted_at=? WHERE id='a'")
      .bind(new Date(now - retention + 1).toISOString())
      .run();
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      const object = await head(key);
      vi.setSystemTime(now + 2);
      return object;
    });
    const before = await row();
    expect((await request("/a/restore", "POST", {})).status).toBe(409);
    expect(await row()).toEqual(before);
  });
  it("keeps concurrent trash and restore calls idempotent", async () => {
    await seedAsset();
    const responses = await Promise.all([
      request("/a/trash", "POST", {}),
      request("/a/trash", "POST", {}),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await responses[0]?.json()).toEqual(await responses[1]?.json());
    const restored = await Promise.all([
      request("/a/restore", "POST", {}),
      request("/a/restore", "POST", {}),
    ]);
    expect(restored.map((r) => r.status)).toEqual([200, 200]);
    expect(await restored[0]?.json()).toEqual(await restored[1]?.json());
    expect(await used()).toBe(10);
  });
});

describe("Real timeline references", () => {
  it.each(["item", "cover"] as const)(
    "blocks trash for a %s reference and allows it only after removal",
    async (kind) => {
      const object = await seedAsset();
      const story = await timeline();
      let item: string | undefined;
      if (kind === "cover")
        expect(
          (
            await timelineRequest(`/${story.id}`, "PATCH", {
              expected_version: 1,
              cover_asset_id: "a",
            })
          ).status,
        ).toBe(200);
      else {
        const response = await timelineRequest(`/${story.id}/items`, "POST", {
          expected_version: 1,
          asset_id: "a",
        });
        expect(response.status).toBe(201);
        item = (
          await response.json<{ timeline: { items: { id: string }[] } }>()
        ).timeline.items[0]?.id;
      }
      const before = await row();
      const blocked = await request("/a/trash", "POST", {});
      expect(blocked.status).toBe(409);
      expect(await row()).toEqual(before);
      await assertObject(object.key, object.version);
      if (kind === "cover")
        expect(
          (
            await timelineRequest(`/${story.id}`, "PATCH", {
              expected_version: 2,
              cover_asset_id: null,
            })
          ).status,
        ).toBe(200);
      else
        expect(
          (
            await timelineRequest(`/${story.id}/items/${item}`, "DELETE", {
              expected_version: 2,
            })
          ).status,
        ).toBe(200);
      expect((await row())?.status).toBe("ready");
      expect((await request("/a/trash", "POST", {})).status).toBe(200);
      expect(await used()).toBe(10);
      await assertObject(object.key, object.version);
    },
  );
  it.each(["item", "cover"] as const)(
    "serializes trash against a concurrent %s association with one safe winner",
    async (kind) => {
      const object = await seedAsset();
      const story = await timeline();
      const response = await Promise.all([
        request("/a/trash", "POST", {}),
        kind === "item"
          ? timelineRequest(`/${story.id}/items`, "POST", {
              expected_version: 1,
              asset_id: "a",
            })
          : timelineRequest(`/${story.id}`, "PATCH", {
              expected_version: 1,
              cover_asset_id: "a",
            }),
      ]);
      const trashWon = response[0]?.status === 200;
      expect(response[0]?.status).toBe(trashWon ? 200 : 409);
      expect(response[1]?.status).toBe(
        trashWon ? 409 : kind === "item" ? 201 : 200,
      );
      expect((await row())?.status).toBe(trashWon ? "deleted" : "ready");
      const refs = await env.DB.prepare(
        "SELECT (SELECT count(*) FROM timeline_items WHERE asset_id='a') + (SELECT count(*) FROM timelines WHERE cover_asset_id='a') AS n",
      ).first("n");
      expect(refs).toBe(trashWon ? 0 : 1);
      expect(await used()).toBe(10);
      await assertObject(object.key, object.version);
    },
  );
});

describe("Separate owner trash listing", () => {
  it("lists only owned deleted assets with tags and stable tie pagination, without exposing storage", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      await seedAsset(id);
      expect((await tags(id)).status).toBe(200);
      expect((await request(`/${id}/trash`, "POST", {})).status).toBe(200);
    }
    await seedAsset("ready");
    await seedAsset("foreign", "deleted", "owner_b");
    await seedAsset("purged", "purged");
    const first = await request("/trash?limit=2");
    expect(first.status).toBe(200);
    const page = await first.json<{
      assets: (Asset & { tags: string[] })[];
      next_cursor: string | null;
    }>();
    expect(page.assets.map((r) => r.id)).toEqual(["d", "c"]);
    for (const asset of page.assets) {
      expect(asset).toMatchObject({
        status: "deleted",
        tags: ["trip", "旅行"],
      });
      for (const key of ["owner_id", "r2_key", "etag", "upload_expires_at"])
        expect(asset).not.toHaveProperty(key);
    }
    await seedAsset("z", "deleted");
    const second = await (
      await request(`/trash?limit=2&cursor=${page.next_cursor}`)
    ).json<{ assets: Asset[]; next_cursor: null }>();
    expect(second.assets.map((r) => r.id)).toEqual(["b", "a"]);
    expect(second.next_cursor).toBeNull();
    expect(
      (
        await request(
          `/trash?cursor=${page.next_cursor}`,
          "GET",
          undefined,
          other,
        )
      ).status,
    ).toBe(400);
    expect((await request(`?cursor=${page.next_cursor}`)).status).toBe(400);
    expect((await request("/trash?tag=trip")).status).toBe(400);
    expect((await request("?status=deleted")).status).toBe(400);
    expect((await request("/trash?limit=1&limit=2")).status).toBe(400);
    expect((await request("/trash", "GET", undefined, "")).status).toBe(401);
    expect(
      (await (await request("")).json<{ assets: Asset[] }>()).assets.map(
        (r) => r.id,
      ),
    ).toEqual(["ready"]);
  });
  it("rejects ready-library cursors and removes restored entries from the trash view", async () => {
    await seedAsset("a");
    await seedAsset("b");
    const cursor = (
      await (await request("?limit=1")).json<{ next_cursor: string }>()
    ).next_cursor;
    expect((await request(`/trash?cursor=${cursor}`)).status).toBe(400);
    expect((await request("/a/trash", "POST", {})).status).toBe(200);
    expect((await request("/a/restore", "POST", {})).status).toBe(200);
    expect(
      (await (await request("/trash")).json<{ assets: Asset[] }>()).assets,
    ).toEqual([]);
  });
});

describe("Restore inspection concurrency", () => {
  it("does not restore a newer trash generation after inspecting an older one", async () => {
    const object = await seedAsset("a", "deleted");
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      const metadata = await head(key);
      await env.DB.prepare(
        "UPDATE assets SET status='ready',deleted_at=NULL WHERE id='a'",
      ).run();
      vi.setSystemTime(now + 5000);
      expect((await request("/a/trash", "POST", {})).status).toBe(200);
      return metadata;
    });
    expect((await request("/a/restore", "POST", {})).status).toBe(409);
    expect(await row()).toMatchObject({
      status: "deleted",
      deleted_at: new Date(now + 5000).toISOString(),
    });
    expect(await used()).toBe(10);
    await assertObject(object.key, object.version);
  });
  it("rejects changed authoritative media metadata between inspection and restore", async () => {
    await seedAsset("a", "deleted");
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      const metadata = await head(key);
      await env.DB.prepare(
        "UPDATE assets SET etag='new-validation' WHERE id='a'",
      ).run();
      return metadata;
    });
    expect((await request("/a/restore", "POST", {})).status).toBe(409);
    expect(await row()).toMatchObject({
      status: "deleted",
      etag: "new-validation",
      deleted_at: new Date(now).toISOString(),
    });
    expect(await used()).toBe(10);
  });
  it.each([null, "invalid"])(
    "rejects invalid deletion time %s without inspecting R2",
    async (deletedAt) => {
      await seedAsset("a", "deleted");
      await env.DB.prepare("UPDATE assets SET deleted_at=? WHERE id='a'")
        .bind(deletedAt)
        .run();
      const before = await row();
      const inspect = vi.spyOn(env.MEDIA, "head");
      expect((await request("/a/restore", "POST", {})).status).toBe(409);
      expect(inspect).not.toHaveBeenCalled();
      expect(await row()).toEqual(before);
    },
  );
  it("returns repeated ready restores without inspecting or changing R2", async () => {
    await seedAsset();
    const before = await row();
    const inspect = vi.spyOn(env.MEDIA, "head");
    expect((await request("/a/restore", "POST", {})).status).toBe(200);
    expect(inspect).not.toHaveBeenCalled();
    expect(await row()).toEqual(before);
  });
  it("maps the database reference guard to conflict without changing state", async () => {
    await seedAsset();
    const before = await row();
    await env.DB.exec(
      "CREATE TRIGGER enforce_reference_test BEFORE UPDATE OF status ON assets WHEN NEW.status='deleted' BEGIN SELECT RAISE(ABORT, 'asset_referenced_by_timeline'); END;",
    );
    expect((await request("/a/trash", "POST", {})).status).toBe(409);
    expect(await row()).toEqual(before);
    expect(await used()).toBe(10);
  });
});

describe("Distinct trash generations", () => {
  it("rejects an old restore after restore and retrash at the identical millisecond", async () => {
    const object = await seedAsset();
    expect((await request("/a/trash", "POST", {})).status).toBe(200);
    const firstTrash = await row();
    let signalInspected: () => void = () => {};
    const inspected = new Promise<void>((resolve) => {
      signalInspected = resolve;
    });
    let releaseHead: () => void = () => {};
    const heldHead = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const head = env.MEDIA.head.bind(env.MEDIA);
    let reads = 0;
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      const metadata = await head(key);
      if (++reads === 1) {
        signalInspected();
        await heldHead;
      }
      return metadata;
    });
    const oldRestore = request("/a/restore", "POST", {});
    await inspected;
    const secondRestore = await request("/a/restore", "POST", {});
    const retrash = await request("/a/trash", "POST", {});
    const newestTrash = await row();
    releaseHead();
    const staleResponse = await oldRestore;
    expect(secondRestore.status).toBe(200);
    expect(retrash.status).toBe(200);
    expect(newestTrash?.deleted_at).toBe(firstTrash?.deleted_at);
    expect(staleResponse.status).toBe(409);
    expect(await row()).toEqual(newestTrash);
    expect((await row())?.status).toBe("deleted");
    expect(await used()).toBe(10);
    await assertObject(object.key, object.version);
  });
});

describe("Internal trash token contract", () => {
  it("creates a fresh token per deletion, preserves it on retries, clears it on restore, and never exposes it", async () => {
    await seedAsset();
    expect((await row())?.trash_generation).toBeNull();
    const response = await request("/a/trash", "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("asset.trash_generation");
    const first = (await row())?.trash_generation;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect((await request("/a/trash", "POST", {})).status).toBe(200);
    expect((await row())?.trash_generation).toBe(first);
    const page = await (await request("/trash")).json<{
      assets: Record<string, unknown>[];
    }>();
    expect(page.assets[0]).not.toHaveProperty("trash_generation");
    const restored = await request("/a/restore", "POST", {});
    expect(restored.status).toBe(200);
    expect(await restored.json()).not.toHaveProperty("asset.trash_generation");
    expect((await row())?.trash_generation).toBeNull();
    expect(await (await request("/a")).json()).not.toHaveProperty(
      "asset.trash_generation",
    );
    expect(
      (await (await request("")).json<{ assets: Record<string, unknown>[] }>())
        .assets[0],
    ).not.toHaveProperty("trash_generation");
    expect((await request("/a/trash", "POST", {})).status).toBe(200);
    expect((await row())?.trash_generation).not.toBe(first);
  });
  it("backfills existing deleted assets without changing media, tags, timestamps or quota", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 5));
    session = await seedUser();
    const objects = [await seedAsset("old_a"), await seedAsset("old_b")];
    await seedAsset("ready");
    await env.DB.prepare(
      "INSERT INTO asset_tags(asset_id,owner_id,tag) VALUES (?, ?, ?), (?, ?, ?)",
    )
      .bind("old_a", "owner_a", "trip", "old_a", "owner_a", "旅行")
      .run();
    await env.DB.prepare(
      "UPDATE assets SET status='deleted', deleted_at=? WHERE id IN ('old_a','old_b')",
    )
      .bind(new Date(now).toISOString())
      .run();
    const before = (
      await env.DB.prepare("SELECT * FROM assets ORDER BY id").all<Asset>()
    ).results;
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const after = (
      await env.DB.prepare("SELECT * FROM assets ORDER BY id").all<Asset>()
    ).results;
    expect(
      after.map(
        ({ trash_generation: _generation, purge_claim: _claim, ...asset }) =>
          asset,
      ),
    ).toEqual(before);
    const deleted = after.filter((asset) => asset.status === "deleted");
    expect(deleted).toHaveLength(2);
    for (const asset of deleted)
      expect(asset.trash_generation).toMatch(/^[0-9a-f]{32}$/);
    expect(deleted[0]?.trash_generation).not.toBe(deleted[1]?.trash_generation);
    expect(
      after.find((asset) => asset.id === "ready")?.trash_generation,
    ).toBeNull();
    expect(await used()).toBe(30);
    for (const object of objects)
      await assertObject(object.key, object.version);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(
      (await env.DB.prepare("SELECT * FROM assets ORDER BY id").all<Asset>())
        .results,
    ).toEqual(after);
    const restored = await request("/old_a/restore", "POST", {});
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      asset: { status: "ready", tags: ["trip", "旅行"] },
    });
    expect((await row("old_a"))?.trash_generation).toBeNull();
    expect(await used()).toBe(30);
  });
});
