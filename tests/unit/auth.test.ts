import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appOrigin } from "../../src/auth/config";
import {
  hashToken,
  isToken,
  pkceChallenge,
  randomToken,
} from "../../src/auth/crypto";
import type { Bindings } from "../../src/bindings";

describe("Authentication primitives", () => {
  it("matches the RFC 7636 S256 vector so the provider can verify PKCE", async () => {
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("uses SHA-256 rather than storing the raw bearer token", async () => {
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("generates distinct 256-bit URL-safe tokens", () => {
    const tokens = Array.from({ length: 100 }, randomToken);
    expect(new Set(tokens).size).toBe(100);
    expect(tokens.every(isToken)).toBe(true);
    expect(isToken("a".repeat(42))).toBe(false);
    expect(isToken("a".repeat(44))).toBe(false);
    expect(isToken(undefined)).toBe(false);
  });

  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
    "https://ages.test",
  ])("allows a canonical secure origin or local loopback: %s", (origin) => {
    const bindings: Bindings = { ...env, APP_ENV: "local", APP_ORIGIN: origin };
    expect(appOrigin(bindings)).toBe(origin);
  });

  it.each([
    "http://ages.test",
    "https://ages.test/",
    "https://user:password@ages.test",
    "https://ages.test/path",
    "https://ages.test?x=1",
    "not-a-url",
  ])(
    "rejects origin configuration that could leak or misroute credentials: %s",
    (origin) => {
      expect(() =>
        appOrigin({ ...env, APP_ENV: "local", APP_ORIGIN: origin }),
      ).toThrow();
    },
  );
});
