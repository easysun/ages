import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Asset } from "../../src/assets/model";
import type { Bindings } from "../../src/bindings";
import worker from "../../src/index";
import { seedUser } from "../helpers/auth";

const origin = "https://ages.test";
const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
const app = createApp();
const now = Date.parse("2026-10-04T00:00:15.000Z");
const day = 24 * 60 * 60 * 1000;
let session: string;
const infoLog = vi.fn();
const errorLog = vi.fn();
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  session = await seedUser();
  vi.spyOn(console, "info").mockImplementation(infoLog);
  vi.spyOn(console, "error").mockImplementation(errorLog);
});
afterEach(() => vi.useRealTimers());
function request(
  path: string,
  method = "GET",
  cookie = session,
  ip = "203.0.113.1",
  extra: Record<string, string> = {},
  config = bindings,
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "CF-Connecting-IP": ip,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
    config,
  );
}
async function seedAsset(
  id = "a",
  status: Asset["status"] = "ready",
  deletedAt = now - 30 * day,
) {
  const key = `synthetic/${id}`;
  const object = await env.MEDIA.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  const stamp = new Date(now - 31 * day).toISOString();
  await env.DB.prepare(`INSERT INTO assets (id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,etag,upload_expires_at,created_at,updated_at)
    VALUES (?,'owner_a','video','synthetic.mp4','video/mp4',10,?,?,?,?,?)`)
    .bind(id, key, object?.etag, stamp, stamp, stamp)
    .run();
  if (status !== "pending")
    await env.DB.prepare("UPDATE assets SET status=? WHERE id=?")
      .bind(status === "failed" ? "failed" : "ready", id)
      .run();
  if (status === "deleted")
    await env.DB.prepare(
      "UPDATE assets SET status='deleted',deleted_at=?,trash_generation=lower(hex(randomblob(16))) WHERE id=?",
    )
      .bind(new Date(deletedAt).toISOString(), id)
      .run();
  return key;
}
async function row(id = "a") {
  return env.DB.prepare("SELECT * FROM assets WHERE id=?")
    .bind(id)
    .first<Asset & { purge_claim: string | null }>();
}
async function used() {
  return env.DB.prepare(
    "SELECT storage_used_bytes FROM usage_quotas WHERE user_id='owner_a'",
  ).first("storage_used_bytes");
}
async function cleanup() {
  const handler = worker as unknown as {
    scheduled?: (
      controller: ScheduledController,
      bindings: Bindings,
      context: ExecutionContext,
    ) => Promise<void>;
  };
  expect(handler.scheduled).toBeTypeOf("function");
  await handler.scheduled?.(
    { scheduledTime: now, cron: "*/15 * * * *", noRetry() {} },
    bindings,
    {} as ExecutionContext,
  );
}

