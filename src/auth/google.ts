import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import type { Bindings } from "../bindings";
import { ApiError } from "../http/errors";
import { oauthConfig } from "./config";

export const googleIssuer = "https://accounts.google.com";
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { [customFetch]: (url, options) => fetch(url, options) },
);
const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(320),
  email_verified: z.literal(true),
  name: z.string().max(200).optional(),
  picture: z.url().max(2048).optional(),
});

export type GoogleIdentity = z.output<typeof identitySchema>;

export async function exchangeGoogleCode(
  bindings: Bindings,
  code: string,
  verifier: string,
  nonce: string,
): Promise<GoogleIdentity> {
  const config = oauthConfig(bindings);
  let response: Response;
  let payload: unknown;
  let stage: "fetch" | "response" | "decode" = "fetch";
  let providerStatus: number | null = null;
  let responseFormat: "unavailable" | "json" | "other" = "unavailable";
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    stage = "response";
    providerStatus = response.status;
    responseFormat =
      response.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "application/json"
        ? "json"
        : "other";
    if (response.status >= 500) throw new Error("Provider unavailable");
    stage = "decode";
    payload = await response.json();
  } catch {
    // Closed fields identify the failing boundary without logging provider data.
    console.error(
      JSON.stringify({
        event: "oauth_token_exchange_failed",
        stage,
        provider_status: providerStatus,
        response_format: responseFormat,
      }),
    );
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  const token = z
    .object({ id_token: z.string().max(16_384) })
    .safeParse(payload);
  if (!response.ok || !token.success) throw new ApiError("UNAUTHENTICATED");

  try {
    const { payload: claims } = await jwtVerify(
      token.data.id_token,
      googleKeys,
      {
        issuer: [googleIssuer, "accounts.google.com"],
        audience: config.clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        maxTokenAge: "10 minutes",
      },
    );
    if (
      claims.nonce !== nonce ||
      claims.aud !== config.clientId ||
      (claims.azp !== undefined && claims.azp !== config.clientId)
    ) {
      throw new Error("Identity mismatch");
    }
    return identitySchema.parse(claims);
  } catch {
    throw new ApiError("UNAUTHENTICATED");
  }
}
