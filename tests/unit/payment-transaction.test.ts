import { describe, expect, it } from "vitest";
import { applyVerifiedPaymentEvent } from "../../src/payments/transaction";

const payment = {
  paymentId: "payment-123",
  providerPaymentId: "provider-payment-456",
  purpose: "subscription" as const,
  amountMinor: 2500,
  currency: "USD",
  status: "pending" as const,
};

const paidEvent = {
  providerEventId: "provider-event-789",
  paymentId: "payment-123",
  providerPaymentId: "provider-payment-456",
  amountMinor: 2500,
  currency: "USD",
  kind: "paid" as const,
};

describe("verified payment transitions", () => {
  it("grants entitlement only for a matching verified paid event", () => {
    expect(applyVerifiedPaymentEvent(payment, paidEvent)).toEqual({
      outcome: "applied",
      status: "paid",
      grantEntitlement: true,
    });
  });

  it("does not grant subscription entitlement for a support payment", () => {
    expect(
      applyVerifiedPaymentEvent({ ...payment, purpose: "support" }, paidEvent),
    ).toEqual({
      outcome: "applied",
      status: "paid",
      grantEntitlement: false,
    });
  });

  it.each([
    ["internal payment ID", { paymentId: "another-payment" }],
    ["provider payment ID", { providerPaymentId: "another-provider-payment" }],
    ["amount", { amountMinor: 2501 }],
    ["currency", { currency: "EUR" }],
  ] as const)("rejects a paid event with a mismatched %s", (_label, change) => {
    expect(
      applyVerifiedPaymentEvent(payment, { ...paidEvent, ...change }),
    ).toEqual({
      outcome: "rejected",
      status: "pending",
      grantEntitlement: false,
      reason: "payment_mismatch",
    });
  });

  it("rejects malformed normalized currency data without granting entitlement", () => {
    const malformedEvent = {
      ...paidEvent,
      currency: 840 as unknown as string,
    };

    expect(applyVerifiedPaymentEvent(payment, malformedEvent)).toEqual({
      outcome: "rejected",
      status: "pending",
      grantEntitlement: false,
      reason: "invalid_event",
    });
  });

  it.each([
    ["failed", "paid"],
    ["refunded", "paid"],
    ["disputed", "paid"],
    ["paid", "failed"],
  ] as const)("does not regress %s to %s", (currentStatus, kind) => {
    const currentPayment = { ...payment, status: currentStatus };
    const event = { ...paidEvent, providerEventId: `event-${kind}`, kind };

    expect(applyVerifiedPaymentEvent(currentPayment, event)).toEqual({
      outcome: "rejected",
      status: currentStatus,
      grantEntitlement: false,
      reason: "invalid_transition",
    });
  });

  it.each(["refunded", "disputed"] as const)(
    "rejects an out-of-order %s event while payment is pending",
    (kind) => {
      const event =
        kind === "refunded"
          ? { ...paidEvent, kind, refundAmountMinor: 2500 }
          : { ...paidEvent, kind };

      expect(applyVerifiedPaymentEvent(payment, event)).toEqual({
        outcome: "rejected",
        status: "pending",
        grantEntitlement: false,
        reason: "invalid_transition",
      });
    },
  );

  it("allows a paid payment to become refunded after a full refund", () => {
    expect(
      applyVerifiedPaymentEvent(
        { ...payment, status: "paid" },
        { ...paidEvent, kind: "refunded", refundAmountMinor: 2500 },
      ),
    ).toEqual({
      outcome: "applied",
      status: "refunded",
      grantEntitlement: false,
    });
  });

  it("allows a paid payment to become disputed", () => {
    expect(
      applyVerifiedPaymentEvent(
        { ...payment, status: "paid" },
        { ...paidEvent, kind: "disputed" },
      ),
    ).toEqual({
      outcome: "applied",
      status: "disputed",
      grantEntitlement: false,
    });
  });

  it("rejects a partial refund instead of treating it as a full refund", () => {
    expect(
      applyVerifiedPaymentEvent(
        { ...payment, status: "paid" },
        { ...paidEvent, kind: "refunded", refundAmountMinor: 1200 },
      ),
    ).toEqual({
      outcome: "rejected",
      status: "paid",
      grantEntitlement: false,
      reason: "partial_refund_unsupported",
    });
  });

  it("rejects a refund larger than the original charge", () => {
    expect(
      applyVerifiedPaymentEvent(
        { ...payment, status: "paid" },
        { ...paidEvent, kind: "refunded", refundAmountMinor: 2600 },
      ),
    ).toEqual({
      outcome: "rejected",
      status: "paid",
      grantEntitlement: false,
      reason: "refund_amount_mismatch",
    });
  });

  it("rejects a refund event without an explicit refunded amount", () => {
    const event = {
      ...paidEvent,
      kind: "refunded",
    } as unknown as Parameters<typeof applyVerifiedPaymentEvent>[1];

    expect(
      applyVerifiedPaymentEvent({ ...payment, status: "paid" }, event),
    ).toEqual({
      outcome: "rejected",
      status: "paid",
      grantEntitlement: false,
      reason: "invalid_event",
    });
  });

  it("records a valid failure without granting entitlement", () => {
    expect(
      applyVerifiedPaymentEvent(payment, { ...paidEvent, kind: "failed" }),
    ).toEqual({
      outcome: "applied",
      status: "failed",
      grantEntitlement: false,
    });
  });
});
