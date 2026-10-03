import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const timestamp = "2026-10-03T00:00:00Z";

async function addUser(id = "user_a") {
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, `${id}@example.test`, timestamp, timestamp)
    .run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1 identity migration", () => {
  it("applies to an empty database and records its migration exactly once", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(
      expect.arrayContaining(["users", "sessions", "usage_quotas"]),
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first(
        "count",
      ),
    ).toBe(1);
  });

  it("reruns without losing users or duplicating migration records", async () => {
    await addUser();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(
      await env.DB.prepare("SELECT email FROM users WHERE id = 'user_a'").first(
        "email",
      ),
    ).toBe("user_a@example.test");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first(
        "count",
      ),
    ).toBe(1);
  });

  it("enforces unique identities and known plans", async () => {
    await addUser();
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind("user_b", "user_a@example.test", timestamp, timestamp)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE users SET plan = 'unlimited' WHERE id = 'user_a'",
      ).run(),
    ).rejects.toThrow();
  });

  it("requires a SHA-256-shaped session hash and a real user", async () => {
    await addUser();
    const query =
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)";
    await expect(
      env.DB.prepare(query)
        .bind("opaque-raw-token", "user_a", timestamp, timestamp)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(query)
        .bind("a".repeat(64), "missing", timestamp, timestamp)
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare(query)
      .bind("a".repeat(64), "user_a", timestamp, timestamp)
      .run();
    await env.DB.prepare("DELETE FROM users WHERE id = 'user_a'").run();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(
        "count",
      ),
    ).toBe(0);
  });

  it("rejects negative quota accounting", async () => {
    await addUser();
    await expect(
      env.DB.prepare(`INSERT INTO usage_quotas
      (user_id, storage_limit_bytes, storage_used_bytes, max_asset_bytes, timeline_limit, link_limit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind("user_a", 1000, -1, 100, 10, 10, timestamp)
        .run(),
    ).rejects.toThrow();
  });

  it("rolls back all writes when a statement in a D1 batch fails", async () => {
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind("user_a", "user_a@example.test", timestamp, timestamp),
        env.DB.prepare(
          "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        ).bind("invalid-raw-token", "user_a", timestamp, timestamp),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(
        "count",
      ),
    ).toBe(0);
  });
});
