import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { signUpload } from "../../src/assets/signing";
import { validateSignature } from "../../src/assets/validation";
import type { Bindings } from "../../src/bindings";

function decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

describe("Bounded media validation", () => {
  it("rejects a maximum-sized corrupt JPEG without quadratic buffer copying", async () => {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const slice = Uint8Array.prototype.slice;
    let copied = 0;
    const copy = vi
      .spyOn(Uint8Array.prototype, "slice")
      .mockImplementation(function (
        this: Uint8Array,
        start?: number,
        end?: number,
      ) {
        const result = slice.call(this, start, end);
        copied += result.length;
        return result;
      });
    try {
      await expect(
        validateSignature(bytes.buffer, "image/jpeg"),
      ).rejects.toThrow();
      expect(copied).toBeLessThan(bytes.length * 4);
    } finally {
      copy.mockRestore();
    }
  });

  it.each([
    [
      "image/png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    ],
    ["image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
    ["image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"],
  ])(
    "detects image metadata for %s without decoding the entire image",
    async (mime, encoded) => {
      expect(await validateSignature(decode(encoded).buffer, mime)).toEqual({
        width: 1,
        height: 1,
      });
    },
  );

  it("extracts JPEG frame dimensions rather than accepting the magic bytes alone", async () => {
    const frame = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0,
      0, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1,
      0xff, 0xd9,
    ]);
    expect(await validateSignature(frame.buffer, "image/jpeg")).toEqual({
      width: 1,
      height: 1,
    });
    await expect(
      validateSignature(
        new Uint8Array([0xff, 0xd8, 0xff]).buffer,
        "image/jpeg",
      ),
    ).rejects.toThrow();
  });

  it.each([0xc0, 0xc1, 0xc2])(
    "reads JPEG frame %s after repeated metadata and marker padding",
    async (marker) => {
      const bytes = new Uint8Array(128 * 1024 + 24);
      bytes.set([0xff, 0xd8]);
      for (let offset = 2; offset < 128 * 1024 + 2; offset += 4) {
        bytes.set([0xff, 0xe0, 0, 2], offset);
      }
      bytes.set(
        [
          0xff,
          0xff,
          marker,
          0,
          17,
          8,
          0,
          2,
          0,
          3,
          3,
          1,
          17,
          0,
          2,
          17,
          1,
          3,
          17,
          1,
          0xff,
          0xd9,
        ],
        128 * 1024 + 2,
      );
      expect(await validateSignature(bytes.buffer, "image/jpeg")).toEqual({
        width: 3,
        height: 2,
      });
    },
  );

  it.each(
    [
      [0xff, 0xe0, 0, 1],
      [0xff, 0xe0, 0xff, 0xff],
      [0xff, 0xda, 0, 2],
      [0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 3],
    ].map((segment) => ({ segment })),
  )(
    "rejects invalid or incomplete JPEG segments before a usable frame: %j",
    async ({ segment }) => {
      await expect(
        validateSignature(
          new Uint8Array([0xff, 0xd8, ...segment]).buffer,
          "image/jpeg",
        ),
      ).rejects.toThrow();
    },
  );

  it("recognizes supported video containers without promising codec compatibility", async () => {
    const mp4 = new Uint8Array([
      0,
      0,
      0,
      24,
      ...new TextEncoder().encode("ftypmp42"),
      0,
      0,
      0,
      0,
      ...new TextEncoder().encode("mp42isom"),
    ]);
    const webm = new Uint8Array([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x8b,
      0x42,
      0x82,
      0x84,
      ...new TextEncoder().encode("webm"),
      0x42,
      0x87,
      0x81,
      2,
    ]);
    for (const [mime, bytes] of [
      ["video/mp4", mp4],
      ["video/webm", webm],
    ] as const) {
      expect(await validateSignature(bytes.buffer, mime)).toEqual({
        width: null,
        height: null,
      });
    }
  });

  it("rejects excessive pixel dimensions and disguised executable/archive content", async () => {
    const huge = decode(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    );
    new DataView(huge.buffer).setUint32(16, 100_000);
    await expect(validateSignature(huge.buffer, "image/png")).rejects.toThrow();
    for (const content of [
      "MZ executable",
      "PK archive",
      "<script>alert(1)</script>",
    ]) {
      await expect(
        validateSignature(
          new Uint8Array(new TextEncoder().encode(content)).buffer,
          "image/jpeg",
        ),
      ).rejects.toThrow();
    }
  });
});

describe("S3 upload signing", () => {
  const bindings: Bindings = {
    ...env,
    APP_ENV: "local",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET_NAME: "ages-test",
    R2_ACCESS_KEY_ID: "synthetic-id",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
  };
  const now = new Date("2026-10-03T01:00:00.999Z");

  it("signs size, MIME and create-only conditions with second-accurate expiration", async () => {
    const upload = await signUpload(
      bindings,
      "originals/a",
      "image/png",
      100,
      now,
    );
    const url = new URL(upload.url);
    expect(upload.expires_at).toBe("2026-10-03T01:10:00.000Z");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261003T010000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    for (const [key, mime, size] of [
      ["originals/b", "image/png", 100],
      ["originals/a", "image/jpeg", 100],
      ["originals/a", "image/png", 101],
    ] as const) {
      const changed = new URL(
        (await signUpload(bindings, key, mime, size, now)).url,
      );
      expect(changed.searchParams.get("X-Amz-Signature")).not.toBe(
        url.searchParams.get("X-Amz-Signature"),
      );
    }
  });
});
