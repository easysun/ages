import { env } from "cloudflare:workers";
import { hashToken, randomToken } from "../../src/auth/crypto";

export async function seedUser(id = "owner_a", storageLimit = 1024 ** 3) {
  const now = new Date().toISOString();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, `${id}@example.test`, now, now),
    env.DB.prepare(`INSERT INTO usage_quotas
      (user_id, storage_limit_bytes, max_asset_bytes, timeline_limit, link_limit, updated_at)
      VALUES (?, ?, ?, 10, 100, ?)`).bind(
      id,
      storageLimit,
      250 * 1024 ** 2,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(
      await hashToken(token),
      id,
      new Date(Date.now() + 3_600_000).toISOString(),
      now,
    ),
  ]);
  return `ages_session=${token}`;
}
