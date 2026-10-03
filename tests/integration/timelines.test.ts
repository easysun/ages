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
type Item = {
  id: string;
  asset_id: string;
  position: number;
  caption: string;
  event_at: unknown;
};
type Timeline = {
  id: string;
  title: string;
  visibility: string;
  cover_asset_id: string | null;
  version: number;
  items: Item[];
};
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser();
  other = await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function request(
  path = "",
  method = "GET",
  body?: unknown,
  cookie = session,
  requestOrigin = origin,
) {
  return app.request(
    `${origin}/api/timelines${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}
async function create(title = "Story", cookie = session) {
  const response = await request("", "POST", { title }, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ timeline: Timeline }>()).timeline;
}
async function ready(id = "asset_a", owner = "owner_a", status = "ready") {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO assets (id, owner_id, kind, status, original_name, mime_type,
    size_bytes, r2_key, upload_expires_at, created_at, updated_at)
    VALUES (?, ?, 'image', ?, 'synthetic.png', 'image/png', 10, ?, ?, ?, ?)`)
    .bind(id, owner, status, id, now, now, now)
    .run();
  return id;
}
async function get(id: string) {
  const response = await request(`/${id}`);
  expect(response.status).toBe(200);
  return (await response.json<{ timeline: Timeline }>()).timeline;
}
async function append(
  timeline: Timeline,
  asset = "asset_a",
  extra: Record<string, unknown> = {},
) {
  const response = await request(`/${timeline.id}/items`, "POST", {
    expected_version: timeline.version,
    asset_id: asset,
    ...extra,
  });
  expect(response.status).toBe(201);
  return (await response.json<{ timeline: Timeline }>()).timeline;
}
async function snapshot(id: string) {
  return env.DB.batch([
    env.DB.prepare("SELECT * FROM timelines WHERE id = ?").bind(id),
    env.DB.prepare(
      "SELECT * FROM timeline_items WHERE timeline_id = ? ORDER BY position",
    ).bind(id),
  ]).then((rows) => rows.map((row) => row.results));
}

describe("Owner-scoped timelines", () => {
  it("creates private stable timelines, paginates without exposing internal state, and hides other owners", async () => {
    const first = await create("First");
    await create("Other", other);
    const second = await create("Second");
    expect(first).toMatchObject({
      visibility: "private",
      version: 1,
      items: [],
      cover_asset_id: null,
    });
    expect(first).not.toHaveProperty("last_mutation_token");
    const response = await request("?limit=1");
    expect(response.status).toBe(200);
    const page = await response.json<{
      timelines: Timeline[];
      next_cursor: string;
    }>();
    expect(page.timelines).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    const rest = await (
      await request(`?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)
    ).json<{ timelines: Timeline[]; next_cursor: null }>();
    expect(
      new Set([...page.timelines, ...rest.timelines].map((row) => row.id)),
    ).toEqual(new Set([first.id, second.id]));
    expect(rest.next_cursor).toBeNull();
    expect(
      (await request(`/${first.id}`, "GET", undefined, other)).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/${first.id}`,
          "PATCH",
          { expected_version: 1, title: "Hijack" },
          other,
        )
      ).status,
    ).toBe(404);
    expect((await request("?cursor=bad")).status).toBe(400);
    expect((await request("?limit=0")).status).toBe(400);
    expect((await request("?unknown=1")).status).toBe(400);
    expect(
      (await request("", "POST", { title: "Extra", visibility: "public" }))
        .status,
    ).toBe(400);
    expect((await request("", "GET", undefined, "")).status).toBe(401);
    expect(
      (
        await request(
          "",
          "POST",
          { title: "CSRF" },
          session,
          "https://other.test",
        )
      ).status,
    ).toBe(403);
  });
  it("reserves the last timeline quota slot atomically under concurrent creates", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET timeline_limit = 1 WHERE user_id = 'owner_a'",
    ).run();
    const responses = await Promise.all([
      request("", "POST", { title: "A" }),
      request("", "POST", { title: "B" }),
    ]);
    expect(responses.map((row) => row.status).sort()).toEqual([201, 403]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM timelines WHERE owner_id='owner_a'",
      ).first("n"),
    ).toBe(1);
  });
  it("updates title, visibility and owned ready covers using a version guard", async () => {
    await ready();
    await ready("foreign", "owner_b");
    await ready("pending", "owner_a", "pending");
    const timeline = await create();
    for (const cover of ["foreign", "pending", "missing"]) {
      expect(
        (
          await request(`/${timeline.id}`, "PATCH", {
            expected_version: 1,
            cover_asset_id: cover,
          })
        ).status,
      ).toBe(409);
      expect((await get(timeline.id)).version).toBe(1);
    }
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 1,
          title: "Updated",
          visibility: "unlisted",
          cover_asset_id: "asset_a",
        })
      ).status,
    ).toBe(200);
    expect(await get(timeline.id)).toMatchObject({
      title: "Updated",
      visibility: "unlisted",
      cover_asset_id: "asset_a",
      version: 2,
    });
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 2,
          cover_asset_id: null,
        })
      ).status,
    ).toBe(200);
    expect((await get(timeline.id)).cover_asset_id).toBeNull();
  });
});

