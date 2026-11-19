import { AwsV4Signer } from "aws4fetch";
import { appOrigin } from "../auth/config";
import type { Bindings } from "../bindings";
import { ApiError } from "../http/errors";

export async function signUpload(
  bindings: Bindings,
  key: string,
  mime: string,
  size: number,
  now: Date,
) {
  const local = bindings.LOCAL_R2_UPLOADS_ENABLED === "true";
  if (
    (!local && !/^[a-f0-9]{32}$/.test(bindings.R2_ACCOUNT_ID ?? "")) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bindings.R2_BUCKET_NAME ?? "") ||
    !bindings.R2_ACCESS_KEY_ID ||
    !bindings.R2_SECRET_ACCESS_KEY
  ) {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  let endpoint = `https://${bindings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  if (local) {
    // appOrigin allows HTTP only on exact loopback hosts in the local environment.
    const origin = appOrigin(bindings);
    if (bindings.APP_ENV !== "local" || !origin.startsWith("http://"))
      throw new ApiError("SERVICE_UNAVAILABLE");
    endpoint = `${origin}/cdn-cgi/local/r2/s3`;
  }
  const url = new URL(`${endpoint}/${bindings.R2_BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", "600");
  const headers = { "Content-Type": mime, "If-None-Match": "*" };
  const signed = await new AwsV4Signer({
    url: url.toString(),
    method: "PUT",
    accessKeyId: bindings.R2_ACCESS_KEY_ID,
    secretAccessKey: bindings.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    signQuery: true,
    allHeaders: true,
    datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    headers: { ...headers, "Content-Length": String(size) },
  }).sign();
  // Browsers compute Content-Length from the File/Blob; scripts must not set it.
  return {
    method: "PUT" as const,
    url: signed.url.toString(),
    headers,
    expires_at: new Date(
      Math.floor(now.getTime() / 1000) * 1000 + 600_000,
    ).toISOString(),
  };
}
