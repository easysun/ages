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

describe("Native Link analytics", () => {
  type AnalyticsReport = {
    timezone: "Asia/Taipei";
    from: string;
    to: string;
    total: number;
    days: { day: string; clicks: number }[];
    channels: {
      kind: "configured" | "other";
      label: string | null;
      clicks: number;
    }[];
    referrers: {
      kind: "host" | "other" | "direct";
      hostname: string | null;
      clicks: number;
    }[];
  };

  function dayInTaipei(date = new Date()) {
    return new Date(date.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  function resolve(
    slug: string,
    options: { method?: string; query?: string; headers?: HeadersInit } = {},
  ) {
    const query = options.query ? `?${options.query}` : "";
    return app.request(
      `${origin}/s/${slug}${query}`,
      {
        method: options.method ?? "GET",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
      bindings,
    );
  }

  async function addTargetLink(
    target:
      | { kind: "url"; url: string }
      | { kind: "timeline"; timeline_id: string }
      | { kind: "asset"; asset_id: string },
    slug: string,
  ) {
    const response = await request("", session, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ target, slug }),
    });
    expect(response.status).toBe(201);
    return (await response.json<{ link: { id: string; slug: string } }>()).link;
  }

  async function addAsset(id = "analytics-asset") {
    const key = `synthetic/owner_a/${id}`;
    const bytes = "0123456789";
    const object = await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: "video/mp4" },
    });
    const stamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO assets(
      id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,etag,
      upload_expires_at,created_at,updated_at
    ) VALUES(?,?,'video','synthetic.mp4','video/mp4',10,?,?,?,?,?)`)
      .bind(id, "owner_a", key, object?.etag, stamp, stamp, stamp)
      .run();
    await env.DB.prepare("UPDATE assets SET status='ready' WHERE id=?")
      .bind(id)
      .run();
    return { key, bytes };
  }

  async function addTimeline(id = "analytics-story") {
    const stamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO timelines(
      id,owner_id,title,visibility,created_at,updated_at
    ) VALUES(?,'owner_a','Story','unlisted',?,?)`)
      .bind(id, stamp, stamp)
      .run();
  }

  async function configureChannels(id: string, channels: string[]) {
    const response = await tracking(id, { ...emptyTracking, channels });
    expect(response.status).toBe(200);
  }

  function analytics(id: string, query = "", cookie = session) {
    return request(`/${id}/analytics${query ? `?${query}` : ""}`, cookie);
  }

  async function report(
    id: string,
    from = dayInTaipei(),
    to = from,
    cookie = session,
  ): Promise<AnalyticsReport> {
    const response = await analytics(
      id,
      `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      cookie,
    );
    expect(response.status).toBe(200);
    return response.json<AnalyticsReport>();
  }

  async function total(id: string) {
    return (await report(id)).total;
  }

  it("valid_resolution_counts_once_and_preserves_redirect_and_media_statuses", async () => {
    const external = await createLink("https://example.org/path?keep=1#part");
    await configureChannels(external.id, ["newsletter"]);
    const settings: LinkTracking = {
      ...emptyTracking,
      channels: ["newsletter"],
      utm: { utm_source: "ages" },
    };
    expect((await tracking(external.id, settings)).status).toBe(200);
    const redirected = await resolve(external.slug, {
      query: "ages_channel=newsletter",
      headers: {
        Referer: "https://News.Example.org:8443/story?raw-referrer-secret=1",
      },
    });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Cache-Control")).toContain("no-store");
    expect(redirected.headers.get("Location")).toBe(
      "https://example.org/path?keep=1&utm_source=ages#part",
    );
    const headRedirect = await resolve(external.slug, {
      method: "HEAD",
      query: "ages_channel=newsletter",
    });
    expect(headRedirect.status).toBe(302);
    expect(headRedirect.headers.get("Cache-Control")).toContain("no-store");
    expect(await total(external.id)).toBe(1);
    expect((await report(external.id)).channels).toEqual([
      { kind: "configured", label: "newsletter", clicks: 1 },
    ]);
    expect((await report(external.id)).referrers).toEqual([
      { kind: "host", hostname: "news.example.org", clicks: 1 },
    ]);

    const applicationTarget = await createLink(
      "https://ages.test/t/private?keep=1#moment",
    );
    expect((await tracking(applicationTarget.id, settings)).status).toBe(200);
    const appRedirect = await resolve(applicationTarget.slug);
    expect(appRedirect.status).toBe(302);
    expect(appRedirect.headers.get("Location")).toBe(
      "https://ages.test/t/private?keep=1#moment",
    );
    expect(await total(applicationTarget.id)).toBe(1);

    await addTimeline();
    const timelineLink = await addTargetLink(
      { kind: "timeline", timeline_id: "analytics-story" },
      "analytics-timeline",
    );
    const timelineRedirect = await resolve(timelineLink.slug);
    expect(timelineRedirect.status).toBe(302);
    expect(timelineRedirect.headers.get("Location")).toBe(
      `${origin}/t/analytics-story`,
    );
    expect(await total(timelineLink.id)).toBe(1);

    await addAsset();
    const assetLink = await addTargetLink(
      { kind: "asset", asset_id: "analytics-asset" },
      "analytics-asset-link",
    );
    const full = await resolve(assetLink.slug);
    expect(full.status).toBe(200);
    expect(full.headers.get("Cache-Control")).toContain("no-store");
    expect(new TextDecoder().decode(await full.arrayBuffer())).toBe(
      "0123456789",
    );
    const range = await resolve(assetLink.slug, {
      headers: { Range: "bytes=2-5" },
    });
    expect(range.status).toBe(206);
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe("2345");
    const ifRange = await resolve(assetLink.slug, {
      headers: { Range: "bytes=2-5", "If-Range": '"unknown"' },
    });
    expect(ifRange.status).toBe(200);
    expect(new TextDecoder().decode(await ifRange.arrayBuffer())).toBe(
      "0123456789",
    );
    const assetHead = await resolve(assetLink.slug, { method: "HEAD" });
    expect(assetHead.status).toBe(200);
    expect(assetHead.headers.get("Cache-Control")).toContain("no-store");
    expect(await total(assetLink.id)).toBe(3);
  });

  it("invalid_media_and_unavailable_resolutions_never_count", async () => {
    const { key } = await addAsset();
    const link = await addTargetLink(
      { kind: "asset", asset_id: "analytics-asset" },
      "analytics-invalid-media",
    );
    const head = await resolve(link.slug, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Cache-Control")).toContain("no-store");
    const unsatisfiable = await resolve(link.slug, {
      headers: { Range: "bytes=20-30" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("Cache-Control")).toContain("no-store");
    expect(await total(link.id)).toBe(0);

    await env.MEDIA.delete(key);
    expect((await resolve(link.slug)).status).toBe(404);
    expect(await total(link.id)).toBe(0);
    await env.MEDIA.put(key, "0123456789", {
      httpMetadata: { contentType: "video/mp4" },
    });
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementationOnce(
      async (objectKey, options) => {
        await env.MEDIA.put(objectKey, "changed!!!", {
          httpMetadata: { contentType: "video/mp4" },
        });
        return get(objectKey, options);
      },
    );
    const validatorMismatch = await resolve(link.slug);
    expect(validatorMismatch.status).toBe(404);
    expect(validatorMismatch.headers.get("Cache-Control")).toContain(
      "no-store",
    );
    expect(await total(link.id)).toBe(0);
    await env.MEDIA.put(key, "0123456789", {
      httpMetadata: { contentType: "video/mp4" },
    });

    await env.DB.prepare(
      "UPDATE assets SET moderation_blocked=1 WHERE id='analytics-asset'",
    ).run();
    expect((await resolve(link.slug)).status).toBe(404);
    await env.DB.prepare(
      "UPDATE assets SET moderation_blocked=0 WHERE id='analytics-asset'",
    ).run();
    await env.DB.prepare(
      "UPDATE distribution_links SET moderation_blocked=1 WHERE id=?",
    )
      .bind(link.id)
      .run();
    expect((await resolve(link.slug)).status).toBe(404);
    await env.DB.prepare(
      "UPDATE distribution_links SET moderation_blocked=0 WHERE id=?",
    )
      .bind(link.id)
      .run();
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(link.id)
      .run();
    expect((await resolve(link.slug)).status).toBe(404);
    await env.DB.prepare(
      "UPDATE distribution_links SET expires_at=NULL, active=0 WHERE id=?",
    )
      .bind(link.id)
      .run();
    expect((await resolve(link.slug)).status).toBe(404);
    expect(await total(link.id)).toBe(0);

    const urlLink = await createLink();
    await env.DB.prepare(
      "UPDATE distribution_links SET moderation_blocked=1 WHERE id=?",
    )
      .bind(urlLink.id)
      .run();
    expect((await resolve(urlLink.slug)).status).toBe(404);
    expect(await total(urlLink.id)).toBe(0);
  });

  it("parallel_new_hosts_stay_bounded", async () => {
    const link = await createLink();
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        resolve(link.slug, {
          headers: {
            Referer: `https://host-${index}.example.org/path?private=${index}`,
          },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(30).fill(302),
    );
    const result = await report(link.id);
    expect(result.total).toBe(30);
    expect(result.referrers).toHaveLength(21);
    expect(result.referrers.filter((row) => row.kind === "host")).toHaveLength(
      20,
    );
    expect(result.referrers.filter((row) => row.kind === "other")).toEqual([
      { kind: "other", hostname: null, clicks: 10 },
    ]);
    expect(result.referrers.reduce((sum, row) => sum + row.clicks, 0)).toBe(30);
  });

  it("same_day_channel_replacement_stays_bounded", async () => {
    const link = await createLink();
    for (let index = 0; index < 21; index++) {
      const label = `campaign-${index}`;
      await configureChannels(link.id, [label]);
      const response = await resolve(link.slug, {
        query: `ages_channel=${encodeURIComponent(label)}`,
      });
      expect(response.status).toBe(302);
    }
    const result = await report(link.id);
    const configured = result.channels.filter(
      (row) => row.kind === "configured",
    );
    expect(configured).toHaveLength(20);
    expect(
      Object.fromEntries(configured.map((row) => [row.label, row.clicks])),
    ).toEqual(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`campaign-${index}`, 1]),
      ),
    );
    expect(result.channels.filter((row) => row.kind === "other")).toEqual([
      { kind: "other", label: null, clicks: 1 },
    ]);
    expect(result.total).toBe(21);
    expect(result.channels.reduce((sum, row) => sum + row.clicks, 0)).toBe(21);
  });

  it("taipei_midnight_changes_day", async () => {
    const link = await createLink();
    await configureChannels(link.id, ["newsletter"]);
    const source = {
      query: "ages_channel=newsletter",
      headers: { Referer: "https://example.org/notes?private=1" },
    };
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-04T15:59:59.000Z"));
      expect((await resolve(link.slug, source)).status).toBe(302);
      vi.setSystemTime(new Date("2026-10-04T16:00:00.000Z"));
      expect((await resolve(link.slug, source)).status).toBe(302);
      const result = await report(link.id, "2026-10-04", "2026-10-05");
      expect(result).toMatchObject({
        timezone: "Asia/Taipei",
        from: "2026-10-04",
        to: "2026-10-05",
        total: 2,
        days: [
          { day: "2026-10-04", clicks: 1 },
          { day: "2026-10-05", clicks: 1 },
        ],
      });
      expect(result.channels).toEqual([
        { kind: "configured", label: "newsletter", clicks: 2 },
      ]);
      expect(result.referrers).toEqual([
        { kind: "host", hostname: "example.org", clicks: 2 },
      ]);
      expect(result.channels.reduce((sum, row) => sum + row.clicks, 0)).toBe(2);
      expect(result.referrers.reduce((sum, row) => sum + row.clicks, 0)).toBe(
        2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("source_totals_equal_daily_totals_and_never_store_request_identifiers", async () => {
    const link = await createLink();
    await configureChannels(link.id, ["email", "social"]);
    const cases = [
      {
        query: "ages_channel=email",
        headers: {
          Referer:
            "https://xn--bcher-kva.Org.:443/story?raw-referrer-secret=1#private",
          "User-Agent": "raw-user-agent-secret",
          "CF-Connecting-IP": "203.0.113.77",
        },
      },
      {
        query: "ages_channel=social",
        headers: { Referer: "https://social.example.org/path?private=1" },
      },
      {
        query: "ages_channel=unknown",
        headers: { Referer: "https://127.0.0.1/private" },
      },
      {
        query: "ages_channel=email&ages_channel=social",
        headers: { Referer: "https://email.example.org/private" },
      },
      { query: "", headers: {} },
    ];
    for (const item of cases)
      expect(
        (
          await resolve(link.slug, {
            query: item.query,
            headers: item.headers,
          })
        ).status,
      ).toBe(302);

    const result = await report(link.id);
    expect(result.total).toBe(5);
    expect(result.days.reduce((sum, row) => sum + row.clicks, 0)).toBe(
      result.total,
    );
    expect(result.channels.reduce((sum, row) => sum + row.clicks, 0)).toBe(
      result.total,
    );
    expect(result.referrers.reduce((sum, row) => sum + row.clicks, 0)).toBe(
      result.total,
    );
    expect(result.channels).toEqual(
      expect.arrayContaining([
        { kind: "configured", label: "email", clicks: 1 },
        { kind: "configured", label: "social", clicks: 1 },
        { kind: "other", label: null, clicks: 3 },
      ]),
    );
    expect(result.referrers).toEqual(
      expect.arrayContaining([
        { kind: "host", hostname: "xn--bcher-kva.org", clicks: 1 },
        { kind: "host", hostname: "social.example.org", clicks: 1 },
        { kind: "other", hostname: null, clicks: 1 },
        { kind: "host", hostname: "email.example.org", clicks: 1 },
        { kind: "direct", hostname: null, clicks: 1 },
      ]),
    );
    const stored = JSON.stringify(
      await Promise.all([
        env.DB.prepare("SELECT * FROM link_daily_totals WHERE link_id=?")
          .bind(link.id)
          .all(),
        env.DB.prepare("SELECT * FROM link_daily_channels WHERE link_id=?")
          .bind(link.id)
          .all(),
        env.DB.prepare("SELECT * FROM link_daily_referrers WHERE link_id=?")
          .bind(link.id)
          .all(),
      ]),
    );
    expect(stored).not.toContain("raw-referrer-secret");
    expect(stored).not.toContain("raw-user-agent-secret");
    expect(stored).not.toContain("203.0.113.77");
  });

  it("maps_local_or_private_referrer_hosts_and_userinfo_to_other", async () => {
    const link = await createLink();
    const referers = [
      "https://127.0.0.1/private",
      "http://[2001:db8::1]/private",
      "https://localhost/private",
      "https://media.localhost/private",
      "https://media.local/private",
      "https://media.internal/private",
      "https://media.test/private",
      "https://media.invalid/private",
      "https://media.example/private",
      "https://single/private",
      "https://user:secret@public.example.org/private",
      "ftp://public.example.org/private",
    ];
    const responses = await Promise.all(
      referers.map((Referer) => resolve(link.slug, { headers: { Referer } })),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(referers.length).fill(302),
    );
    const result = await report(link.id);
    expect(result.total).toBe(referers.length);
    expect(result.referrers).toEqual([
      { kind: "other", hostname: null, clicks: referers.length },
    ]);
  });

  it("keeps_inactive_history_owner_only_and_rejects_invalid_ranges", async () => {
    const link = await createLink();
    expect((await resolve(link.slug)).status).toBe(302);
    expect(
      (
        await request(`/${link.id}`, session, {
          method: "PATCH",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ active: false }),
        })
      ).status,
    ).toBe(200);
    expect((await report(link.id)).total).toBe(1);
    await expectError(await analytics(link.id, "", ""), 401, "UNAUTHENTICATED");
    await expectError(await analytics(link.id, "", other), 404, "NOT_FOUND");

    for (const query of [
      "from=2026-02-30&to=2026-03-01",
      "from=2026-03-02&to=2026-03-01",
      "from=2025-10-04&to=2026-10-05",
      "from=2026-03-01&from=2026-03-01&to=2026-03-02",
      "from=2026-03-01&to=2026-03-02&unknown=x",
    ])
      await expectError(
        await analytics(link.id, query),
        400,
        "INVALID_REQUEST",
      );

    const defaultReport = await analytics(link.id);
    expect(defaultReport.status).toBe(200);
    expect((await defaultReport.json<AnalyticsReport>()).days).toHaveLength(30);
    const maximum = await analytics(link.id, "from=2025-10-05&to=2026-10-05");
    expect(maximum.status).toBe(200);
    expect((await maximum.json<AnalyticsReport>()).days).toHaveLength(366);
  });

  it("rechecks_availability_inside_atomic_increment_batch", async () => {
    const link = await createLink();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("UPDATE distribution_links SET active=0 WHERE id=?")
        .bind(link.id)
        .run();
      return batch(statements);
    });
    await expectError(await resolve(link.slug), 404, "NOT_FOUND");
    expect(await total(link.id)).toBe(0);
    for (const table of [
      "link_daily_totals",
      "link_daily_channels",
      "link_daily_referrers",
    ])
      expect(
        await env.DB.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE link_id=?`,
        )
          .bind(link.id)
          .first("count"),
      ).toBe(0);
  });

  it("returns_internal_error_when_recording_fails_and_cancels_open_media", async () => {
    await addAsset();
    const link = await addTargetLink(
      { kind: "asset", asset_id: "analytics-asset" },
      "analytics-record-failure",
    );
    const cancel = vi.fn();
    const get = env.MEDIA.get.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "get").mockImplementationOnce(async (key, options) => {
      const object = await get(key, options);
      if (!object || !("body" in object)) return object;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      });
      return new Proxy(object, {
        get(target, property) {
          if (property === "body") return body;
          return Reflect.get(target, property, target);
        },
      });
    });
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(
      new Error("synthetic analytics write failure"),
    );
    await expectError(await resolve(link.slug), 500, "INTERNAL_ERROR");
    expect(cancel).toHaveBeenCalledTimes(1);
    const reportResponse = await analytics(link.id);
    expect(reportResponse.status).toBe(200);
    expect((await reportResponse.json<AnalyticsReport>()).total).toBe(0);
  });
});
