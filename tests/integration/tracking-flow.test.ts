import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Bindings } from "../../src/bindings";
import { createTrackingApp } from "../../src/tracking/index";
import { seedUser } from "../helpers/auth";

const appOrigin = "http://127.0.0.1:8797";
const trackingOrigin = "http://localhost:8798";
const bindings: Bindings = {
  ...env,
  APP_ENV: "local",
  APP_ORIGIN: appOrigin,
  TRACKING_ORIGIN: trackingOrigin,
};
const app = createApp();
const trackingApp = createTrackingApp();
let session: string;
const customParameters = [
  { key: "note", value: "</script><img src=x onerror=alert(1)>" },
  { key: "send_to", value: "G-ATTACKER1" },
  {
    key: "page_location",
    value: "https://attacker.example.test/ticket-secret",
  },
  { key: "transport_url", value: "https://attacker.example.test/collect" },
  { key: "event_callback", value: "continueNow" },
  { key: "event", value: "attacker_route" },
  { key: "field_1", value: "a".repeat(100) },
  { key: "field_2", value: "b".repeat(100) },
  { key: "field_3", value: "c".repeat(100) },
  { key: "field_4", value: "d".repeat(100) },
];

type CreatedLink = { id: string; slug: string };

function request(path: string, init: RequestInit = {}) {
  return app.request(
    `${appOrigin}${path}`,
    {
      ...init,
      headers: {
        ...(init.method && init.method !== "GET" ? { Origin: appOrigin } : {}),
        ...init.headers,
      },
    },
    bindings,
  );
}

