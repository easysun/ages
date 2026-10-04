import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { encodeCursor } from "../../src/assets/library";
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
        "SELECT target_kind,target_id,reporter_id,category,detail FROM report_events ORDER BY target_id",
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
    expect(await count("report_events")).toBe(0);
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
    expect(await count("report_events")).toBe(1);
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
      await env.DB.prepare("SELECT category,detail FROM report_events").first(),
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
    expect(await count("report_events")).toBe(20);
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
  it("preserves owner visibility and immutable audit identity with idempotent repeated moderation", async () => {
    await story();
    expect((await moderate("timeline", "story")).status).toBe(200);
    expect((await moderate("timeline", "story")).status).toBe(200);
    expect(await count("moderation_audit")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT visibility,version FROM timelines WHERE id='story'",
      ).first(),
    ).toEqual({ visibility: "unlisted", version: 2 });
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
  expect(await count("report_events")).toBe(0);
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
      "INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES(?,'reporter','timeline',?,'abuse','',?)",
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
  expect(await count("report_events")).toBe(20);
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
  expect(await count("report_events")).toBe(0);
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

async function seedReportBacklog() {
  const rows = Array.from({ length: 105 }, (_, n) => ({
    id: `report_${n}`,
    created_at: `2026-10-0${1 + (n % 3)}T00:00:00.000Z`,
  }));
  for (const row of rows)
    await env.DB.prepare(
      "INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES(?,'reporter','timeline',?,'abuse','',?)",
    )
      .bind(row.id, `subject_${row.id}`, row.created_at)
      .run();
  return rows.sort((a, b) =>
    a.created_at === b.created_at
      ? a.id < b.id
        ? 1
        : -1
      : a.created_at < b.created_at
        ? 1
        : -1,
  );
}

it("paginates an operator backlog beyond 100 using descending timestamp/id ties without repeats after a newer report arrives", async () => {
  const expected = await seedReportBacklog();
  const initial = await request("/api/admin/reports", "GET", undefined, admin);
  expect((await initial.json<{ reports: unknown[] }>()).reports).toHaveLength(
    30,
  );
  const response = await request(
    "/api/admin/reports?limit=100",
    "GET",
    undefined,
    admin,
  );
  expect(response.status).toBe(200);
  const first = await response.json<{
    reports: { id: string }[];
    next_cursor: string | null;
  }>();
  expect(first.reports).toHaveLength(100);
  expect(typeof first.next_cursor).toBe("string");
  await env.DB.prepare(
    "INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES('newer','reporter','timeline','newer','abuse','','2026-10-04T00:00:00.000Z')",
  ).run();
  const next = await request(
    `/api/admin/reports?cursor=${first.next_cursor}`,
    "GET",
    undefined,
    admin,
  );
  expect(next.status).toBe(200);
  const second = await next.json<{
    reports: { id: string }[];
    next_cursor: string | null;
  }>();
  expect(second.reports).toHaveLength(5);
  expect(second.next_cursor).toBeNull();
  const ids = [...first.reports, ...second.reports].map((row) => row.id);
  expect(ids).toEqual(expected.map((row) => row.id));
  expect(new Set(ids).size).toBe(105);
});

it("rejects malformed and foreign collection/operator cursors and checks the current admin role on every page", async () => {
  await seedReportBacklog();
  const first = await request(
    "/api/admin/reports?limit=1",
    "GET",
    undefined,
    admin,
  );
  const page = await first.json<{ next_cursor: string }>();
  expect(typeof page.next_cursor).toBe("string");
  const libraryCursor = encodeCursor({
    v: 1,
    owner: "operator",
    tag: null,
    created_at: "2026-10-01T00:00:00.000Z",
    id: "report_1",
  });
  for (const query of [
    "cursor=admin-reports.!!",
    `cursor=${libraryCursor}`,
    `cursor=links.${libraryCursor}`,
    `cursor=${page.next_cursor}&cursor=${page.next_cursor}`,
    "tag=abuse",
    "limit=100.0",
  ])
    expect(
      (await request(`/api/admin/reports?${query}`, "GET", undefined, admin))
        .status,
    ).toBe(400);
  const otherAdmin = await seedUser("other_operator");
  await env.DB.prepare(
    "UPDATE users SET plan='admin' WHERE id='other_operator'",
  ).run();
  expect(
    (
      await request(
        `/api/admin/reports?cursor=${page.next_cursor}`,
        "GET",
        undefined,
        otherAdmin,
      )
    ).status,
  ).toBe(400);
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    await env.DB.prepare(
      "UPDATE users SET plan='free' WHERE id='operator'",
    ).run();
    return batch(statements);
  });
  expect(
    (
      await request(
        `/api/admin/reports?cursor=${page.next_cursor}`,
        "GET",
        undefined,
        admin,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/api/admin/reports?cursor=${page.next_cursor}`,
        "GET",
        undefined,
        admin,
      )
    ).status,
  ).toBe(403);
});

it("reports changed Timeline snapshots immediately while deduplicating the same version for direct and Link subjects", async () => {
  await seedAsset();
  await story();
  const subjectLink = await link("story-link", "timeline", "story");
  const first = await report({ kind: "timeline", timeline_id: "story" });
  const firstId = (await first.json<{ report: { id: string } }>()).report.id;
  expect(
    (await report({ kind: "timeline", timeline_id: "story" })).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/api/timelines/story/items",
        "POST",
        { expected_version: 1, asset_id: "a", caption: "New story content" },
        owner,
      )
    ).status,
  ).toBe(201);
  const changed = await report({ kind: "timeline", timeline_id: "story" });
  expect(changed.status).toBe(201);
  expect((await changed.json<{ report: { id: string } }>()).report.id).not.toBe(
    firstId,
  );
  expect((await report({ kind: "link", slug: "story-link" })).status).toBe(201);
  expect(
    (
      await request(
        "/api/timelines/story",
        "PATCH",
        { expected_version: 2, title: "Edited story" },
        owner,
      )
    ).status,
  ).toBe(200);
  expect((await report({ kind: "link", slug: "story-link" })).status).toBe(201);
  const events = (
    await env.DB.prepare(
      "SELECT target_kind,target_id,observed_timeline_version FROM report_events ORDER BY created_at,id",
    ).all()
  ).results;
  expect(events).toHaveLength(4);
  expect(
    events
      .filter((event) => event.target_kind === "timeline")
      .map((event) => event.observed_timeline_version)
      .sort(),
  ).toEqual([1, 2]);
  expect(
    events
      .filter((event) => event.target_kind === "link")
      .map((event) => ({
        id: event.target_id,
        version: event.observed_timeline_version,
      }))
      .sort((a, b) => Number(a.version) - Number(b.version)),
  ).toEqual([
    { id: subjectLink, version: 2 },
    { id: subjectLink, version: 3 },
  ]);
});

it("allows a new report exactly 24 hours later while retaining both immutable-subject events", async () => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await link("url-link", "url", "https://example.test");
  await env.DB.prepare(
    "UPDATE sessions SET expires_at=? WHERE user_id='reporter'",
  )
    .bind(new Date(now + 25 * 60 * 60 * 1000).toISOString())
    .run();
  expect((await report({ kind: "link", slug: "url-link" })).status).toBe(201);
  vi.setSystemTime(now + 24 * 60 * 60 * 1000 - 1);
  expect((await report({ kind: "link", slug: "url-link" })).status).toBe(200);
  vi.setSystemTime(now + 24 * 60 * 60 * 1000);
  expect((await report({ kind: "link", slug: "url-link" })).status).toBe(201);
  expect(await count("report_events")).toBe(2);
  expect(
    (
      await env.DB.prepare(
        "SELECT observed_timeline_version FROM report_events",
      ).all()
    ).results,
  ).toEqual([
    { observed_timeline_version: null },
    { observed_timeline_version: null },
  ]);
});

it("captures the authoritative Timeline version inside the report transaction rather than a stale earlier lookup", async () => {
  await story();
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    expect(
      (
        await request(
          "/api/timelines/story",
          "PATCH",
          { expected_version: 1, title: "Changed before report transaction" },
          owner,
        )
      ).status,
    ).toBe(200);
    return batch(statements);
  });
  expect(
    (await report({ kind: "timeline", timeline_id: "story" })).status,
  ).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT observed_timeline_version FROM report_events",
    ).first("observed_timeline_version"),
  ).toBe(2);
});

it("invalidates stale owner mutations once per Timeline block transition and preserves the token on idempotent retries", async () => {
  await story();
  expect((await moderate("timeline", "story")).status).toBe(200);
  const blocked = await env.DB.prepare(
    "SELECT version,last_mutation_token FROM timelines WHERE id='story'",
  ).first<{ version: number; last_mutation_token: string }>();
  expect(blocked?.version).toBe(2);
  expect(blocked?.last_mutation_token).toBeTruthy();
  expect(
    (
      await request(
        "/api/timelines/story",
        "PATCH",
        { expected_version: 1, title: "Stale editor" },
        owner,
      )
    ).status,
  ).toBe(409);
  expect((await moderate("timeline", "story")).status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT version,last_mutation_token FROM timelines WHERE id='story'",
    ).first(),
  ).toEqual(blocked);
  expect((await moderate("timeline", "story", false)).status).toBe(200);
  const restored = await env.DB.prepare(
    "SELECT version,last_mutation_token FROM timelines WHERE id='story'",
  ).first<{ version: number; last_mutation_token: string }>();
  expect(restored?.version).toBe(3);
  expect(restored?.last_mutation_token).not.toBe(blocked?.last_mutation_token);
  expect(
    (
      await request(
        "/api/timelines/story",
        "PATCH",
        { expected_version: 2, title: "Another stale editor" },
        owner,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/timelines/story",
        "PATCH",
        { expected_version: 3, title: "Current editor" },
        owner,
      )
    ).status,
  ).toBe(200);
  expect(await count("moderation_audit")).toBe(2);
});

it("backfills every original report unchanged into canonical events and freezes the archive without guessing legacy observed versions", async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((migration) => migration.name < "0011"),
  );
  owner = await seedUser();
  reporter = await seedUser("reporter");
  await story();
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  for (let n = 0; n < 25; n++)
    await env.DB.prepare(
      "INSERT INTO content_reports(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES(?,'reporter','timeline',?,'copyright','Original detail',?)",
    )
      .bind(`legacy_${n}`, n === 0 ? "story" : `legacy_target_${n}`, stamp)
      .run();
  const before = (
    await env.DB.prepare("SELECT * FROM content_reports ORDER BY id").all()
  ).results;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(
    (await env.DB.prepare("SELECT * FROM report_events ORDER BY id").all())
      .results,
  ).toEqual(before.map((row) => ({ ...row, observed_timeline_version: null })));
  expect(
    (await env.DB.prepare("SELECT * FROM content_reports ORDER BY id").all())
      .results,
  ).toEqual(before);
  for (const sql of [
    "UPDATE content_reports SET detail='Changed'",
    "DELETE FROM content_reports",
    "INSERT INTO content_reports SELECT * FROM content_reports WHERE id='legacy_0'",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow(
      "legacy_reports_read_only",
    );
  for (const sql of [
    "UPDATE report_events SET detail='Changed'",
    "DELETE FROM report_events",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow(
      "immutable_report_event",
    );
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await count("report_events")).toBe(25);
  expect(
    (await report({ kind: "timeline", timeline_id: "story" })).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/api/timelines/story",
        "PATCH",
        { expected_version: 1, title: "Changed legacy story" },
        owner,
      )
    ).status,
  ).toBe(200);
  expect(
    (await report({ kind: "timeline", timeline_id: "story" })).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE sessions SET expires_at=? WHERE user_id='reporter'",
  )
    .bind(new Date(now + 25 * 60 * 60 * 1000).toISOString())
    .run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now + 24 * 60 * 60 * 1000);
  expect(
    (await report({ kind: "timeline", timeline_id: "story" })).status,
  ).toBe(201);
  expect(await count("report_events")).toBe(26);
  expect(
    await env.DB.prepare(
      "SELECT observed_timeline_version FROM report_events WHERE target_id='story' AND observed_timeline_version IS NOT NULL",
    ).first("observed_timeline_version"),
  ).toBe(2);
});
