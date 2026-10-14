import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { cleanupExpiredUploads } from "../../src/assets/cleanup";
import type { Asset } from "../../src/assets/model";
import type { Bindings } from "../../src/bindings";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = {
  ...env,
  APP_ENV: "local",
  APP_ORIGIN: origin,
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_BUCKET_NAME: "ages-test",
  R2_ACCESS_KEY_ID: "test-access-id",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
};
const app = createApp();
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
let session: string;
const log = vi.fn();
type Intent = {
  asset: { id: string; status: string; visibility: string };
  upload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
};
type StorageQuota = {
  storage_limit_bytes: number;
  max_asset_bytes: number;
  storage_used_bytes: number;
  storage_reserved_bytes: number;
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  session = await seedUser();
  vi.spyOn(console, "info").mockImplementation(log);
  vi.spyOn(console, "error").mockImplementation(log);
});

function request(
  path: string,
  body?: unknown,
  cookie = session,
  config = bindings,
) {
  return app.request(
    `${origin}/api/assets${path}`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    config,
  );
}

function intent(overrides: Record<string, unknown> = {}, cookie = session) {
  return request(
    "/upload-intent",
    {
      filename: "moment.png",
      mime_type: "image/png",
      size_bytes: png.length,
      ...overrides,
    },
    cookie,
  );
}

async function createIntent(overrides: Record<string, unknown> = {}) {
  const response = await intent(overrides);
  expect(response.status).toBe(201);
  return response.json<Intent>();
}

async function asset(id: string) {
  const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?")
    .bind(id)
    .first<Asset>();
  if (!row) throw new Error("Missing asset");
  return row;
}

async function put(upload: Intent, bytes = png, mime = "image/png") {
  const row = await asset(upload.asset.id);
  // Local R2 exercises the same conditional write required by the signed S3 URL.
  return env.MEDIA.put(row.r2_key, bytes, {
    onlyIf: new Headers({
      "If-None-Match": upload.upload.headers["If-None-Match"] ?? "",
    }),
    httpMetadata: { contentType: mime },
  });
}

async function used() {
  return env.DB.prepare(
    "SELECT storage_used_bytes FROM usage_quotas WHERE user_id = 'owner_a'",
  ).first("storage_used_bytes");
}

