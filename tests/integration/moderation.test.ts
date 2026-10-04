import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let owner: string;
let reporter: string;
let admin: string;
const info = vi.fn();
const errors = vi.fn();
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  owner = await seedUser();
  reporter = await seedUser("reporter");
  admin = await seedUser("operator");
  await env.DB.prepare(
    "UPDATE users SET plan='admin' WHERE id='operator'",
  ).run();
  vi.spyOn(console, "info").mockImplementation(info);
  vi.spyOn(console, "error").mockImplementation(errors);
});
afterEach(() => vi.useRealTimers());
function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = reporter,
  site = origin,
) {
  return app.request(
    `${origin}${path}`,
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
async function seedAsset(id = "a") {
  const key = `synthetic/${id}`;
  const stamp = new Date().toISOString();
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  await env.DB.prepare(
    "INSERT INTO assets(id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,etag,upload_expires_at,created_at,updated_at) VALUES(?,'owner_a','video','synthetic.mp4','video/mp4',10,?,?,?,?,?)",
  )
    .bind(id, key, object.etag, stamp, stamp, stamp)
    .run();
  await env.DB.prepare("UPDATE assets SET status='ready' WHERE id=?")
    .bind(id)
    .run();
  return { key, version: object.version };
}
async function story(
  id = "story",
  visibility = "unlisted",
  cover: string | null = null,
) {
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO timelines(id,owner_id,title,visibility,cover_asset_id,created_at,updated_at) VALUES(?,'owner_a','A sensitive story',?,?,?,?)",
  )
    .bind(id, visibility, cover, stamp, stamp)
    .run();
}
async function item(storyId = "story", assetId = "a") {
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO timeline_items(id,timeline_id,owner_id,asset_id,position,caption,created_at,updated_at) VALUES(?,?,'owner_a',?,0,'A sensitive caption',?,?)",
  )
    .bind(`${storyId}_${assetId}`, storyId, assetId, stamp, stamp)
    .run();
}
async function link(slug = "raw-media", kind = "asset", target = "a") {
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO distribution_links(id,owner_id,slug,target_kind,target_url,timeline_id,asset_id,created_at,updated_at) VALUES(?,'owner_a',?,?,?,?,?,?,?)",
  )
    .bind(
      `link_${slug}`,
      slug,
      kind,
      kind === "url" ? target : null,
      kind === "timeline" ? target : null,
      kind === "asset" ? target : null,
      stamp,
      stamp,
    )
    .run();
  return `link_${slug}`;
}
function report(
  target: unknown,
  category = "abuse",
  detail = "Please review this content.",
  cookie = reporter,
) {
  return request("/api/reports", "POST", { target, category, detail }, cookie);
}
function moderate(
  kind: string,
  id: string,
  blocked = true,
  cookie = admin,
  site = origin,
) {
  return request(
    "/api/admin/content",
    "PUT",
    { target: { kind, id }, blocked, reason: "Review completed." },
    cookie,
    site,
  );
}
async function count(table: string) {
  return env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
}
async function unavailable(path: string) {
  for (const method of ["GET", "HEAD"]) {
    const response = await request(path, method, undefined, "");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).not.toMatch(
      /sensitive|synthetic|owner_a|og:title|og:image|r2_key/,
    );
  }
}

