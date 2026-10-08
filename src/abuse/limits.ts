import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { hashToken } from "../auth/crypto";
import type { AppContext } from "../bindings";
import { ApiError, errorResponse } from "../http/errors";

// Provisional per-minute beta bounds, not pricing or entitlements.
const limits = {
  public: 600,
  auth: 30,
  writes: 120,
  intents: 30,
  reports: 10,
} as const;
const windowMs = 60_000;

async function consume(
  context: Context<AppContext>,
  policy: keyof typeof limits,
  subject: string,
) {
  const now = Date.now();
  const bucket = Math.floor(now / windowMs) * windowMs;
  const scope = await hashToken(`${policy}:${subject}`);
  // Conditional UPSERT is atomic across concurrent Worker requests and restarts.
  const allowed =
    await context.env.DB.prepare(`INSERT INTO rate_limits (scope_hash,bucket,count,expires_at)
    VALUES (?,?,1,?) ON CONFLICT (scope_hash,bucket) DO UPDATE SET count=rate_limits.count+1
    WHERE rate_limits.count < ? RETURNING count`)
      .bind(scope, bucket, bucket + windowMs + 3_600_000, limits[policy])
      .first();
  if (allowed) return null;
  context.header(
    "Retry-After",
    String(Math.max(1, Math.ceil((bucket + windowMs - now) / 1000))),
  );
  return errorResponse(context, "RATE_LIMITED");
}

export const requestLimits = createMiddleware<AppContext>(
  async (context, next) => {
    const protectedPath =
      /^\/(?:auth\/(?:google|logout)(?:\/|$)|api\/(?:me|assets|timelines|content-nodes|content-edges|links|reports|admin)(?:\/|$)|t(?:\/|$)|s(?:\/|$)|c(?:\/|$))/.test(
        context.req.path,
      );
    if (!protectedPath) return next();
    // Only the Cloudflare edge header is trusted; forwarded headers are never consulted.
    const ip =
      context.req.header("CF-Connecting-IP") ||
      (context.env.APP_ENV === "local" ? "local" : null);
    if (!ip) throw new ApiError("SERVICE_UNAVAILABLE");
    const policy = context.req.path.startsWith("/auth/") ? "auth" : "public";
    const rejected = await consume(context, policy, ip);
    if (rejected) return rejected;
    await next();
  },
);

export async function limitAuthenticatedWrite(context: Context<AppContext>) {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return null;
  const owner = context.get("user").id;
  const rejected = await consume(context, "writes", owner);
  if (rejected) return rejected;
  if (
    context.req.path === "/api/reports" ||
    (context.req.method === "POST" &&
      /^\/api\/content-edges\/[^/]+\/reports$/.test(context.req.path))
  )
    return consume(context, "reports", owner);
  if (context.req.path === "/api/assets/upload-intent")
    return consume(context, "intents", owner);
  return null;
}

export async function cleanupLimits(db: D1Database) {
  await db
    .prepare(`DELETE FROM rate_limits WHERE rowid IN (
    SELECT rowid FROM rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 1000
  )`)
    .bind(Date.now())
    .run();
}
