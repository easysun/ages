import type { Context } from "hono";
import type { Asset } from "../assets/model";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";

function mediaRange(
  value: string,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    offset >= size ||
    end < offset
  )
    return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

// Callers authorize their own scope before passing an asset; this helper never grants access.
export async function streamAssetMedia(
  context: Context<AppContext>,
  asset: Asset,
  recheckGrant?: () => Promise<void>,
) {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Content-Type-Options", "nosniff");
  if (asset.status !== "ready" || asset.deleted_at !== null || !asset.etag)
    throw new ApiError("NOT_FOUND");
  const head = await context.env.MEDIA.head(asset.r2_key);
  if (
    !head ||
    head.etag !== asset.etag ||
    head.size !== asset.size_bytes ||
    head.httpMetadata?.contentType !== asset.mime_type
  )
    throw new ApiError("NOT_FOUND");
  await recheckGrant?.();
  if (context.req.method === "HEAD") {
    context.header("Content-Type", asset.mime_type);
    context.header("Content-Length", String(asset.size_bytes));
    context.header("Accept-Ranges", "bytes");
    return context.body(null, 200);
  }
  // Undisclosed storage validators cannot satisfy If-Range; return the full representation.
  const rangeHeader = context.req.header("If-Range")
    ? undefined
    : context.req.header("Range");
  const range =
    rangeHeader === undefined
      ? undefined
      : mediaRange(rangeHeader, asset.size_bytes);
  if (range === null) {
    context.header("Accept-Ranges", "bytes");
    context.header("Content-Length", "0");
    context.header("Content-Range", `bytes */${asset.size_bytes}`);
    return context.body(null, 416);
  }
  const object = await context.env.MEDIA.get(asset.r2_key, {
    onlyIf: { etagMatches: asset.etag },
    ...(range ? { range } : {}),
  });
  if (!object || !("body" in object)) throw new ApiError("NOT_FOUND");
  if (
    object.version !== head.version ||
    object.etag !== asset.etag ||
    object.size !== asset.size_bytes ||
    object.httpMetadata?.contentType !== asset.mime_type
  ) {
    await object.body.cancel();
    throw new ApiError("NOT_FOUND");
  }
  try {
    await recheckGrant?.();
  } catch (error) {
    await object.body.cancel();
    throw error;
  }
  context.header("Content-Type", asset.mime_type);
  context.header("Accept-Ranges", "bytes");
  context.header("Content-Length", String(range?.length ?? asset.size_bytes));
  if (range)
    context.header(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size_bytes}`,
    );
  return context.body(object.body, range ? 206 : 200);
}