async function createLink(
  target:
    | { kind: "url"; url: string }
    | { kind: "timeline"; timeline_id: string }
    | { kind: "asset"; asset_id: string } = {
    kind: "url",
    url: "https://destination.example.test/private-path?destination_secret=private#story",
  },
): Promise<CreatedLink> {
  const response = await request("/api/links", {
    method: "POST",
    headers: {
      Cookie: session,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target,
      slug: `ticket-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ link: CreatedLink }>()).link;
}

async function configureProvider(linkId: string) {
  const owner = await request("/api/me/tracking/providers", {
    method: "PUT",
    headers: {
      Cookie: session,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ga4_measurement_id: "G-ABC123",
      meta_pixel_id: null,
      gtm_container_id: null,
      ga4_route: "direct",
      meta_route: "direct",
    }),
  });
  expect(owner.status).toBe(200);
  const settings = await request(`/api/links/${linkId}/tracking`, {
    method: "PUT",
    headers: {
      Cookie: session,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tags: [],
      channels: ["newsletter"],
      utm: {
        utm_source: "ages",
        utm_medium: "m".repeat(100),
        utm_campaign: "c".repeat(100),
        utm_term: "t".repeat(100),
        utm_content: "v".repeat(100),
      },
      custom: customParameters,
    }),
  });
  expect(settings.status).toBe(200);
}

async function linkClickCount(linkId: string) {
  const row = await env.DB.prepare(
    "SELECT clicks FROM link_daily_totals WHERE link_id = ?",
  )
    .bind(linkId)
    .first<{ clicks: number }>();
  return row?.clicks ?? 0;
}

async function ticketCount(linkId: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM tracking_tickets WHERE link_id = ?",
  )
    .bind(linkId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function ticketHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function insertTicket(
  link: CreatedLink,
  token = "a".repeat(64),
  expiresAt = new Date(Date.now() + 300_000).toISOString(),
) {
  const row = await env.DB.prepare(
    "SELECT target_kind FROM distribution_links WHERE id = ?",
  )
    .bind(link.id)
    .first<{ target_kind: string }>();
  const event = {
    event_name: "ages_link_click",
    link_id: link.id,
    target_kind: row?.target_kind ?? "url",
    channel: "Other",
    utm: {},
    custom: [],
  };
  await env.DB.prepare(`INSERT INTO tracking_tickets (
    token_hash,link_id,target_kind,event_json,providers_json,expires_at
  ) VALUES(?,?,?,?,'{"ga4":null,"meta":null,"gtm":null}',?)`)
    .bind(
      await ticketHash(token),
      link.id,
      event.target_kind,
      JSON.stringify(event),
      expiresAt,
    )
    .run();
  return token;
}

async function continueTicket(
  token: string,
  origin = trackingOrigin,
  body?: string,
) {
  return request("/s/continue", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ?? `token=${encodeURIComponent(token)}`,
  });
}

async function seedAsset(id: string, withObject = true) {
  const bytes = new TextEncoder().encode("0123456789");
  const key = `synthetic/${id}`;
  const stored = withObject
    ? await env.MEDIA.put(key, bytes, {
        httpMetadata: { contentType: "video/mp4" },
      })
    : null;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO assets (
    id,owner_id,kind,status,original_name,mime_type,size_bytes,r2_key,etag,
    upload_expires_at,created_at,updated_at
  ) VALUES(?,'owner_a','video','ready','Synthetic video.mp4','video/mp4',?, ?, ?,?,?,?)`)
    .bind(
      id,
      bytes.length,
      key,
      stored?.etag ?? "missing-object-etag",
      now,
      now,
      now,
    )
    .run();
  return bytes;
}

function trackAssetBodyCancellation() {
  let cancelCalls = 0;
  const get = env.MEDIA.get.bind(env.MEDIA);
  vi.spyOn(env.MEDIA, "get").mockImplementationOnce(async (key, options) => {
    const object = await get(key, options);
    if (!object || !("body" in object)) return object;
    const body = new ReadableStream<Uint8Array>({
      cancel: async (reason) => {
        cancelCalls += 1;
        await object.body.cancel(reason);
      },
    });
    return new Proxy(object, {
      get: (target, property) =>
        property === "body" ? body : Reflect.get(target, property, target),
    });
  });
  return () => cancelCalls;
}

async function seedTimeline(id: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO timelines (
    id,owner_id,title,visibility,created_at,updated_at
  ) VALUES(?,'owner_a','Synthetic story','unlisted',?,?)`)
    .bind(id, now, now)
    .run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser("owner_a");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isolated provider consent flow", () => {
  it("rejects a tracking origin that shares the app cookie hostname", async () => {
    const response = await trackingApp.request(
      "https://app.example.test:8798/not-a-ticket",
      {},
      {
        DB: env.DB,
        APP_ENV: "production",
        APP_ORIGIN: "https://app.example.test",
        TRACKING_ORIGIN: "https://app.example.test:8798",
      },
    );

    expect(response.status).toBe(503);
  });

  it("rejects loopback HTTP tracking origins outside the local environment", async () => {
    const response = await trackingApp.request(
      "http://localhost:8798/not-a-ticket",
      {},
      {
        DB: env.DB,
        APP_ENV: "production",
        APP_ORIGIN: "https://app.example.test",
        TRACKING_ORIGIN: "http://localhost:8798",
      },
    );

    expect(response.status).toBe(503);
  });

  it("redirects a provider-enabled GET to one opaque ticket and stores only a bounded event", async () => {
    const link = await createLink();
    await configureProvider(link.id);

    const response = await request(`/s/${link.slug}?ages_channel=newsletter`, {
      headers: {
        Referer: "https://referrer-secret.example.test/story?private=1",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(
      new RegExp(`^${trackingOrigin}/[0-9a-f]{64}$`),
    );
    expect(response.headers.get("Location")).not.toContain(
      "destination.example.test",
    );
    expect(await ticketCount(link.id)).toBe(1);
    expect(await linkClickCount(link.id)).toBe(1);

    const ticket = await env.DB.prepare(
      "SELECT token_hash, target_kind, event_json, providers_json, expires_at, consumed_at FROM tracking_tickets WHERE link_id = ?",
    )
      .bind(link.id)
      .first<{
        token_hash: string;
        target_kind: string;
        event_json: string;
        providers_json: string;
        expires_at: string;
        consumed_at: string | null;
      }>();
    expect(ticket).not.toBeNull();
    expect(ticket?.target_kind).toBe("url");
    expect(ticket?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket?.consumed_at).toBeNull();
    expect(Date.parse(ticket?.expires_at ?? "") - Date.now()).toBeGreaterThan(
      299_000,
    );
    expect(
      Date.parse(ticket?.expires_at ?? "") - Date.now(),
    ).toBeLessThanOrEqual(300_000);
    const event = JSON.parse(ticket?.event_json ?? "null") as Record<
      string,
      unknown
    >;
    expect(event).toEqual({
      event_name: "ages_link_click",
      link_id: link.id,
      target_kind: "url",
      channel: "newsletter",
      utm: {
        utm_source: "ages",
        utm_medium: "m".repeat(100),
        utm_campaign: "c".repeat(100),
        utm_term: "t".repeat(100),
        utm_content: "v".repeat(100),
      },
      custom: customParameters,
    });
    expect(ticket?.event_json).not.toContain("destination_secret");
    expect(ticket?.event_json).not.toContain("referrer-secret");
    expect(ticket?.providers_json).not.toContain("owner_a");

    const token = new URL(
      response.headers.get("Location") ?? "",
    ).pathname.slice(1);
    const trackingBindings = {
      DB: env.DB,
      APP_ENV: "local",
      APP_ORIGIN: appOrigin,
      TRACKING_ORIGIN: trackingOrigin,
    };
    const firstView = await trackingApp.request(
      `${trackingOrigin}/${token}`,
      {},
      trackingBindings,
    );
    const secondView = await trackingApp.request(
      `${trackingOrigin}/${token}`,
      {},
      trackingBindings,
    );
    const queryView = await trackingApp.request(
      `${trackingOrigin}/${token}?ticket=${token}`,
      {},
      trackingBindings,
    );
    expect(firstView.status).toBe(200);
    expect(secondView.status).toBe(200);
    expect(queryView.status).toBe(404);
    expect(firstView.headers.get("Set-Cookie")).toBeNull();
    expect(firstView.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(firstView.headers.get("Cache-Control")).toContain("no-store");
    expect(firstView.headers.get("Referrer-Policy")).toBe("strict-origin");
    const trackingHtml = await firstView.text();
    expect(trackingHtml).toContain("Before you continue");
    expect(trackingHtml).toContain("Google Analytics 4");
    expect(trackingHtml).toContain("ages_link_click");
    expect(trackingHtml).not.toContain("destination_secret");
    expect(trackingHtml).not.toContain("destination.example.test");
    expect(trackingHtml).not.toContain("referrer-secret");
    const stillUnconsumed = await env.DB.prepare(
      "SELECT consumed_at FROM tracking_tickets WHERE token_hash = ?",
    )
      .bind(ticket?.token_hash)
      .first<{ consumed_at: string | null }>();
    expect(stillUnconsumed?.consumed_at).toBeNull();
  });

  it("keeps HEAD direct without creating a ticket or counting a click", async () => {
    const link = await createLink();
    await configureProvider(link.id);

    const response = await request(`/s/${link.slug}`, { method: "HEAD" });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://destination.example.test");
    expect(location.searchParams.get("destination_secret")).toBe("private");
    expect(location.searchParams.get("utm_source")).toBe("ages");
    expect(location.searchParams.get("note")).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
    expect(location.hash).toBe("#story");
    expect(await ticketCount(link.id)).toBe(0);
    expect(await linkClickCount(link.id)).toBe(0);
  });

  it("preserves direct delivery and one native count when no provider is enabled", async () => {
    const link = await createLink();

    const response = await request(`/s/${link.slug}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://destination.example.test/private-path?destination_secret=private#story",
    );
    expect(await ticketCount(link.id)).toBe(0);
    expect(await linkClickCount(link.id)).toBe(1);
  });

  it("does not count or redirect when the initial ticket write fails", async () => {
    const link = await createLink();
    await configureProvider(link.id);
    await env.DB.prepare(`CREATE TRIGGER fail_provider_ticket BEFORE INSERT ON tracking_tickets
      BEGIN SELECT RAISE(ABORT, 'test_ticket_insert_failure'); END`).run();

    const response = await request(`/s/${link.slug}`);

    expect(response.status).toBe(500);
    expect(response.headers.get("Location")).toBeNull();
    expect(await linkClickCount(link.id)).toBe(0);
  });

  it("consumes a valid ticket once and continues to its destination without a second count", async () => {
    const link = await createLink();
    const settings = await request(`/api/links/${link.id}/tracking`, {
      method: "PUT",
      headers: {
        Cookie: session,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tags: [],
        channels: [],
        utm: {
          utm_source: "ages",
          utm_medium: "m".repeat(100),
          utm_campaign: "c".repeat(100),
          utm_term: "t".repeat(100),
          utm_content: "v".repeat(100),
        },
        custom: [{ key: "note", value: "a bounded value" }],
      }),
    });
    expect(settings.status).toBe(200);
    const token = await insertTicket(link);

    const response = await continueTicket(token);

    const expected = new URL(
      "https://destination.example.test/private-path?destination_secret=private#story",
    );
    expected.searchParams.set("utm_source", "ages");
    expected.searchParams.set("utm_medium", "m".repeat(100));
    expected.searchParams.set("utm_campaign", "c".repeat(100));
    expected.searchParams.set("utm_term", "t".repeat(100));
    expected.searchParams.set("utm_content", "v".repeat(100));
    expected.searchParams.set("note", "a bounded value");
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const continuationHtml = await response.text();
    expect(continuationHtml).toContain('http-equiv="refresh"');
    expect(continuationHtml).toContain('<a href="');
    expect(continuationHtml).toContain(expected.href.replaceAll("&", "&amp;"));
    expect(continuationHtml).not.toContain("<script");
    expect(continuationHtml).not.toContain(token);
    expect(await linkClickCount(link.id)).toBe(0);
    const consumed = await env.DB.prepare(
      "SELECT consumed_at FROM tracking_tickets WHERE token_hash = ?",
    )
      .bind(await ticketHash(token))
      .first<{ consumed_at: string | null }>();
    expect(consumed?.consumed_at).not.toBeNull();
    const reused = await continueTicket(token);
    expect(reused.status).toBe(404);
    expect(reused.headers.get("Location")).toBeNull();
  });

  it("requires exact tracking Origin and exactly one bounded token field", async () => {
    const link = await createLink();
    const token = await insertTicket(link);

    expect(
      (await continueTicket(token, "http://localhost:8798.attacker.test"))
        .status,
    ).toBe(403);
    expect(
      (
        await continueTicket(
          token,
          trackingOrigin,
          `token=${token}&token=${token}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await continueTicket(
          token,
          trackingOrigin,
          `token=${token}&extra=${"x".repeat(4_100)}`,
        )
      ).status,
    ).toBe(413);
    const untouched = await env.DB.prepare(
      "SELECT consumed_at FROM tracking_tickets WHERE token_hash = ?",
    )
      .bind(await ticketHash(token))
      .first<{ consumed_at: string | null }>();
    expect(untouched?.consumed_at).toBeNull();
  });

  it("consumes before checking live Link availability and never redirects a revoked Link", async () => {
    const link = await createLink();
    const token = await insertTicket(link);
    await env.DB.prepare(
      "UPDATE distribution_links SET active = 0 WHERE id = ?",
    )
      .bind(link.id)
      .run();

    const response = await continueTicket(token);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(await linkClickCount(link.id)).toBe(0);
    const consumed = await env.DB.prepare(
      "SELECT consumed_at FROM tracking_tickets WHERE token_hash = ?",
    )
      .bind(await ticketHash(token))
      .first<{ consumed_at: string | null }>();
    expect(consumed?.consumed_at).not.toBeNull();
  });

  it("rechecks Timeline visibility after the visitor leaves the consent page", async () => {
    const timelineId = "tracking-story";
    await seedTimeline(timelineId);
    const link = await createLink({
      kind: "timeline",
      timeline_id: timelineId,
    });
    const token = await insertTicket(link);
    await env.DB.prepare(
      "UPDATE timelines SET visibility = 'private' WHERE id = ?",
    )
      .bind(timelineId)
      .run();

    const response = await continueTicket(token);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(await linkClickCount(link.id)).toBe(0);
  });

  it("does not ticket or count a provider-enabled Asset Link whose R2 media is missing", async () => {
    await seedAsset("missing-tracking-media", false);
    const link = await createLink({
      kind: "asset",
      asset_id: "missing-tracking-media",
    });
    await configureProvider(link.id);

    const response = await request(`/s/${link.slug}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(await ticketCount(link.id)).toBe(0);
    expect(await linkClickCount(link.id)).toBe(0);
  });

  it("cancels a prepared Range response before redirecting an available Asset Link", async () => {
    await seedAsset("tracking-range-media");
    const link = await createLink({
      kind: "asset",
      asset_id: "tracking-range-media",
    });
    await configureProvider(link.id);
    const cancellationCount = trackAssetBodyCancellation();

    const response = await request(`/s/${link.slug}`, {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(
      new RegExp(`^${trackingOrigin}/[0-9a-f]{64}$`),
    );
    for (const header of [
      "Content-Type",
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
    expect(cancellationCount()).toBe(1);
    expect(await ticketCount(link.id)).toBe(1);
    expect(await linkClickCount(link.id)).toBe(1);
  });

  it("cancels Asset media and clears prepared headers when ticket creation fails", async () => {
    await seedAsset("tracking-ticket-failure-media");
    const link = await createLink({
      kind: "asset",
      asset_id: "tracking-ticket-failure-media",
    });
    await configureProvider(link.id);
    await env.DB.prepare(`CREATE TRIGGER fail_provider_ticket BEFORE INSERT ON tracking_tickets
      BEGIN SELECT RAISE(ABORT, 'test_ticket_insert_failure'); END`).run();
    const cancellationCount = trackAssetBodyCancellation();

    const response = await request(`/s/${link.slug}`, {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Location")).toBeNull();
    for (const header of [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(cancellationCount()).toBe(1);
    expect(await ticketCount(link.id)).toBe(0);
    expect(await linkClickCount(link.id)).toBe(0);
  });

  it("continues an Asset Link to its no-loop media route with normal Range and HEAD behavior", async () => {
    await seedAsset("tracking-media");
    const link = await createLink({
      kind: "asset",
      asset_id: "tracking-media",
    });
    await configureProvider(link.id);

    const initial = await request(`/s/${link.slug}`);
    expect(initial.status).toBe(302);
    const token = new URL(initial.headers.get("Location") ?? "").pathname.slice(
      1,
    );
    const continued = await continueTicket(token);
    expect(continued.status).toBe(302);
    expect(continued.headers.get("Location")).toBe(
      `${appOrigin}/s/${link.slug}/media`,
    );
    const range = await request(`/s/${link.slug}/media`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("2345");
    const head = await request(`/s/${link.slug}/media`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(await ticketCount(link.id)).toBe(1);
    expect(await linkClickCount(link.id)).toBe(1);
  });
});
