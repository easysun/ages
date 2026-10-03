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

function jpegSize(header: Uint8Array) {
  const data = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  let offset = 2;
  // Advance offsets without copying the remaining sample for each marker.
  while (offset < header.length) {
    if (header[offset++] !== 0xff) break;
    while (header[offset] === 0xff) offset++;
    const marker = header[offset++];
    if (marker === 0x01) continue;
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0xda ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > header.length
    )
      break;
    const length = data.getUint16(offset);
    if (length < 2 || offset + length > header.length) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (
        length < 8 ||
        header[offset + 7] === 0 ||
        length !== 8 + 3 * (header[offset + 7] ?? 0)
      )
        break;
      return {
        height: data.getUint16(offset + 3),
        width: data.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  throw new Error("Invalid or incomplete JPEG frame header");
}

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
      const { width, height } =
        mime === "image/jpeg" ? jpegSize(header) : imageSize(header);
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
