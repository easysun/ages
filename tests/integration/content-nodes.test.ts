import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import { effectiveNode, publicNodePayload } from "../../src/graph/nodes";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
const policies = ["private", "unlisted", "public"] as const;
type Visibility = (typeof policies)[number];
type ApiNode = {
  id: string;
  owner_id?: string;
  kind: "timeline" | "external";
  visibility: Visibility;
  timeline_id: string | null;
  url: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  removed_at?: string | null;
  moderation_blocked?: number;
};

let owner: string;
let other: string;
let admin: string;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  owner = await seedUser();
  other = await seedUser("owner_b");
  admin = await seedUser("operator");
  await env.DB.prepare(
    "UPDATE users SET plan='admin' WHERE id='operator'",
  ).run();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = owner,
  site = origin,
) {
  return app.request(
    origin + path,
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

async function createTimeline(
  title = "Private story",
  visibility: Visibility = "private",
  cookie = owner,
) {
  const created = await request("/api/timelines", "POST", { title }, cookie);
  expect(created.status).toBe(201);
  const timeline = await created.json<{ timeline: { id: string } }>();
  if (visibility !== "private") {
    const changed = await request(
      `/api/timelines/${timeline.timeline.id}`,
      "PATCH",
      { expected_version: 1, visibility },
      cookie,
    );
    expect(changed.status).toBe(200);
  }
  return timeline.timeline.id;
}

async function createNode(input: unknown, cookie = owner) {
  const response = await request("/api/content-nodes", "POST", input, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ node: ApiNode }>()).node;
}

async function createExternal(
  url = "https://example.test/story",
  title: string | null = "External story",
  visibility?: Visibility,
  cookie = owner,
) {
  return createNode(
    {
      kind: "external",
      url,
      title,
      ...(visibility === undefined ? {} : { visibility }),
    },
    cookie,
  );
}

async function node(id: string, cookie = owner) {
  return request(
    `/api/content-nodes/${encodeURIComponent(id)}`,
    "GET",
    undefined,
    cookie,
  );
}

async function seedAsset(id: string) {
  const key = `synthetic/owner_a/${id}`;
  const stamp = new Date().toISOString();
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  await env.DB.prepare(
    "INSERT INTO assets (id, owner_id, kind, status, original_name, mime_type, size_bytes, r2_key, etag, upload_expires_at, created_at, updated_at) VALUES (?, 'owner_a', 'video', 'ready', 'synthetic.mp4', 'video/mp4', 10, ?, ?, ?, ?, ?)",
  )
    .bind(id, key, object.etag, stamp, stamp, stamp)
    .run();
  return key;
}

function moderateExistingContent(kind: string, id: string, blocked = true) {
  return request(
    "/api/admin/content",
    "PUT",
    { target: { kind, id }, blocked, reason: "Review completed." },
    admin,
  );
}

function moderateNode(
  id: string,
  blocked = true,
  cookie = admin,
  site = origin,
) {
  return request(
    `/api/admin/content-nodes/${encodeURIComponent(id)}`,
    "PATCH",
    { blocked, reason: "Review completed." },
    cookie,
    site,
  );
}

describe("effective Timeline node visibility", () => {
  it("effective_visibility_is_intersection", async () => {
    const rank: Record<Visibility, number> = {
      private: 0,
      unlisted: 1,
      public: 2,
    };
    for (const nodeVisibility of policies) {
      for (const timelineVisibility of policies) {
        const title = `story-${nodeVisibility}-${timelineVisibility}`;
        const timelineId = await createTimeline(title, timelineVisibility);
        const created = await createNode({
          kind: "timeline",
          timeline_id: timelineId,
          visibility: nodeVisibility,
        });
        expect(created.title).toBe(title);
        expect(
          await env.DB.prepare("SELECT title FROM content_nodes WHERE id=?")
            .bind(created.id)
            .first("title"),
        ).toBeNull();

        const expected =
          policies[Math.min(rank[nodeVisibility], rank[timelineVisibility])];
        const effectiveForOwner = await effectiveNode(
          env.DB,
          created.id,
          "owner_a",
        );
        expect(effectiveForOwner?.visibility).toBe(expected);
        expect(effectiveForOwner?.node.title).toBe(title);
        const nonOwnerView = await effectiveNode(env.DB, created.id, "owner_b");
        expect(nonOwnerView?.visibility ?? null).toBe(
          expected === "private" ? null : expected,
        );
        const anonymousView = await effectiveNode(env.DB, created.id, null);
        expect(anonymousView?.visibility ?? null).toBe(
          expected === "private" ? null : expected,
        );
      }
    }
  });

  it("uses external node visibility without a Timeline target", async () => {
    for (const visibility of policies) {
      const created = await createExternal(
        `https://example.test/${visibility}`,
        `External ${visibility}`,
        visibility,
      );
      const ownerView = await effectiveNode(env.DB, created.id, "owner_a");
      expect(ownerView?.visibility).toBe(visibility);
      const publicView = await effectiveNode(env.DB, created.id, null);
      expect(publicView?.visibility ?? null).toBe(
        visibility === "private" ? null : visibility,
      );
    }
  });

  it("moderation_hides_node_and_metadata", async () => {
    const external = await createExternal(
      "https://example.test/moderated",
      "Sensitive title",
      "public",
    );
    const before = await effectiveNode(env.DB, external.id, null);
    expect(before).not.toBeNull();
    expect((await moderateNode(external.id)).status).toBe(200);
    expect(await effectiveNode(env.DB, external.id, null)).toBeNull();
    expect(await effectiveNode(env.DB, external.id, "owner_a")).toBeNull();

    const timelineId = await createTimeline("Sensitive Timeline", "public");
    await seedAsset("cover");
    await seedAsset("member");
    let changed = await request(`/api/timelines/${timelineId}`, "PATCH", {
      expected_version: 2,
      cover_asset_id: "cover",
    });
    expect(changed.status).toBe(200);
    changed = await request(`/api/timelines/${timelineId}/items`, "POST", {
      expected_version: 3,
      asset_id: "member",
    });
    expect(changed.status).toBe(201);
    const timelineNode = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });

    expect((await moderateExistingContent("asset", "cover")).status).toBe(200);
    expect(await effectiveNode(env.DB, timelineNode.id, null)).toBeNull();
    expect(
      (await moderateExistingContent("asset", "cover", false)).status,
    ).toBe(200);
    expect((await moderateExistingContent("asset", "member")).status).toBe(200);
    expect(await effectiveNode(env.DB, timelineNode.id, null)).toBeNull();

    expect((await moderateNode(external.id, false)).status).toBe(200);
    expect((await effectiveNode(env.DB, external.id, null))?.visibility).toBe(
      "public",
    );
  });

  it("hides a node when its Timeline is moderated", async () => {
    const timelineId = await createTimeline("Story", "public");
    const created = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });
    expect((await moderateExistingContent("timeline", timelineId)).status).toBe(
      200,
    );
    expect(await effectiveNode(env.DB, created.id, null)).toBeNull();
  });
});