describe("Durable endpoint limits", () => {
  it("allows exactly thirty concurrent auth requests and returns correlated 429 with the exact remaining seconds", async () => {
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => request("/auth/google", "GET", "")),
    );
    expect(responses.filter((r) => r.status === 503)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    const response = responses.find((r) => r.status === 429);
    expect(response?.headers.get("Retry-After")).toBe("45");
    expect(await response?.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        request_id: response?.headers.get("X-Request-ID"),
      },
    });
  });
  it("resets at the bucket boundary and isolates trusted IPs while ignoring spoofed forwarding headers", async () => {
    for (let n = 0; n < 30; n++) await request("/auth/google", "GET", "");
    expect(
      (
        await request("/auth/google", "GET", "", "203.0.113.1", {
          "X-Forwarded-For": "198.51.100.1",
        })
      ).status,
    ).toBe(429);
    expect(
      (await request("/auth/google", "GET", "", "203.0.113.2")).status,
    ).toBe(503);
    vi.setSystemTime(now + 44999);
    expect(
      (await request("/auth/google", "GET", "")).headers.get("Retry-After"),
    ).toBe("1");
    vi.setSystemTime(now + 45000);
    expect((await request("/auth/google", "GET", "")).status).toBe(503);
  });
  it("does not reopen a full current bucket when an older request finishes late", async () => {
    let inspected: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (algorithm, data) => {
        if (++calls === 1) {
          inspected();
          await held;
        }
        return digest(algorithm, data);
      },
    );
    const older = request("/auth/google", "GET", "");
    await waiting;
    vi.setSystemTime(now + 45000);
    for (let n = 0; n < 30; n++) await request("/auth/google", "GET", "");
    release();
    expect((await older).status).toBe(503);
    expect((await request("/auth/google", "GET", "")).status).toBe(429);
  });
  it("cleans expired buckets without deleting the same scope's active bucket", async () => {
    for (let n = 0; n < 30; n++) await request("/auth/google", "GET", "");
    vi.setSystemTime(now + 2 * 60 * 60 * 1000);
    for (let n = 0; n < 30; n++) await request("/auth/google", "GET", "");
    expect(
      await env.DB.prepare("SELECT count(*) FROM rate_limits").first(
        "count(*)",
      ),
    ).toBe(2);
    await cleanup();
    expect(
      await env.DB.prepare("SELECT count(*) FROM rate_limits").first(
        "count(*)",
      ),
    ).toBe(1);
    expect((await request("/auth/google", "GET", "")).status).toBe(429);
  });
  it("bounds authenticated writes by owner independently of IP and session changes", async () => {
    await seedAsset();
    const responses = await Promise.all(
      Array.from({ length: 130 }, (_, n) =>
        request(
          "/api/assets/a/tags",
          "PUT",
          session,
          `203.0.113.${(n % 2) + 1}`,
        ),
      ),
    );
    expect(responses.filter((r) => r.status === 400)).toHaveLength(120);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    const other = await seedUser("owner_b");
    expect((await request("/api/assets/a/tags", "PUT", other)).status).toBe(
      400,
    );
  });
  it("bounds intent floods more tightly than normal writes", async () => {
    for (let n = 0; n < 30; n++)
      expect((await request("/api/assets/upload-intent", "POST")).status).toBe(
        400,
      );
    expect((await request("/api/assets/upload-intent", "POST")).status).toBe(
      429,
    );
  });
  it("allows a hundred-media view but stops enumeration after six hundred public requests", async () => {
    const responses = await Promise.all(
      Array.from({ length: 610 }, () =>
        request("/t/missing/media/missing", "GET", ""),
      ),
    );
    expect(responses.filter((r) => r.status === 404)).toHaveLength(600);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    expect((await request("/t/missing", "GET", "", "203.0.113.2")).status).toBe(
      404,
    );
  });
  it("requires cloud IP metadata, uses fallback only locally, and never records raw IP/session/query secrets", async () => {
    expect(
      (
        await request(
          "/auth/google",
          "GET",
          "",
          "",
          {},
          { ...bindings, APP_ENV: "production" },
        )
      ).status,
    ).toBe(503);
    expect(
      (await request("/t/missing?secret=never-log-this", "GET", session, ""))
        .status,
    ).toBe(404);
    await request("/t/missing", "GET", session);
    const rows = await env.DB.prepare("SELECT * FROM rate_limits").all();
    const stored = JSON.stringify(rows.results);
    expect(stored).not.toContain("203.0.113.1");
    expect(stored).not.toContain(session);
    const logs = JSON.stringify([
      ...infoLog.mock.calls,
      ...errorLog.mock.calls,
    ]);
    for (const secret of [session, "203.0.113.1", "never-log-this"])
      expect(logs).not.toContain(secret);
  });
});