describe("Authenticated bounded content reports", () => {
  it("derives stable subjects for visible Timelines and active public Links without accepting forged targets", async () => {
    await seedAsset();
    await story();
    await item();
    const raw = await link();
    await link("story-link", "timeline", "story");
    await link("url-link", "url", "https://example.test");
    for (const target of [
      { kind: "timeline", timeline_id: "story" },
      { kind: "link", slug: "raw-media" },
      { kind: "link", slug: "story-link" },
      { kind: "link", slug: "url-link" },
    ])
      expect((await report(target)).status).toBe(201);
    const rows = (
      await env.DB.prepare(
        "SELECT target_kind,target_id,reporter_id,category,detail FROM content_reports ORDER BY target_id",
      ).all()
    ).results;
    expect(rows).toContainEqual({
      target_kind: "link",
      target_id: raw,
      reporter_id: "reporter",
      category: "abuse",
      detail: "Please review this content.",
    });
    expect(rows).toHaveLength(4);
    expect((await report({ kind: "asset", asset_id: "a" })).status).toBe(400);
    expect(
      (await report({ kind: "link", slug: "raw-media", asset_id: "a" })).status,
    ).toBe(400);
  });
  it("rejects anonymous and foreign-origin creation and hides unavailable or private subjects", async () => {
    await seedAsset();
    await story("private-story", "private");
    await story();
    const saved = await link();
    expect(
      (
        await report(
          { kind: "link", slug: "raw-media" },
          "abuse",
          "Details",
          "",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/api/reports",
          "POST",
          {
            target: { kind: "link", slug: "raw-media" },
            category: "abuse",
            detail: "Details",
          },
          reporter,
          "https://foreign.test",
        )
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE distribution_links SET active=0 WHERE id=?")
      .bind(saved)
      .run();
    for (const target of [
      { kind: "timeline", timeline_id: "private-story" },
      { kind: "timeline", timeline_id: "missing" },
      { kind: "link", slug: "raw-media" },
      { kind: "link", slug: "missing" },
    ]) {
      const response = await report(target);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(
        /sensitive|private-story|raw-media/,
      );
    }
    expect(await count("content_reports")).toBe(0);
  });
  it("deduplicates concurrent repeated reports while preserving their original bounded details", async () => {
    await story();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        report({ kind: "timeline", timeline_id: "story" }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(await count("content_reports")).toBe(1);
    expect(
      (
        await report(
          { kind: "timeline", timeline_id: "story" },
          "spam",
          "Replacement detail",
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT category,detail FROM content_reports",
      ).first(),
    ).toEqual({ category: "abuse", detail: "Please review this content." });
  });
  it("validates categories, details and strict bodies without logging report details or cookie secrets", async () => {
    await story();
    for (const body of [
      {
        target: { kind: "timeline", timeline_id: "story" },
        category: "unknown",
        detail: "x",
      },
      {
        target: { kind: "timeline", timeline_id: "story" },
        category: "abuse",
        detail: "x".repeat(1001),
      },
      {
        target: { kind: "timeline", timeline_id: "story" },
        category: "abuse",
        detail: "\u0000",
      },
      {
        target: { kind: "timeline", timeline_id: "story" },
        category: "abuse",
        detail: "x",
        reporter_id: "operator",
      },
    ])
      expect((await request("/api/reports", "POST", body)).status).toBe(400);
    const response = await report(
      { kind: "timeline", timeline_id: "story" },
      "copyright",
      "never-log-this-private-report",
    );
    expect(response.status).toBe(201);
    const logs = JSON.stringify([...info.mock.calls, ...errors.mock.calls]);
    expect(logs).not.toContain("never-log-this-private-report");
    expect(logs).not.toContain(reporter);
  });
  it("applies a durable report burst bound with correlated retry headers", async () => {
    await story();
    for (let n = 0; n < 10; n++)
      expect([200, 201]).toContain(
        (await report({ kind: "timeline", timeline_id: "story" })).status,
      );
    const response = await report({ kind: "timeline", timeline_id: "story" });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        request_id: response.headers.get("X-Request-ID"),
      },
    });
  });
  it("bounds distinct daily reports atomically while allowing a previously reported subject to dedupe", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let n = 0; n < 21; n++) {
      vi.setSystemTime(start + n * 60_000);
      const slug = `subject-${n}`;
      await link(slug, "url", "https://example.test");
      const response = await report({ kind: "link", slug });
      expect(response.status).toBe(n < 20 ? 201 : 429);
    }
    expect(await count("content_reports")).toBe(20);
    expect((await report({ kind: "link", slug: "subject-0" })).status).toBe(
      200,
    );
  });
});

