import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { hashToken } from "../../src/auth/crypto";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let owner: string;
let other: string;
let admin: string;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  owner = await seedUser("owner_a");
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
  extraHeaders: Record<string, string> = {},
  requestBindings: Bindings = bindings,
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: site,
        "CF-Connecting-IP": "203.0.113.81",
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    requestBindings,
  );
}

function countPreparedStatements(db: D1Database) {
  let count = 0;
  const countedDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          count += 1;
          return target.prepare(query);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: countedDb, count: () => count };
}

async function seedIncomingEdges(
  targetId: string,
  candidates: {
    sourceId: string;
    visibility: "private" | "unlisted" | "public";
    createdAt: string;
  }[],
) {
  const statements = candidates.flatMap(
    ({ sourceId, visibility, createdAt }) => [
      env.DB.prepare(`INSERT INTO content_nodes
      (id,owner_id,kind,visibility,timeline_id,url,title,created_at,updated_at)
      VALUES (?,?,'external',?,NULL,?,?,?,?)`).bind(
        sourceId,
        "owner_a",
        visibility,
        `https://example.test/${sourceId}`,
        sourceId,
        createdAt,
        createdAt,
      ),
      env.DB.prepare(`INSERT INTO content_edges
      (id,source_id,target_id,type,creator_id,created_at)
      VALUES (?,?,?,'references',?,?)`).bind(
        `ce_${sourceId}`,
        sourceId,
        targetId,
        "owner_a",
        createdAt,
      ),
    ],
  );
  await env.DB.batch(statements);
}

async function createExternal(
  title: string,
  visibility: "private" | "unlisted" | "public",
  cookie = owner,
) {
  const response = await request(
    "/api/content-nodes",
    "POST",
    {
      kind: "external",
      url: `https://example.test/${crypto.randomUUID()}`,
      title,
      visibility,
    },
    cookie,
  );
  expect(response.status).toBe(201);
  return (
    await response.json<{
      node: { id: string; title: string; visibility: string };
    }>()
  ).node;
}

async function createTimeline(title: string, cookie = owner) {
  const response = await request("/api/timelines", "POST", { title }, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ timeline: { id: string } }>()).timeline.id;
}

async function makeTimelinePublic(id: string, cookie = owner) {
  const response = await request(
    `/api/timelines/${encodeURIComponent(id)}`,
    "PATCH",
    { expected_version: 1, visibility: "public" },
    cookie,
  );
  expect(response.status).toBe(200);
}

async function createTimelineNode(id: string, cookie = owner) {
  const response = await request(
    "/api/content-nodes",
    "POST",
    { kind: "timeline", timeline_id: id, visibility: "public" },
    cookie,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ node: { id: string; title: string } }>()).node;
}

async function seedStoryAsset(id: string) {
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
}

async function addStoryMember(timelineId: string, assetId: string) {
  const response = await request(
    `/api/timelines/${encodeURIComponent(timelineId)}/items`,
    "POST",
    {
      expected_version: 2,
      asset_id: assetId,
      caption: "A protected story member",
    },
  );
  expect(response.status).toBe(201);
}

async function createEdge(
  sourceId: string,
  targetId: string,
  cookie = owner,
  type = "references",
) {
  return request(
    "/api/content-edges",
    "POST",
    { source_id: sourceId, target_id: targetId, type },
    cookie,
  );
}

function edgeAction(id: string, action: string, cookie = owner) {
  return request(
    `/api/content-edges/${encodeURIComponent(id)}`,
    "PATCH",
    { action },
    cookie,
  );
}

function adminEdgeState(
  id: string,
  blocked: boolean,
  cookie = admin,
  site = origin,
) {
  return request(
    `/api/admin/content-edges/${encodeURIComponent(id)}`,
    "PATCH",
    { blocked, reason: "Review completed." },
    cookie,
    site,
  );
}

function edgeList(
  nodeId: string,
  direction: "incoming" | "outgoing",
  query = "",
  cookie = "",
) {
  const separator = query ? "&" : "?";
  return request(
    `/api/content-nodes/${encodeURIComponent(nodeId)}/edges?direction=${direction}${query ? `${separator}${query}` : ""}`,
    "GET",
    undefined,
    cookie,
  );
}

async function expectEdgeList(
  nodeId: string,
  direction: "incoming" | "outgoing",
  expected: Record<string, unknown>,
  query = "",
  cookie = "",
) {
  const response = await edgeList(nodeId, direction, query, cookie);
  expect(response.status).toBe(200);
  expect(await response.json<Record<string, unknown>>()).toMatchObject(
    expected,
  );
}

function reportEdge(id: string, body: unknown, cookie = owner, site = origin) {
  return request(
    `/api/content-edges/${encodeURIComponent(id)}/reports`,
    "POST",
    body,
    cookie,
    site,
  );
}