describe("Independent story items", () => {
  it("reuses assets with independent captions and precision-preserving dates, removes only items", async () => {
    await ready();
    const date = {
      kind: "date",
      date: "2024-02-29",
      time_zone: "Asia/Taipei",
      calendar: "iso8601",
    };
    const first = await append(await create("A"), "asset_a", {
      caption: "A",
      event_at: date,
    });
    const second = await append(await create("B"), "asset_a", {
      caption: "B",
      event_at: {
        kind: "instant",
        instant: "2026-10-04T16:30:00+08:00",
        time_zone: "Asia/Taipei",
      },
    });
    expect(first.items[0]?.event_at).toEqual(date);
    expect(second.items[0]?.event_at).toEqual({
      kind: "instant",
      instant: "2026-10-04T08:30:00.000Z",
      time_zone: "Asia/Taipei",
    });
    const item = first.items[0];
    expect(
      (
        await request(`/${first.id}/items/${item?.id}`, "PATCH", {
          expected_version: 2,
          caption: "Edited",
          event_at: null,
        })
      ).status,
    ).toBe(200);
    expect((await get(first.id)).items[0]).toMatchObject({
      caption: "Edited",
      event_at: null,
    });
    expect((await get(second.id)).items[0]?.caption).toBe("B");
    expect(
      (
        await request(`/${first.id}/items/${item?.id}`, "DELETE", {
          expected_version: 3,
        })
      ).status,
    ).toBe(200);
    expect((await get(first.id)).items).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM assets WHERE id='asset_a'",
      ).first("status"),
    ).toBe("ready");
  });
  it("rejects invalid dates, unsupported zones, unknown fields and missing versions without mutation", async () => {
    await ready();
    const timeline = await create();
    const before = await snapshot(timeline.id);
    for (const event of [
      {
        kind: "date",
        date: "2023-02-29",
        time_zone: "UTC",
        calendar: "iso8601",
      },
      {
        kind: "date",
        date: "2024-02-30",
        time_zone: "UTC",
        calendar: "iso8601",
      },
      {
        kind: "date",
        date: "2024-01-01",
        time_zone: "Mars/City",
        calendar: "iso8601",
      },
      { kind: "instant", instant: "2024-02-30T00:00:00Z", time_zone: "UTC" },
    ])
      expect(
        (
          await request(`/${timeline.id}/items`, "POST", {
            expected_version: 1,
            asset_id: "asset_a",
            event_at: event,
          })
        ).status,
      ).toBe(400);
    expect(
      (await request(`/${timeline.id}/items`, "POST", { asset_id: "asset_a" }))
        .status,
    ).toBe(400);
    expect(
      (await request(`/${timeline.id}`, "PATCH", { expected_version: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 1,
          position: 2,
        })
      ).status,
    ).toBe(400);
    expect(await snapshot(timeline.id)).toEqual(before);
  });
  it("rejects stale append, metadata, edit, remove and reorder without even changing timestamps or tokens", async () => {
    await ready();
    const timeline = await append(await create());
    const before = await snapshot(timeline.id);
    const item = timeline.items[0];
    const attempts: [string, string, unknown][] = [
      [`/${timeline.id}`, "PATCH", { expected_version: 1, title: "Stale" }],
      [
        `/${timeline.id}/items`,
        "POST",
        { expected_version: 1, asset_id: "asset_a" },
      ],
      [
        `/${timeline.id}/items/${item?.id}`,
        "PATCH",
        { expected_version: 1, caption: "Stale" },
      ],
      [`/${timeline.id}/items/${item?.id}`, "DELETE", { expected_version: 1 }],
      [
        `/${timeline.id}/order`,
        "PUT",
        { expected_version: 1, item_ids: [item?.id] },
      ],
    ];
    for (const [path, method, body] of attempts) {
      expect((await request(path, method, body)).status).toBe(409);
      expect(await snapshot(timeline.id)).toEqual(before);
    }
  });
  it("allows exactly one concurrent writer and makes retrying the loser a complete no-op", async () => {
    await ready();
    const timeline = await create();
    const bodies = ["A", "B"].map((caption) => ({
      expected_version: 1,
      asset_id: "asset_a",
      caption,
    }));
    const responses = await Promise.all(
      bodies.map((body) => request(`/${timeline.id}/items`, "POST", body)),
    );
    expect(responses.map((row) => row.status).sort()).toEqual([201, 409]);
    const winner = await responses
      .find((row) => row.status === 201)
      ?.json<{ timeline: Timeline }>();
    expect(winner?.timeline.version).toBe(2);
    expect(winner?.timeline.items).toHaveLength(1);
    const before = await snapshot(timeline.id);
    expect(
      (
        await request(
          `/${timeline.id}/items`,
          "POST",
          bodies[responses.findIndex((row) => row.status === 409)],
        )
      ).status,
    ).toBe(409);
    expect(await snapshot(timeline.id)).toEqual(before);
  });
  it("validates the entire unique reorder set and reverses 100 items atomically", async () => {
    await ready();
    let timeline = await create();
    for (let i = 0; i < 100; i++) timeline = await append(timeline);
    const ids = timeline.items.map((item) => item.id);
    const before = await snapshot(timeline.id);
    for (const invalid of [
      ids.slice(1),
      [...ids, "missing"],
      [...ids.slice(1), ids[1]],
      [...ids.slice(1), "foreign"],
    ]) {
      expect(
        (
          await request(`/${timeline.id}/order`, "PUT", {
            expected_version: timeline.version,
            item_ids: invalid,
          })
        ).status,
      ).toBe(400);
      expect(await snapshot(timeline.id)).toEqual(before);
    }
    const reversed = [...ids].reverse();
    expect(
      (
        await request(`/${timeline.id}/order`, "PUT", {
          expected_version: timeline.version,
          item_ids: reversed,
        })
      ).status,
    ).toBe(200);
    const result = await get(timeline.id);
    expect(result.version).toBe(timeline.version + 1);
    expect(result.items.map((item) => item.id)).toEqual(reversed);
    expect(result.items.map((item) => item.position)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
  });
  it("rolls back the version, token and timestamp if a downstream batch statement fails", async () => {
    await ready();
    const timeline = await create();
    const before = await snapshot(timeline.id);
    await env.DB.exec(
      `CREATE TRIGGER inject_item_failure BEFORE INSERT ON timeline_items BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`,
    );
    expect(
      (
        await request(`/${timeline.id}/items`, "POST", {
          expected_version: 1,
          asset_id: "asset_a",
        })
      ).status,
    ).toBe(500);
    expect(await snapshot(timeline.id)).toEqual(before);
  });
});

