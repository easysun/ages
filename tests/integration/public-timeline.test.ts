import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Asset } from "../../src/assets/model";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
const date = "2026-01-01T00:00:00.000Z";
let session: string;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser();
  await seedUser("owner_b");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function request(path: string, init: RequestInit = {}, config = bindings) {
  return app.request(`${origin}${path}`, init, config);
}
async function asset(
  id: string,
  owner = "owner_a",
  kind = "image",
  status: Asset["status"] = "ready",
) {
  const bytes = kind === "video" ? new TextEncoder().encode("0123456789") : png;
  const mime = kind === "video" ? "video/mp4" : "image/png";
  const key = `synthetic/${owner}/${id}`;
  const stored = await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: "public, max-age=999999" },
  });
  await env.DB.prepare(`INSERT INTO assets (id, owner_id, kind, status, original_name, mime_type, size_bytes,
    r2_key, etag, width, height, upload_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'synthetic.png', ?, ?, ?, ?, 1, 1, ?, ?, ?)`)
    .bind(
      id,
      owner,
      kind,
      status,
      mime,
      bytes.length,
      key,
      stored?.etag,
      date,
      date,
      date,
    )
    .run();
  return key;
}
async function timeline(
  id = "story",
  visibility = "unlisted",
  title = "A story",
  cover: string | null = null,
  owner = "owner_a",
) {
  await env.DB.prepare(
    "INSERT INTO timelines (id, owner_id, title, visibility, cover_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, owner, title, visibility, cover, date, date)
    .run();
}
async function item(
  id: string,
  assetId: string,
  timelineId = "story",
  position = 0,
  caption = "A moment",
  event: unknown = null,
  owner = "owner_a",
) {
  await env.DB.prepare(`INSERT INTO timeline_items (id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      timelineId,
      owner,
      assetId,
      position,
      caption,
      event === null ? null : JSON.stringify(event),
      date,
      date,
    )
    .run();
}
async function unavailable(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = await response.text();
  expect(body).not.toMatch(/Report this Timeline|Report an Ages Link|\/report/);
  expect(body).not.toMatch(
    /A secret|synthetic|originals|r2_key|owner_a|og:image|og:title/,
  );
}

describe("Canonical public timeline SSR", () => {
  it("serves escaped OG and story text without JavaScript and uses the configured canonical origin", async () => {
    const title = 'A <script>alert("title")</script> & memory';
    const caption = 'A <img src=x onerror="alert(1)"> & "moment"';
    await asset("photo");
    await timeline("story", "unlisted", title);
    await item("item", "photo", "story", 0, caption);
    const response = await request("/t/story?ignored=tracking", {
      headers: { Host: "attacker.test", "X-Forwarded-Host": "attacker.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain(
      '<link rel="canonical" href="https://ages.test/t/story">',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://ages.test/t/story">',
    );
    expect(html).toContain(
      'property="og:title" content="A &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt; &amp; memory"',
    );
    expect(html).toContain(
      'property="og:description" content="A &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;moment&quot;"',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://ages.test/t/story/media/photo">',
    );
    expect(html).toContain(
      "A &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;moment&quot;",
    );
    expect(html).not.toMatch(
      /<script\b|<img src=x|attacker\.test|r2_key|etag|last_mutation_token|owner_a|synthetic\/owner/,
    );
    expect(html).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
    expect(html).toContain("<main");
    expect(html).toContain("<ol");
  });

  it.each(["unlisted", "public"])(
    "reflects %s indexing policy in HTML and headers",
    async (visibility) => {
      await timeline("story", visibility);
      const response = await request("/t/story");
      expect(response.status).toBe(200);
      const robots =
        visibility === "unlisted" ? "noindex, nofollow" : "index, follow";
      expect(response.headers.get("X-Robots-Tag")).toBe(robots);
      expect(await response.text()).toContain(
        `<meta name="robots" content="${robots}">`,
      );
    },
  );

  it.each(["unlisted", "public"] as const)(
    "offers both reporting links for a visible %s timeline with an encoded identifier",
    async (visibility) => {
      const id = "story&memory";
      await timeline(id, visibility);
      const response = await request(`/t/${encodeURIComponent(id)}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        `href="/report?kind=timeline&amp;timeline_id=${encodeURIComponent(id)}">Report this Timeline</a>`,
      );
      expect(html).toContain('href="/report">Report an Ages Link</a>');
    },
  );

  it("never leaks a private timeline page, OG or cover even with an owner cookie", async () => {
    await asset("photo");
    await timeline("secret", "private", "A secret", "photo");
    await item("item", "photo", "secret");
    for (const cookie of [undefined, session]) {
      await unavailable(
        await request("/t/secret", {
          headers: cookie ? { Cookie: cookie } : {},
        }),
      );
      await unavailable(
        await request("/t/secret/media/photo", {
          headers: cookie ? { Cookie: cookie } : {},
        }),
      );
      const head = await request("/t/secret/media/photo", { method: "HEAD" });
      expect(head.status).toBe(404);
      expect(await head.text()).toBe("");
    }
    await unavailable(await request("/t/missing"));
  });

  it("preserves narrative order and explicit calendar precision while rendering video and images", async () => {
    await asset("photo");
    await asset("video", "owner_a", "video");
    await timeline();
    await item("second", "video", "story", 9, "Second", {
      kind: "instant",
      instant: "2026-01-01T00:30:00.000Z",
      time_zone: "Asia/Taipei",
    });
    await item("first", "photo", "story", 3, "First", {
      kind: "date",
      date: "2024-02-29",
      time_zone: "Asia/Taipei",
      calendar: "iso8601",
    });
    const html = await (await request("/t/story")).text();
    expect(html.indexOf("First")).toBeLessThan(html.lastIndexOf("Second"));
    expect(html).toContain('<time datetime="2024-02-29">2024-02-29</time>');
    expect(html).toContain('datetime="2026-01-01T00:30:00.000Z"');
    expect(html).toContain("Asia/Taipei");
    expect(html).toContain('<video controls preload="metadata"');
    expect(html).toContain('loading="lazy"');
  });

  it("selects an image cover outside the item set for OG, but never labels video as og:image", async () => {
    await asset("cover");
    await asset("video", "owner_a", "video");
    await timeline("story", "public", "A story", "cover");
    await item("item", "video");
    const html = await (await request("/t/story")).text();
    expect(html).toContain(
      'property="og:image" content="https://ages.test/t/story/media/cover"',
    );
    expect((await request("/t/story/media/cover")).status).toBe(200);
    await env.DB.prepare(
      "UPDATE timelines SET cover_asset_id='video' WHERE id='story'",
    ).run();
    expect(await (await request("/t/story")).text()).not.toContain(
      'property="og:image"',
    );
  });

  it("keeps the same canonical URL after a fourth moment is appended through the owner API", async () => {
    await timeline();
    for (let i = 0; i < 3; i++) {
      await asset(`photo${i}`);
      await item(`item${i}`, `photo${i}`, "story", i, `Moment ${i}`);
    }
    const before = await (await request("/t/story")).text();
    await asset("fourth");
    const append = await request("/api/timelines/story/items", {
      method: "POST",
      headers: {
        Cookie: session,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expected_version: 1,
        asset_id: "fourth",
        caption: "Fourth moment",
      }),
    });
    expect(append.status).toBe(201);
    const after = await (await request("/t/story")).text();
    for (const html of [before, after])
      expect(html).toContain(
        '<link rel="canonical" href="https://ages.test/t/story">',
      );
    expect(before).not.toContain("Fourth moment");
    expect(after).toContain("Fourth moment");
  });

  it("rechecks visibility for page, OG and media after an earlier public request", async () => {
    await asset("photo");
    await timeline("story", "public", "A secret", "photo");
    await item("item", "photo");
    expect((await request("/t/story")).status).toBe(200);
    expect((await request("/t/story/media/photo")).status).toBe(200);
    await env.DB.prepare(
      "UPDATE timelines SET visibility='private' WHERE id='story'",
    ).run();
    await unavailable(await request("/t/story"));
    await unavailable(await request("/t/story/media/photo"));
  });
});

