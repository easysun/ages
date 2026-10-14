import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  appOrigin,
  assertSameOrigin,
  cookiePolicy,
  oauthConfig,
} from "../auth/config";
import { hashToken, isToken, pkceChallenge, randomToken } from "../auth/crypto";
import { exchangeGoogleCode } from "../auth/google";
import { createLocalSession, localLoginEnabled } from "../auth/local";
import { cleanupAuth, createSession, sessionHash } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { type ReportTarget, reportTargetSchema } from "../moderation/model";

export const auth = new Hono<AppContext>();
auth.use("*", async (context, next) => {
  context.header("Referrer-Policy", "no-referrer");
  if (new URL(context.req.url).origin !== appOrigin(context.env)) {
    throw new ApiError("FORBIDDEN");
  }
  await next();
});

function assertWellFormedQuery(search: string) {
  if (!search) return;
  for (const pair of search.slice(1).split("&")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    const value = separator < 0 ? "" : pair.slice(separator + 1);
    try {
      decodeURIComponent(key.replace(/\+/g, " "));
      decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      throw new ApiError("INVALID_REQUEST");
    }
  }
}

function parseReportTarget(
  kind: string | null,
  value: string | null,
): ReportTarget {
  const candidate =
    kind === "timeline"
      ? { kind, timeline_id: value }
      : kind === "link"
        ? { kind, slug: value }
        : null;
  const parsed = reportTargetSchema.safeParse(candidate);
  if (!parsed.success) throw new ApiError("INVALID_REQUEST");
  return parsed.data;
}

function reportTargetFromUrl(url: URL): ReportTarget | null {
  assertWellFormedQuery(url.search);
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (!keys.length) return null;
  if (
    keys.length !== 2 ||
    params.getAll("report_kind").length !== 1 ||
    params.getAll("report_value").length !== 1
  )
    throw new ApiError("INVALID_REQUEST");
  return parseReportTarget(
    params.get("report_kind"),
    params.get("report_value"),
  );
}

function storedReportTarget(
  kind: string | null,
  value: string | null,
): ReportTarget | null {
  if (kind === null && value === null) return null;
  return parseReportTarget(kind, value);
}

function reportTargetLocation(target: ReportTarget) {
  const params = new URLSearchParams({ kind: target.kind });
  params.set(
    target.kind === "timeline" ? "timeline_id" : "slug",
    target.kind === "timeline" ? target.timeline_id : target.slug,
  );
  return `/report?${params.toString()}`;
}

function assertUnambiguousCallbackQuery(params: URLSearchParams) {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (key === "next" || seen.has(key)) {
      throw new ApiError("INVALID_REQUEST");
    }
    seen.add(key);
  }
}

auth.get("/google", async (context) => {
  const reportTarget = reportTargetFromUrl(new URL(context.req.url));
  const config = oauthConfig(context.env);
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const cookie = cookiePolicy(context.env, "oauth");
  const reportTargetValue = reportTarget
    ? reportTarget.kind === "timeline"
      ? reportTarget.timeline_id
      : reportTarget.slug
    : null;
  await cleanupAuth(context.env);
  await context.env.DB.prepare(`INSERT INTO oauth_attempts
    (state_hash, browser_hash, verifier, nonce, expires_at, report_target_kind, report_target_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await hashToken(state),
      await hashToken(browser),
      verifier,
      nonce,
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      reportTarget?.kind ?? null,
      reportTargetValue,
    )
    .run();
  setCookie(context, cookie.name, browser, { ...cookie.options, maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return context.redirect(url.toString());
});

auth.get("/google/callback", async (context) => {
  const cookie = cookiePolicy(context.env, "oauth");
  const browser = getCookie(context, cookie.name);
  deleteCookie(context, cookie.name, cookie.options);
  assertUnambiguousCallbackQuery(new URL(context.req.url).searchParams);
  const state = context.req.query("state");
  if (!isToken(state) || !isToken(browser))
    throw new ApiError("INVALID_REQUEST");
  // DELETE RETURNING consumes exactly once, including simultaneous callbacks.
  const attempt = await context.env.DB.prepare(`DELETE FROM oauth_attempts
    WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
    RETURNING verifier, nonce, report_target_kind, report_target_value`)
    .bind(
      await hashToken(state),
      await hashToken(browser),
      new Date().toISOString(),
    )
    .first<{
      verifier: string;
      nonce: string;
      report_target_kind: string | null;
      report_target_value: string | null;
    }>();
  const code = context.req.query("code");
  if (!attempt || !code || code.length > 4096 || context.req.query("error")) {
    throw new ApiError("INVALID_REQUEST");
  }
  const reportTarget = storedReportTarget(
    attempt.report_target_kind,
    attempt.report_target_value,
  );
  const identity = await exchangeGoogleCode(
    context.env,
    code,
    attempt.verifier,
    attempt.nonce,
  );
  await createSession(context, identity);
  return context.redirect(
    reportTarget ? reportTargetLocation(reportTarget) : "/",
    303,
  );
});

auth.get("/local", (context) => {
  if (!localLoginEnabled(context.env)) throw new ApiError("NOT_FOUND");
  return context.json({ enabled: true });
});

auth.post("/local", async (context) => {
  if (!localLoginEnabled(context.env)) throw new ApiError("NOT_FOUND");
  assertSameOrigin(context);
  await createLocalSession(context);
  return context.redirect("/library", 303);
});

auth.post("/logout", async (context) => {
  assertSameOrigin(context);
  const hash = await sessionHash(context);
  if (hash)
    await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(hash)
      .run();
  const cookie = cookiePolicy(context.env, "session");
  deleteCookie(context, cookie.name, cookie.options);
  return context.body(null, 204);
});
