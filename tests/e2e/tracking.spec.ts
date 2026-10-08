import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  e2eOrigin,
  e2eTrackingOrigin,
  seedLibrary,
  seedProviderLink,
} from "./fixtures";

const artifactDirectory = resolve(".wrangler/e2e-artifacts");
mkdirSync(artifactDirectory, { recursive: true });
const localDestination =
  "http://127.0.0.3:8799/landing?utm_source=old&destination_secret=private#story";

type VendorOptions = {
  destinationTarget?: string;
  failScripts?: boolean;
  holdScripts?: boolean;
  referringPage?: { url: string; target: string };
};

type ContainerObservation = {
  eligibilityKeys: string[];
  eligibilityFields: {
    ages_ga4_eligible: boolean;
    ages_meta_pixel_eligible: boolean;
  } | null;
  clickEventCount: number;
  dispatches: string[];
  ownerTagTriggers: string[];
  documentReferrer: string;
};

async function installNetworkStubs(
  page: import("@playwright/test").Page,
  options: VendorOptions = {},
) {
  const requests: string[] = [];
  const unexpected: string[] = [];
  const destinationRequests: string[] = [];
  const destinationReferrers: string[] = [];
  const trackingCookieHeaders: string[] = [];
  const continuationOrigins: string[] = [];
  const continuationStatuses: number[] = [];
  const vendorReferrers: string[] = [];
  const vendorDocumentReferrers: string[] = [];
  const containerRuns: ContainerObservation[] = [];
  let releaseScripts = () => {};
  const scriptsReleased = new Promise<void>((resolveScripts) => {
    releaseScripts = resolveScripts;
  });

  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === e2eOrigin && url.pathname === "/s/continue")
      continuationStatuses.push(response.status());
  });

  page.on("request", async (request) => {
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    if (url.origin === e2eTrackingOrigin)
      trackingCookieHeaders.push(headers.cookie ?? "");
    if (url.origin === e2eOrigin && url.pathname === "/s/continue")
      continuationOrigins.push(headers.origin ?? "");
    if (url.origin === "http://127.0.0.3:8799")
      destinationReferrers.push(headers.referer ?? "");
    if (
      url.protocol === "https:" &&
      ["www.googletagmanager.com", "connect.facebook.net"].includes(
        url.hostname,
      )
    )
      vendorReferrers.push(headers.referer ?? "");
  });
  page.on("console", (message) => {
    const text = message.text();
    const referrerPrefix = "AGES_VENDOR_REFERRER:";
    const containerPrefix = "AGES_GTM_STUB:";
    if (text.startsWith(referrerPrefix))
      vendorDocumentReferrers.push(
        JSON.parse(text.slice(referrerPrefix.length)) as string,
      );
    if (text.startsWith(containerPrefix))
      containerRuns.push(
        JSON.parse(text.slice(containerPrefix.length)) as ContainerObservation,
      );
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (options.referringPage?.url === url.href) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "Referrer-Policy": "unsafe-url" },
        body: `<!doctype html><title>Referring page</title><a href="${options.referringPage.target}">Open shared Link</a>`,
      });
      return;
    }
    const destination = options.destinationTarget
      ? new URL(options.destinationTarget)
      : null;
    if (destination && url.origin === destination.origin) {
      destinationRequests.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>External fixture reached</title><h1>External fixture reached</h1>",
      });
      return;
    }
    if (url.origin === e2eOrigin && url.pathname === "/synthetic-destination") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic destination</title><h1>Synthetic destination reached</h1>",
      });
      return;
    }
    if (url.protocol !== "https:") {
      await route.continue();
      return;
    }
    const allowedScripts = new Set([
      "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
      "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
      "https://connect.facebook.net/en_US/fbevents.js",
    ]);
    const analyticsOrigins = new Set([
      "https://www.google-analytics.com",
      "https://region1.google-analytics.com",
      "https://www.facebook.com",
    ]);
    if (allowedScripts.has(url.href)) {
      requests.push(url.href);
      if (options.holdScripts) await scriptsReleased;
      if (options.failScripts) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: url.href.endsWith("/gtm.js?id=GTM-ABC123")
          ? `(() => {
  window.__agesVendorStubLoaded = true;
  const entries = window.dataLayer || [];
  const records = entries.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  const eligibility = records.find((entry) => entry.event === "ages_provider_eligibility");
  const clickEventCount = records.filter((entry) => entry.event === "ages_link_click").length;
  const dispatches = [];
  if (clickEventCount === 1 && eligibility && eligibility.ages_ga4_eligible === true) dispatches.push("ga4");
  if (clickEventCount === 1 && eligibility && eligibility.ages_meta_pixel_eligible === true) dispatches.push("meta");
  const ownerTagTriggers = clickEventCount === 1 ? ["container-owned-event-tag"] : [];
  console.log("AGES_GTM_STUB:" + JSON.stringify({
    eligibilityKeys: eligibility ? Object.keys(eligibility).sort() : [],
    eligibilityFields: eligibility ? {
      ages_ga4_eligible: eligibility.ages_ga4_eligible,
      ages_meta_pixel_eligible: eligibility.ages_meta_pixel_eligible
    } : null,
    clickEventCount,
    dispatches,
    ownerTagTriggers,
    documentReferrer: document.referrer
  }));
})();`
          : 'window.__agesVendorStubLoaded = true; console.log("AGES_VENDOR_REFERRER:" + JSON.stringify(document.referrer));',
      });
      return;
    }
    if (analyticsOrigins.has(url.origin)) {
      requests.push(url.href);
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    unexpected.push(url.href);
    await route.abort("blockedbyclient");
  });
  return {
    requests,
    destinationRequests,
    destinationReferrers,
    trackingCookieHeaders,
    continuationOrigins,
    continuationStatuses,
    vendorReferrers,
    vendorDocumentReferrers,
    containerRuns,
    unexpected,
    releaseScripts,
  };
}

