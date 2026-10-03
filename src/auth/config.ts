import type { Context } from "hono";
import type { AppContext, Bindings } from "../bindings";
import { ApiError } from "../http/errors";

export function appOrigin(bindings: Bindings): string {
  let url: URL;
  try {
    url = new URL(bindings.APP_ORIGIN ?? "");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  const localHttp =
    bindings.APP_ENV === "local" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.origin !== bindings.APP_ORIGIN
  ) {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  return url.origin;
}

export function oauthConfig(bindings: Bindings) {
  const origin = appOrigin(bindings);
  if (!bindings.GOOGLE_CLIENT_ID || !bindings.GOOGLE_CLIENT_SECRET) {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  return {
    clientId: bindings.GOOGLE_CLIENT_ID,
    clientSecret: bindings.GOOGLE_CLIENT_SECRET,
    redirectUri: `${origin}/auth/google/callback`,
  };
}

export function assertSameOrigin(context: Context<AppContext>) {
  if (
    context.req.header("Origin") !== appOrigin(context.env) ||
    context.req.header("Sec-Fetch-Site") === "cross-site"
  ) {
    throw new ApiError("FORBIDDEN");
  }
}

export function cookiePolicy(bindings: Bindings, name: "session" | "oauth") {
  const secure = bindings.APP_ENV !== "local";
  return {
    name: `${secure ? "__Host-" : ""}ages_${name}`,
    options: { httpOnly: true, secure, sameSite: "Lax" as const, path: "/" },
  };
}
