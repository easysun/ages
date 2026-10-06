import { describe, expect, it } from "vitest";
import { googleCustomParameterName } from "../../src/tracking/google-parameters";

describe("GA4 custom parameter names", () => {
  it("uses a fixed namespace for SDK control-name collisions", async () => {
    for (const key of [
      "send_to",
      "page_location",
      "transport_url",
      "event_callback",
      "event",
    ]) {
      expect(await googleCustomParameterName(key)).toBe(`ages_c_${key}`);
    }
  });

  it("hashes long and Unicode keys stably without exposing the key", async () => {
    const firstKey = "a".repeat(40);
    const unicodeKey = "旅の記録";
    const first = await googleCustomParameterName(firstKey);
    const reordered = await Promise.all(
      [unicodeKey, firstKey].map(googleCustomParameterName),
    );
    const unicode = reordered[0];

    expect(first).toMatch(/^ages_h_[0-9a-f]{32}$/);
    expect(unicode).toMatch(/^ages_h_[0-9a-f]{32}$/);
    expect(reordered[1]).toBe(first);
    expect(first).not.toBe(unicode);
    expect(first).not.toContain(firstKey);
    expect(unicode).not.toContain(unicodeKey);
    expect(first).toHaveLength(39);
    expect(first).toBe("ages_h_e33cdf9c7f7120b98e8c78408953e07f");
    expect(unicode).toBe("ages_h_adecaf6b5aa50fe49d052aebca196811");
  });

  it("keeps distinct accepted lone-surrogate keys distinct", async () => {
    const firstKey = String.fromCharCode(0xd800).repeat(40);
    const secondKey = String.fromCharCode(0xd801).repeat(40);
    const replacementCharacterKey = "�".repeat(40);

    const [first, second, replacementCharacter] = await Promise.all([
      googleCustomParameterName(firstKey),
      googleCustomParameterName(secondKey),
      googleCustomParameterName(replacementCharacterKey),
    ]);

    expect(first).not.toBe(second);
    expect(first).not.toBe(replacementCharacter);
    expect(second).not.toBe(replacementCharacter);
    expect(replacementCharacter).toBe(
      "ages_h_410f108a5ad93d71d11b22648db29799",
    );
  });
});
