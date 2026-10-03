import { Hono } from "hono";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";

export const health = new Hono<AppContext>();

health.get("/", (context) => context.json({ status: "ok", service: "ages" }));

health.get("/ready", async (context) => {
  try {
    if (
      !["local", "development", "preview", "production"].includes(
        context.env.APP_ENV,
      )
    ) {
      throw new Error("Invalid environment.");
    }
    const checks = await Promise.allSettled([
      (async () =>
        context.env.DB.prepare("SELECT id FROM users LIMIT 1").first())(),
      (async () => context.env.MEDIA.head("__readiness_probe__"))(),
      (async () => context.env.LINK_CACHE.get("__readiness_probe__"))(),
    ]);
    if (checks.some((check) => check.status === "rejected")) {
      throw new Error("A required binding is unavailable.");
    }
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  return context.json({ status: "ready", service: "ages" });
});
