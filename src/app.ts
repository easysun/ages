import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestLimits } from "./abuse/limits";
import type { AppContext } from "./bindings";
import { ApiError, errorResponse } from "./http/errors";
import { requestContext } from "./http/middleware";
import { auth } from "./routes/auth";
import { health } from "./routes/health";
import { library } from "./routes/library";
import { linkAnalytics } from "./routes/link-analytics";
import { linkResolver, links } from "./routes/links";
import { me } from "./routes/me";
import { administration, reports } from "./routes/moderation";
import { publicTimeline } from "./routes/public-timeline";
import { timelines } from "./routes/timelines";
import { uploads } from "./routes/uploads";

export function createApp() {
  const app = new Hono<AppContext>();
  app.use("*", requestContext);
  app.use("*", requestLimits);
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) => errorResponse(context, "PAYLOAD_TOO_LARGE"),
    }),
  );
  app.onError((error, context) => {
    let code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    if (error instanceof HTTPException && error.status === 400) {
      code = "INVALID_REQUEST";
    }
    console.error(
      JSON.stringify({
        event: "request_failed",
        request_id: context.get("requestId"),
        code,
      }),
    );
    return errorResponse(context, code);
  });
  app.notFound((context) => errorResponse(context, "NOT_FOUND"));
  app.route("/health", health);
  app.route("/auth", auth);
  app.route("/api/me", me);
  app.route("/api/assets", uploads);
  app.route("/api/assets", library);
  app.route("/api/timelines", timelines);
  app.route("/api/links", linkAnalytics);
  app.route("/api/links", links);
  app.route("/api/reports", reports);
  app.route("/api/admin", administration);
  app.route("/s", linkResolver);

  app.route("/t", publicTimeline);
  return app;
}