describe("Database association safeguards", () => {
  it("enforces owner foreign keys, ready associations and immutable item identity for direct SQL", async () => {
    await ready();
    await ready("foreign", "owner_b");
    await ready("pending", "owner_a", "pending");
    const timeline = await create();
    for (const asset of ["foreign", "pending", "missing"])
      await expect(
        env.DB.prepare(`INSERT INTO timeline_items
      (id,timeline_id,owner_id,asset_id,position,caption,created_at,updated_at) VALUES (?,?,'owner_a',?,0,'','now','now')`)
          .bind(asset, timeline.id, asset)
          .run(),
      ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE timelines SET cover_asset_id='foreign' WHERE id=?")
        .bind(timeline.id)
        .run(),
    ).rejects.toThrow();
    const added = await append(timeline);
    await expect(
      env.DB.prepare("UPDATE timeline_items SET owner_id='owner_b' WHERE id=?")
        .bind(added.items[0]?.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE timeline_items SET position=-1 WHERE id=?")
        .bind(added.items[0]?.id)
        .run(),
    ).rejects.toThrow();
  });
  it("protects item and cover references from trash, purge and physical deletion", async () => {
    await ready();
    await ready("cover");
    const timeline = await append(await create());
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 2,
          cover_asset_id: "cover",
        })
      ).status,
    ).toBe(200);
    for (const id of ["asset_a", "cover"]) {
      await expect(
        env.DB.prepare(
          "UPDATE assets SET status='deleted', deleted_at='now' WHERE id=?",
        )
          .bind(id)
          .run(),
      ).rejects.toThrow();
      await expect(
        env.DB.prepare("DELETE FROM assets WHERE id=?").bind(id).run(),
      ).rejects.toThrow();
      await expect(
        env.DB.prepare("UPDATE assets SET status='purged' WHERE id=?")
          .bind(id)
          .run(),
      ).rejects.toThrow();
    }
  });
  it("serializes reference creation against trash without a referenced trashed asset", async () => {
    await ready();
    const timeline = await create();
    const outcomes = await Promise.allSettled([
      request(`/${timeline.id}/items`, "POST", {
        expected_version: 1,
        asset_id: "asset_a",
      }),
      env.DB.prepare(
        "UPDATE assets SET status='deleted', deleted_at='now' WHERE id='asset_a'",
      ).run(),
    ]);
    const current = await get(timeline.id);
    const status = await env.DB.prepare(
      "SELECT status FROM assets WHERE id='asset_a'",
    ).first("status");
    if (current.items.length) {
      expect(status).toBe("ready");
      expect(outcomes[1]?.status).toBe("rejected");
    } else {
      expect(status).toBe("deleted");
      expect(
        (outcomes[0] as PromiseFulfilledResult<Response>).value.status,
      ).toBe(409);
    }
  });
});