describe("Reversible administrator takedowns", () => {
  it("requires admin, authentication and same-origin without any self-role grant", async () => {
    await story();
    expect((await moderate("timeline", "story", true, "")).status).toBe(401);
    expect((await moderate("timeline", "story", true, owner)).status).toBe(403);
    expect(
      (await moderate("timeline", "story", true, admin, "https://foreign.test"))
        .status,
    ).toBe(403);
    expect(
      (await request("/api/admin/reports", "GET", undefined, owner)).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/admin/content",
          "PUT",
          {
            target: { kind: "timeline", id: "story" },
            blocked: true,
            reason: "Review",
            moderator_id: "operator",
          },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(await count("moderation_audit")).toBe(0);
    expect((await request("/t/story")).status).toBe(200);
  });
  it("lists reports only for current admins and validates bounded list queries", async () => {
    await story();
    await report({ kind: "timeline", timeline_id: "story" });
    const response = await request(
      "/api/admin/reports?limit=1",
      "GET",
      undefined,
      admin,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reports: [
        { target: { kind: "timeline", id: "story" }, category: "abuse" },
      ],
    });
    for (const query of [
      "?limit=101",
      "?limit=0",
      "?limit=1&limit=2",
      "?unknown=x",
    ])
      expect(
        (await request(`/api/admin/reports${query}`, "GET", undefined, admin))
          .status,
      ).toBe(400);
    await env.DB.prepare(
      "UPDATE users SET plan='free' WHERE id='operator'",
    ).run();
    expect(
      (await request("/api/admin/reports", "GET", undefined, admin)).status,
    ).toBe(403);
    expect((await moderate("timeline", "story")).status).toBe(403);
  });
  it("rechecks moderator role inside the mutation transaction after session authentication", async () => {
    await story();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(
        "UPDATE users SET plan='free' WHERE id='operator'",
      ).run();
      return batch(statements);
    });
    expect((await moderate("timeline", "story")).status).toBe(403);
    expect((await request("/t/story")).status).toBe(200);
    expect(await count("moderation_audit")).toBe(0);
  });
  it("disables and restores Timeline SSR, OG, membership media and Timeline Links without losing bytes or slugs", async () => {
    const object = await seedAsset();
    await story();
    await item();
    await link("story-link", "timeline", "story");
    expect((await moderate("timeline", "story")).status).toBe(200);
    await unavailable("/t/story");
    await unavailable("/t/story/media/a");
    await unavailable("/s/story-link");
    expect(
      (await request("/api/timelines/story", "GET", undefined, owner)).status,
    ).toBe(200);
    expect((await moderate("timeline", "story", false)).status).toBe(200);
    expect((await request("/t/story")).status).toBe(200);
    expect((await request("/s/story-link")).status).toBe(302);
    expect((await request("/t/story/media/a")).status).toBe(200);
    expect((await env.MEDIA.head(object.key))?.version).toBe(object.version);
    expect(
      await env.DB.prepare(
        "SELECT storage_used_bytes FROM usage_quotas WHERE user_id='owner_a'",
      ).first("storage_used_bytes"),
    ).toBe(10);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM reserved_link_slugs WHERE slug='story-link'",
      ).first("n"),
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT moderator_id,target_kind,target_id,previous_blocked,blocked FROM moderation_audit ORDER BY created_at,id",
        ).all()
      ).results,
    ).toHaveLength(2);
  });
  it("blocks one Link independently while its underlying public Timeline and other Links remain available", async () => {
    await story();
    const id = await link("first-link", "timeline", "story");
    await link("second-link", "timeline", "story");
    expect((await moderate("link", id)).status).toBe(200);
    await unavailable("/s/first-link");
    expect((await request("/s/second-link")).status).toBe(302);
    expect((await request("/t/story")).status).toBe(200);
    expect((await moderate("link", id, false)).status).toBe(200);
    expect((await request("/s/first-link")).status).toBe(302);
  });
  it("blocks a shared underlying Asset across both Timelines, cover OG, raw grants and owner media without breaking metadata/trash/restore", async () => {
    const object = await seedAsset();
    await story("first", "unlisted", "a");
    await story("second", "public");
    await item("second");
    const raw = await link();
    expect((await moderate("asset", "a")).status).toBe(200);
    for (const path of [
      "/t/first",
      "/t/second",
      "/t/first/media/a",
      "/t/second/media/a",
      "/s/raw-media",
    ])
      await unavailable(path);
    expect(
      (await request("/api/assets/a/media", "GET", undefined, owner)).status,
    ).toBe(404);
    expect(
      (await request("/api/assets/a", "GET", undefined, owner)).status,
    ).toBe(200);
    expect(
      (await request(`/api/links/${raw}`, "PATCH", { active: false }, owner))
        .status,
    ).toBe(200);
    await env.DB.prepare("DELETE FROM timeline_items WHERE asset_id='a'").run();
    await env.DB.prepare(
      "UPDATE timelines SET cover_asset_id=NULL WHERE cover_asset_id='a'",
    ).run();
    expect(
      (await request("/api/assets/a/trash", "POST", {}, owner)).status,
    ).toBe(200);
    expect(
      (await request("/api/assets/a/restore", "POST", {}, owner)).status,
    ).toBe(200);
    expect(
      (await request("/api/assets/a/media", "GET", undefined, owner)).status,
    ).toBe(404);
    expect((await moderate("asset", "a", false)).status).toBe(200);
    expect(
      (await request("/api/assets/a/media", "GET", undefined, owner)).status,
    ).toBe(200);
    expect((await env.MEDIA.head(object.key))?.version).toBe(object.version);
  });
  it("rejects asset blocking which occurs during R2 metadata or body inspection before success headers", async () => {
    await seedAsset();
    await story();
    await item();
    await link();
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementationOnce(async (key) => {
      const metadata = await head(key);
      expect((await moderate("asset", "a")).status).toBe(200);
      return metadata;
    });
    expect((await request("/s/raw-media")).status).toBe(404);
    expect((await moderate("asset", "a", false)).status).toBe(200);
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementationOnce(async (key, options) => {
      const object = await get(key, options);
      expect((await moderate("asset", "a")).status).toBe(200);
      return object;
    });
    const response = await request("/t/story/media/a");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Length")).not.toBe("10");
  });
  it("rejects Timeline and Link takedowns during R2 inspection for HEAD and GET", async () => {
    await seedAsset();
    await story();
    await item();
    const raw = await link();
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementationOnce(async (key) => {
      const metadata = await head(key);
      expect((await moderate("link", raw)).status).toBe(200);
      return metadata;
    });
    expect((await request("/s/raw-media", "HEAD")).status).toBe(404);
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementationOnce(async (key, options) => {
      const object = await get(key, options);
      expect((await moderate("timeline", "story")).status).toBe(200);
      return object;
    });
    expect((await request("/t/story/media/a")).status).toBe(404);
  });
  it("preserves owner visibility/version and immutable audit identity with idempotent repeated moderation", async () => {
    await story();
    expect((await moderate("timeline", "story")).status).toBe(200);
    expect((await moderate("timeline", "story")).status).toBe(200);
    expect(await count("moderation_audit")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT visibility,version FROM timelines WHERE id='story'",
      ).first(),
    ).toEqual({ visibility: "unlisted", version: 1 });
    const audit = await env.DB.prepare(
      "SELECT * FROM moderation_audit",
    ).first();
    expect(audit).toMatchObject({
      moderator_id: "operator",
      target_kind: "timeline",
      target_id: "story",
      previous_blocked: 0,
      blocked: 1,
      reason: "Review completed.",
    });
    await expect(
      env.DB.prepare(
        "UPDATE moderation_audit SET moderator_id='owner_a'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("DELETE FROM moderation_audit").run(),
    ).rejects.toThrow();
    expect((await moderate("timeline", "missing")).status).toBe(404);
  });
});

