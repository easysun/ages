import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import type { LinkTracking } from "../../src/links/tracking";
import { applyLinkParameters } from "../../src/links/tracking";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
let session: string;
let other: string;

type Link = {
  id: string;
  slug: string;
  target: { kind: "url"; url: string };
};
type LinkPage = { links: Link[]; next_cursor: string | null };

const emptyTracking: LinkTracking = {
  tags: [],
  channels: [],
  utm: {},
  custom: [],
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

function create(targetUrl = "https://example.org/path?keep=1#part") {
  return request("", session, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ target: { kind: "url", url: targetUrl } }),
  });
}

async function createLink(targetUrl?: string): Promise<Link> {
  const response = await create(targetUrl);
  expect(response.status).toBe(201);
  return ((await response.json()) as { link: Link }).link;
}

function tracking(
  id: string,
  body?: LinkTracking,
  cookie = session,
  requestOrigin = origin,
) {
  return request(`/${id}/tracking`, cookie, {
    ...(body ? { method: "PUT" } : {}),
    headers: body
      ? { Origin: requestOrigin, "Content-Type": "application/json" }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function page(query = "", cookie = session): Promise<LinkPage> {
  const response = await request(query ? `?${query}` : "", cookie);
  expect(response.status).toBe(200);
  return response.json();
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
}

describe("Owner Link tracking configuration", () => {
  it("foreign_owner_cannot_read_or_replace_tracking", async () => {
    const saved = await createLink();
    expect(await (await tracking(saved.id)).json()).toEqual({
      tracking: emptyTracking,
    });
    const configured: LinkTracking = {
      ...emptyTracking,
      utm: { utm_source: "travel" },
    };
    expect((await tracking(saved.id, configured)).status).toBe(200);
    expect(await (await tracking(saved.id)).json()).toEqual({
      tracking: configured,
    });
    await expectError(
      await tracking(saved.id, undefined, ""),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(
      await tracking(saved.id, emptyTracking, ""),
      401,
      "UNAUTHENTICATED",
    );
    await expectError(
      await tracking(saved.id, undefined, other),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await tracking(saved.id, emptyTracking, other),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await tracking(saved.id, emptyTracking, session, "https://attacker.test"),
      403,
      "FORBIDDEN",
    );
    expect(await (await tracking(saved.id)).json()).toEqual({
      tracking: configured,
    });
  });

  it("replaces all tracking fields and validates exact boundaries", async () => {
    const saved = await createLink();
    const tags = Array.from({ length: 20 }, (_, index) => `tag${index}`);
    const channels = Array.from(
      { length: 20 },
      (_, index) => `channel${index}`,
    );
    const custom = Array.from({ length: 10 }, (_, index) => ({
      key: `${index}${"k".repeat(39)}`,
      value: "v".repeat(100),
    }));
    const complete: LinkTracking = {
      tags,
      channels,
      utm: {
        utm_source: "source",
        utm_medium: "medium",
        utm_campaign: "campaign",
        utm_term: "term",
        utm_content: "content",
      },
      custom,
    };
    expect((await tracking(saved.id, complete)).status).toBe(200);
    expect(await (await tracking(saved.id)).json()).toEqual({
      tracking: complete,
    });

    const rejected: unknown[] = [
      { ...complete, tags: [...tags, "extra"] },
      { ...complete, channels: [...channels, "extra"] },
      { ...complete, tags: ["duplicate", "duplicate"] },
      { ...complete, channels: ["duplicate", "duplicate"] },
      { ...complete, custom: [...custom, { key: "extra", value: "" }] },
      { ...emptyTracking, custom: [{ key: "k".repeat(41), value: "" }] },
      { ...emptyTracking, custom: [{ key: "key", value: "v".repeat(101) }] },
      { ...emptyTracking, custom: [{ key: "utm_extra", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "Ages_Channel", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "__proto__", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "prototype", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "constructor", value: "x" }] },
      {
        ...emptyTracking,
        custom: [
          { key: "same", value: "one" },
          { key: "same", value: "two" },
        ],
      },
      { ...emptyTracking, custom: [{ key: "bad\u0001key", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "key", value: "bad\u007fvalue" }] },
      { ...emptyTracking, utm: { utm_source: "v".repeat(101) } },
      { ...emptyTracking, utm: { utm_other: "x" } },
    ];
    for (const value of rejected) {
      await expectError(
        await request(`/${saved.id}/tracking`, session, {
          method: "PUT",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
        400,
        "INVALID_REQUEST",
      );
      expect(await (await tracking(saved.id)).json()).toEqual({
        tracking: complete,
      });
    }
  });

  it("exact_unicode_tag_filters_bind_cursors", async () => {
    const labels = ["旅行", "旅行", "Trip", "trip", " Trip ", "Trip\u0085"];
    const saved = await Promise.all(labels.map(() => createLink()));
    await Promise.all(
      saved.map((link, index) =>
        tracking(link.id, { ...emptyTracking, tags: [labels[index] ?? ""] }),
      ),
    );

    for (let index = 0; index < saved.length; index++) {
      const response = await tracking(saved[index]?.id ?? "");
      expect(await response.json()).toEqual({
        tracking: { ...emptyTracking, tags: [labels[index]] },
      });
    }

    const first = await page(`limit=1&tag=${encodeURIComponent("旅行")}`);
    expect(first.links).toHaveLength(1);
    expect(first.next_cursor).toMatch(/^links\./);
    const second = await page(
      `limit=1&tag=${encodeURIComponent("旅行")}&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
    );
    expect(second.links).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect([first.links[0]?.id, second.links[0]?.id].sort()).toEqual(
      saved
        .slice(0, 2)
        .map((link) => link.id)
        .sort(),
    );

    for (const [tag, expected] of [
      ["Trip", saved[2]?.id],
      ["trip", saved[3]?.id],
      [" Trip ", saved[4]?.id],
      ["Trip\u0085", saved[5]?.id],
    ] as const) {
      const filtered = await page(`tag=${encodeURIComponent(tag)}`);
      expect(filtered.links.map((link) => link.id)).toEqual([expected]);
    }
    await expectError(
      await request(
        `?limit=1&tag=${encodeURIComponent("旅行 ")}&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
      ),
      400,
      "INVALID_REQUEST",
    );
  });

  it("does not add parameters to a URL-kind Link that points to the application origin", async () => {
    const destination = "https://ages.test/t/private?keep=1#part";
    const saved = await createLink(destination);
    const configured: LinkTracking = {
      ...emptyTracking,
      utm: { utm_source: "travel" },
    };
    expect((await tracking(saved.id, configured)).status).toBe(200);
    expect(applyLinkParameters(saved.target.url, configured, origin)).toBe(
      saved.target.url,
    );
  });

  it("rejects tracking rows attached to a different owner identity", async () => {
    const saved = await createLink();
    await expect(
      env.DB.prepare(
        "INSERT INTO link_tags (link_id, owner_id, tag, position) VALUES (?, ?, ?, 0)",
      )
        .bind(saved.id, "owner_b", "foreign")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO link_channels (link_id, owner_id, channel, position) VALUES (?, ?, ?, 0)",
      )
        .bind(saved.id, "owner_b", "foreign")
        .run(),
    ).rejects.toThrow();
  });

  it("rolls back a complete replacement when a later tracking insert fails", async () => {
    const saved = await createLink();
    const original: LinkTracking = {
      tags: ["saved"],
      channels: ["saved"],
      utm: { utm_source: "before" },
      custom: [{ key: "note", value: "before" }],
    };
    expect((await tracking(saved.id, original)).status).toBe(200);
    await env.DB.exec(
      "CREATE TRIGGER fail_test_link_channel BEFORE INSERT ON link_channels WHEN NEW.channel = 'fail' BEGIN SELECT RAISE(ABORT, 'test_failure'); END",
    );
    const attempted: LinkTracking = {
      tags: ["replacement"],
      channels: ["accepted", "fail"],
      utm: { utm_source: "after" },
      custom: [{ key: "note", value: "after" }],
    };
    await expectError(
      await tracking(saved.id, attempted),
      500,
      "INTERNAL_ERROR",
    );
    expect(await (await tracking(saved.id)).json()).toEqual({
      tracking: original,
    });
  });
});