describe("Timeline mutation edge cases", () => {
  it("hides foreign timelines for every mutation and rejects foreign item IDs without changes", async () => {
    await ready();
    const timeline = await append(await create());
    const otherTimeline = await create("Other");
    const before = await snapshot(timeline.id);
    const item = timeline.items[0];
    for (const [path, method, body] of [
      [
        `/${timeline.id}/items`,
        "POST",
        { expected_version: 2, asset_id: "asset_a" },
      ],
      [
        `/${timeline.id}/items/${item?.id}`,
        "PATCH",
        { expected_version: 2, caption: "Other" },
      ],
      [`/${timeline.id}/items/${item?.id}`, "DELETE", { expected_version: 2 }],
      [
        `/${timeline.id}/order`,
        "PUT",
        { expected_version: 2, item_ids: [item?.id] },
      ],
    ] as const)
      expect((await request(path, method, body, other)).status).toBe(404);
    expect(
      (
        await request(`/${otherTimeline.id}/items/${item?.id}`, "PATCH", {
          expected_version: 1,
          caption: "Wrong timeline",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/${otherTimeline.id}/items/${item?.id}`, "DELETE", {
          expected_version: 1,
        })
      ).status,
    ).toBe(409);
    expect(await snapshot(timeline.id)).toEqual(before);
    expect((await get(otherTimeline.id)).version).toBe(1);
  });
  it("supports empty reorder and append after removing an interior item", async () => {
    await ready();
    let timeline = await create();
    expect(
      (
        await request(`/${timeline.id}/order`, "PUT", {
          expected_version: 1,
          item_ids: [],
        })
      ).status,
    ).toBe(200);
    timeline = await get(timeline.id);
    for (let i = 0; i < 3; i++) timeline = await append(timeline);
    expect(
      (
        await request(
          `/${timeline.id}/items/${timeline.items[1]?.id}`,
          "DELETE",
          { expected_version: timeline.version },
        )
      ).status,
    ).toBe(200);
    timeline = await append(await get(timeline.id));
    expect(timeline.items.map((item) => item.position)).toEqual([0, 2, 3]);
    expect(
      (
        await request(`/${timeline.id}/order`, "PUT", {
          expected_version: timeline.version,
          item_ids: timeline.items.map((item) => item.id).reverse(),
        })
      ).status,
    ).toBe(200);
    expect((await get(timeline.id)).items.map((item) => item.position)).toEqual(
      [0, 1, 2],
    );
  });
  it("serializes reorder against metadata and returns each winner's own batch state", async () => {
    await ready();
    let timeline = await append(await create());
    timeline = await append(timeline);
    const ids = timeline.items.map((item) => item.id);
    const responses = await Promise.all([
      request(`/${timeline.id}/order`, "PUT", {
        expected_version: timeline.version,
        item_ids: [...ids].reverse(),
      }),
      request(`/${timeline.id}`, "PATCH", {
        expected_version: timeline.version,
        title: "New title",
      }),
    ]);
    expect(responses.map((row) => row.status).sort()).toEqual([200, 409]);
    const winner = await responses
      .find((row) => row.status === 200)
      ?.json<{ timeline: Timeline }>();
    expect(winner?.timeline).toEqual(await get(timeline.id));
    expect(winner?.timeline.version).toBe(timeline.version + 1);
    if (responses[0]?.status === 200) {
      expect(winner?.timeline.items.map((item) => item.id)).toEqual(
        [...ids].reverse(),
      );
      expect(winner?.timeline.title).toBe("Story");
    } else {
      expect(winner?.timeline.items.map((item) => item.id)).toEqual(ids);
      expect(winner?.timeline.title).toBe("New title");
    }
  });
  it("rejects trashed or purged assets, protects cover-only references, and releases protection after removal", async () => {
    await ready("deleted", "owner_a", "deleted");
    await ready("purged", "owner_a", "purged");
    await ready("cover");
    const timeline = await create();
    for (const id of ["deleted", "purged"]) {
      expect(
        (
          await request(`/${timeline.id}/items`, "POST", {
            expected_version: 1,
            asset_id: id,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/${timeline.id}`, "PATCH", {
            expected_version: 1,
            cover_asset_id: id,
          })
        ).status,
      ).toBe(409);
    }
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 1,
          cover_asset_id: "cover",
        })
      ).status,
    ).toBe(200);
    await expect(
      env.DB.prepare(
        "UPDATE assets SET status='deleted', deleted_at='now' WHERE id='cover'",
      ).run(),
    ).rejects.toThrow();
    expect(
      (
        await request(`/${timeline.id}`, "PATCH", {
          expected_version: 2,
          cover_asset_id: null,
        })
      ).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE assets SET status='deleted', deleted_at='now' WHERE id='cover'",
    ).run();
    expect(
      await env.DB.prepare("SELECT status FROM assets WHERE id='cover'").first(
        "status",
      ),
    ).toBe("deleted");
  });
  it("enforces timeline quota and event discriminators even when direct SQL bypasses request validation", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET timeline_limit=0 WHERE user_id='owner_a'",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO timelines (id, owner_id, title, created_at, updated_at) VALUES ('direct','owner_a','Story','now','now')",
      ).run(),
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE usage_quotas SET timeline_limit=1 WHERE user_id='owner_a'",
    ).run();
    const timeline = await create();
    await ready();
    for (const event of [
      "{",
      "{}",
      '{"kind":"date","date":"2024-01-01","calendar":"iso8601"}',
      '{"kind":"unknown","time_zone":"UTC"}',
    ])
      await expect(
        env.DB.prepare(`INSERT INTO timeline_items
      (id,timeline_id,owner_id,asset_id,position,caption,event_at,created_at,updated_at) VALUES ('invalid',?,'owner_a','asset_a',0,'',?,'now','now')`)
          .bind(timeline.id, event)
          .run(),
      ).rejects.toThrow();
    expect((await get(timeline.id)).items).toEqual([]);
  });
  it("uses a timeline-specific quota message instead of describing storage capacity", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET timeline_limit=0 WHERE user_id='owner_a'",
    ).run();
    const response = await request("", "POST", { title: "Over limit" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "TIMELINE_QUOTA_EXCEEDED",
        message: "Timeline quota exceeded.",
      },
    });
  });
});
