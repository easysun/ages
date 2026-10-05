import { Hono } from "hono";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import {
  getTrackingProviders,
  trackingProviderSettingsSchema,
} from "../tracking/providers";

export const me = new Hono<AppContext>();
me.use("/tracking/providers", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  await next();
});
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

me.get("/tracking/providers", requireUser, async (context) => {
  const providers = await getTrackingProviders(
    context.env.DB,
    context.get("user").id,
  );
  return context.json({ providers });
});

me.put("/tracking/providers", requireUser, async (context) => {
  assertSameOrigin(context);
  const input = await parseJson(context, trackingProviderSettingsSchema);
  await context.env.DB.prepare(`INSERT INTO tracking_provider_settings
    (user_id, ga4_measurement_id, meta_pixel_id, gtm_container_id, ga4_route, meta_route)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ga4_measurement_id = excluded.ga4_measurement_id,
      meta_pixel_id = excluded.meta_pixel_id,
      gtm_container_id = excluded.gtm_container_id,
      ga4_route = excluded.ga4_route,
      meta_route = excluded.meta_route`)
    .bind(
      context.get("user").id,
      input.ga4_measurement_id,
      input.meta_pixel_id,
      input.gtm_container_id,
      input.ga4_route,
      input.meta_route,
    )
    .run();
  return context.json({
    providers: await getTrackingProviders(
      context.env.DB,
      context.get("user").id,
    ),
  });
});
