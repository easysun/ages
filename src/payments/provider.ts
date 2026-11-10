// Provider identifiers are external references, not Ages payment IDs.
import type { PaymentPurpose, VerifiedPaymentEvent } from "./transaction";

export type PaymentRequest = {
  paymentId: string;
  purpose: PaymentPurpose;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};

export type ProviderEvent = VerifiedPaymentEvent;

export interface PaymentProvider {
  readonly name: string;
  createPayment(request: PaymentRequest): Promise<{
    providerPaymentId: string;
    checkout:
      | { kind: "redirect"; url: string }
      | { kind: "form"; action: string; fields: Record<string, string> };
  }>;
  verifyCallback(request: Request): Promise<ProviderEvent>;
  queryPayment(providerPaymentId: string): Promise<{
    status: "pending" | "paid" | "failed" | "refunded" | "disputed";
  }>;
}
