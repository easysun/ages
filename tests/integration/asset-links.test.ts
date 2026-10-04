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
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser();
  other = await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  headers = {},
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}
function create(asset_id = "a", slug = "raw-media", cookie = session) {
  return request(
    "/api/links",
    "POST",
    { target: { kind: "asset", asset_id }, slug },
    cookie,
  );
}
async function saved() {
  const response = await create();
  expect(response.status).toBe(201);
  return (await response.json<{ link: { id: string; slug: string } }>()).link;
}
async function asset(id = "a", owner = "owner_a", status = "ready") {
  const key = `synthetic/${owner}/${id}`;
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  const stamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO assets(id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,etag,upload_expires_at,created_at,updated_at)
    VALUES(?,?,'video','synthetic.mp4','video/mp4',10,?,?,?,?,?)`)
    .bind(id, owner, key, object?.etag, stamp, stamp, stamp)
    .run();
  if (status !== "pending")
    await env.DB.prepare("UPDATE assets SET status=? WHERE id=?")
      .bind(status, id)
      .run();
  return { key, version: object?.version };
}
async function deactivate(id: string) {
  expect(
    (await request(`/api/links/${id}`, "PATCH", { active: false }, session))
      .status,
  ).toBe(200);
}
async function row() {
  return env.DB.prepare("SELECT * FROM assets WHERE id='a'").first();
}

describe("Scoped raw Asset Links", () => {
  it("grants anonymous GET, HEAD and Range while preserving private owner APIs and storage metadata", async () => {
    await asset();
    const link = await saved();
    expect(await row()).toMatchObject({
      visibility: "private",
      status: "ready",
    });
    for (const path of ["/api/assets/a", "/api/assets/a/media"])
      expect((await request(path)).status).toBe(401);
    const response = await request(`/s/${link.slug}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
    const head = await request(`/s/${link.slug}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(await head.text()).toBe("");
    const range = await request(`/s/${link.slug}`, "GET", undefined, "", {
      Range: "bytes=2-5",
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("2345");
    expect((await request(`/s/${link.slug}`, "POST")).status).toBe(404);
    const payload = await (
      await request(`/api/links/${link.id}`, "GET", undefined, session)
    ).json();
    expect(payload).toMatchObject({
      link: { target: { kind: "asset", asset_id: "a" } },
    });
    expect(JSON.stringify(payload)).not.toMatch(/r2_key|etag|trash_generation/);
  });
  it("rejects missing, foreign, pending and failed targets, auth and foreign origin", async () => {
    await asset();
    await asset("foreign", "owner_b");
    await asset("pending", "owner_a", "pending");
    await asset("failed", "owner_a", "failed");
    for (const id of ["missing", "foreign", "pending", "failed"])
      expect((await create(id)).status).toBe(409);
    expect((await create("a", "raw-media", other)).status).toBe(409);
    expect((await create("a", "raw-media", "")).status).toBe(401);
    expect(
      (
        await request(
          "/api/links",
          "POST",
          { target: { kind: "asset", asset_id: "a" } },
          session,
          { Origin: "https://attacker.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM distribution_links",
      ).first("n"),
    ).toBe(0);
    const stamp = new Date().toISOString();
    await expect(
      env.DB.prepare(
        `INSERT INTO distribution_links(id,owner_id,slug,target_kind,asset_id,created_at,updated_at) VALUES('foreign','owner_b','sql-foreign','asset','a',?,?)`,
      )
        .bind(stamp, stamp)
        .run(),
    ).rejects.toThrow();
  });
  it("serializes cross-kind slug and quota races without reserving losing slugs", async () => {
    await asset();
    const url = (slug: string) =>
      request(
        "/api/links",
        "POST",
        { target: { kind: "url", url: "https://example.test" }, slug },
        session,
      );
    const same = await Promise.all([create(), url("raw-media")]);
    expect(same.map((r) => r.status).sort()).toEqual([201, 409]);
    await env.DB.prepare(
      "UPDATE usage_quotas SET link_limit=2 WHERE user_id='owner_a'",
    ).run();
    const quota = await Promise.all([
      create("a", "asset-race"),
      url("url-race"),
    ]);
    expect(quota.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM reserved_link_slugs",
      ).first("n"),
    ).toBe(2);
  });
  it("blocks active references including expired Links; deactivation preserves media, tags and quota and permits trash", async () => {
    const object = await asset();
    const link = await saved();
    await request("/api/assets/a/tags", "PUT", { tags: ["story"] }, session);
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(link.id)
      .run();
    expect((await request(`/s/${link.slug}`)).status).toBe(404);
    expect(
      (await request("/api/assets/a/trash", "POST", {}, session)).status,
    ).toBe(409);
    await expect(
      env.DB.prepare(
        "UPDATE assets SET status='deleted',deleted_at=? WHERE id='a'",
      )
        .bind(new Date().toISOString())
        .run(),
    ).rejects.toThrow("asset_referenced_by_link");
    await deactivate(link.id);
    const trash = await request("/api/assets/a/trash", "POST", {}, session);
    expect(trash.status).toBe(200);
    expect(JSON.stringify(await trash.json())).not.toMatch(
      /trash_generation|r2_key|etag/,
    );
    expect(await row()).toMatchObject({ status: "deleted" });
    const media = await env.MEDIA.get(object.key);
    expect(media?.version).toBe(object.version);
    expect(await media?.text()).toBe("0123456789");
    expect(
      await env.DB.prepare(
        "SELECT storage_used_bytes FROM usage_quotas WHERE user_id='owner_a'",
      ).first("storage_used_bytes"),
    ).toBe(10);
    expect(
      await env.DB.prepare(
        "SELECT tag FROM asset_tags WHERE asset_id='a'",
      ).first("tag"),
    ).toBe("story");
    expect(
      (
        await request(
          `/api/links/${link.id}`,
          "PATCH",
          { active: true },
          session,
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare(
      "UPDATE assets SET status='purged' WHERE id='a'",
    ).run();
    expect(await row()).toMatchObject({ status: "purged" });
  });
  it("keeps a slug reserved after actual Link removal and protects the reservation ledger", async () => {
    await asset();
    const link = await saved();
    await deactivate(link.id);
    await env.DB.prepare("DELETE FROM distribution_links WHERE id=?")
      .bind(link.id)
      .run();
    expect((await create()).status).toBe(409);
    expect(await row()).toMatchObject({ status: "ready" });
    await expect(
      env.DB.prepare("DELETE FROM reserved_link_slugs").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE reserved_link_slugs SET slug='recycled'").run(),
    ).rejects.toThrow();
  });
  it("fails closed on revoked, corrupt and expired grants for every media method", async () => {
    await asset();
    const link = await saved();
    for (const expires of ["invalid", new Date(Date.now() - 1).toISOString()]) {
      await env.DB.prepare(
        "UPDATE distribution_links SET expires_at=? WHERE id=?",
      )
        .bind(expires, link.id)
        .run();
      for (const method of ["GET", "HEAD"])
        expect(
          (
            await request(`/s/${link.slug}`, method, undefined, "", {
              Range: "bytes=0-1",
            })
          ).status,
        ).toBe(404);
    }
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at=NULL WHERE id=?",
    )
      .bind(link.id)
      .run();
    await deactivate(link.id);
    expect((await request(`/s/${link.slug}`)).status).toBe(404);
  });
  it("rejects changed R2 media and revocation while its metadata is being inspected", async () => {
    const object = await asset();
    const link = await saved();
    const original = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementationOnce(async (key) => {
      const result = await original(key);
      await deactivate(link.id);
      return result;
    });
    expect((await request(`/s/${link.slug}`)).status).toBe(404);
    expect(
      (
        await request(
          `/api/links/${link.id}`,
          "PATCH",
          { active: true },
          session,
        )
      ).status,
    ).toBe(200);
    await env.MEDIA.put(object.key, "changed!!!", {
      httpMetadata: { contentType: "video/mp4" },
    });
    expect((await request(`/s/${link.slug}`)).status).toBe(404);
  });
  it("rechecks revocation after GET before emitting any media bytes", async () => {
    await asset();
    const link = await saved();
    const original = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementationOnce(async (key, options) => {
      const result = await original(key, options);
      await deactivate(link.id);
      return result;
    });
    const response = await request(`/s/${link.slug}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Length")).not.toBe("10");
  });
  it("serializes trash versus new Asset grants to a safe winner", async () => {
    await asset();
    const race = await Promise.all([
      create(),
      request("/api/assets/a/trash", "POST", {}, session),
    ]);
    expect(race.map((r) => r.status)).toSatisfy(
      (statuses: number[]) =>
        (statuses[0] === 201 && statuses[1] === 409) ||
        (statuses[0] === 409 && statuses[1] === 200),
    );
    const state = await row();
    if (race[0]?.status === 201) {
      expect(state).toMatchObject({ status: "ready" });
      await expect(
        env.DB.prepare("UPDATE assets SET status='deleted' WHERE id='a'").run(),
      ).rejects.toThrow();
    } else {
      expect(state).toMatchObject({ status: "deleted" });
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM distribution_links",
        ).first("n"),
      ).toBe(0);
    }
  });
  it("serializes trash versus reactivation without granting deleted media", async () => {
    await asset();
    const link = await saved();
    await deactivate(link.id);
    const results = await Promise.all([
      request(`/api/links/${link.id}`, "PATCH", { active: true }, session),
      request("/api/assets/a/trash", "POST", {}, session),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const active = await env.DB.prepare(
      "SELECT active FROM distribution_links WHERE id=?",
    )
      .bind(link.id)
      .first("active");
    expect(await row()).toMatchObject({
      status: active === 1 ? "ready" : "deleted",
    });
    expect((await request(`/s/${link.slug}`)).status).toBe(
      active === 1 ? 200 : 404,
    );
  });
  it("rechecks expiry at the exact deadline after HEAD metadata inspection", async () => {
    await asset();
    const link = await saved();
    const deadline = Date.now() + 60_000;
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at=? WHERE id=?",
    )
      .bind(new Date(deadline).toISOString(), link.id)
      .run();
    const original = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementationOnce(async (key) => {
      const result = await original(key);
      vi.spyOn(Date, "now").mockReturnValue(deadline);
      return result;
    });
    const response = await request(`/s/${link.slug}`, "HEAD");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Length")).not.toBe("10");
  });
  it("rejects lost media and storage metadata changes without leaking validators", async () => {
    const object = await asset();
    const link = await saved();
    await env.MEDIA.delete(object.key);
    expect((await request(`/s/${link.slug}`, "HEAD")).status).toBe(404);
    await env.MEDIA.put(object.key, "0123456789", {
      httpMetadata: { contentType: "audio/mpeg" },
    });
    const response = await request(`/s/${link.slug}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("ETag")).toBeNull();
  });
  it("keeps foreign ownership and every target identity immutable at the database boundary", async () => {
    await asset();
    const link = await saved();
    await deactivate(link.id);
    for (const assignment of [
      "asset_id='missing'",
      "owner_id='owner_b'",
      "target_kind='url',asset_id=NULL,target_url='https://example.test'",
      "slug='another-slug'",
    ]) {
      await expect(
        env.DB.prepare(`UPDATE distribution_links SET ${assignment} WHERE id=?`)
          .bind(link.id)
          .run(),
      ).rejects.toThrow("immutable_link_identity");
    }
    await expect(
      env.DB.prepare("DELETE FROM assets WHERE id='a'").run(),
    ).rejects.toThrow();
    expect(await row()).toMatchObject({ status: "ready" });
    const stamp = new Date().toISOString();
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO distribution_links(id,owner_id,slug,target_kind,target_url,created_at,updated_at) VALUES('rolled-back','owner_a','rolled-back','url','https://example.test',?,?)",
        ).bind(stamp, stamp),
        env.DB.prepare(
          "INSERT INTO reserved_link_slugs(slug) VALUES('raw-media')",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM reserved_link_slugs WHERE slug='rolled-back'",
      ).first("n"),
    ).toBe(0);
  });
});

it("copies legacy Links unchanged before guards, retains accounting, and freezes the archive", async () => {
  await reset();
  const legacy = env.TEST_MIGRATIONS.filter((m) => m.name < "0008");
  await applyD1Migrations(env.DB, legacy);
  session = await seedUser();
  const stamp = "2026-01-01T00:00:00.000Z";
  await env.DB.prepare(
    "INSERT INTO timelines(id,owner_id,title,visibility,created_at,updated_at) VALUES('story','owner_a','Story','unlisted',?,?)",
  )
    .bind(stamp, stamp)
    .run();
  for (const [id, kind, target, slug, active, expiry] of [
    [
      "u",
      "url",
      "https://example.test",
      "old-url",
      0,
      "2027-01-01T00:00:00.000Z",
    ],
    ["t", "timeline", "story", "old-story", 1, null],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO links(id,owner_id,slug,target_kind,target_url,timeline_id,active,expires_at,created_at,updated_at) VALUES(?,'owner_a',?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        slug,
        kind,
        kind === "url" ? target : null,
        kind === "timeline" ? target : null,
        active,
        expiry,
        stamp,
        stamp,
      )
      .run();
  }
  await env.DB.prepare(
    "UPDATE usage_quotas SET link_limit=1 WHERE user_id='owner_a'",
  ).run();
  await asset("legacy-media");
  await env.DB.prepare(
    "UPDATE timelines SET visibility='private' WHERE id='story'",
  ).run();
  const before = (await env.DB.prepare("SELECT * FROM links ORDER BY id").all())
    .results;
  const usage = await env.DB.prepare(
    "SELECT * FROM usage_quotas WHERE user_id='owner_a'",
  ).first();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(
    (await env.DB.prepare("SELECT * FROM distribution_links ORDER BY id").all())
      .results,
  ).toEqual(
    before.map((r) => ({ ...r, asset_id: null, moderation_blocked: 0 })),
  );
  expect(
    await env.DB.prepare(
      "SELECT * FROM usage_quotas WHERE user_id='owner_a'",
    ).first(),
  ).toEqual(usage);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reserved_link_slugs").first(
      "n",
    ),
  ).toBe(2);
  for (const sql of [
    "UPDATE links SET active=0",
    "DELETE FROM links",
    "INSERT INTO links SELECT * FROM links WHERE id='u'",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow(
      "legacy_links_read_only",
    );
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(
    (await env.DB.prepare("SELECT * FROM links ORDER BY id").all()).results,
  ).toEqual(before);
  expect((await request("/s/old-story")).status).toBe(404);
  await env.DB.prepare(
    "UPDATE timelines SET visibility='unlisted' WHERE id='story'",
  ).run();
  expect((await request("/s/old-story")).status).toBe(302);
  expect((await request("/s/old-url")).status).toBe(404);
});
