import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";

export const me = new Hono<AppContext>();
me.get("/", requireUser, async (context) => {
  const user = context.get("user");
  const quota =
    await context.env.DB.prepare(`SELECT storage_limit_bytes, storage_used_bytes,
    max_asset_bytes, timeline_limit, link_limit,
    COALESCE((SELECT SUM(size_bytes) FROM assets WHERE owner_id = q.user_id
      AND status IN ('pending', 'failed') AND upload_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 0)
      AS storage_reserved_bytes
    FROM usage_quotas q WHERE user_id = ?`)
      .bind(user.id)
      .first();
  if (!quota) throw new ApiError("SERVICE_UNAVAILABLE");
  return context.json({ user, quota });
});
