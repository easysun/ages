import { createMiddleware } from "hono/factory";
import type { AppContext } from "../bindings";

export const requestContext = createMiddleware<AppContext>(
  async (context, next) => {
    const noIndex = context.env.ROBOTS_NOINDEX === "true";
    const requestId = `req_${crypto.randomUUID()}`;
    context.set("requestId", requestId);
    context.header("X-Request-ID", requestId);
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    if (noIndex) {
      context.header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    }
    const started = Date.now();
    await next();
    // A public-content route may request `index, follow`; the OKE opt-in wins.
    if (noIndex) {
      context.header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    }
    // Route patterns preserve diagnostics without recording URLs, IDs, or query secrets.
    console.info(
      JSON.stringify({
        event: "request_completed",
        request_id: requestId,
        method: context.req.method,
        route: context.req.routePath ?? "unmatched",
        status: context.res.status,
        duration_ms: Date.now() - started,
      }),
    );
  },
);
