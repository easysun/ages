import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./bindings";
import { ApiError, errorResponse } from "./http/errors";
import { requestContext } from "./http/middleware";
import { health } from "./routes/health";

export function createApp() {
  const app = new Hono<AppContext>();
  app.use("*", requestContext);
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
  return app;
}
