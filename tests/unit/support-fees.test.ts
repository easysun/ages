import { describe, expect, it } from "vitest";
import { calculateSupportFee } from "../../src/payments/support-fees";

describe("support platform fees", () => {
  it.each([
    ["free", 2000],
    ["plus", 1000],
    ["creator", 500],
    ["pro", 250],
  ] as const)("uses the requested %s rate", (plan, expected) => {
    expect(calculateSupportFee(10_000, plan)).toEqual({
      grossMinor: 10_000,
      platformFeeMinor: expected,
      remainingMinor: 10_000 - expected,
    });
  });

  it("rounds half a minor unit up without losing money", () => {
    expect(calculateSupportFee(20, "pro")).toEqual({
      grossMinor: 20,
      platformFeeMinor: 1,
      remainingMinor: 19,
    });
  });

  it("calculates safely at the largest supported integer amount", () => {
    const gross = Number.MAX_SAFE_INTEGER;
    const result = calculateSupportFee(gross, "free");
    expect(BigInt(result.platformFeeMinor)).toBe(
      (BigInt(gross) * 2000n + 5000n) / 10000n,
    );
    expect(result.platformFeeMinor + result.remainingMinor).toBe(gross);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    "rejects invalid amounts: %s",
    (amount) => {
      expect(() => calculateSupportFee(amount, "free")).toThrow();
    },
  );

  it("rejects unknown plan values at runtime", () => {
    expect(() => calculateSupportFee(100, "admin" as never)).toThrow();
  });
});