async function edgeBetween(sourceId: string, targetId: string, cookie = owner) {
  const response = await createEdge(sourceId, targetId, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ edge: { id: string } }>()).edge.id;
}

async function count(
  table:
    | "content_edges"
    | "content_edge_reports"
    | "content_edge_moderation_events"
    | "report_events",
) {
  return env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>(
    "n",
  );
}

describe("directed ContentEdges", () => {
  it("public_foreign_edge_is_immediate_not_reciprocal", async () => {
    const source = await createExternal("Source story", "public");
    const target = await createExternal("Target story", "public", other);
    const created = await createEdge(source.id, target.id, owner, "related_to");
    expect(created.status).toBe(201);
    const edge = (await created.json<{ edge: { id: string } }>()).edge;

    const incoming = await edgeList(target.id, "incoming");
    expect(incoming.status).toBe(200);
    expect(incoming.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await incoming.text();
    expect(JSON.parse(payload)).toMatchObject({
      edges: [
        {
          id: edge.id,
          type: "related_to",
          source: { id: source.id, title: "Source story" },
          target: { id: target.id, title: "Target story" },
          attribution: "added by source owner",
        },
      ],
      next_cursor: null,
    });
    const reverse = await edgeList(source.id, "incoming");
    expect((await reverse.json<{ edges: unknown[] }>()).edges).toHaveLength(0);
    expect(await count("content_edges")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT source_id,target_id FROM content_edges WHERE id=?",
      )
        .bind(edge.id)
        .first(),
    ).toEqual({ source_id: source.id, target_id: target.id });
    expect(payload).not.toContain("owner_a@example.test");
    expect(payload).not.toContain("owner_b@example.test");
    expect(payload).not.toContain("creator_id");
  });

  it("unlisted_edge_requires_target_acceptance_and_known_endpoints", async () => {
    const source = await createExternal("Unlisted source", "unlisted");
    const target = await createExternal("Public target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);

    await expectEdgeList(target.id, "incoming", { edges: [] });
    const pending = await request(
      `/api/content-nodes/${encodeURIComponent(target.id)}/incoming-review`,
      "GET",
      undefined,
      other,
    );
    expect(pending.status).toBe(200);
    expect(pending.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await pending.json()).toMatchObject({
      edges: [
        {
          id: edgeId,
          source: { id: source.id, title: "Unlisted source" },
          attribution: "added by source owner",
        },
      ],
    });

    const pairBeforeAcceptance = await edgeList(
      target.id,
      "incoming",
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    expect(
      (await pairBeforeAcceptance.json<{ edges: unknown[] }>()).edges,
    ).toHaveLength(0);
    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    const pairAfterAcceptance = await edgeList(
      target.id,
      "incoming",
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    expect(pairAfterAcceptance.status).toBe(200);
    expect(pairAfterAcceptance.headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
    expect(
      (await pairAfterAcceptance.json<{ edges: unknown[] }>()).edges,
    ).toHaveLength(1);
    await expectEdgeList(target.id, "incoming", { edges: [] });
  });

  it("target_owner_cannot_preaccept_a_public_edge_before_it_becomes_unlisted", async () => {
    const source = await createExternal("Public source", "public");
    const target = await createExternal("Public target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);

    expect((await edgeAction(edgeId, "accept", other)).status).toBe(409);
    const beforeTransition = await env.DB.prepare(
      "SELECT accepted_at FROM content_edges WHERE id=?",
    )
      .bind(edgeId)
      .first<{ accepted_at: string | null }>();
    expect(beforeTransition?.accepted_at).toBeNull();

    expect(
      (
        await request(
          `/api/content-nodes/${encodeURIComponent(source.id)}`,
          "PATCH",
          { visibility: "unlisted" },
          owner,
        )
      ).status,
    ).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );

    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    const afterAcceptance = await env.DB.prepare(
      "SELECT accepted_at FROM content_edges WHERE id=?",
    )
      .bind(edgeId)
      .first<{ accepted_at: string | null }>();
    expect(afterAcceptance?.accepted_at).not.toBeNull();
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [{ id: edgeId }] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
  });

  it("private_cross_owner_edge_is_rejected", async () => {
    const source = await createExternal("Public source", "public");
    const target = await createExternal("Private target", "private", other);
    const response = await createEdge(source.id, target.id);
    expect(response.status).toBe(404);
    const privateSource = await createExternal("Private source", "private");
    const publicTarget = await createExternal("Public target", "public", other);
    expect((await createEdge(privateSource.id, publicTarget.id)).status).toBe(
      404,
    );
    expect(await count("content_edges")).toBe(0);
  });

  it("visibility_change_hides_existing_edge_and_requires_fresh_unlisted_acceptance", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    await expectEdgeList(target.id, "incoming", { edges: [{ id: edgeId }] });

    const changed = await request(
      `/api/content-nodes/${encodeURIComponent(source.id)}`,
      "PATCH",
      { visibility: "unlisted" },
    );
    expect(changed.status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );

    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [{ id: edgeId }] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    const privateSource = await request(
      `/api/content-nodes/${encodeURIComponent(source.id)}`,
      "PATCH",
      { visibility: "private" },
    );
    expect(privateSource.status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
  });

  it("target_visibility_change_hides_existing_edge_and_requires_fresh_acceptance", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    const changed = await request(
      `/api/content-nodes/${encodeURIComponent(target.id)}`,
      "PATCH",
      { visibility: "unlisted" },
      other,
    );
    expect(changed.status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );

    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [{ id: edgeId }] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    const privateTarget = await request(
      `/api/content-nodes/${encodeURIComponent(target.id)}`,
      "PATCH",
      { visibility: "private" },
      other,
    );
    expect(privateTarget.status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    await expectEdgeList(
      source.id,
      "outgoing",
      { edges: [] },
      `known_node=${encodeURIComponent(target.id)}`,
      owner,
    );
  });

  it("suppression_survives_visibility_changes", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await edgeAction(edgeId, "suppress", other)).status).toBe(200);
    for (const [nodeId, cookie] of [
      [source.id, owner],
      [target.id, other],
    ] as const) {
      const changed = await request(
        `/api/content-nodes/${encodeURIComponent(nodeId)}`,
        "PATCH",
        { visibility: "unlisted" },
        cookie,
      );
      expect(changed.status).toBe(200);
    }
    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
    expect((await edgeAction(edgeId, "unsuppress", other)).status).toBe(200);
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [{ id: edgeId }] },
      `known_node=${encodeURIComponent(source.id)}`,
      other,
    );
  });

  it("target_owner_and_admin_blocks_are_independent", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await edgeAction(edgeId, "block", other)).status).toBe(200);
    expect((await adminEdgeState(edgeId, true)).status).toBe(200);
    expect((await edgeAction(edgeId, "unblock", other)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });

    expect((await edgeAction(edgeId, "block", other)).status).toBe(200);
    expect((await adminEdgeState(edgeId, false)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    expect((await edgeAction(edgeId, "unblock", other)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [{ id: edgeId }] });
  });

  it("suppression_cannot_clear_either_block", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await edgeAction(edgeId, "block", other)).status).toBe(200);
    expect((await adminEdgeState(edgeId, true)).status).toBe(200);
    expect((await edgeAction(edgeId, "suppress", other)).status).toBe(200);
    expect((await edgeAction(edgeId, "unsuppress", other)).status).toBe(200);
    expect((await edgeAction(edgeId, "unblock", other)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    expect((await edgeAction(edgeId, "block", other)).status).toBe(200);
    expect((await adminEdgeState(edgeId, false)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    expect((await edgeAction(edgeId, "unblock", other)).status).toBe(200);
    await expectEdgeList(target.id, "incoming", { edges: [{ id: edgeId }] });
  });

  it("admin_block_changes_append_audit_event", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await adminEdgeState(edgeId, true)).status).toBe(200);
    expect((await adminEdgeState(edgeId, true)).status).toBe(200);
    expect((await adminEdgeState(edgeId, false)).status).toBe(200);
    expect(await count("content_edge_moderation_events")).toBe(2);
    const events = (
      await env.DB.prepare(
        "SELECT moderator_id,edge_id,previous_blocked,blocked,reason,created_at FROM content_edge_moderation_events ORDER BY created_at,id",
      ).all()
    ).results;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      moderator_id: "operator",
      edge_id: edgeId,
      previous_blocked: 0,
      blocked: 1,
      reason: "Review completed.",
    });
    expect(events[1]).toMatchObject({
      moderator_id: "operator",
      edge_id: edgeId,
      previous_blocked: 1,
      blocked: 0,
      reason: "Review completed.",
    });
    for (const sql of [
      "UPDATE content_edge_moderation_events SET reason='Changed'",
      "DELETE FROM content_edge_moderation_events",
    ])
      expect(env.DB.prepare(sql).run()).rejects.toThrow();
    expect((await adminEdgeState(edgeId, true, owner)).status).toBe(403);
    expect(
      (await adminEdgeState(edgeId, true, admin, "https://foreign.test"))
        .status,
    ).toBe(403);
  });

  it("foreign_source_write_fails", async () => {
    const source = await createExternal("Foreign source", "public", other);
    const target = await createExternal("Owned target", "public");
    expect((await createEdge(source.id, target.id, owner)).status).toBe(404);
    expect(await count("content_edges")).toBe(0);
  });

  it("blocked_story_member_hides_backlink", async () => {
    const timelineId = await createTimeline("Public story");
    await makeTimelinePublic(timelineId);
    await seedStoryAsset("story-member");
    await addStoryMember(timelineId, "story-member");
    const source = await createTimelineNode(timelineId);
    const target = await createExternal("Public target", "public", other);
    await edgeBetween(source.id, target.id);
    await expectEdgeList(target.id, "incoming", {
      edges: [{ source: { id: source.id } }],
    });
    await env.DB.prepare(
      "UPDATE assets SET moderation_blocked=1 WHERE id='story-member'",
    ).run();
    await expectEdgeList(target.id, "incoming", { edges: [] });
  });

  it("rejects_self_duplicates_and_foreign_target_controls_without_removing_nodes", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    expect((await createEdge(source.id, source.id)).status).toBe(400);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await createEdge(source.id, target.id)).status).toBe(409);
    expect((await edgeAction(edgeId, "suppress", owner)).status).toBe(404);
    expect(
      (
        await request(
          `/api/content-edges/${edgeId}`,
          "DELETE",
          undefined,
          other,
        )
      ).status,
    ).toBe(404);
    const removed = await request(`/api/content-edges/${edgeId}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await count("content_edges")).toBe(1);
    expect(
      (
        await request(
          `/api/content-nodes/${source.id}`,
          "GET",
          undefined,
          owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/content-nodes/${target.id}`,
          "GET",
          undefined,
          other,
        )
      ).status,
    ).toBe(200);
    expect((await createEdge(source.id, target.id)).status).toBe(201);
  });
});

