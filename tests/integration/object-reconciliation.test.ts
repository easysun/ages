import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileUntrackedOriginals } from "../../src/assets/reconciliation";
import type { Bindings } from "../../src/bindings";
import { scheduledCleanup } from "../../src/cleanup";
import { seedUser } from "../helpers/auth";

const bindings: Bindings = { ...env, APP_ENV: "local" };
const now = Date.parse("2026-10-13T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const cursorKey = "ops:original-object-reconciliation:v1";
type ListedObject = Awaited<
  ReturnType<typeof env.MEDIA.list>
>["objects"][number];
type ListResult = Awaited<ReturnType<typeof env.MEDIA.list>>;
const infoLog = vi.fn();
const errorLog = vi.fn();

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await seedUser();
  vi.spyOn(console, "info").mockImplementation(infoLog);
  vi.spyOn(console, "error").mockImplementation(errorLog);
});

afterEach(() => vi.useRealTimers());

function listResult(
  objects: ListedObject[],
  truncated = false,
  cursor?: string,
): ListResult {
  return {
    objects,
    truncated,
    delimitedPrefixes: [],
    ...(cursor === undefined ? {} : { cursor }),
  } as ListResult;
}

async function putObject(key: string, size: number) {
  await env.MEDIA.put(key, new Uint8Array(size), {
    httpMetadata: { contentType: "application/octet-stream" },
  });
}

async function listedObject(
  key: string,
  uploaded: Date,
): Promise<ListedObject> {
  const result = await env.MEDIA.list({ prefix: key, limit: 1 });
  const object = result.objects.find((candidate) => candidate.key === key);
  if (!object) throw new Error("Missing local R2 fixture");
  return {
    ...object,
    uploaded,
    writeHttpMetadata: object.writeHttpMetadata.bind(object),
  };
}