describe("Scheduled retry-safe cleanup", () => {
  it("purges exact thirty-day trash only and preserves ready and recent trash with quota", async () => {
    const expired = await seedAsset("expired", "deleted");
    const ready = await seedAsset("ready");
    const recent = await seedAsset("recent", "deleted", now - 30 * day + 1);
    await cleanup();
    expect((await row("expired"))?.status).toBe("purged");
    expect(await env.MEDIA.head(expired)).toBeNull();
    expect((await row("ready"))?.status).toBe("ready");
    expect((await row("recent"))?.status).toBe("deleted");
    expect(await env.MEDIA.head(ready)).not.toBeNull();
    expect(await env.MEDIA.head(recent)).not.toBeNull();
    expect(await used()).toBe(20);
    await cleanup();
    expect(await used()).toBe(20);
  });
  it("releases expired pending reservations and deletes abandoned uploads idempotently", async () => {
    const key = await seedAsset("pending", "pending");
    await cleanup();
    expect((await row("pending"))?.status).toBe("purged");
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await used()).toBe(0);
    await cleanup();
    expect(await used()).toBe(0);
  });
  it("claims before R2 deletion, retains accounting on failure and retries safely", async () => {
    const key = await seedAsset("a", "deleted");
    const before = await row();
    const remove = env.MEDIA.delete.bind(env.MEDIA);
    let calls = 0;
    vi.spyOn(env.MEDIA, "delete").mockImplementation(async (keys) => {
      expect((await row())?.purge_claim).toBe(before?.trash_generation);
      expect((await request("/api/assets/a/restore", "POST")).status).toBe(409);
      if (++calls === 1) throw new Error("R2 transient never-log-this");
      return remove(keys);
    });
    await cleanup();
    expect((await row())?.status).toBe("deleted");
    expect((await row())?.purge_claim).toBe(before?.trash_generation);
    expect(await used()).toBe(10);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(
      await (await request("/api/assets/trash")).json(),
    ).not.toHaveProperty("assets.0.purge_claim");
    await cleanup();
    expect((await row())?.status).toBe("purged");
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await used()).toBe(0);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("never-log-this");
  });
  it("rejects claimed generations before retention expiry through both the API and database", async () => {
    await seedAsset("a", "deleted", now - day);
    await env.DB.prepare(
      "UPDATE assets SET purge_claim=trash_generation WHERE id='a'",
    ).run();
    const before = await row();
    expect((await request("/api/assets/a/restore", "POST")).status).toBe(409);
    await expect(
      env.DB.prepare(
        "UPDATE assets SET status='ready',deleted_at=NULL,trash_generation=NULL,purge_claim=NULL WHERE id='a'",
      ).run(),
    ).rejects.toThrow("asset_purge_claimed");
    await expect(
      env.DB.prepare(
        "UPDATE assets SET purge_claim=lower(hex(randomblob(16))) WHERE id='a'",
      ).run(),
    ).rejects.toThrow("asset_purge_claimed");
    expect(await row()).toEqual(before);
    expect(await used()).toBe(10);
    const payload = await (await request("/api/assets/a/trash", "POST")).json();
    expect(payload).not.toHaveProperty("asset.purge_claim");
    expect(payload).not.toHaveProperty("asset.trash_generation");
  });
  it("keeps an expired intent's object through the twenty-four-hour grace period without a reservation", async () => {
    const key = await seedAsset("pending", "pending");
    // D1 SQL time is platform time, independent of the test's JavaScript Date stub.
    const databaseTime = await env.DB.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS time",
    ).first<string>("time");
    const reference = Date.parse(databaseTime ?? "");
    expect(Number.isFinite(reference)).toBe(true);
    vi.setSystemTime(reference);
    await env.DB.prepare(
      "UPDATE assets SET upload_expires_at=? WHERE id='pending'",
    )
      .bind(new Date(reference - 1000).toISOString())
      .run();
    await cleanup();
    expect((await row("pending"))?.status).toBe("failed");
    expect(await env.MEDIA.head(key)).not.toBeNull();
    const response = await request("/api/me");
    expect(await response.json()).toMatchObject({
      quota: { storage_reserved_bytes: 0, storage_used_bytes: 0 },
    });
    vi.setSystemTime(reference + day);
    await cleanup();
    expect((await row("pending"))?.status).toBe("purged");
    expect(await env.MEDIA.head(key)).toBeNull();
  });
  it("retries abandoned object deletion failures without changing terminal accounting", async () => {
    const key = await seedAsset("failed", "failed");
    const remove = env.MEDIA.delete.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "delete").mockRejectedValueOnce(
      new Error("signed-url-secret"),
    );
    await cleanup();
    expect((await row("failed"))?.status).toBe("failed");
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(await used()).toBe(0);
    vi.spyOn(env.MEDIA, "delete").mockImplementation(remove);
    await cleanup();
    expect((await row("failed"))?.status).toBe("purged");
    expect(await used()).toBe(0);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "signed-url-secret",
    );
  });
  it("blocks an in-flight restore if cleanup claims after metadata inspection", async () => {
    await seedAsset("a", "deleted", now - 30 * day + 1);
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      const metadata = await head(key);
      vi.setSystemTime(now + 1);
      await cleanup();
      return metadata;
    });
    expect((await request("/api/assets/a/restore", "POST")).status).toBe(404);
    expect((await row())?.status).toBe("purged");
    expect(await used()).toBe(0);
  });
  it("bounds each purge sweep to one hundred rows and makes progress on the next run", async () => {
    for (let n = 0; n < 101; n++)
      await seedAsset(`asset_${n.toString().padStart(3, "0")}`, "deleted");
    await cleanup();
    expect(
      await env.DB.prepare(
        "SELECT count(*) FROM assets WHERE status='purged'",
      ).first("count(*)"),
    ).toBe(100);
    await cleanup();
    expect(
      await env.DB.prepare(
        "SELECT count(*) FROM assets WHERE status='purged'",
      ).first("count(*)"),
    ).toBe(101);
    expect(await used()).toBe(0);
  });
  it("rotates failed upload retries so a full failing page cannot starve later objects", async () => {
    for (let n = 0; n < 101; n++)
      await seedAsset(`asset_${n.toString().padStart(3, "0")}`, "failed");
    const remove = env.MEDIA.delete.bind(env.MEDIA);
    const attempted: string[] = [];
    vi.spyOn(env.MEDIA, "delete").mockImplementation(async (key) => {
      if (typeof key !== "string") throw new Error("Unexpected batch delete");
      attempted.push(key);
      if (key !== "synthetic/asset_100")
        throw new Error("persistent R2 failure");
      return remove(key);
    });
    for (let sweep = 0; sweep < 3; sweep++) {
      vi.setSystemTime(now + sweep * 15 * 60 * 1000);
      await cleanup();
    }
    expect(attempted).toContain("synthetic/asset_100");
    expect(attempted).toHaveLength(300);
    expect((await row("asset_100"))?.status).toBe("purged");
    expect(await env.MEDIA.head("synthetic/asset_100")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT count(*) FROM assets WHERE status='failed'",
      ).first("count(*)"),
    ).toBe(100);
    expect(await used()).toBe(0);
  });
  it("bounds auth cleanup per table and advances across batches while preserving live credentials", async () => {
    const hashes = Array.from({ length: 1201 }, (_, n) =>
      (n + 1).toString(16).padStart(64, "0"),
    );
    const expired = new Date(now - 1).toISOString();
    await env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) SELECT value,'owner_a',?,? FROM json_each(?)",
    )
      .bind(expired, expired, JSON.stringify(hashes))
      .run();
    await env.DB.prepare(
      "INSERT INTO oauth_attempts(state_hash,browser_hash,verifier,nonce,expires_at) SELECT value,?,'synthetic-verifier','synthetic-nonce',? FROM json_each(?)",
    )
      .bind("b".repeat(64), expired, JSON.stringify(hashes))
      .run();
    await env.DB.prepare(
      "INSERT INTO oauth_attempts(state_hash,browser_hash,verifier,nonce,expires_at) VALUES (?,?, 'live-verifier','live-nonce',?)",
    )
      .bind("f".repeat(64), "b".repeat(64), new Date(now + day).toISOString())
      .run();
    await cleanup();
    for (const table of ["sessions", "oauth_attempts"]) {
      expect(
        await env.DB.prepare(`SELECT count(*) FROM ${table}`).first("count(*)"),
      ).toBe(202);
      expect(
        await env.DB.prepare(
          `SELECT count(*) FROM ${table} WHERE expires_at <= ?`,
        )
          .bind(expired)
          .first("count(*)"),
      ).toBe(201);
    }
    expect((await request("/api/me")).status).toBe(200);
    await cleanup();
    for (const table of ["sessions", "oauth_attempts"])
      expect(
        await env.DB.prepare(`SELECT count(*) FROM ${table}`).first("count(*)"),
      ).toBe(1);
    expect((await request("/api/me")).status).toBe(200);
  });
  it("removes expired counter rows and auth records without invalidating live sessions", async () => {
    await request("/t/missing");
    await env.DB.prepare(
      "UPDATE sessions SET expires_at=? WHERE user_id='owner_a'",
    )
      .bind(new Date(now - 1).toISOString())
      .run();
    await seedUser("owner_b");
    await env.DB.prepare(
      "UPDATE sessions SET expires_at=? WHERE user_id='owner_b'",
    )
      .bind(new Date(now + day).toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO oauth_attempts(state_hash,browser_hash,verifier,nonce,expires_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        "a".repeat(64),
        "b".repeat(64),
        "synthetic-verifier",
        "synthetic-nonce",
        new Date(now - 1).toISOString(),
      )
      .run();
    vi.setSystemTime(now + 2 * 60 * 60 * 1000);
    await cleanup();
    expect(
      await env.DB.prepare("SELECT count(*) FROM rate_limits").first(
        "count(*)",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) FROM sessions").first("count(*)"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT count(*) FROM oauth_attempts").first(
        "count(*)",
      ),
    ).toBe(0);
  });
});
