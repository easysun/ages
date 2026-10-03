import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";

export const me = new Hono<AppContext>();
me.get("/", requireUser, async (context) => {
  const user = context.get("user");
  const quota =
    await context.env.DB.prepare(`SELECT storage_limit_bytes, storage_used_bytes,
    max_asset_bytes, timeline_limit, link_limit FROM usage_quotas WHERE user_id = ?`)
      .bind(user.id)
      .first();
  if (!quota) throw new ApiError("SERVICE_UNAVAILABLE");
  return context.json({ user, quota });
});