async function seedAsset(
  id: string,
  status: "pending" | "ready" | "failed" | "deleted" | "purged",
  key: string,
  size: number,
) {
  const stamp = new Date(now - 2 * day).toISOString();
  await env.DB.prepare(`INSERT INTO assets (
    id, owner_id, kind, status, original_name, mime_type, size_bytes, r2_key,
    upload_expires_at, created_at, updated_at, deleted_at, trash_generation
  ) VALUES (?, 'owner_a', 'file', ?, 'private-owner-secret.png',
    'application/octet-stream', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      status,
      size,
      key,
      stamp,
      stamp,
      stamp,
      status === "deleted" ? stamp : null,
      status === "deleted" ? "a".repeat(32) : null,
    )
    .run();
}

async function assetRows() {
  return (await env.DB.prepare("SELECT * FROM assets ORDER BY id").all())
    .results;
}

async function quotaRows() {
  return (
    await env.DB.prepare("SELECT * FROM usage_quotas ORDER BY user_id").all()
  ).results;
}

function events(log: ReturnType<typeof vi.fn>) {
  return log.mock.calls.map(([message]) => JSON.parse(String(message)));
}

describe("report-only original object reconciliation", () => {
  it("counts only old objects without Asset rows and preserves every row, quota, and object", async () => {
    const fixtureRows = [
      ["pending", "pending", 3],
      ["ready", "ready", 4],
      ["failed", "failed", 5],
      ["deleted", "deleted", 6],
      ["purged", "purged", 7],
    ] as const;
    const allKeys: string[] = [];
    const objects: ListedObject[] = [];

    for (const [id, status, size] of fixtureRows) {
      const key = `originals/owner-secret/${id}/object-secret`;
      allKeys.push(key);
      await putObject(key, size);
      await seedAsset(id, status, key, size);
      objects.push(await listedObject(key, new Date(now - 2 * day)));
    }

    for (const [id, size] of [
      ["missing_a", 11],
      ["missing_b", 13],
    ] as const) {
      const key = `originals/owner-secret/${id}/object-secret`;
      allKeys.push(key);
      await putObject(key, size);
      objects.push(await listedObject(key, new Date(now - 2 * day)));
    }

    const unrelatedKey = "thumbnails/owner-secret/other-object";
    await putObject(unrelatedKey, 19);
    const beforeAssets = await assetRows();
    const beforeQuota = await quotaRows();
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult(objects));
    const remove = vi.spyOn(env.MEDIA, "delete");
    const prepare = env.DB.prepare.bind(env.DB);
    const classificationSql: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("r2_key IN")) classificationSql.push(sql);
      return prepare(sql);
    });

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ prefix: "originals/", limit: 100 });
    expect(classificationSql).toHaveLength(1);
    expect(classificationSql[0]).not.toMatch(/status\s*=/i);
    expect(events(infoLog)).toEqual([
      {
        event: "original_object_reconciliation_page",
        objects_scanned: 7,
        objects_eligible: 7,
        asset_rows_found: 5,
        missing_asset_rows: 2,
        bytes_scanned: 49,
        missing_asset_bytes: 24,
        skipped_recent: 0,
        skipped_future: 0,
        skipped_invalid_uploaded: 0,
      },
    ]);
    expect(await assetRows()).toEqual(beforeAssets);
    expect(await quotaRows()).toEqual(beforeQuota);
    expect(remove).not.toHaveBeenCalled();
    for (const key of [...allKeys, unrelatedKey])
      expect(await env.MEDIA.head(key)).not.toBeNull();

    const output = JSON.stringify(infoLog.mock.calls);
    for (const secret of [
      "owner-secret",
      "object-secret",
      "private-owner-secret.png",
      cursorKey,
      unrelatedKey,
    ])
      expect(output).not.toContain(secret);
  });

  it("applies the strict 24-hour cutoff and reports recent, future, and invalid timestamps", async () => {
    const dates = [
      ["old", new Date(now - day - 1)],
      ["exact_cutoff", new Date(now - day)],
      ["recent", new Date(now - day + 1)],
      ["future", new Date(now + 1)],
      ["invalid", new Date(Number.NaN)],
    ] as const;
    const objects: ListedObject[] = [];
    for (const [id, uploaded] of dates) {
      const key = `originals/timestamps/${id}`;
      await putObject(key, 10);
      objects.push(await listedObject(key, uploaded));
    }
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult(objects));
    const prepare = env.DB.prepare.bind(env.DB);
    const classificationSql: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("r2_key IN")) classificationSql.push(sql);
      return prepare(sql);
    });

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(1);
    expect(classificationSql).toHaveLength(1);
    expect(classificationSql[0]?.match(/\?/g)).toHaveLength(1);
    expect(events(infoLog)).toEqual([
      {
        event: "original_object_reconciliation_page",
        objects_scanned: 5,
        objects_eligible: 1,
        asset_rows_found: 0,
        missing_asset_rows: 1,
        bytes_scanned: 50,
        missing_asset_bytes: 10,
        skipped_recent: 2,
        skipped_future: 1,
        skipped_invalid_uploaded: 1,
      },
    ]);
  });

  it("skips D1 when no object has an eligible uploaded timestamp", async () => {
    const objects: ListedObject[] = [];
    for (const [id, uploaded] of [
      ["cutoff", new Date(now - day)],
      ["future", new Date(now + day)],
      ["invalid", new Date(Number.NaN)],
    ] as const) {
      const key = `originals/no-eligible/${id}`;
      await putObject(key, 10);
      objects.push(await listedObject(key, uploaded));
    }
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult(objects));
    const prepare = env.DB.prepare.bind(env.DB);
    const classificationSql: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("r2_key IN")) classificationSql.push(sql);
      return prepare(sql);
    });

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(1);
    expect(classificationSql).toEqual([]);
    expect(events(infoLog)[0]).toMatchObject({
      objects_scanned: 3,
      bytes_scanned: 30,
      objects_eligible: 0,
      asset_rows_found: 0,
      missing_asset_rows: 0,
    });
  });

  it("stores one opaque continuation cursor for a 100-object page and clears it at the end", async () => {
    for (let n = 0; n < 101; n++)
      await putObject(`originals/page/${n.toString().padStart(3, "0")}`, 1);
    const actualList = env.MEDIA.list.bind(env.MEDIA);
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockImplementation((options) => actualList(options));
    const put = vi.spyOn(env.LINK_CACHE, "put");
    const remove = vi.spyOn(env.LINK_CACHE, "delete");

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenLastCalledWith({ prefix: "originals/", limit: 100 });
    expect(events(infoLog)[0]).toMatchObject({ objects_scanned: 100 });
    const cursor = await env.LINK_CACHE.get(cursorKey);
    expect(cursor).toBeTruthy();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(cursorKey, cursor, {
      expirationTtl: 86400,
    });

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      prefix: "originals/",
      limit: 100,
      cursor,
    });
    expect(events(infoLog)[1]).toMatchObject({ objects_scanned: 1 });
    expect(await env.LINK_CACHE.get(cursorKey)).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(cursorKey);
  });

  it("continues a short truncated page from its opaque cursor", async () => {
    const firstKey = "originals/short/first";
    const secondKey = "originals/short/second";
    await putObject(firstKey, 10);
    await putObject(secondKey, 20);
    const first = await listedObject(firstKey, new Date(now - 2 * day));
    const second = await listedObject(secondKey, new Date(now - 2 * day));
    const opaqueCursor = "provider-cursor-secret";
    const responses = [
      listResult([first], true, opaqueCursor),
      listResult([second]),
    ];
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockImplementation(async () => responses.shift() as ListResult);

    await reconcileUntrackedOriginals(bindings);
    expect(await env.LINK_CACHE.get(cursorKey)).toBe(opaqueCursor);
    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "originals/",
      limit: 100,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "originals/",
      limit: 100,
      cursor: opaqueCursor,
    });
    expect(events(infoLog).map((event) => event.objects_scanned)).toEqual([
      1, 1,
    ]);
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain(opaqueCursor);
  });

  it("restarts from the first page when the checkpoint is lost", async () => {
    const key = "originals/cache-loss/object";
    await putObject(key, 10);
    const object = await listedObject(key, new Date(now - 2 * day));
    const responses = [
      listResult([object], true, "first-cursor"),
      listResult([object], true, "restarted-cursor"),
    ];
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockImplementation(async () => responses.shift() as ListResult);

    await reconcileUntrackedOriginals(bindings);
    await env.LINK_CACHE.delete(cursorKey);
    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "originals/",
      limit: 100,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "originals/",
      limit: 100,
    });
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("restarted-cursor");
  });

  it("fails a truncated response without a non-empty cursor without advancing the checkpoint", async () => {
    const key = "originals/missing-cursor/object";
    await putObject(key, 10);
    const object = await listedObject(key, new Date(now - 2 * day));
    await env.LINK_CACHE.put(cursorKey, "saved-cursor");
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult([object], true, ""));

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow();

    expect(list).toHaveBeenCalledTimes(1);
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("saved-cursor");
    expect(infoLog).not.toHaveBeenCalled();
  });

  it("splits eligible D1 lookups into bound chunks of at most 90 keys", async () => {
    const objects: ListedObject[] = [];
    for (let n = 0; n < 100; n++) {
      const key = `originals/chunks/${n.toString().padStart(3, "0")}`;
      await putObject(key, 1);
      objects.push(await listedObject(key, new Date(now - 2 * day)));
    }
    vi.spyOn(env.MEDIA, "list").mockResolvedValue(listResult(objects));
    const prepare = env.DB.prepare.bind(env.DB);
    const classificationSql: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("r2_key IN")) classificationSql.push(sql);
      return prepare(sql);
    });

    await reconcileUntrackedOriginals(bindings);

    expect(classificationSql).toHaveLength(2);
    expect(classificationSql.map((sql) => sql.match(/\?/g)?.length)).toEqual([
      90, 10,
    ]);
    expect(classificationSql.every((sql) => sql.includes("r2_key IN"))).toBe(
      true,
    );
  });

  it("does not advance the cursor after D1 classification fails and safely retries that page", async () => {
    const key = "originals/d1-failure/object";
    await putObject(key, 10);
    const object = await listedObject(key, new Date(now - 2 * day));
    const beforeAssets = await assetRows();
    const beforeQuota = await quotaRows();
    await env.LINK_CACHE.put(cursorKey, "saved-cursor");
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult([object], true, "next-cursor"));
    const prepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("r2_key IN")) throw new Error("d1-secret-error");
      return prepare(sql);
    });

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "d1-secret-error",
    );
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("saved-cursor");
    prepareSpy.mockRestore();

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "originals/",
      limit: 100,
      cursor: "saved-cursor",
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "originals/",
      limit: 100,
      cursor: "saved-cursor",
    });
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("next-cursor");
    expect(await assetRows()).toEqual(beforeAssets);
    expect(await quotaRows()).toEqual(beforeQuota);
    expect(await env.MEDIA.head(key)).not.toBeNull();
  });

  it("does not advance the cursor when writing a checkpoint fails and safely retries", async () => {
    const key = "originals/kv-write-failure/object";
    await putObject(key, 10);
    const object = await listedObject(key, new Date(now - 2 * day));
    const beforeAssets = await assetRows();
    const beforeQuota = await quotaRows();
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult([object], true, "next-cursor"));
    const write = vi
      .spyOn(env.LINK_CACHE, "put")
      .mockRejectedValueOnce(new Error("kv-write-secret"));

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "kv-write-secret",
    );
    expect(await env.LINK_CACHE.get(cursorKey)).toBeNull();
    write.mockRestore();

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "originals/",
      limit: 100,
    });
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("next-cursor");
    expect(await assetRows()).toEqual(beforeAssets);
    expect(await quotaRows()).toEqual(beforeQuota);
    expect(await env.MEDIA.head(key)).not.toBeNull();
  });

  it("leaves a completed page replayable when clearing its checkpoint fails", async () => {
    const key = "originals/kv-delete-failure/object";
    await putObject(key, 10);
    const object = await listedObject(key, new Date(now - 2 * day));
    const beforeAssets = await assetRows();
    const beforeQuota = await quotaRows();
    await env.LINK_CACHE.put(cursorKey, "saved-cursor");
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockResolvedValue(listResult([object]));
    const remove = vi
      .spyOn(env.LINK_CACHE, "delete")
      .mockRejectedValueOnce(new Error("kv-delete-secret"));

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "kv-delete-secret",
    );
    expect(await env.LINK_CACHE.get(cursorKey)).toBe("saved-cursor");
    remove.mockRestore();

    await reconcileUntrackedOriginals(bindings);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "originals/",
      limit: 100,
      cursor: "saved-cursor",
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "originals/",
      limit: 100,
      cursor: "saved-cursor",
    });
    expect(await env.LINK_CACHE.get(cursorKey)).toBeNull();
    expect(await assetRows()).toEqual(beforeAssets);
    expect(await quotaRows()).toEqual(beforeQuota);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(events(infoLog)).toHaveLength(1);
  });

  it("fails before listing when the KV checkpoint cannot be read", async () => {
    const read = vi
      .spyOn(env.LINK_CACHE, "get")
      .mockRejectedValueOnce(new Error("kv-read-secret"));
    const list = vi.spyOn(env.MEDIA, "list");

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "kv-read-secret",
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it("best-effort clears a saved cursor after list failure without retrying the list", async () => {
    await env.LINK_CACHE.put(cursorKey, "saved-cursor-secret");
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockRejectedValue(new Error("provider-list-secret"));
    const remove = vi.spyOn(env.LINK_CACHE, "delete");

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "provider-list-secret",
    );

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      prefix: "originals/",
      limit: 100,
      cursor: "saved-cursor-secret",
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(cursorKey);
    expect(await env.LINK_CACHE.get(cursorKey)).toBeNull();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "provider-list-secret",
    );
  });

  it("does not try to clear a checkpoint or retry after a first-page list failure", async () => {
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockRejectedValue(new Error("first-page-list-secret"));
    const remove = vi.spyOn(env.LINK_CACHE, "delete");

    await expect(reconcileUntrackedOriginals(bindings)).rejects.toThrow(
      "first-page-list-secret",
    );

    expect(list).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps scheduled cleanup successful and logs one generic event after a saved-cursor list failure", async () => {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .bind("2000-01-01T00:00:00.000Z", "owner_a")
      .run();
    await env.LINK_CACHE.put(cursorKey, "private-provider-cursor");
    const list = vi
      .spyOn(env.MEDIA, "list")
      .mockRejectedValue(new Error("private-provider-error"));

    await expect(scheduledCleanup(bindings)).resolves.toBeUndefined();

    expect(
      await env.DB.prepare("SELECT count(*) FROM sessions").first("count(*)"),
    ).toBe(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await env.LINK_CACHE.get(cursorKey)).toBeNull();
    expect(events(errorLog)).toEqual([
      { event: "original_object_reconciliation_failed" },
    ]);
    const output = JSON.stringify(errorLog.mock.calls);
    for (const secret of [
      "private-provider-cursor",
      "private-provider-error",
      "owner_a",
    ])
      expect(output).not.toContain(secret);
  });
});
