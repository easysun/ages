import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";
import { z } from "zod";
import { ApiError } from "../http/errors";

export const uploadSchema = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((value) =>
      [...value].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    ),
  mime_type: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
  ]),
  size_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  captured_at: z.iso.datetime({ offset: true }).optional(),
});

export async function validateSignature(bytes: ArrayBuffer, mime: string) {
  // Bound reads and reject unrelated compressed formats before invoking a parser.
  const header = new Uint8Array(bytes);
  const text = (start: number, end: number) =>
    String.fromCharCode(...header.slice(start, end));
  const known =
    (mime === "image/jpeg" &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff) ||
    (mime === "image/png" && text(0, 8) === "\x89PNG\r\n\x1a\n") ||
    (mime === "image/gif" && ["GIF87a", "GIF89a"].includes(text(0, 6))) ||
    (mime === "image/webp" &&
      text(0, 4) === "RIFF" &&
      text(8, 12) === "WEBP") ||
    (mime === "video/mp4" && text(4, 8) === "ftyp") ||
    (mime === "video/webm" && text(0, 4) === "\x1a\x45\xdf\xa3");
  if (!known) throw new ApiError("UPLOAD_VALIDATION_FAILED");
  try {
    const detected = await fileTypeFromBuffer(header.subarray(0, 8192));
    if (detected?.mime !== mime) throw new Error("MIME mismatch");
    if (mime.startsWith("image/")) {
      const { width, height } = imageSize(header);
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > 30_000 ||
        height > 30_000 ||
        width * height > 100_000_000
      ) {
        throw new Error("Unsupported dimensions");
      }
      return { width, height };
    }
    return { width: null, height: null };
  } catch {
    throw new ApiError("UPLOAD_VALIDATION_FAILED");
  }
}