it("upgrades existing content with only default moderation state and reruns without changing references, accounting or reservations", async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((migration) => migration.name < "0010"),
  );
  owner = await seedUser();
  await seedAsset();
  await story("existing", "public", "a");
  await item("existing");
  await link();
  await env.DB.prepare(
    "INSERT INTO asset_tags(asset_id,owner_id,tag) VALUES('a','owner_a','trip')",
  ).run();
  const tables = [
    "assets",
    "timelines",
    "distribution_links",
    "timeline_items",
    "asset_tags",
    "usage_quotas",
    "reserved_link_slugs",
  ];
  const before = await Promise.all(
    tables.map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
    ),
  );
  const object = await env.MEDIA.head("synthetic/a");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const [index, table] of tables.entries()) {
    const after = (await env.DB.prepare(`SELECT * FROM ${table}`).all())
      .results;
    expect(after).toEqual(
      index < 3
        ? before[index]?.map((row) => ({ ...row, moderation_blocked: 0 }))
        : before[index],
    );
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await count("content_reports")).toBe(0);
  expect(await count("moderation_audit")).toBe(0);
  expect((await env.MEDIA.head("synthetic/a"))?.version).toBe(object?.version);
  expect((await request("/t/existing", "GET", undefined, "")).status).toBe(200);
  expect((await request("/s/raw-media", "GET", undefined, "")).status).toBe(
    200,
  );
});

