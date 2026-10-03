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
import { cleanupAuth, createSession, sessionHash } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";

export const auth = new Hono<AppContext>();
auth.use("*", async (context, next) => {
  context.header("Referrer-Policy", "no-referrer");
  if (new URL(context.req.url).origin !== appOrigin(context.env)) {
    throw new ApiError("FORBIDDEN");
  }
  await next();
});

auth.get("/google", async (context) => {
  const config = oauthConfig(context.env);
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const cookie = cookiePolicy(context.env, "oauth");
  await cleanupAuth(context.env);
  await context.env.DB.prepare(`INSERT INTO oauth_attempts
    (state_hash, browser_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      await hashToken(state),
      await hashToken(browser),
      verifier,
      nonce,
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
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
  const state = context.req.query("state");
  const cookie = cookiePolicy(context.env, "oauth");
  const browser = getCookie(context, cookie.name);
  deleteCookie(context, cookie.name, cookie.options);
  if (!isToken(state) || !isToken(browser))
    throw new ApiError("INVALID_REQUEST");
  // DELETE RETURNING consumes exactly once, including simultaneous callbacks.
  const attempt = await context.env.DB.prepare(`DELETE FROM oauth_attempts
    WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
    RETURNING verifier, nonce`)
    .bind(
      await hashToken(state),
      await hashToken(browser),
      new Date().toISOString(),
    )
    .first<{ verifier: string; nonce: string }>();
  const code = context.req.query("code");
  if (!attempt || !code || code.length > 4096 || context.req.query("error")) {
    throw new ApiError("INVALID_REQUEST");
  }
  const identity = await exchangeGoogleCode(
    context.env,
    code,
    attempt.verifier,
    attempt.nonce,
  );
  await createSession(context, identity);
  return context.redirect("/", 303);
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
