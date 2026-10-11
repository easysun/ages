import { Hono } from "hono";
import { sessionHash } from "../auth/session";
import type { AppContext } from "../bindings";
import { visibleEdges } from "../graph/edges";
import { effectiveNode } from "../graph/nodes";
import {
  renderContentNode,
  renderUnavailableContentNode,
} from "../graph/render";

export const publicContentNode = new Hono<AppContext>();

publicContentNode.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  await next();
});

publicContentNode.on(["GET", "HEAD"], "/:id", async (context) => {
  const db = context.env.DB;
  const id = context.req.param("id");
  const hash = await sessionHash(context);
  const session = hash
    ? await db
        .prepare(
          "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at > ?",
        )
        .bind(hash, new Date().toISOString())
        .first<{ user_id: string }>()
    : null;
  const result = await effectiveNode(db, id, session?.user_id ?? null);
  if (!result) {
    if (context.req.method === "HEAD")
      return context.body(null, 404, {
        "Content-Type": "text/html; charset=utf-8",
      });
    const body = renderUnavailableContentNode();
    return context.body(body, 404, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  if (result.visibility === "public")
    context.header("X-Robots-Tag", "index, follow");
  if (context.req.method === "HEAD")
    return context.body(null, 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  const backlinks =
    result.visibility === "public"
      ? (await visibleEdges(db, id, "incoming", null, null, null, 30)).edges
      : [];
  const body = renderContentNode(result.node, result.visibility, backlinks);
  return context.body(body, 200, {
    "Content-Type": "text/html; charset=utf-8",
  });
});
