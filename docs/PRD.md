# Ages product requirements

Status: working product requirements, 2026-11-20. This document distinguishes
requirements from repository evidence. A merged feature or passing local test
does not establish that it is deployed or verified in production.

## Product and intended users

Ages helps people preserve and share a living timeline of memories. An owner
can start with photos and text, arrange a story, share it, and return to append
new moments without changing its share URL. Short links, raw media links,
previews, and QR codes support distribution of that story. A public social feed
is not an MVP prerequisite.

The primary MVP journey is:

1. Sign in and create a private timeline, starting with text or a photo.
2. Add further media and text moments, reusing private library assets when desired.
3. Set each moment's narrative position, description, and event date.
4. Share the timeline under an explicit visibility policy.
5. Return to append a later moment without changing the share URL.

The accepted end-to-end acceptance journey includes three photos, unlisted
sharing with server-rendered OG metadata, then a fourth appended photo. See
[implementation-plan.md](implementation-plan.md) for detailed stage gates.

## Scope and requirements

### Timelines and library

- Asset, TimelineItem, Timeline, and Link are distinct entities. A reusable
  Asset can appear in multiple timelines with independent story metadata.
  Removing a TimelineItem, Link, or Timeline must not delete its Asset.
- Preserve the distinction between capture time, event date, and user-selected
  narrative order. Date-only events must not silently become UTC instants.
- Owners can add text and photo moments to the same timeline, reorder moments,
  and edit their story details. The web interface supports keyboard and touch
  alternatives to drag interactions.
- Reorder validates the complete unique item set, applies atomically, and
  returns a version conflict rather than overwriting concurrent changes.
  Refresh must preserve the committed order and metadata.
- Product direction includes video and audio. Supported formats, processing,
  and acceptance for each are separate release gates; do not represent them as
  production-ready solely from this document.
- Uploads reserve quota before direct object upload, verify ownership, object
  size and file content before completion, and finalize idempotently.
  Storage cleanup and reconciliation must be safe under retries and races.

### Images launch usage and upgrade experience

- The Phase 1 Images owner experience at `im.ages.tw` shows a labelled storage
  meter and percentage for positive allowances, remaining capacity, and the
  distinction between completed usage and pending upload reservations. A zero
  allowance is a clearly explained exhausted state without a calculated percent.
  If an image-count entitlement is
  actually enforced, show a second count meter with used/allowed/remaining;
  otherwise show only an informational image count without a fake limit.
- Reuse the authoritative D1-backed account quota and existing Library progress
  UI. Any Images-specific or count-based quota must first establish server-side
  ownership, atomic admission, Trash/retention counting, and cross-product
  Asset reuse semantics. Specific Free and paid plan capacity entitlements
  remain proposals until separately approved.
- Offer a discoverable informational **Upgrade plan** entry, linked to the
  official `https://ages.tw/pricing` page and visibly stating that subscriptions
  are not yet available. Do not create payment sessions, activate subscriptions,
  or imply an upgrade took effect while the merchant and payment gates remain
  incomplete. See [images-quota-and-upgrade.md](images-quota-and-upgrade.md).

### Sharing, access, and recovery

- Assets and timelines default to private. Unlisted pages are accessible by
  their URL and send noindex. Public pages may be indexed.
- Private titles, previews, media, and API responses must not be disclosed to
  anonymous users or other owners. Visibility is checked on each access.
- Sharing expiry and revocation take effect immediately. Retired slugs cannot
  be claimed by another owner. Thumbnail and OG media obey equivalent access
  controls.
- Trash and restore must protect against accidental deletion, subject to a
  published retention policy. A referenced Asset cannot be trashed until its
  references are removed; a future change to that behavior requires an explicit
  product decision. Authenticated memories must not silently expire due to
  inactivity.
- Rate limiting, upload cleanup, abuse controls, and recoverable backups are
  launch requirements. Validate behavior under concurrent requests and failure
  conditions before enabling public uploads.

### Plans and payments

