import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { seedUser } from "../helpers/auth";
import { contentEdgePageFixture } from "../helpers/content-edge-pages";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedUser("page_owner");
  await seedUser("source_owner");
});

it("seeds both relationship pages with valid source ownership and public nodes", async () => {
  const fixture = contentEdgePageFixture("page_owner", "source_owner");
  await env.DB.exec(fixture.sql);
  const nodes = await env.DB.prepare("SELECT * FROM content_nodes").all<{
    id: string;
    owner_id: string;
    kind: string;
    visibility: string;
  }>();
  expect(nodes.results).toHaveLength(63);
  expect(fixture.targets).toHaveLength(31);
  expect(fixture.sources).toHaveLength(31);
  expect(nodes.results.every((node) => node.kind === "external")).toBe(true);
  expect(nodes.results.every((node) => node.visibility === "public")).toBe(
    true,
  );

  const outgoing = await env.DB.prepare(
    "SELECT target_id, creator_id FROM content_edges WHERE source_id=?",
  )
    .bind(fixture.node.id)
    .all<{ target_id: string; creator_id: string }>();
  expect(outgoing.results).toHaveLength(31);
  expect(new Set(outgoing.results.map((edge) => edge.target_id))).toEqual(
    new Set(fixture.targets.map((node) => node.id)),
  );
  expect(
    outgoing.results.every((edge) => edge.creator_id === "page_owner"),
  ).toBe(true);
  const incoming = await env.DB.prepare(
    "SELECT source_id, creator_id, accepted_at FROM content_edges WHERE target_id=?",
  )
    .bind(fixture.node.id)
    .all<{
      source_id: string;
      creator_id: string;
      accepted_at: string | null;
    }>();
  expect(incoming.results).toHaveLength(31);
  expect(new Set(incoming.results.map((edge) => edge.source_id))).toEqual(
    new Set(fixture.sources.map((node) => node.id)),
  );
  expect(
    incoming.results.every((edge) => edge.creator_id === "source_owner"),
  ).toBe(true);
  expect(incoming.results.every((edge) => edge.accepted_at === null)).toBe(
    true,
  );
  const newest = await env.DB.prepare(
    "SELECT id FROM content_nodes WHERE owner_id=? ORDER BY created_at DESC, id DESC LIMIT 1",
  )
    .bind("page_owner")
    .first("id");
  expect(newest).toBe(fixture.node.id);
});

it("keeps repeated fixtures disjoint and quotes owner IDs", async () => {
  const owner = "owner'quoted";
  await seedUser(owner);
  const first = contentEdgePageFixture(owner, "source_owner");
  const second = contentEdgePageFixture(owner, "source_owner");
  await env.DB.exec(first.sql);
  await env.DB.exec(second.sql);
  expect(first.node.id).not.toBe(second.node.id);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS total FROM content_nodes").first(
      "total",
    ),
  ).toBe(126);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS total FROM content_edges").first(
      "total",
    ),
  ).toBe(124);
  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM content_nodes WHERE owner_id=?",
  )
    .bind(owner)
    .first("total");
  expect(owned).toBe(64);
});
