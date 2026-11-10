# Payment Foundation Requirements

The current `src/payments` modules define provider-neutral types, fee calculation,
and a pure verified-event transition helper. They do not create checkouts, receive
webhooks, persist payments, grant entitlements, or connect to a payment provider.
Keep payment providers disabled until a complete integration meets these gates.

## Durable checkout creation

- Create a local payment row and a server-generated idempotency key in durable
  storage before calling a provider. Enforce uniqueness for the logical checkout
  request (including its owner or account scope) so retried client requests find
  the same payment rather than create a second charge.
- Reuse the same persisted key and identical payment parameters for retries of
  the same logical provider request. A new logical checkout gets a new key. Do
  not generate a new key after a timeout or uncertain provider response; query or
  reconcile the existing attempt first. Follow the provider's documented key
  scope and retention window, and reconcile before retrying after that window.
- Persist the provider payment ID and checkout result against the local payment.
  If the provider call succeeds but persistence fails, recover the same provider
  operation with its original key rather than starting another checkout.

## Verified event application and entitlement

- Verify the provider signature and normalize the event before applying it. In
  one durable transaction, insert a provider-scoped unique event ID, update the
  payment state, and apply the resulting entitlement state. The event record
  prevents replay and the transaction prevents payment and entitlement from
  diverging.
- If entitlement storage cannot participate in that transaction, atomically
  persist the payment transition, deduplication record, and a durable outbox
  entry. Process the outbox at least once with idempotent entitlement updates;
  retry until applied and expose failures for operations. A transient in-memory
  task or a non-durable queue is not a substitute.
- A verified paid subscription may activate entitlement. A full refund or an
  open dispute must suspend/revoke that subscription entitlement as part of the
  same transaction or outbox flow. Support payments never grant subscription
  entitlement. Derive access from the authoritative entitlement state, not from
  a cached payment status or a checkout return URL.
- Restore access after a dispute only after a verified authoritative resolution
  that the charge was won/retained. A payment marked `disputed` is unresolved:
  keep its subscription entitlement suspended and retain it for reconciliation.
  Do not treat a generic `paid` query result or a missing event as dispute
  resolution. Reconciliation must compare unresolved local payments with the
  provider's authoritative state, record each resolution idempotently, and leave
  still-disputed payments unresolved for a later run or operator review. The
  current normalized event/query types cannot express a dispute resolution;
  extend them with explicit authoritative outcomes before enabling that flow.
- A partial refund is unsupported by the current transition model. Do not mark
  its provider event as processed or return a success acknowledgment. Preserve
  it in an unhandled durable inbox for retry/review, signal non-success to the
  provider, and alert or reconcile it. Acknowledge it only after a supported
  full-refund transition or an explicit future partial-refund implementation
  has durably handled it. Never interpret a partial refund as a full refund.

The stateless `applyVerifiedPaymentEvent` helper is validation/transition logic
only; its returned flags are not persistence, replay protection, entitlement
management, or webhook acknowledgment guarantees. Add and verify durable storage,
provider-scoped deduplication, the transaction/outbox path, dispute-resolution
reconciliation, and provider-specific acknowledgment behavior before enabling
any adapter.