describe("owner ContentNode API", () => {
  it("owner detail reports effective visibility and unavailable targets", async () => {
    const timelineId = await createTimeline("Private source");
    const created = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });

    const detail = await node(created.id);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      node: { id: created.id, visibility: "public" },
      effective_visibility: "private",
    });

    await env.DB.prepare("UPDATE timelines SET moderation_blocked=1 WHERE id=?")
      .bind(timelineId)
      .run();
    const unavailable = await node(created.id);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({
      node: { id: created.id },
      effective_visibility: null,
    });
  });

  it("creates private nodes by default and never stores Timeline titles in node metadata", async () => {
    const timelineId = await createTimeline("Private original title");
    const timelineNode = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
    });
    expect(timelineNode.id).toMatch(/^cn_[0-9a-f-]{36}$/);
    expect(timelineNode).toMatchObject({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "private",
      title: "Private original title",
    });

    const external = await createExternal();
    expect(external).toMatchObject({ kind: "external", visibility: "private" });
  });

  it("foreign_timeline_creation_is_denied", async () => {
    const timelineId = await createTimeline("Owner-only story");
    const denied = await request(
      "/api/content-nodes",
      "POST",
      { kind: "timeline", timeline_id: timelineId, visibility: "public" },
      other,
    );
    expect(denied.status).toBe(404);

    const owned = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
    });
    expect((await node(owned.id, other)).status).toBe(404);
    expect(
      (
        await request(
          `/api/content-nodes/${owned.id}`,
          "PATCH",
          { visibility: "public" },
          other,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/content-nodes/${owned.id}`,
          "DELETE",
          undefined,
          other,
        )
      ).status,
    ).toBe(404);

    const foreignTimelineId = await createTimeline(
      "Other story",
      "private",
      other,
    );
    const stamp = new Date().toISOString();
    await expect(
      env.DB.prepare(
        "INSERT INTO content_nodes (id, owner_id, kind, visibility, timeline_id, url, title, created_at, updated_at) VALUES ('cn_bad', 'owner_a', 'timeline', 'private', ?, NULL, NULL, ?, ?)",
      )
        .bind(foreignTimelineId, stamp, stamp)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("requires authentication and same-origin writes", async () => {
    expect(
      (await request("/api/content-nodes", "GET", undefined, "")).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/api/content-nodes",
          "POST",
          { kind: "external", url: "https://example.test" },
          "",
          origin,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/api/content-nodes",
          "POST",
          { kind: "external", url: "https://example.test" },
          owner,
          "https://outside.test",
        )
      ).status,
    ).toBe(403);
  });

  it("same_url_different_owner_is_distinct and validates safe inputs", async () => {
    const url = "https://example.test/reused";
    const first = await createExternal(url, "Travel 旅行 🙂", "public");
    const second = await createExternal(url, "Travel 旅行 🙂", "public", other);
    const duplicate = await createExternal(
      url,
      "Another reference",
      "unlisted",
    );
    expect(second.id).not.toBe(first.id);
    expect(duplicate.id).not.toBe(first.id);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM content_nodes WHERE url=?",
      )
        .bind(url)
        .first("n"),
    ).toBe(3);

    for (const title of [
      "bad\u0000title",
      "bad\u001ftitle",
      "bad\u007ftitle",
      "😀".repeat(101),
    ]) {
      const invalidTitle = await request("/api/content-nodes", "POST", {
        kind: "external",
        url,
        title,
      });
      expect(invalidTitle.status, JSON.stringify(title)).toBe(400);
    }
    for (const badUrl of [
      "javascript:alert(1)",
      "https://user:pass@example.test",
      `https://example.test/${"x".repeat(4100)}`,
    ]) {
      expect(
        (
          await request("/api/content-nodes", "POST", {
            kind: "external",
            url: badUrl,
          })
        ).status,
      ).toBe(400);
    }
    const unicodeTitle = "😀".repeat(100);
    expect(
      (await createExternal("https://example.test/utf16", unicodeTitle)).title,
    ).toBe(unicodeTitle);
  });

  it("updates only permitted metadata and keeps target identity immutable", async () => {
    const original = await createExternal(
      "https://example.test/original",
      "Before",
      "private",
    );
    const changed = await request(
      `/api/content-nodes/${original.id}`,
      "PATCH",
      { title: "旅行", visibility: "unlisted" },
    );
    expect(changed.status).toBe(200);
    expect((await changed.json<{ node: ApiNode }>()).node).toMatchObject({
      id: original.id,
      kind: "external",
      visibility: "unlisted",
      url: "https://example.test/original",
      title: "旅行",
    });
    expect(
      (
        await request(`/api/content-nodes/${original.id}`, "PATCH", {
          url: "https://example.test/changed",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/content-nodes/${original.id}`, "PATCH", {
          kind: "timeline",
        })
      ).status,
    ).toBe(400);
  });

  it("removes nodes reversibly and keeps removed nodes hidden until an explicit restore", async () => {
    const timelineId = await createTimeline("Durable Timeline", "public");
    const assetKey = await seedAsset("durable-cover");
    const covered = await request(`/api/timelines/${timelineId}`, "PATCH", {
      expected_version: 2,
      cover_asset_id: "durable-cover",
    });
    expect(covered.status).toBe(200);
    const linkResponse = await request("/api/links", "POST", {
      target: { kind: "timeline", timeline_id: timelineId },
    });
    expect(linkResponse.status).toBe(201);
    const link = (
      await linkResponse.json<{ link: { id: string; slug: string } }>()
    ).link;
    const created = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });
    const deleted = await request(`/api/content-nodes/${created.id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect((await node(created.id)).status).toBe(404);
    expect(await effectiveNode(env.DB, created.id, null)).toBeNull();
    const live = await request("/api/content-nodes");
    expect(
      (await live.json<{ nodes: ApiNode[] }>()).nodes.map((row) => row.id),
    ).not.toContain(created.id);

    const removed = await request("/api/content-nodes?removed=true");
    expect(removed.status).toBe(200);
    expect(
      (await removed.json<{ nodes: ApiNode[] }>()).nodes.map((row) => row.id),
    ).toContain(created.id);
    const otherRemoved = await request(
      "/api/content-nodes?removed=true",
      "GET",
      undefined,
      other,
    );
    expect(otherRemoved.status).toBe(200);
    expect(
      (await otherRemoved.json<{ nodes: ApiNode[] }>()).nodes,
    ).toHaveLength(0);
    expect(
      (await request("/api/content-nodes?removed=true", "GET", undefined, ""))
        .status,
    ).toBe(401);

    const preserved = await env.DB.batch([
      env.DB.prepare("SELECT id FROM timelines WHERE id=?").bind(timelineId),
      env.DB.prepare("SELECT id FROM assets WHERE id=?").bind("durable-cover"),
      env.DB.prepare("SELECT id FROM distribution_links WHERE id=?").bind(
        link.id,
      ),
    ]);
    expect(preserved.map((result) => result.results)).toEqual([
      [{ id: timelineId }],
      [{ id: "durable-cover" }],
      [{ id: link.id }],
    ]);
    expect(await env.MEDIA.head(assetKey)).not.toBeNull();
    expect((await request(`/s/${link.slug}`)).status).toBe(302);
    const restored = await request(
      `/api/content-nodes/${created.id}`,
      "PATCH",
      { removed: false },
    );
    expect(restored.status).toBe(200);
    expect((await node(created.id)).status).toBe(200);
  });

  it("rejects duplicate live Timeline nodes and conflicting restoration without changing either row", async () => {
    const timelineId = await createTimeline("One stable reference", "public");
    const original = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });
    expect(
      (
        await request("/api/content-nodes", "POST", {
          kind: "timeline",
          timeline_id: timelineId,
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(`/api/content-nodes/${original.id}`, "DELETE")).status,
    ).toBe(200);
    const replacement = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "unlisted",
    });

    const conflict = await request(
      `/api/content-nodes/${original.id}`,
      "PATCH",
      { removed: false },
    );
    expect(conflict.status).toBe(409);
    const rows = await env.DB.prepare(
      "SELECT id, removed_at, visibility FROM content_nodes WHERE id IN (?, ?) ORDER BY id",
    )
      .bind(original.id, replacement.id)
      .all();
    expect(rows.results).toContainEqual({
      id: original.id,
      removed_at: expect.any(String),
      visibility: "public",
    });
    expect(rows.results).toContainEqual({
      id: replacement.id,
      removed_at: null,
      visibility: "unlisted",
    });
  });

  it("isolates live and removed keyset cursor namespaces and owner scope", async () => {
    const liveOne = await createExternal(
      "https://example.test/live-one",
      "Live one",
      "public",
    );
    const liveTwo = await createExternal(
      "https://example.test/live-two",
      "Live two",
      "public",
    );
    const removedOne = await createExternal(
      "https://example.test/removed-one",
      "Removed one",
      "public",
    );
    const removedTwo = await createExternal(
      "https://example.test/removed-two",
      "Removed two",
      "public",
    );
    await request(`/api/content-nodes/${removedOne.id}`, "DELETE");
    await request(`/api/content-nodes/${removedTwo.id}`, "DELETE");

    const liveFirst = await (await request("/api/content-nodes?limit=1")).json<{
      nodes: ApiNode[];
      next_cursor: string | null;
    }>();
    const removedFirst = await (
      await request("/api/content-nodes?removed=true&limit=1")
    ).json<{
      nodes: ApiNode[];
      next_cursor: string | null;
    }>();
    expect(liveFirst.nodes).toHaveLength(1);
    expect(removedFirst.nodes).toHaveLength(1);
    expect(liveFirst.next_cursor).toMatch(/^nodes\./);
    expect(removedFirst.next_cursor).toMatch(/^removed-nodes\./);
    expect(
      (
        await request(
          "/api/content-nodes?removed=true&limit=1&cursor=" +
            encodeURIComponent(liveFirst.next_cursor ?? ""),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/api/content-nodes?limit=1&cursor=" +
            encodeURIComponent(removedFirst.next_cursor ?? ""),
        )
      ).status,
    ).toBe(400);
    expect((await request("/api/content-nodes?cursor=nodes.!")).status).toBe(
      400,
    );
    expect((await request("/api/content-nodes?limit=101")).status).toBe(400);

    const ownerCursor = liveFirst.next_cursor;
    if (ownerCursor) {
      expect(
        (
          await request(
            `/api/content-nodes?cursor=${encodeURIComponent(ownerCursor)}`,
            "GET",
            undefined,
            other,
          )
        ).status,
      ).toBe(400);
    }
    expect(liveOne.id).not.toBe(liveTwo.id);
    const liveNext = await (
      await request(
        "/api/content-nodes?limit=1&cursor=" +
          encodeURIComponent(liveFirst.next_cursor ?? ""),
      )
    ).json<{ nodes: ApiNode[] }>();
    expect(new Set([liveFirst.nodes[0]?.id, liveNext.nodes[0]?.id])).toEqual(
      new Set([liveOne.id, liveTwo.id]),
    );
    const removedNextResponse = await request(
      "/api/content-nodes?removed=true&limit=1&cursor=" +
        encodeURIComponent(removedFirst.next_cursor ?? ""),
    );
    expect(removedNextResponse.status).toBe(200);
    const removedNext = await removedNextResponse.json<{ nodes: ApiNode[] }>();
    expect(
      new Set([removedFirst.nodes[0]?.id, removedNext.nodes[0]?.id]),
    ).toEqual(new Set([removedOne.id, removedTwo.id]));
  });

  it("uses a 30 item default page and returns all 31 external nodes over keyset pages", async () => {
    for (let index = 0; index < 31; index += 1) {
      await createExternal(
        `https://example.test/page/${index}`,
        `Page ${index}`,
        "public",
      );
    }
    const first = await (await request("/api/content-nodes")).json<{
      nodes: ApiNode[];
      next_cursor: string | null;
    }>();
    expect(first.nodes).toHaveLength(30);
    expect(first.next_cursor).toMatch(/^nodes\./);
    const next = await request(
      "/api/content-nodes?limit=100&cursor=" +
        encodeURIComponent(first.next_cursor ?? ""),
    );
    expect(next.status).toBe(200);
    const second = await next.json<{ nodes: ApiNode[]; next_cursor: null }>();
    expect(second.nodes).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(
      new Set([...first.nodes, ...second.nodes].map((row) => row.id)).size,
    ).toBe(31);
  });

  it("keeps a ContentNode when its Timeline Link expires", async () => {
    const timelineId = await createTimeline("Linked story", "public");
    const contentNode = await createNode({
      kind: "timeline",
      timeline_id: timelineId,
      visibility: "public",
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const link = await request("/api/links", "POST", {
      target: { kind: "timeline", timeline_id: timelineId },
      expires_at: expiresAt,
    });
    expect(link.status).toBe(201);
    const linkId = (await link.json<{ link: { id: string } }>()).link.id;
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at=? WHERE id=?",
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), linkId)
      .run();
    expect((await node(contentNode.id)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM content_nodes WHERE id=?")
        .bind(contentNode.id)
        .first(),
    ).toEqual({ id: contentNode.id });
  });

  it("publicNodePayload omits ownership, removal, and moderation fields", async () => {
    const created = await createExternal(
      "https://example.test/public-payload",
      "Visible 旅行",
      "public",
    );
    const result = await effectiveNode(env.DB, created.id, null);
    if (result === null) throw new Error("Expected public node availability.");
    const payload = publicNodePayload(result.node);
    expect(payload).toMatchObject({
      id: created.id,
      kind: "external",
      visibility: "public",
      url: "https://example.test/public-payload",
      title: "Visible 旅行",
    });
    expect(payload).not.toHaveProperty("owner_id");
    expect(payload).not.toHaveProperty("moderation_blocked");
    expect(payload).not.toHaveProperty("removed_at");
    expect(JSON.stringify(payload)).not.toContain("owner_a@example.test");
    expect(JSON.stringify(payload)).not.toMatch(/r2_key|storage_key|email/i);
  });

  it("rejects unknown and invalid list query parameters", async () => {
    for (const query of [
      "?unknown=1",
      "?removed=false",
      "?removed=true&removed=true",
      "?limit=0",
      "?limit=100.1",
      "?cursor=foreign",
    ]) {
      expect((await request(`/api/content-nodes${query}`)).status).toBe(400);
    }
  });
});

describe("ContentNode moderation", () => {
  it("requires current admin role, authentication, and same-origin for moderation", async () => {
    const created = await createExternal(
      "https://example.test/admin",
      "Admin target",
      "public",
    );
    expect((await moderateNode(created.id, true, "")).status).toBe(401);
    expect((await moderateNode(created.id, true, owner)).status).toBe(403);
    expect(
      (await moderateNode(created.id, true, admin, "https://outside.test"))
        .status,
    ).toBe(403);

    const response = await request(`/api/admin/content-nodes/${created.id}`);
    expect(response.status).toBe(403);
    expect(
      (
        await request(
          `/api/admin/content-nodes/${created.id}`,
          "GET",
          undefined,
          admin,
        )
      ).status,
    ).toBe(200);
  });

  it("records reasoned state transitions once, supports retry, and keeps an immutable audit", async () => {
    const created = await createExternal(
      "https://example.test/audit",
      "Audit target",
      "public",
    );
    const initial = await request(
      `/api/admin/content-nodes/${created.id}`,
      "GET",
      undefined,
      admin,
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      moderation: { blocked: false },
    });

    const first = await moderateNode(created.id, true);
    expect(first.status).toBe(200);
    const current = await request(
      `/api/admin/content-nodes/${created.id}`,
      "GET",
      undefined,
      admin,
    );
    expect(await current.json()).toMatchObject({
      moderation: { blocked: true },
    });
    expect((await moderateNode(created.id, true)).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM content_node_moderation_events WHERE node_id=?",
      )
        .bind(created.id)
        .first("n"),
    ).toBe(1);
    expect(await effectiveNode(env.DB, created.id, null)).toBeNull();

    expect((await moderateNode(created.id, false)).status).toBe(200);
    const restored = await request(
      `/api/admin/content-nodes/${created.id}`,
      "GET",
      undefined,
      admin,
    );
    expect(await restored.json()).toMatchObject({
      moderation: { blocked: false },
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM content_node_moderation_events WHERE node_id=?",
      )
        .bind(created.id)
        .first("n"),
    ).toBe(2);
    await expect(
      env.DB.prepare(
        "UPDATE content_node_moderation_events SET reason='rewritten' WHERE node_id=?",
      )
        .bind(created.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare(
        "DELETE FROM content_node_moderation_events WHERE node_id=?",
      )
        .bind(created.id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("does not mutate moderation when the operator role is revoked before the batch", async () => {
    const created = await createExternal(
      "https://example.test/role-revoked",
      "Role target",
      "public",
    );
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(
        "UPDATE users SET plan='free' WHERE id='operator'",
      ).run();
      return batch(statements);
    });
    expect((await moderateNode(created.id)).status).toBe(403);
    expect((await effectiveNode(env.DB, created.id, null))?.visibility).toBe(
      "public",
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM content_node_moderation_events WHERE node_id=?",
      )
        .bind(created.id)
        .first("n"),
    ).toBe(0);
  });

  it("rejects malformed moderation reasons without appending an event", async () => {
    const created = await createExternal(
      "https://example.test/invalid-reason",
      "Reason target",
      "public",
    );
    for (const reason of ["", "   ", "x".repeat(501), "\u0000"]) {
      expect(
        (
          await request(
            `/api/admin/content-nodes/${created.id}`,
            "PATCH",
            { blocked: true, reason },
            admin,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM content_node_moderation_events WHERE node_id=?",
      )
        .bind(created.id)
        .first("n"),
    ).toBe(0);
  });
});