describe("Upload capabilities and reservations", () => {
  it("creates a private pending asset before issuing an object-specific immutable PUT capability", async () => {
    const upload = await createIntent({
      filename: "../../malicious.png",
      captured_at: "2026-01-02T03:04:05+08:00",
    });
    const row = await asset(upload.asset.id);
    const url = new URL(upload.upload.url);
    expect(upload.asset).toMatchObject({
      status: "pending",
      visibility: "private",
    });
    expect(row.original_name).toBe("../../malicious.png");
    expect(row.r2_key).not.toContain("malicious");
    expect(row.r2_key).not.toContain("..");
    expect(row.captured_at).toBe("2026-01-02T03:04:05+08:00");
    expect(url.origin).toBe(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    );
    expect(url.pathname).toBe(`/ages-test/${row.r2_key}`);
    expect(upload.upload.method).toBe("PUT");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;if-none-match",
    );
    expect(upload.upload.headers).toEqual({
      "Content-Type": "image/png",
      "If-None-Match": "*",
    });
    expect(upload.upload.url).not.toContain("test-secret-key");
    expect(upload.asset).not.toHaveProperty("r2_key");
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
    expect(await used()).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("X-Amz-");
  });

  it("rejects anonymous creation and cross-origin mutations", async () => {
    expect((await intent({}, "")).status).toBe(401);
    const response = await app.request(
      `${origin}/api/assets/upload-intent`,
      {
        method: "POST",
        headers: { Cookie: session, Origin: "https://attacker.test" },
      },
      bindings,
    );
    expect(response.status).toBe(403);
  });

  it.each([
    { mime_type: "image/svg+xml" },
    { mime_type: "application/octet-stream" },
    { size_bytes: 0 },
    { size_bytes: -1 },
    { size_bytes: 1.5 },
    { owner_id: "another-owner" },
    { filename: "bad\nname.png" },
    { captured_at: "2026-01-01" },
  ])("rejects unsupported or forged intent metadata: %j", async (overrides) => {
    expect((await intent(overrides)).status).toBe(400);
  });

  it("does not allow large binary bodies through metadata endpoints", async () => {
    const response = await app.request(
      `${origin}/api/assets/upload-intent`,
      {
        method: "POST",
        headers: {
          Cookie: session,
          Origin: origin,
          "Content-Type": "image/png",
        },
        body: new Uint8Array(100_000),
      },
      bindings,
    );
    expect(response.status).toBe(413);
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
  });

  it("enforces both per-media and account-specific file limits", async () => {
    expect((await intent({ size_bytes: 25 * 1024 ** 2 + 1 })).status).toBe(413);
    expect(
      (
        await intent({
          mime_type: "video/mp4",
          size_bytes: 250 * 1024 ** 2 + 1,
        })
      ).status,
    ).toBe(413);
    await env.DB.prepare(
      "UPDATE usage_quotas SET max_asset_bytes = 10 WHERE user_id = 'owner_a'",
    ).run();
    expect((await intent()).status).toBe(413);
  });

  it.each(["video/mp4", "video/webm"])(
    "accepts an exact 250 MiB %s intent without uploading its body",
    async (mime_type) => {
      const maxVideoBytes = 250 * 1024 ** 2;
      await env.DB.prepare(
        "UPDATE usage_quotas SET max_asset_bytes = ?, storage_limit_bytes = ? WHERE user_id = 'owner_a'",
      )
        .bind(300 * 1024 ** 2, 1024 ** 3)
        .run();

      const response = await intent({
        filename: "moment.video",
        mime_type,
        size_bytes: maxVideoBytes,
      });
      expect(response.status).toBe(201);
      const upload = await response.json<Intent>();
      const row = await asset(upload.asset.id);
      expect(upload.asset).toMatchObject({
        status: "pending",
        visibility: "private",
      });
      expect(row).toMatchObject({
        owner_id: "owner_a",
        kind: "video",
        status: "pending",
        visibility: "private",
        mime_type,
        size_bytes: maxVideoBytes,
      });

      const me = await app.request(
        `${origin}/api/me`,
        { headers: { Cookie: session } },
        bindings,
      );
      expect(me.status).toBe(200);
      const quota = (await me.json<{ quota: StorageQuota }>()).quota;
      expect(quota).toMatchObject({
        storage_limit_bytes: 1024 ** 3,
        max_asset_bytes: 300 * 1024 ** 2,
        storage_used_bytes: 0,
        storage_reserved_bytes: maxVideoBytes,
      });

      const url = new URL(upload.upload.url);
      expect(upload.upload.method).toBe("PUT");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-length;content-type;host;if-none-match",
      );
      expect(upload.upload.headers).toEqual({
        "Content-Type": mime_type,
        "If-None-Match": "*",
      });
      expect((await env.MEDIA.list()).objects).toHaveLength(0);
    },
  );

  it.each(["video/mp4", "video/webm"])(
    "rejects a 250 MiB plus one byte %s intent without changing usage",
    async (mime_type) => {
      const oversizeVideoBytes = 250 * 1024 ** 2 + 1;
      await env.DB.prepare(
        "UPDATE usage_quotas SET max_asset_bytes = ?, storage_limit_bytes = ? WHERE user_id = 'owner_a'",
      )
        .bind(300 * 1024 ** 2, 1024 ** 3)
        .run();

      const pendingBefore = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM assets WHERE owner_id = 'owner_a' AND status = 'pending'",
      ).first("count");
      const meBefore = await app.request(
        `${origin}/api/me`,
        { headers: { Cookie: session } },
        bindings,
      );
      expect(meBefore.status).toBe(200);
      const quotaBefore = (await meBefore.json<{ quota: StorageQuota }>())
        .quota;
      expect(quotaBefore).toMatchObject({
        storage_limit_bytes: 1024 ** 3,
        max_asset_bytes: 300 * 1024 ** 2,
        storage_used_bytes: 0,
        storage_reserved_bytes: 0,
      });

      const response = await intent({
        filename: "moment.video",
        mime_type,
        size_bytes: oversizeVideoBytes,
      });
      expect(response.status).toBe(413);

      const pendingAfter = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM assets WHERE owner_id = 'owner_a' AND status = 'pending'",
      ).first("count");
      const meAfter = await app.request(
        `${origin}/api/me`,
        { headers: { Cookie: session } },
        bindings,
      );
      expect(meAfter.status).toBe(200);
      const quotaAfter = (await meAfter.json<{ quota: StorageQuota }>()).quota;
      expect(pendingAfter).toBe(pendingBefore);
      expect(quotaAfter.storage_reserved_bytes).toBe(
        quotaBefore.storage_reserved_bytes,
      );
      expect(quotaAfter.storage_used_bytes).toBe(
        quotaBefore.storage_used_bytes,
      );
      expect((await env.MEDIA.list()).objects).toHaveLength(0);
    },
  );

  it("fails closed without signing configuration and does not reserve storage", async () => {
    const response = await request(
      "/upload-intent",
      {
        filename: "moment.png",
        mime_type: "image/png",
        size_bytes: png.length,
      },
      session,
      { ...bindings, R2_SECRET_ACCESS_KEY: "" },
    );
    expect(response.status).toBe(503);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM assets").first(
        "count",
      ),
    ).toBe(0);
  });

  it("atomically reserves pending storage so simultaneous intents cannot oversubscribe", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET storage_limit_bytes = ? WHERE user_id = 'owner_a'",
    )
      .bind(png.length)
      .run();
    const responses = await Promise.all([intent(), intent(), intent()]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    expect(await used()).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT SUM(size_bytes) AS reserved FROM assets WHERE status = 'pending'",
      ).first("reserved"),
    ).toBe(png.length);
    expect(
      await (responses.find((r) => r.status === 403) as Response).json(),
    ).toMatchObject({ error: { code: "QUOTA_EXCEEDED" } });
  });

  it("releases expired reservations without allowing the expired upload to become ready", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET storage_limit_bytes = ? WHERE user_id = 'owner_a'",
    )
      .bind(png.length)
      .run();
    const old = await createIntent();
    await put(old);
    await env.DB.prepare(
      "UPDATE assets SET upload_expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    expect((await intent()).status).toBe(201);
    expect((await request(`/${old.asset.id}/complete`)).status).toBe(409);
    expect(await used()).toBe(0);
  });
});