describe("edge listing and owner review", () => {
  it("keeps anonymous reads no-store on success and errors while preserving node authentication", async () => {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    await edgeBetween(source.id, target.id);
    for (const path of [
      `/api/content-nodes/${target.id}/edges?direction=invalid`,
      `/api/content-nodes/${target.id}/edges?direction=incoming&unknown=x`,
      `/api/content-nodes/${target.id}/edges?direction=incoming&direction=outgoing`,
    ]) {
      const response = await request(path, "GET", undefined, "");
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(
      (await request("/api/content-nodes", "GET", undefined, "")).status,
    ).toBe(401);
    expect(
      (await request(`/api/content-nodes/${source.id}`, "GET", undefined, ""))
        .status,
    ).toBe(401);
  });

  it("validates edge pagination and binds opaque cursors to viewer_node_direction_and_known_node", async () => {
    const sourceA = await createExternal("Source A", "public");
    const sourceB = await createExternal("Source B", "public");
    const target = await createExternal("Target", "public", other);
    await edgeBetween(sourceA.id, target.id);
    await edgeBetween(sourceB.id, target.id);
    const first = await edgeList(target.id, "incoming", "limit=1");
    expect(first.status).toBe(200);
    const page = await first.json<{
      edges: unknown[];
      next_cursor: string | null;
    }>();
    expect(page.edges).toHaveLength(1);
    expect(page.next_cursor).toMatch(/^edges\./);
    const second = await edgeList(
      target.id,
      "incoming",
      `limit=1&cursor=${encodeURIComponent(page.next_cursor ?? "")}`,
    );
    expect((await second.json<{ edges: unknown[] }>()).edges).toHaveLength(1);
    const cursor = encodeURIComponent(page.next_cursor ?? "");
    const invalidCursors: [string, string][] = [
      [
        `/api/content-nodes/${target.id}/edges?direction=outgoing&limit=1&cursor=${cursor}`,
        "",
      ],
      [
        `/api/content-nodes/${sourceA.id}/edges?direction=incoming&limit=1&cursor=${cursor}`,
        "",
      ],
      [
        `/api/content-nodes/${target.id}/edges?direction=incoming&known_node=${sourceA.id}&limit=1&cursor=${cursor}`,
        "",
      ],
      [
        `/api/content-nodes/${target.id}/edges?direction=incoming&limit=1&cursor=${cursor}`,
        owner,
      ],
    ];
    for (const [path, cookie] of invalidCursors)
      expect((await request(path, "GET", undefined, cookie)).status).toBe(400);
    for (const query of [
      "limit=101",
      "limit=0",
      "limit=1&limit=2",
      "cursor=edges.invalid",
      "unknown=x",
    ])
      expect((await edgeList(target.id, "incoming", query)).status).toBe(400);
  });

  it("does_not_return_a_cursor_for_hidden_rows_after_the_last_visible_edge", async () => {
    const visibleSource = await createExternal("Visible source", "public");
    const hiddenSource = await createExternal(
      "Hidden unlisted source",
      "unlisted",
    );
    const target = await createExternal("Public target", "public", other);
    await edgeBetween(visibleSource.id, target.id);
    const hidden = await createEdge(hiddenSource.id, target.id);
    expect(hidden.status).toBe(201);
    await env.DB.prepare(
      "UPDATE content_edges SET created_at='2099-01-01T00:00:00.000Z' WHERE source_id=? AND target_id=?",
    )
      .bind(hiddenSource.id, target.id)
      .run();
    const response = await edgeList(target.id, "incoming", "limit=1");
    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(JSON.parse(payload)).toMatchObject({
      edges: [{ source: { id: visibleSource.id } }],
      next_cursor: null,
    });
    expect(payload).not.toContain(hiddenSource.id);
  });

  it("filters_many_hidden_candidates_before_bounded_edge_pages_and_exact_pairs", async () => {
    const target = await createExternal("Public target", "public", other);
    const hiddenCandidates = Array.from({ length: 40 }, (_, index) => ({
      sourceId: `cn_hidden_${String(index).padStart(2, "0")}`,
      visibility: "private" as const,
      createdAt: "2099-01-01T00:00:00.000Z",
    }));
    const visibleCandidates = [
      {
        sourceId: "cn_visible_0",
        visibility: "public" as const,
        createdAt: "2000-01-02T00:00:00.000Z",
      },
      {
        sourceId: "cn_visible_1",
        visibility: "public" as const,
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    ];
    await seedIncomingEdges(target.id, [
      ...hiddenCandidates,
      ...visibleCandidates,
    ]);

    const firstRead = countPreparedStatements(env.DB);
    const firstResponse = await request(
      `/api/content-nodes/${target.id}/edges?direction=incoming&limit=1`,
      "GET",
      undefined,
      "",
      origin,
      {},
      { ...bindings, DB: firstRead.db },
    );
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json<{
      edges: { id: string; source: { id: string } }[];
      next_cursor: string | null;
    }>();
    expect(firstPage.edges).toMatchObject([
      { id: "ce_cn_visible_0", source: { id: "cn_visible_0" } },
    ]);
    expect(firstPage.next_cursor).toMatch(/^edges\./);
    expect(firstRead.count()).toBeLessThanOrEqual(3);
    const firstCursorValue = firstPage.next_cursor;
    if (firstCursorValue === null)
      throw new Error("Expected a second visible edge cursor");
    const firstCursor = JSON.parse(
      atob(firstCursorValue.slice("edges.".length)),
    ) as { id: string; created_at: string };
    expect(firstCursor).toMatchObject({
      id: "ce_cn_visible_0",
      created_at: "2000-01-02T00:00:00.000Z",
    });

    const secondRead = countPreparedStatements(env.DB);
    const secondResponse = await request(
      `/api/content-nodes/${target.id}/edges?direction=incoming&limit=1&cursor=${encodeURIComponent(firstCursorValue)}`,
      "GET",
      undefined,
      "",
      origin,
      {},
      { ...bindings, DB: secondRead.db },
    );
    const secondPage = await secondResponse.json<{
      edges: { id: string; source: { id: string } }[];
      next_cursor: string | null;
    }>();
    expect(secondResponse.status).toBe(200);
    expect(secondPage.edges).toMatchObject([
      { id: "ce_cn_visible_1", source: { id: "cn_visible_1" } },
    ]);
    expect(secondPage.next_cursor).toBeNull();
    expect(secondRead.count()).toBeLessThanOrEqual(3);

    const exactPairRead = countPreparedStatements(env.DB);
    const exactPairResponse = await request(
      `/api/content-nodes/${target.id}/edges?direction=incoming&known_node=cn_visible_1`,
      "GET",
      undefined,
      "",
      origin,
      {},
      { ...bindings, DB: exactPairRead.db },
    );
    expect(exactPairResponse.status).toBe(200);
    expect(
      await exactPairResponse.json<{ edges: { id: string }[] }>(),
    ).toMatchObject({ edges: [{ id: "ce_cn_visible_1" }] });
    expect(exactPairRead.count()).toBeLessThanOrEqual(3);
  });

  it("limits_unlisted_reads_to_the_explicit_pair_and_never_exposes_private_foreign_nodes", async () => {
    const source = await createExternal("Unlisted source", "unlisted");
    const target = await createExternal("Public target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    expect((await edgeAction(edgeId, "accept", other)).status).toBe(200);
    const wrongPair = await edgeList(
      target.id,
      "incoming",
      "known_node=cn_unknown",
      other,
    );
    expect((await wrongPair.json<{ edges: unknown[] }>()).edges).toHaveLength(
      0,
    );
    const pair = await edgeList(
      target.id,
      "incoming",
      `known_node=${source.id}`,
      other,
    );
    expect((await pair.json<{ edges: unknown[] }>()).edges).toHaveLength(1);
    await expectEdgeList(target.id, "incoming", { edges: [] });
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [{ id: edgeId }] },
      `known_node=${source.id}`,
    );
    await expectEdgeList(
      target.id,
      "incoming",
      { edges: [] },
      `known_node=${target.id}`,
      other,
    );
  });

  it("exposes_pending_sources_only_in_the_exact_target_owner_inbox", async () => {
    const source = await createExternal("Unlisted source", "unlisted");
    const target = await createExternal("Target", "public", other);
    const edgeId = await edgeBetween(source.id, target.id);
    const foreign = await request(
      `/api/content-nodes/${target.id}/incoming-review`,
      "GET",
      undefined,
      owner,
    );
    expect(foreign.status).toBe(404);
    const pending = await request(
      `/api/content-nodes/${target.id}/incoming-review`,
      "GET",
      undefined,
      other,
    );
    expect(pending.status).toBe(200);
    expect(pending.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await pending.json()).toMatchObject({
      edges: [{ id: edgeId, source: { id: source.id } }],
    });
    expect(
      (
        await request(
          `/api/content-nodes/${target.id}/incoming-review`,
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(401);
  });

  it("incoming_review_excludes_private_sources", async () => {
    const target = await createExternal("Owned target", "public", owner);
    const privateSource = await createExternal(
      "Private source",
      "private",
      owner,
    );
    const unlistedSource = await createExternal(
      "Unlisted source",
      "unlisted",
      other,
    );
    await edgeBetween(privateSource.id, target.id, owner);
    const pendingId = await edgeBetween(unlistedSource.id, target.id, other);
    const response = await request(
      `/api/content-nodes/${encodeURIComponent(target.id)}/incoming-review`,
      "GET",
      undefined,
      owner,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      edges: [
        {
          id: pendingId,
          source: { id: unlistedSource.id, title: "Unlisted source" },
          pending_acceptance: true,
        },
      ],
      next_cursor: null,
    });
  });

  it("filters_many_private_sources_before_bounded_incoming_review_pages", async () => {
    const target = await createExternal("Owned target", "public", other);
    const hiddenCandidates = Array.from({ length: 40 }, (_, index) => ({
      sourceId: `cn_review_hidden_${String(index).padStart(2, "0")}`,
      visibility: "private" as const,
      createdAt: "2099-01-01T00:00:00.000Z",
    }));
    const visibleCandidates = [
      {
        sourceId: "cn_review_visible_0",
        visibility: "public" as const,
        createdAt: "2000-01-02T00:00:00.000Z",
      },
      {
        sourceId: "cn_review_visible_1",
        visibility: "unlisted" as const,
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    ];
    await seedIncomingEdges(target.id, [
      ...hiddenCandidates,
      ...visibleCandidates,
    ]);

    const firstRead = countPreparedStatements(env.DB);
    const firstResponse = await request(
      `/api/content-nodes/${target.id}/incoming-review?limit=1`,
      "GET",
      undefined,
      other,
      origin,
      {},
      { ...bindings, DB: firstRead.db },
    );
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json<{
      edges: { id: string; source: { id: string } }[];
      next_cursor: string | null;
    }>();
    expect(firstPage.edges).toMatchObject([
      {
        id: "ce_cn_review_visible_0",
        source: { id: "cn_review_visible_0" },
      },
    ]);
    expect(firstPage.next_cursor).toMatch(/^incoming-review\./);
    expect(firstRead.count()).toBeLessThanOrEqual(5);
    const firstCursorValue = firstPage.next_cursor;
    if (firstCursorValue === null)
      throw new Error("Expected a second visible incoming edge");

    const secondRead = countPreparedStatements(env.DB);
    const secondResponse = await request(
      `/api/content-nodes/${target.id}/incoming-review?limit=1&cursor=${encodeURIComponent(firstCursorValue)}`,
      "GET",
      undefined,
      other,
      origin,
      {},
      { ...bindings, DB: secondRead.db },
    );
    const secondPage = await secondResponse.json<{
      edges: {
        id: string;
        source: { id: string };
        pending_acceptance: boolean;
      }[];
      next_cursor: string | null;
    }>();
    expect(secondResponse.status).toBe(200);
    expect(secondPage.edges).toMatchObject([
      {
        id: "ce_cn_review_visible_1",
        source: { id: "cn_review_visible_1" },
        pending_acceptance: true,
      },
    ]);
    expect(secondPage.next_cursor).toBeNull();
    expect(secondRead.count()).toBeLessThanOrEqual(5);
  });
});

describe("edge reports and shared abuse limits", () => {
  async function createReportableEdge() {
    const source = await createExternal("Source", "public");
    const target = await createExternal("Target", "public", other);
    return { source, target, edgeId: await edgeBetween(source.id, target.id) };
  }

  async function createPublicTimeline() {
    const timelineId = await createTimeline("Report subject");
    await makeTimelinePublic(timelineId);
    return timelineId;
  }

  async function seedRegularReports(total: number, reporterId: string) {
    const stamp = new Date().toISOString();
    for (let index = 0; index < total; index++)
      await env.DB.prepare(
        "INSERT INTO report_events (id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES (?,?, 'timeline',?,'abuse','Seeded report',?)",
      )
        .bind(`seed-report-${index}`, reporterId, `subject-${index}`, stamp)
        .run();
  }

  async function seedGraphReports(
    total: number,
    edgeId: string,
    reporterId: string,
  ) {
    const stamp = new Date().toISOString();
    for (let index = 0; index < total; index++)
      await env.DB.prepare(
        "INSERT INTO content_edge_reports (id,reporter_id,edge_id,category,detail,created_at) VALUES (?,?,?,'abuse','Seeded graph report',?)",
      )
        .bind(`seed-edge-report-${index}`, reporterId, edgeId, stamp)
        .run();
  }

  it("validates_target_owner_reports_deduplicates_and_keeps_report_rows_append_only", async () => {
    const { edgeId } = await createReportableEdge();
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "abuse", detail: "Please review." },
          other,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "spam", detail: "Replacement." },
          other,
        )
      ).status,
    ).toBe(200);
    expect(await count("content_edge_reports")).toBe(1);
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "abuse", detail: "Foreign." },
          owner,
        )
      ).status,
    ).toBe(404);
    expect(
      (await reportEdge(edgeId, { category: "unknown", detail: "x" }, other))
        .status,
    ).toBe(400);
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "abuse", detail: "x".repeat(1001) },
          other,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "abuse", detail: "x", reporter_id: "owner_a" },
          other,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await reportEdge(
          edgeId,
          { category: "abuse", detail: "x" },
          other,
          "https://foreign.test",
        )
      ).status,
    ).toBe(403);
    for (const sql of [
      "UPDATE content_edge_reports SET detail='Changed'",
      "DELETE FROM content_edge_reports",
    ])
      await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  });

  it("enforces_the_shared_daily_cap_for_graph_reports_after_existing_reports", async () => {
    const { edgeId: firstEdgeId } = await createReportableEdge();
    const timelineId = await createPublicTimeline();

    await seedRegularReports(19, "owner_b");
    expect(
      (
        await reportEdge(
          firstEdgeId,
          { category: "abuse", detail: "Graph report." },
          other,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          "/api/reports",
          "POST",
          {
            target: { kind: "timeline", timeline_id: timelineId },
            category: "abuse",
            detail: "Must be capped.",
          },
          other,
        )
      ).status,
    ).toBe(429);
    expect(await count("report_events")).toBe(19);
    expect(await count("content_edge_reports")).toBe(1);
  });

  it("applies_the_combined_daily_cap_atomically_across_both_report_routes", async () => {
    const { edgeId } = await createReportableEdge();
    const timelineId = await createPublicTimeline();
    await seedRegularReports(19, "owner_b");
    const responses = await Promise.all([
      reportEdge(edgeId, { category: "abuse", detail: "Graph report." }, other),
      request(
        "/api/reports",
        "POST",
        {
          target: { kind: "timeline", timeline_id: timelineId },
          category: "abuse",
          detail: "Timeline report.",
        },
        other,
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 429,
    ]);
    const graphCreated = responses[0].status === 201;
    const timelineCreated = responses[1].status === 201;
    expect(await count("report_events")).toBe(19 + Number(timelineCreated));
    expect(await count("content_edge_reports")).toBe(Number(graphCreated));
    expect(
      Number(await count("report_events")) +
        Number(await count("content_edge_reports")),
    ).toBe(20);
  });

  it("enforces_the_shared_daily_cap_for_existing_reports_after_graph_reports", async () => {
    const first = await createReportableEdge();
    const second = await createReportableEdge();
    const timelineId = await createPublicTimeline();
    await seedGraphReports(19, first.edgeId, "owner_b");
    expect(
      (
        await request(
          "/api/reports",
          "POST",
          {
            target: { kind: "timeline", timeline_id: timelineId },
            category: "abuse",
            detail: "Existing report.",
          },
          other,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await reportEdge(
          second.edgeId,
          { category: "abuse", detail: "Must be capped." },
          other,
        )
      ).status,
    ).toBe(429);
    expect(await count("report_events")).toBe(1);
    expect(await count("content_edge_reports")).toBe(19);
  });

  it("lists_edge_reports_only_for_admins_with_bounded_keyset_queries", async () => {
    const firstEdge = await createReportableEdge();
    const secondEdge = await createReportableEdge();
    expect(
      (
        await reportEdge(
          firstEdge.edgeId,
          { category: "copyright", detail: "Rights review." },
          other,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await reportEdge(
          secondEdge.edgeId,
          { category: "spam", detail: "Second review." },
          other,
        )
      ).status,
    ).toBe(201);
    const response = await request(
      "/api/admin/content-edge-reports?limit=1",
      "GET",
      undefined,
      admin,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const firstPage = await response.json<{
      reports: { edge_id: string; category: string; detail: string }[];
      next_cursor: string | null;
    }>();
    expect(firstPage.reports).toHaveLength(1);
    expect([firstEdge.edgeId, secondEdge.edgeId]).toContain(
      firstPage.reports[0]?.edge_id,
    );
    expect(firstPage.next_cursor).toMatch(/^edge-reports\./);
    const secondPage = await request(
      `/api/admin/content-edge-reports?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor ?? "")}`,
      "GET",
      undefined,
      admin,
    );
    expect(secondPage.status).toBe(200);
    const secondPageData = await secondPage.json<{
      reports: { edge_id: string; category: string; detail: string }[];
      next_cursor: string | null;
    }>();
    expect(secondPageData.reports).toHaveLength(1);
    expect([firstEdge.edgeId, secondEdge.edgeId]).toContain(
      secondPageData.reports[0]?.edge_id,
    );
    expect(secondPageData.reports[0]?.edge_id).not.toBe(
      firstPage.reports[0]?.edge_id,
    );
    expect(secondPageData.next_cursor).toBeNull();
    expect(
      [
        firstPage.reports[0]?.edge_id,
        secondPageData.reports[0]?.edge_id,
      ].sort(),
    ).toEqual([firstEdge.edgeId, secondEdge.edgeId].sort());
    for (const query of [
      "?limit=101",
      "?limit=0",
      "?limit=1&limit=2",
      "?unknown=x",
    ])
      expect(
        (
          await request(
            `/api/admin/content-edge-reports${query}`,
            "GET",
            undefined,
            admin,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await request(
          "/api/admin/content-edge-reports",
          "GET",
          undefined,
          owner,
        )
      ).status,
    ).toBe(403);
  });

  it("enforces_global_ip_write_and_reports_budgets_on_edge_routes", async () => {
    const { source, target, edgeId } = await createReportableEdge();
    const bucket = Math.floor(Date.now() / 60_000) * 60_000;
    const expires = bucket + 60_000 + 3_600_000;
    async function setLimit(
      policy: "public" | "writes" | "reports",
      subject: string,
      value: number,
    ) {
      await env.DB.prepare(
        "INSERT INTO rate_limits (scope_hash,bucket,count,expires_at) VALUES (?,?,?,?) ON CONFLICT (scope_hash,bucket) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at",
      )
        .bind(await hashToken(`${policy}:${subject}`), bucket, value, expires)
        .run();
    }
    async function readLimit(policy: "writes" | "reports", subject: string) {
      return env.DB.prepare(
        "SELECT count FROM rate_limits WHERE scope_hash=? AND bucket=?",
      )
        .bind(await hashToken(`${policy}:${subject}`), bucket)
        .first<number>("count");
    }

    const globalIp = "203.0.113.200";
    await setLimit("public", globalIp, 600);
    const globallyLimited = await request(
      "/api/content-edges",
      "POST",
      { source_id: source.id, target_id: target.id, type: "references" },
      "",
      origin,
      { "CF-Connecting-IP": globalIp },
    );
    expect(globallyLimited.status).toBe(429);

    await setLimit("writes", "owner_a", 120);
    const writeLimited = await request("/api/content-edges", "POST", {
      source_id: source.id,
      target_id: target.id,
      type: "references",
    });
    expect(writeLimited.status).toBe(429);

    const path = `/api/content-edges/${edgeId}/reports`;
    expect(await readLimit("reports", "owner_b")).toBeNull();
    const beforeWrites = await readLimit("writes", "owner_b");
    await setLimit("reports", "owner_b", 9);
    const accepted = await request(
      path,
      "POST",
      { category: "abuse", detail: "One left." },
      other,
    );
    expect(accepted.status).toBe(201);
    expect(await readLimit("reports", "owner_b")).toBe(10);
    expect(await readLimit("writes", "owner_b")).toBe((beforeWrites ?? 0) + 1);
    expect(
      (
        await request(
          path,
          "POST",
          { category: "abuse", detail: "Over burst." },
          other,
        )
      ).status,
    ).toBe(429);
    expect(await readLimit("reports", "owner_b")).toBe(10);

    const beforeNestedReports = await readLimit("reports", "owner_b");
    expect(
      (
        await request(
          `/api/content-edges/${edgeId}/nested/reports`,
          "POST",
          { category: "abuse", detail: "No match." },
          other,
        )
      ).status,
    ).toBe(404);
    expect(await readLimit("reports", "owner_b")).toBe(beforeNestedReports);
  });
});