async function openProviderLink(
  page: import("@playwright/test").Page,
  route: "direct" | "gtm" = "direct",
  options: VendorOptions = {},
) {
  const { owner } = await seedLibrary(page.context());
  const link = seedProviderLink(owner, route, options.destinationTarget);
  const vendors = await installNetworkStubs(page, options);
  await page.goto(`${e2eOrigin}/s/${link.slug}`);
  return { link, vendors };
}

function queueSnapshot(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const runtime = window as Window & {
      dataLayer?: unknown[];
      fbq?: { queue?: unknown[][] };
    };
    const dataLayer = runtime.dataLayer ?? [];
    const googleCalls = dataLayer.map((entry) => {
      if (entry && typeof entry === "object" && Symbol.iterator in entry)
        return Array.from(entry as Iterable<unknown>);
      return entry;
    });
    return {
      googleCalls,
      pixelCalls: runtime.fbq?.queue ?? [],
    };
  });
}

test("account settings explain GA4 and GTM provider-side event controls", async ({
  page,
}, testInfo) => {
  await seedLibrary(page.context());
  await page.goto(`${e2eOrigin}/settings/tracking`);

  await expect(
    page.getByText(/turn off Enhanced Measurement in the property settings/i),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Configure Ages-managed tags to fire on the Custom Event ages_link_click/i,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Data Layer Variable ages_ga4_eligible to equal true for GA4/i,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Data Layer Variable ages_meta_pixel_eligible to equal true for Meta/i,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/flag is true only when that provider has a saved ID/i),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Container-owned tags may use ages_link_click without these flags/i,
    ),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(
      artifactDirectory,
      `tracking-settings-instructions-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
});

test("direct providers strip ticket data and send one fixed event only after consent", async ({
  page,
}, testInfo) => {
  const { link, vendors } = await openProviderLink(page, "direct", {
    holdScripts: true,
    destinationTarget: localDestination,
  });

  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  expect(new URL(page.url()).pathname).toBe("/consent");
  expect(vendors.trackingCookieHeaders.length).toBeGreaterThan(0);
  expect(vendors.trackingCookieHeaders.every((cookie) => cookie === "")).toBe(
    true,
  );
  await expect(
    page.getByRole("heading", { name: "Before you continue" }),
  ).toBeVisible();
  const providers = page.getByRole("listitem");
  await expect(providers).toHaveText([
    "Google Analytics 4",
    "Meta Pixel",
    "Google Tag Manager",
  ]);
  const consentCopy = await page.locator("main").innerText();
  expect(consentCopy).not.toContain("G-ABC123");
  expect(consentCopy).not.toContain("1234567890");
  expect(consentCopy).not.toContain("GTM-ABC123");
  await page.screenshot({
    path: resolve(
      artifactDirectory,
      `tracking-consent-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  expect(vendors.requests).toEqual([]);
  await expect(page.locator('input[name="token"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Allow optional analytics" }).click();
  await expect.poll(() => vendors.requests.length).toBe(3);

  const snapshot = await queueSnapshot(page);
  const googleEvents = snapshot.googleCalls.filter(
    (call) =>
      Array.isArray(call) &&
      call[0] === "event" &&
      call[1] === "ages_link_click",
  );
  const googleConfig = snapshot.googleCalls.find(
    (call) =>
      Array.isArray(call) && call[0] === "config" && call[1] === "G-ABC123",
  );
  expect(googleEvents).toHaveLength(1);
  expect(googleConfig).toEqual([
    "config",
    "G-ABC123",
    expect.objectContaining({ send_page_view: false, page_referrer: "" }),
  ]);
  const googleParameters = (googleEvents[0] as unknown[])[2] as Record<
    string,
    string
  >;
  expect(googleParameters.page_location).toBeUndefined();
  expect(googleParameters.send_to).toBeUndefined();
  expect(googleParameters.transport_url).toBeUndefined();
  expect(googleParameters.event_callback).toBeUndefined();
  expect(googleParameters.event).toBeUndefined();
  expect(googleParameters.ages_c_send_to).toBe("G-ATTACKER1");
  expect(googleParameters.ages_c_page_location).toBe(
    "https://attacker.example.test/ticket-secret",
  );
  expect(googleParameters.ages_c_transport_url).toBe(
    "https://attacker.example.test/collect",
  );
  expect(googleParameters.ages_c_event_callback).toBe("continueNow");
  expect(googleParameters.ages_c_event).toBe("attacker_route");
  expect(googleParameters.target_kind).toBe("url");
  expect(googleParameters.channel).toBe("Other");
  expect(googleParameters.utm_source).toBe("ages");
  for (const key of ["utm_medium", "utm_campaign", "utm_term", "utm_content"])
    expect(Array.from(googleParameters[key] ?? "")).toHaveLength(100);
  expect(Object.keys(googleParameters).length).toBeLessThanOrEqual(25);
  for (const [key, value] of Object.entries(googleParameters)) {
    expect(key.length).toBeLessThanOrEqual(40);
    expect(Array.from(value).length).toBeLessThanOrEqual(100);
  }
  for (const [index, expected] of ["a", "b", "c", "d"].entries())
    expect(googleParameters[`ages_c_field_${index + 1}`]).toBe(
      expected.repeat(100),
    );
  expect(JSON.stringify(snapshot)).not.toContain(link.slug);
  expect(JSON.stringify(snapshot)).not.toContain("destination_secret");
  expect(JSON.stringify(snapshot)).not.toContain("destination.example.test");
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(
    snapshot.pixelCalls.filter((call) => call[0] === "trackCustom"),
  ).toHaveLength(1);
  expect(
    snapshot.pixelCalls.some(
      (call) => call[0] === "track" && call[1] === "PageView",
    ),
  ).toBe(false);
  expect(vendors.requests).toEqual([
    "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
  ]);
  expect(vendors.unexpected).toEqual([]);
  expect(vendors.vendorReferrers).toEqual(["", "", ""]);
  vendors.releaseScripts();
  await expect.poll(() => vendors.containerRuns.length).toBe(1);
  expect(vendors.containerRuns[0]?.dispatches).toEqual([]);
  expect(vendors.containerRuns[0]?.ownerTagTriggers).toEqual([
    "container-owned-event-tag",
  ]);
  await expect
    .poll(() => vendors.continuationOrigins.length)
    .toBeGreaterThan(0);
  expect(vendors.continuationOrigins).toContain(e2eTrackingOrigin);
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  await expect(
    page.getByRole("heading", { name: "External fixture reached" }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("destination_secret")).toBe(
    "private",
  );
  expect(new URL(page.url()).searchParams.get("utm_source")).toBe("ages");
  expect(vendors.destinationRequests).toHaveLength(1);
  expect(vendors.destinationReferrers).toEqual([""]);
});

test("the app-to-tracking redirect hides the referring document from provider code", async ({
  page,
}) => {
  const { owner } = await seedLibrary(page.context());
  const link = seedProviderLink(owner, "direct", localDestination);
  const referringPage = {
    url: `${e2eOrigin}/synthetic-referrer?private=synthetic-secret`,
    target: `${e2eOrigin}/s/${link.slug}`,
  };
  const vendors = await installNetworkStubs(page, {
    destinationTarget: localDestination,
    referringPage,
  });

  await page.goto(referringPage.url);
  await page.getByRole("link", { name: "Open shared Link" }).click();
  await expect(
    page.getByRole("heading", { name: "Before you continue" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow optional analytics" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  expect(vendors.vendorDocumentReferrers).toEqual(["", ""]);
  expect(vendors.containerRuns).toHaveLength(1);
  expect(vendors.containerRuns[0]?.documentReferrer).toBe("");
  expect(vendors.unexpected).toEqual([]);
});

test("GTM routing loads one container and emits one bounded dataLayer event", async ({
  page,
}) => {
  const { vendors } = await openProviderLink(page, "gtm", {
    holdScripts: true,
    destinationTarget: localDestination,
  });

  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  expect(new URL(page.url()).pathname).toBe("/consent");
  await expect(page.getByRole("listitem")).toHaveText([
    "Google Analytics 4",
    "Meta Pixel",
    "Google Tag Manager",
  ]);
  await page.getByRole("button", { name: "Allow optional analytics" }).click();
  await expect.poll(() => vendors.requests.length).toBe(1);
  const snapshot = await queueSnapshot(page);
  const gtmEvents = snapshot.googleCalls.filter(
    (call) =>
      call &&
      typeof call === "object" &&
      (call as { event?: string }).event === "ages_link_click",
  ) as Record<string, unknown>[];
  const eligibility = snapshot.googleCalls.find(
    (call) =>
      call &&
      typeof call === "object" &&
      (call as { event?: string }).event === "ages_provider_eligibility",
  );
  expect(eligibility).toEqual({
    event: "ages_provider_eligibility",
    ages_ga4_eligible: true,
    ages_meta_pixel_eligible: true,
  });
  expect(gtmEvents).toHaveLength(1);
  expect(gtmEvents[0]).toMatchObject({
    link_id: expect.stringMatching(/^ln_/),
    target_kind: "url",
    channel: "Other",
    ages_custom: expect.arrayContaining([
      { key: "send_to", value: "G-ATTACKER1" },
      { key: "event", value: "attacker_route" },
    ]),
  });
  expect(gtmEvents[0]?.event).toBe("ages_link_click");
  expect(gtmEvents[0]?.page_location).toBe(`${e2eTrackingOrigin}/consent`);
  expect(vendors.requests).toEqual([
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
  ]);
  expect(vendors.unexpected).toEqual([]);
  expect(vendors.vendorReferrers).toEqual([""]);
  vendors.releaseScripts();
  await expect.poll(() => vendors.containerRuns.length).toBe(1);
  expect(vendors.containerRuns[0]?.dispatches).toEqual(["ga4", "meta"]);
  expect(vendors.containerRuns[0]?.ownerTagTriggers).toEqual([
    "container-owned-event-tag",
  ]);
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  await expect(
    page.getByRole("heading", { name: "External fixture reached" }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("destination_secret")).toBe(
    "private",
  );
  expect(new URL(page.url()).searchParams.get("utm_source")).toBe("ages");
  expect(vendors.destinationRequests).toHaveLength(1);
  expect(vendors.destinationReferrers).toEqual([""]);
});

test("standalone GTM loads and emits only after consent, while skip sends no provider request", async ({
  page,
}) => {
  const { owner } = await seedLibrary(page.context());
  const target = localDestination;
  const link = seedProviderLink(owner, "direct", target, {
    ga4: false,
    meta: false,
  });
  const vendors = await installNetworkStubs(page, {
    destinationTarget: target,
    holdScripts: true,
  });

  await page.goto(`${e2eOrigin}/s/${link.slug}`);
  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  await expect(page.getByRole("listitem")).toHaveText(["Google Tag Manager"]);
  expect(vendors.requests).toEqual([]);
  await page.getByRole("button", { name: "Allow optional analytics" }).click();
  await expect.poll(() => vendors.requests.length).toBe(1);
  const snapshot = await queueSnapshot(page);
  const clickEvents = snapshot.googleCalls.filter(
    (call) =>
      call &&
      typeof call === "object" &&
      (call as { event?: string }).event === "ages_link_click",
  ) as Record<string, unknown>[];
  expect(clickEvents).toHaveLength(1);
  expect(clickEvents[0]?.ages_custom).toEqual(
    expect.arrayContaining([{ key: "send_to", value: "G-ATTACKER1" }]),
  );
  expect(snapshot.googleCalls).toContainEqual({
    event: "ages_provider_eligibility",
    ages_ga4_eligible: false,
    ages_meta_pixel_eligible: false,
  });
  expect(vendors.requests).toEqual([
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
  ]);
  vendors.releaseScripts();
  await expect.poll(() => vendors.containerRuns.length).toBe(1);
  expect(vendors.containerRuns[0]?.clickEventCount).toBe(1);
  expect(vendors.containerRuns[0]?.dispatches).toEqual([]);
  expect(vendors.containerRuns[0]?.ownerTagTriggers).toEqual([
    "container-owned-event-tag",
  ]);
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);

  const skippedPage = await page.context().newPage();
  const skippedLink = seedProviderLink(owner, "direct", target, {
    ga4: false,
    meta: false,
  });
  const skipped = await installNetworkStubs(skippedPage, {
    destinationTarget: target,
  });
  await skippedPage.goto(`${e2eOrigin}/s/${skippedLink.slug}`);
  await skippedPage
    .getByRole("button", { name: "Continue without analytics" })
    .click();
  await expect(skippedPage).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  expect(skipped.requests).toEqual([]);
  expect(skipped.containerRuns).toEqual([]);
  await skippedPage.close();
});

test("GTM provider tags follow bounded per-Link eligibility in mixed routes", async ({
  page,
}) => {
  const { owner } = await seedLibrary(page.context());
  const scenarios = [
    {
      name: "both providers routed through GTM",
      route: "gtm" as const,
      options: {},
      eligible: { ga4: true, meta: true },
      dispatches: ["ga4", "meta"],
      directGa4: false,
    },
    {
      name: "GA4 opted out for this Link",
      route: "gtm" as const,
      options: { allowGa4: false },
      eligible: { ga4: false, meta: true },
      dispatches: ["meta"],
      directGa4: false,
    },
    {
      name: "Meta opted out for this Link",
      route: "gtm" as const,
      options: { allowMeta: false },
      eligible: { ga4: true, meta: false },
      dispatches: ["ga4"],
      directGa4: false,
    },
    {
      name: "direct GA4 and GTM Meta",
      route: "direct" as const,
      options: { metaRoute: "gtm" as const },
      eligible: { ga4: false, meta: true },
      dispatches: ["meta"],
      directGa4: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const scenarioPage = index === 0 ? page : await page.context().newPage();
    const link = seedProviderLink(
      owner,
      scenario.route,
      localDestination,
      scenario.options,
    );
    const vendors = await installNetworkStubs(scenarioPage, {
      destinationTarget: localDestination,
      holdScripts: true,
    });

    await scenarioPage.goto(`${e2eOrigin}/s/${link.slug}`);
    expect(vendors.requests).toEqual([]);
    await scenarioPage
      .getByRole("button", { name: "Allow optional analytics" })
      .click();
    await expect
      .poll(() => vendors.requests.length)
      .toBe(scenario.directGa4 ? 2 : 1);

    const snapshot = await queueSnapshot(scenarioPage);
    const eligibility = snapshot.googleCalls.find(
      (call) =>
        call &&
        typeof call === "object" &&
        (call as { event?: string }).event === "ages_provider_eligibility",
    );
    expect(eligibility).toEqual({
      event: "ages_provider_eligibility",
      ages_ga4_eligible: scenario.eligible.ga4,
      ages_meta_pixel_eligible: scenario.eligible.meta,
    });
    const clickEvents = snapshot.googleCalls.filter(
      (call) =>
        call &&
        typeof call === "object" &&
        (call as { event?: string }).event === "ages_link_click",
    ) as Record<string, unknown>[];
    expect(clickEvents).toHaveLength(1);
    expect(clickEvents[0]?.ages_custom).toEqual(
      expect.arrayContaining([{ key: "event", value: "attacker_route" }]),
    );
    expect(Object.keys(eligibility as Record<string, unknown>).sort()).toEqual([
      "ages_ga4_eligible",
      "ages_meta_pixel_eligible",
      "event",
    ]);
    const directEvents = snapshot.googleCalls.filter(
      (call) =>
        Array.isArray(call) &&
        call[0] === "event" &&
        call[1] === "ages_link_click",
    );
    expect(directEvents).toHaveLength(scenario.directGa4 ? 1 : 0);

    vendors.releaseScripts();
    await expect.poll(() => vendors.containerRuns.length).toBe(1);
    expect(vendors.containerRuns[0]?.eligibilityFields).toEqual({
      ages_ga4_eligible: scenario.eligible.ga4,
      ages_meta_pixel_eligible: scenario.eligible.meta,
    });
    expect(vendors.containerRuns[0]?.dispatches).toEqual(scenario.dispatches);
    expect(vendors.containerRuns[0]?.ownerTagTriggers).toEqual([
      "container-owned-event-tag",
    ]);
    await expect(scenarioPage).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
    if (scenarioPage !== page) await scenarioPage.close();
  }
});

test("skip and unanswered consent continue without requesting provider code", async ({
  page,
}, testInfo) => {
  const skipped = await openProviderLink(page, "direct", {
    destinationTarget: localDestination,
  });
  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  await page.screenshot({
    path: resolve(
      artifactDirectory,
      `tracking-skip-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Continue without analytics" })
    .click();
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  await expect(
    page.getByRole("heading", { name: "External fixture reached" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(
      artifactDirectory,
      `tracking-skip-destination-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  expect(skipped.vendors.requests).toEqual([]);
  expect(skipped.vendors.unexpected).toEqual([]);
  expect(skipped.vendors.destinationRequests).toHaveLength(1);
  expect(skipped.vendors.destinationReferrers).toEqual([""]);

  const unanswered = await openProviderLink(page, "direct", {
    destinationTarget: localDestination,
  });
  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  await page.waitForTimeout(10_100);
  try {
    await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
  } catch (error) {
    // Log only bounded response metadata, never ticket URLs or form tokens.
    console.info("Unanswered consent continuation", {
      statuses: unanswered.vendors.continuationStatuses,
      origins: unanswered.vendors.continuationOrigins,
      destinationRequests: unanswered.vendors.destinationRequests.length,
    });
    throw error;
  }
  await expect(
    page.getByRole("heading", { name: "External fixture reached" }),
  ).toBeVisible();
  expect(unanswered.vendors.requests).toEqual([]);
  expect(unanswered.vendors.unexpected).toEqual([]);
  expect(unanswered.vendors.destinationRequests).toHaveLength(1);
  expect(unanswered.vendors.destinationReferrers).toEqual([""]);
});

test("provider script failure still submits the continuation", async ({
  page,
}) => {
  const { vendors } = await openProviderLink(page, "direct", {
    failScripts: true,
  });

  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  await page.getByRole("button", { name: "Allow optional analytics" }).click();
  await expect(page).toHaveURL(
    `${e2eOrigin}/synthetic-destination?destination_secret=private#story`,
  );
  expect(vendors.requests).toContain(
    "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
  );
  expect(vendors.unexpected).toEqual([]);
});

test("the ordinary POST continuation works with JavaScript disabled", async ({
  browser,
}, testInfo) => {
  const viewport = testInfo.project.use.viewport;
  const context = await browser.newContext({
    baseURL: e2eOrigin,
    javaScriptEnabled: false,
    ...(viewport === undefined ? {} : { viewport }),
  });
  try {
    const page = await context.newPage();
    const { owner } = await seedLibrary(context);
    const target =
      "http://127.0.0.3:8799/landing?destination_secret=private#story";
    const link = seedProviderLink(owner, "direct", target);
    const vendors = await installNetworkStubs(page, {
      destinationTarget: target,
    });
    await page.goto(`${e2eOrigin}/s/${link.slug}`);
    expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
    await page
      .getByRole("button", { name: "Continue without analytics" })
      .click();
    await expect(
      page.getByRole("heading", { name: "External fixture reached" }),
    ).toBeVisible();
    expect(new URL(page.url()).origin).toBe("http://127.0.0.3:8799");
    expect(new URL(page.url()).searchParams.get("destination_secret")).toBe(
      "private",
    );
    expect(vendors.requests).toEqual([]);
    expect(vendors.unexpected).toEqual([]);
    expect(vendors.destinationRequests).toHaveLength(1);
    expect(vendors.destinationReferrers).toEqual([""]);
    expect(vendors.continuationOrigins).toContain(e2eTrackingOrigin);
  } finally {
    await context.close();
  }
});

test("external URL continuation escapes the redirect-chain form policy without leaking referrer", async ({
  page,
}) => {
  const target = localDestination;
  const { owner } = await seedLibrary(page.context());
  const link = seedProviderLink(owner, "direct", target);
  const vendors = await installNetworkStubs(page, {
    destinationTarget: target,
  });

  await page.goto(`${e2eOrigin}/s/${link.slug}`);
  expect(new URL(page.url()).origin).toBe(e2eTrackingOrigin);
  await page
    .getByRole("button", { name: "Continue without analytics" })
    .click();

  await expect(
    page.getByRole("heading", { name: "External fixture reached" }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe("http://127.0.0.3:8799");
  expect(new URL(page.url()).searchParams.get("destination_secret")).toBe(
    "private",
  );
  expect(new URL(page.url()).searchParams.get("utm_source")).toBe("ages");
  expect(vendors.requests).toEqual([]);
  expect(vendors.destinationRequests).toHaveLength(1);
  expect(vendors.unexpected).toEqual([]);
  expect(vendors.continuationOrigins).toContain(e2eTrackingOrigin);
  expect(vendors.destinationReferrers).toEqual([""]);
});
