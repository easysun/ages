export type PaymentStatus =
  | "pending"
  | "paid"
  | "failed"
  | "refunded"
  | "disputed";

export type PaymentPurpose = "subscription" | "support";

export type PaymentEventKind = Exclude<PaymentStatus, "pending">;

export type PaymentTransaction = {
  paymentId: string;
  providerPaymentId: string;
  purpose: PaymentPurpose;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
};

type VerifiedPaymentEventBase = {
  providerEventId: string;
  paymentId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
};

export type VerifiedPaymentEvent =
  | (VerifiedPaymentEventBase & {
      kind: Exclude<PaymentEventKind, "refunded">;
    })
  | (VerifiedPaymentEventBase & {
      kind: "refunded";
      refundAmountMinor: number;
    });

export type PaymentTransitionResult =
  | {
      outcome: "applied";
      status: PaymentStatus;
      grantEntitlement: boolean;
    }
  | {
      outcome: "unchanged";
      status: PaymentStatus;
      grantEntitlement: false;
    }
  | {
      outcome: "rejected";
      status: PaymentStatus;
      grantEntitlement: false;
      reason:
        | "invalid_event"
        | "invalid_payment"
        | "payment_mismatch"
        | "invalid_transition"
        | "partial_refund_unsupported"
        | "refund_amount_mismatch";
    };

const eventKinds: readonly string[] = [
  "paid",
  "failed",
  "refunded",
  "disputed",
];
const paymentStatuses: readonly string[] = [
  "pending",
  "paid",
  "failed",
  "refunded",
  "disputed",
];
const paymentPurposes: readonly string[] = ["subscription", "support"];

const allowedTransitions: Record<PaymentStatus, readonly PaymentEventKind[]> = {
  pending: ["paid", "failed"],
  paid: ["refunded", "disputed"],
  failed: [],
  refunded: [],
  disputed: [],
};

/**
 * Computes a transition after a provider adapter has verified the event.
 *
 * This helper is stateless. It does not persist or scope provider event IDs,
 * deduplicate retries, or atomically apply payment changes. Production webhook
 * handling must add durable, provider-scoped replay protection in the same
 * transaction as the payment update before claiming those guarantees.
 */
export function applyVerifiedPaymentEvent(
  payment: PaymentTransaction,
  event: VerifiedPaymentEvent,
): PaymentTransitionResult {
  if (
    !paymentStatuses.includes(payment.status) ||
    typeof payment.paymentId !== "string" ||
    payment.paymentId.length === 0 ||
    typeof payment.providerPaymentId !== "string" ||
    payment.providerPaymentId.length === 0 ||
    typeof payment.purpose !== "string" ||
    !paymentPurposes.includes(payment.purpose) ||
    !Number.isSafeInteger(payment.amountMinor) ||
    payment.amountMinor <= 0 ||
    typeof payment.currency !== "string" ||
    payment.currency.length === 0
  ) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "invalid_payment",
    };
  }

  if (
    typeof event.providerEventId !== "string" ||
    event.providerEventId.length === 0 ||
    typeof event.paymentId !== "string" ||
    event.paymentId.length === 0 ||
    typeof event.providerPaymentId !== "string" ||
    event.providerPaymentId.length === 0 ||
    !Number.isSafeInteger(event.amountMinor) ||
    event.amountMinor <= 0 ||
    typeof event.currency !== "string" ||
    event.currency.length === 0 ||
    typeof event.kind !== "string" ||
    !eventKinds.includes(event.kind) ||
    (event.kind === "refunded" &&
      (!Number.isSafeInteger(event.refundAmountMinor) ||
        event.refundAmountMinor <= 0))
  ) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "invalid_event",
    };
  }

  if (
    event.paymentId !== payment.paymentId ||
    event.providerPaymentId !== payment.providerPaymentId ||
    event.amountMinor !== payment.amountMinor ||
    event.currency.toUpperCase() !== payment.currency.toUpperCase()
  ) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "payment_mismatch",
    };
  }

  if (
    event.kind === "refunded" &&
    event.refundAmountMinor < payment.amountMinor
  ) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "partial_refund_unsupported",
    };
  }

  if (
    event.kind === "refunded" &&
    event.refundAmountMinor > payment.amountMinor
  ) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "refund_amount_mismatch",
    };
  }

  if (event.kind === payment.status) {
    return {
      outcome: "unchanged",
      status: payment.status,
      grantEntitlement: false,
    };
  }

  if (!allowedTransitions[payment.status].includes(event.kind)) {
    return {
      outcome: "rejected",
      status: payment.status,
      grantEntitlement: false,
      reason: "invalid_transition",
    };
  }

  return {
    outcome: "applied",
    status: event.kind,
    grantEntitlement:
      payment.purpose === "subscription" &&
      payment.status === "pending" &&
      event.kind === "paid",
  };
}
