import { z } from "zod";
import { ApiError } from "../http/errors";

export const tagSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      [...value].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
  );
export const tagsSchema = z.strictObject({
  tags: z
    .array(tagSchema)
    .max(20)
    .refine((tags) => new Set(tags).size === tags.length),
});
const cursorSchema = z.strictObject({
  v: z.literal(1),
  owner: z.string().min(1).max(200),
  tag: tagSchema.nullable(),
  created_at: z.iso.datetime(),
  id: z.string().min(1).max(200),
});
type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function libraryQuery(url: string, owner: string) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (
      !["limit", "tag", "cursor"].includes(key) ||
      params.getAll(key).length !== 1
    )
      throw new ApiError("INVALID_REQUEST");
  }
  const limitText = params.get("limit") ?? "30";
  const limit = Number(limitText);
  if (
    !/^[1-9]\d*$/.test(limitText) ||
    !Number.isSafeInteger(limit) ||
    limit > 100
  )
    throw new ApiError("INVALID_REQUEST");
  const tag = params.get("tag");
  if (tag !== null && !tagSchema.safeParse(tag).success)
    throw new ApiError("INVALID_REQUEST");
  let cursor: Cursor | null = null;
  const encoded = params.get("cursor");
  if (encoded !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2000}$/.test(encoded))
        throw new Error("Invalid cursor");
      const bytes = Uint8Array.from(
        atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      );
      cursor = cursorSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes,
          ),
        ),
      );
      if (
        encodeCursor(cursor) !== encoded ||
        cursor.owner !== owner ||
        cursor.tag !== tag
      )
        throw new Error("Cursor scope mismatch");
    } catch {
      throw new ApiError("INVALID_REQUEST");
    }
  }
  return { limit, tag, cursor };
}