describe("Timeline-scoped media authorization", () => {
  it("blocks unattached and foreign media and cannot use a public asset visibility to bypass membership", async () => {
    await asset("attached");
    await asset("unused");
    await asset("foreign", "owner_b");
    await timeline();
    await item("item", "attached");
    await env.DB.prepare(
      "UPDATE assets SET visibility='public' WHERE id='unused'",
    ).run();
    for (const id of ["unused", "foreign", "missing"])
      await unavailable(await request(`/t/story/media/${id}`));
    await unavailable(await request("/t/missing/media/attached"));
  });

  it("shares one asset through independently authorized timelines and rejects a third timeline", async () => {
    await asset("shared");
    await timeline("one", "public");
    await timeline("two", "unlisted");
    await timeline("three", "public");
    await item("one-item", "shared", "one");
    await item("two-item", "shared", "two");
    expect((await request("/t/one/media/shared")).status).toBe(200);
    expect((await request("/t/two/media/shared")).status).toBe(200);
    await unavailable(await request("/t/three/media/shared"));
    await env.DB.prepare(
      "DELETE FROM timeline_items WHERE timeline_id='one'",
    ).run();
    await unavailable(await request("/t/one/media/shared"));
    expect((await request("/t/two/media/shared")).status).toBe(200);
  });

  it.each(["pending", "failed", "deleted", "purged"] as const)(
    "never streams %s assets",
    async (status) => {
      await asset("a", "owner_a", "video", status);
      await timeline();
      await unavailable(await request("/t/story/media/a"));
    },
  );

  it("streams verified bytes with private no-store and without exposing object identity", async () => {
    await asset("video", "owner_a", "video");
    await timeline();
    await item("item", "video");
    const response = await request("/t/story/media/video");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBeNull();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "0123456789",
    );
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ])("streams a valid video range %s", async (range, body, contentRange) => {
    await asset("video", "owner_a", "video");
    await timeline();
    await item("item", "video");
    const response = await request("/t/story/media/video", {
      headers: { Range: range },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(body);
  });

  it.each(["bytes=10-", "bytes=4-2", "bytes=1-2,4-5", "invalid"])(
    "returns 416 for invalid range %s",
    async (range) => {
      await asset("video", "owner_a", "video");
      await timeline();
      await item("item", "video");
      const response = await request("/t/story/media/video", {
        headers: { Range: range },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
  );

  it("HEAD reports full metadata without fetching a body and ignores Range", async () => {
    await asset("video", "owner_a", "video");
    await timeline();
    await item("item", "video");
    const get = vi.spyOn(env.MEDIA, "get");
    const response = await request("/t/story/media/video", {
      method: "HEAD",
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects changed or missing R2 objects", async () => {
    const key = await asset("video", "owner_a", "video");
    await timeline();
    await item("item", "video");
    await env.MEDIA.put(key, "xxxxxxxxxx", {
      httpMetadata: { contentType: "video/mp4" },
    });
    await unavailable(await request("/t/story/media/video"));
    expect(
      (await request("/t/story/media/video", { method: "HEAD" })).status,
    ).toBe(404);
    await env.MEDIA.delete(key);
    await unavailable(await request("/t/story/media/video"));
  });

  it.each(["xxxxxxxxxx", "0123456789"])(
    "rejects an object replacement during streaming, including equal bytes: %s",
    async (bytes) => {
      const key = await asset("video", "owner_a", "video");
      await timeline();
      await item("item", "video");
      const get = env.MEDIA.get.bind(env.MEDIA);
      vi.spyOn(env.MEDIA, "get").mockImplementation(
        async (objectKey, options) => {
          await env.MEDIA.put(key, bytes, {
            httpMetadata: { contentType: "video/mp4" },
          });
          return get(objectKey, options);
        },
      );
      const response = await request("/t/story/media/video");
      expect(response.headers.get("Content-Length")).toBeNull();
      await unavailable(response);
    },
  );
});
