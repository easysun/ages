export type SupportPlan = "free" | "plus" | "creator" | "pro";

const rates: Record<SupportPlan, number> = {
  free: 2000,
  plus: 1000,
  creator: 500,
  pro: 250,
};

export function calculateSupportFee(
  amountMinor: number,
  plan: SupportPlan,
): {
  grossMinor: number;
  platformFeeMinor: number;
  remainingMinor: number;
} {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new RangeError(
      "Amount must be a positive safe integer in minor units",
    );
  if (!Object.hasOwn(rates, plan)) throw new RangeError("Unknown support plan");
  const platformFeeMinor = Number(
    (BigInt(amountMinor) * BigInt(rates[plan]) + 5000n) / 10000n,
  );
  return {
    grossMinor: amountMinor,
    platformFeeMinor,
    remainingMinor: amountMinor - platformFeeMinor,
  };
}
