import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext, Bindings } from "../bindings";
import { ApiError } from "../http/errors";
import { cookiePolicy } from "./config";
import { hashToken, isToken, randomToken } from "./crypto";
import { type GoogleIdentity, googleIssuer } from "./google";

export type AuthenticatedUser = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  plan: "free" | "creator" | "pro" | "admin";
};

export async function sessionHash(context: Context<AppContext>) {
  const token = getCookie(context, cookiePolicy(context.env, "session").name);
  return isToken(token) ? hashToken(token) : null;
}

export const requireUser = createMiddleware<AppContext>(
  async (context, next) => {
    const hash = await sessionHash(context);
    const user =
      hash &&
      (await context.env.DB.prepare(`
    SELECT u.id, u.email, u.display_name, u.avatar_url, u.plan
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `)
        .bind(hash, new Date().toISOString())
        .first<AuthenticatedUser>());
    if (!user) throw new ApiError("UNAUTHENTICATED");
    context.set("user", user);
    await next();
  },
);

export async function createSession(
  context: Context<AppContext>,
  identity: GoogleIdentity,
) {
  const db = context.env.DB;
  const id = `us_${crypto.randomUUID()}`;
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const oldHash = await sessionHash(context);
  const now = new Date().toISOString();
  const lifetime = 7 * 24 * 60 * 60;
  const expires = new Date(Date.now() + lifetime * 1000).toISOString();
  const email = identity.email.toLowerCase();
  // D1 serializes the batch: an email collision never links unrelated subjects.
  const result = await db.batch([
    db
      .prepare(`INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM oauth_identities WHERE issuer = ? AND subject = ?)
        AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`)
      .bind(
        id,
        email,
        identity.name ?? null,
        identity.picture ?? null,
        now,
        now,
        googleIssuer,
        identity.sub,
        email,
      ),
    db
      .prepare(`INSERT INTO oauth_identities (issuer, subject, user_id, created_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
      ON CONFLICT (issuer, subject) DO NOTHING`)
      .bind(googleIssuer, identity.sub, id, now, id),
    db
      .prepare(`UPDATE users SET
      email = CASE WHEN NOT EXISTS (SELECT 1 FROM users other WHERE other.email = ? AND other.id != users.id)
        THEN ? ELSE email END,
      display_name = ?, avatar_url = ?, updated_at = ?
      WHERE id = (SELECT user_id FROM oauth_identities WHERE issuer = ? AND subject = ?)`)
      .bind(
        email,
        email,
        identity.name ?? null,
        identity.picture ?? null,
        now,
        googleIssuer,
        identity.sub,
      ),
    // Provisional private-beta allowances, not published pricing or entitlements.
    db
      .prepare(`INSERT INTO usage_quotas
      (user_id, storage_limit_bytes, max_asset_bytes, timeline_limit, link_limit, updated_at)
      SELECT user_id, ?, ?, 10, 100, ? FROM oauth_identities WHERE issuer = ? AND subject = ?
      ON CONFLICT (user_id) DO NOTHING`)
      .bind(1024 ** 3, 250 * 1024 ** 2, now, googleIssuer, identity.sub),
    db
      .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, user_id, ?, ? FROM oauth_identities WHERE issuer = ? AND subject = ?`)
      .bind(tokenHash, expires, now, googleIssuer, identity.sub),
    db
      .prepare(`DELETE FROM sessions WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)`)
      .bind(oldHash, tokenHash),
  ]);
  if (result[4]?.meta.changes !== 1) throw new ApiError("FORBIDDEN");
  const cookie = cookiePolicy(context.env, "session");
  setCookie(context, cookie.name, token, {
    ...cookie.options,
    maxAge: lifetime,
  });
}

export async function cleanupAuth(bindings: Bindings) {
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    bindings.DB.prepare(
      "DELETE FROM oauth_attempts WHERE expires_at <= ?",
    ).bind(now),
  ]);
}
