import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { AppContext, Bindings } from "../bindings";
import { ApiError } from "../http/errors";
import { appOrigin, cookiePolicy } from "./config";
import { hashToken, randomToken } from "./crypto";
import { sessionHash } from "./session";

export function localLoginEnabled(bindings: Bindings) {
  if (bindings.APP_ENV !== "local" || bindings.LOCAL_LOGIN_ENABLED !== "true")
    return false;
  const url = new URL(appOrigin(bindings));
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export async function createLocalSession(context: Context<AppContext>) {
  const id = "us_local_test";
  const email = "local-test@ages.example.test";
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const oldHash = await sessionHash(context);
  const now = new Date().toISOString();
  const lifetime = 3600;
  const expires = new Date(Date.now() + lifetime * 1000).toISOString();
  const db = context.env.DB;
  const result = await db.batch([
    db
      .prepare(`INSERT INTO users (id,email,display_name,created_at,updated_at)
      VALUES (?,?,'Local test account',?,?) ON CONFLICT DO NOTHING`)
      .bind(id, email, now, now),
    db
      .prepare(`INSERT INTO usage_quotas
      (user_id,storage_limit_bytes,max_asset_bytes,timeline_limit,link_limit,updated_at)
      SELECT id,?,?,10,100,? FROM users WHERE id=? AND email=? AND plan='free'
      ON CONFLICT (user_id) DO NOTHING`)
      .bind(1024 ** 3, 250 * 1024 ** 2, now, id, email),
    db
      .prepare(`INSERT INTO sessions (token_hash,user_id,expires_at,created_at)
      SELECT ?,id,?,? FROM users WHERE id=? AND email=? AND plan='free'`)
      .bind(tokenHash, expires, now, id, email),
    db
      .prepare(`DELETE FROM sessions WHERE token_hash=?
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=?)`)
      .bind(oldHash, tokenHash),
  ]);
  if (result[2]?.meta.changes !== 1) throw new ApiError("FORBIDDEN");
  const cookie = cookiePolicy(context.env, "session");
  setCookie(context, cookie.name, token, {
    ...cookie.options,
    maxAge: lifetime,
  });
}
