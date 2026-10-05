# Provider tracking release gates

The release preflight checks the declared app and tracking origins, their
separate declared registrable domains, the tracking Worker route and bindings,
and the configured application resources. It cannot establish a Public Suffix
List boundary, domain ownership, DNS or TLS readiness, browser cookie isolation,
or delivery of provider events.

Before provisioning a tracking domain or approving a production release, an
operator must:

1. Check `APP_REGISTRABLE_DOMAIN` and `TRACKING_REGISTRABLE_DOMAIN` against the
   current Public Suffix List. Confirm that both values are registrable domains
   owned by the service and that neither is the other's parent domain.
2. Provision both origins and verify their DNS records, TLS certificates, and
   custom-domain routes from an external network.
3. Use a browser to confirm that app session cookies are not sent to the
   tracking origin and that the tracking form can return through the app
   continuation to a third-origin destination.
4. With an approved provider test account, confirm that declining consent sends
   no provider event and accepting consent sends the expected bounded event.
   Check that repeated media reads do not create additional events.
5. Record the observed domains, browser checks, provider event result, and
   verification date in the release record.

Local tests use synthetic provider IDs and in-process network stubs. They do not
contact provider networks or count as evidence for these production gates.