it("rolls back the audit if updating content fails, so successful audit rows always match applied state", async () => {
  await story();
  await env.DB.prepare(
    "CREATE TRIGGER synthetic_reject_moderation BEFORE UPDATE OF moderation_blocked ON timelines BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
  ).run();
  expect((await moderate("timeline", "story")).status).toBe(500);
  expect(await count("moderation_audit")).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT moderation_blocked FROM timelines WHERE id='story'",
    ).first("moderation_blocked"),
  ).toBe(0);
  expect((await request("/t/story", "GET", undefined, "")).status).toBe(200);
});

it("caps concurrent distinct reports at the final daily slot rather than allowing each request to reserve it", async () => {
  const stamp = new Date().toISOString();
  for (let n = 0; n < 19; n++)
    await env.DB.prepare(
      "INSERT INTO content_reports(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES(?,'reporter','timeline',?,'abuse','',?)",
    )
      .bind(`old_${n}`, `old_subject_${n}`, stamp)
      .run();
  for (let n = 0; n < 8; n++) await story(`concurrent_${n}`);
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      report({ kind: "timeline", timeline_id: `concurrent_${n}` }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 429, 429, 429, 429, 429, 429, 429,
  ]);
  expect(await count("content_reports")).toBe(20);
});

it("rejects expired, blocked, private-target and unavailable raw grants without disclosing their subjects", async () => {
  await seedAsset();
  await story("private-target", "private");
  await story();
  const raw = await link();
  const expired = await link("expired-url", "url", "https://example.test");
  const privateLink = await link("private-link", "timeline", "story");
  await env.DB.prepare(
    "UPDATE timelines SET visibility='private' WHERE id='story'",
  ).run();
  await env.DB.prepare(
    "UPDATE distribution_links SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
  )
    .bind(expired)
    .run();
  expect((await moderate("asset", "a")).status).toBe(200);
  for (const slug of ["raw-media", "expired-url", "private-link"])
    expect((await report({ kind: "link", slug })).status).toBe(404);
  expect((await moderate("asset", "a", false)).status).toBe(200);
  expect((await moderate("link", raw)).status).toBe(200);
  expect((await report({ kind: "link", slug: "raw-media" })).status).toBe(404);
  expect(await count("content_reports")).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT target_kind,timeline_id FROM distribution_links WHERE id=?",
    )
      .bind(privateLink)
      .first(),
  ).toEqual({ target_kind: "timeline", timeline_id: "story" });
});

it("requires a bounded nonempty moderation reason and strict target identity without recording invalid attempts", async () => {
  await story();
  for (const reason of ["", "   ", "x".repeat(501), "\u0000"])
    expect(
      (
        await request(
          "/api/admin/content",
          "PUT",
          { target: { kind: "timeline", id: "story" }, blocked: true, reason },
          admin,
        )
      ).status,
    ).toBe(400);
  expect(await count("moderation_audit")).toBe(0);
  expect((await request("/t/story", "GET", undefined, "")).status).toBe(200);
});