describe("Upload finalization", () => {
  it("rejects a corrupt maximum-sample JPEG and retains only its pending reservation", async () => {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const upload = await createIntent({
      mime_type: "image/jpeg",
      size_bytes: bytes.length,
    });
    await put(upload, bytes, "image/jpeg");
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(422);
    expect((await asset(upload.asset.id)).status).toBe("failed");
    expect(await used()).toBe(0);
    const response = await app.request(
      `${origin}/api/me`,
      { headers: { Cookie: session } },
      bindings,
    );
    expect(await response.json()).toMatchObject({
      quota: { storage_used_bytes: 0, storage_reserved_bytes: bytes.length },
    });
  });

  it("checks ownership before looking up the object", async () => {
    const upload = await createIntent();
    const other = await seedUser("owner_b");
    expect(
      (await request(`/${upload.asset.id}/complete`, undefined, other)).status,
    ).toBe(404);
    expect((await asset(upload.asset.id)).status).toBe("pending");
  });

  it("keeps a missing object retryable during the upload window", async () => {
    const upload = await createIntent();
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(422);
    expect((await asset(upload.asset.id)).status).toBe("pending");
    await put(upload);
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(200);
  });

  it.each(["size", "mime", "signature"])(
    "rejects %s mismatches without consuming storage quota",
    async (kind) => {
      const upload = await createIntent();
      const bytes =
        kind === "size"
          ? png.slice(0, 10)
          : kind === "signature"
            ? new Uint8Array(png.length)
            : png;
      await put(upload, bytes, kind === "mime" ? "image/jpeg" : "image/png");
      expect((await request(`/${upload.asset.id}/complete`)).status).toBe(422);
      expect((await asset(upload.asset.id)).status).toBe("failed");
      expect(await used()).toBe(0);
    },
  );

  it("marks ready and charges storage exactly once even with concurrent completion", async () => {
    const upload = await createIntent();
    await put(upload);
    const responses = await Promise.all([
      request(`/${upload.asset.id}/complete`),
      request(`/${upload.asset.id}/complete`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const row = await asset(upload.asset.id);
    expect(row.status).toBe("ready");
    expect(row.width).toBe(1);
    expect(row.height).toBe(1);
    expect(row.etag).toBeTruthy();
    expect(await used()).toBe(png.length);
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(200);
    expect(await used()).toBe(png.length);
  });

  it("keeps an invalid upload reserved until its capability expires to prevent rapid quota recycling", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET storage_limit_bytes = ? WHERE user_id = 'owner_a'",
    )
      .bind(png.length)
      .run();
    const upload = await createIntent();
    await put(upload, new Uint8Array(png.length));
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(422);
    expect((await intent()).status).toBe(403);
    expect(await used()).toBe(0);
  });

  it("prevents the signed conditional PUT from overwriting a completed asset", async () => {
    const upload = await createIntent();
    await put(upload);
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(200);
    expect(await put(upload, new Uint8Array(png.length))).toBeNull();
    const saved = await env.MEDIA.get((await asset(upload.asset.id)).r2_key);
    expect(
      new Uint8Array((await saved?.arrayBuffer()) ?? new ArrayBuffer(0)),
    ).toEqual(png);
  });

  it("keeps completed storage counted when accepting further upload intents", async () => {
    await env.DB.prepare(
      "UPDATE usage_quotas SET storage_limit_bytes = ? WHERE user_id = 'owner_a'",
    )
      .bind(png.length)
      .run();
    const upload = await createIntent();
    await put(upload);
    await request(`/${upload.asset.id}/complete`);
    expect((await intent()).status).toBe(403);
  });

  it("reports pending reservations separately from completed storage in the authenticated quota", async () => {
    const upload = await createIntent();
    const me = () =>
      app.request(
        `${origin}/api/me`,
        { headers: { Cookie: session } },
        bindings,
      );
    expect(await (await me()).json()).toMatchObject({
      quota: { storage_used_bytes: 0, storage_reserved_bytes: png.length },
    });
    await put(upload);
    await request(`/${upload.asset.id}/complete`);
    expect(await (await me()).json()).toMatchObject({
      quota: { storage_used_bytes: png.length, storage_reserved_bytes: 0 },
    });
  });

  it("limits object reads and keeps late validation from resurrecting an expired reservation", async () => {
    const bytes = new Uint8Array(1024 ** 2);
    bytes.set(png);
    const upload = await createIntent({ size_bytes: bytes.length });
    await put(upload, bytes);
    const get = env.MEDIA.get.bind(env.MEDIA);
    const read = vi
      .spyOn(env.MEDIA, "get")
      .mockImplementation(async (key, options) => {
        const result = await get(key, options);
        await env.DB.prepare(
          "UPDATE assets SET upload_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        )
          .bind(upload.asset.id)
          .run();
        return result;
      });
    expect((await request(`/${upload.asset.id}/complete`)).status).toBe(409);
    expect(read).toHaveBeenCalledWith(expect.any(String), {
      range: { offset: 0, length: 256 * 1024 },
      onlyIf: { etagMatches: expect.any(String) },
    });
    expect(await used()).toBe(0);
    expect((await asset(upload.asset.id)).status).toBe("pending");
  });

  it("rejects storage identity changes and invalid status reversal in the database", async () => {
    const upload = await createIntent();
    await put(upload);
    await request(`/${upload.asset.id}/complete`);
    await expect(
      env.DB.prepare("UPDATE assets SET size_bytes = 1 WHERE id = ?")
        .bind(upload.asset.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE assets SET status = 'pending' WHERE id = ?")
        .bind(upload.asset.id)
        .run(),
    ).rejects.toThrow();
    expect(await used()).toBe(png.length);
  });

  it("cleans orphan uploads after expiry but preserves ready objects and their accounting", async () => {
    const ready = await createIntent();
    const abandoned = await createIntent();
    await put(ready);
    await put(abandoned);
    await request(`/${ready.asset.id}/complete`);
    await env.DB.prepare(
      "UPDATE assets SET upload_expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    await cleanupExpiredUploads(bindings);
    await cleanupExpiredUploads(bindings);
    expect((await asset(abandoned.asset.id)).status).toBe("purged");
    expect(
      await env.MEDIA.head((await asset(abandoned.asset.id)).r2_key),
    ).toBeNull();
    expect(
      await env.MEDIA.head((await asset(ready.asset.id)).r2_key),
    ).not.toBeNull();
    expect(await used()).toBe(png.length);
  });
});
