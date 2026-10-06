import { Hono } from "hono";
import { ApiError } from "../http/errors";
import { type TrackingWorkerBindings, trackingPageOrigins } from "./config";
import { renderTrackingInterstitial } from "./interstitial";
import { readTrackingTicket } from "./tickets";

export function createTrackingApp() {
  const app = new Hono<{ Bindings: TrackingWorkerBindings }>();
  app.onError((error, context) => {
    const status: 404 | 500 | 503 =
      error instanceof ApiError && error.code === "NOT_FOUND"
        ? 404
        : error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE"
          ? 503
          : 500;
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    return context.text(
      status === 404
        ? "Not found."
        : status === 503
          ? "Unavailable"
          : "Unable to continue.",
      status,
    );
  });
  app.notFound((context) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.text("Not found.", 404);
  });
  app.get("/:token", async (context) => {
    const origins = trackingPageOrigins(context.env);
    const requestUrl = new URL(context.req.url);
    if (
      requestUrl.origin !== origins.trackingOrigin ||
      requestUrl.search !== "" ||
      requestUrl.hash !== ""
    )
      throw new ApiError("NOT_FOUND");
    const view = await readTrackingTicket(
      context.env.DB,
      context.req.param("token"),
      new Date(),
    );
    if (!view) throw new ApiError("NOT_FOUND");
    const { html, contentSecurityPolicy } = await renderTrackingInterstitial(
      context.req.param("token"),
      view,
      origins,
    );
    context.header("Cache-Control", "no-store, max-age=0");
    context.header("Referrer-Policy", "strict-origin");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Robots-Tag", "noindex, nofollow");
    context.header("X-Frame-Options", "DENY");
    context.header("Content-Security-Policy", contentSecurityPolicy);
    context.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    return context.html(html);
  });
  return app;
}

const app = createTrackingApp();

export default {
  fetch: app.fetch,
};
