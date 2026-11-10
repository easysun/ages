# Provider tracking release gates

The release preflight checks the declared app and tracking origins, their
separate declared registrable domains, the tracking Worker route and bindings,
and the configured application resources. In workers.dev mode it also reads the
account subdomain, both Workers' live workers.dev settings, and the tracking
Worker's secret names. It cannot establish the Public Suffix List boundary for
an app custom domain, domain ownership, DNS or TLS readiness, browser cookie
isolation, or delivery of provider events.

Workers.dev mode uses only the exact
`https://<tracking-worker>.<account>.workers.dev` origin and declares
`TRACKING_REGISTRABLE_DOMAIN` as `<account>.workers.dev`. The app stays on its
configured custom-domain origin with `workers_dev` and `preview_urls` disabled.
The read-only preflight requires the account subdomain to be provisioned already;
it never creates or enables it. This mode preserves the full GA4, Meta Pixel, and
GTM consent and event gates for preview and production. Cloudflare describes
workers.dev as intended for personal or hobby projects and recommends custom
domains or routes for production, so workers.dev is not the recommended choice
for a business-critical tracking service. A production release using it must
record that reliability and support trade-off. See
[Cloudflare's workers.dev guidance](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Before provisioning a tracking domain or approving a production release, an
operator must:

1. Check `APP_REGISTRABLE_DOMAIN` and `TRACKING_REGISTRABLE_DOMAIN` against the
   current Public Suffix List. Confirm that both values are registrable domains
   owned by the service and that neither is the other's parent domain.
2. Provision both origins and verify DNS and TLS externally. For custom-domain
   mode, verify the exact custom-domain routes. For workers.dev mode, verify the
   already-provisioned account subdomain and the tracking Worker's exact host;
   confirm the app remains on its custom domain.
3. Use supported browsers to confirm the Public Suffix List boundary, that app
   session cookies are absent from tracking and provider requests, and that the
   tracking origin cannot read app cookies, storage, or APIs. Confirm the
   tracking form retains its exact Origin through the app continuation to a
   third-origin destination, including without JavaScript.
4. With approved GA4, Meta Pixel, and GTM test configurations, confirm that
   declining consent sends no provider event and accepting consent sends only
   the expected bounded event. Verify GA4 Enhanced Measurement is disabled,
   configured provider routing does not duplicate events, and repeated media
   reads do not create additional events.
5. Record the observed domains, browser checks, provider event result, any
   workers.dev reliability and support trade-off, and verification date in the
   release record.

Local tests use synthetic provider IDs and in-process network stubs. They do not
contact provider networks or count as evidence for these production gates.