The canonical public plan information belongs at **https://ages.tw/pricing** on
the official site. It must be readable without signing in, clearly distinguish
subscription prices from creator-support platform fees, and link to
consumer@ages.tw for customer support. Provide the page in English and
Traditional Chinese.

The following figures are **proposed**, in New Taiwan dollars per month. They
are not a promise that purchasing is available.

| Plan | Proposed monthly subscription | Proposed creator-support platform fee |
| --- | ---: | ---: |
| Free | NT$0 | 20% |
| Plus | NT$99 | 10% |
| Creator | NT$299 | 5% |
| Pro | NT$599 | 2.5% |

Creator support is separate from a member's subscription. The rate applies to
support received under the creator's plan. Specific plan features, storage
limits, annual pricing, and provider charges remain open until confirmed.
The official pricing page does not advertise a free trial. Do not advertise or
activate checkout while payment integration and merchant review remain incomplete.
An Images quota-panel upgrade link is informational only until paid entitlements
are approved and enabled; unpublished per-plan storage and image-count limits
must not be represented as purchasable benefits.

Before paid launch, durable idempotent checkout, verified and deduplicated
provider events, correct entitlement transitions, refunds, dispute handling,
and reconciliation must meet [payment-foundation.md](payment-foundation.md).
The payment foundation is provider-neutral; payment and webhook adapters are
disabled in the current repository.

### Clients, localization, and accessibility

Web is the first client. Interfaces must support desktop and mobile layouts,
keyboard and touch interaction, semantic controls, and reduced motion. APIs
and domain data must remain usable by future Android, iOS, and spatial
clients without depending on browser-only assumptions. English and Traditional Chinese are required across the web product, including
core creation, sharing, errors, and accessible controls. User-authored content
must remain unchanged. Localized public pages retain visibility and noindex
semantics. Each supported flow needs keyboard and mobile verification.

## Measurement and acceptance

The north-star measure is monthly active timelines receiving at least one new
item. Track activation, first share, viewer conversion, four-week append
retention, items per active timeline, and share-to-view ratio. Define reporting
timezone and event deduplication before using these metrics for decisions.

Release acceptance must cover:

- The complete sign-in, upload, timeline, share, and append journey.
- Reuse of one Asset in multiple timelines without unintended deletion.
- Reorder persistence, stale-version 409 responses, and concurrent edits.
- Anonymous and cross-owner access denial for private content and media.
- Expired or revoked links, unlisted noindex, and protected preview images.
- Upload retries, incomplete uploads, corrupted files, quota races, and cleanup.
- Images storage and optional enforced image-count usage/remaining indicators,
  quota boundary and concurrency states, bilingual accessibility, and a clearly
  unavailable-but-future-ready upgrade link without payment-side effects.
- A referenced Asset is protected from trash. An unreferenced Asset can be
  trashed and restored without affecting other stories or media.
- English and Traditional Chinese plan presentation, prices, support contact,
  disabled checkout, and keyboard/mobile rendering.
- Unit and regression checks, isolated restore validation, and environment
  specific smoke checks before promoting an approved revision.

## Verified repository state and open release work

At main commit `c91821c`, the repository includes the existing app
`/pricing` page with the proposed values above. The official-site main commit `1e40323bca562676b71eb8319d367dd32dcf1d26`
contains the canonical pricing page, bilingual source, consumer@ages.tw and
proposed prices and capacities. The shared conversation reports production
deployment; live deployment and customer mailbox receipt have not been independently
verified for this document. The app pricing redirect is tracked in PR #82. The repository's private-beta quota settings are operational defaults,
not finalized public plan entitlements.

Commit `dbf12d3` merged support for text and photo timeline moments. This
establishes repository implementation and associated tests, not deployment or
a verified production release. Existing rate-limit middleware and tests are
present; operational limits and abuse safeguards still require release
validation. Payment checkout remains disabled as described above.

OKE dev currently has a data-preservation gate: a consistent backup and
isolated restore must be verified before replacing its existing Pod. OCI reports control-plane version 1.37.1;
workload and data verification remain outstanding. Production credentials, destinations, and release
configuration must be validated for the selected environment. Local builds and
repository checks do not by themselves establish either deployment.
