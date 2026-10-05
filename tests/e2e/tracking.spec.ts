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
  const vendorReferrers: string[] = [];
  let releaseScripts = () => {};
  const scriptsReleased = new Promise<void>((resolveScripts) => {
    releaseScripts = resolveScripts;
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

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
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
        body: "window.__agesVendorStubLoaded = true;",
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
    vendorReferrers,
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
}) => {
  await seedLibrary(page.context());
  await page.goto(`${e2eOrigin}/settings/tracking`);

  await expect(
    page.getByText(/turn off Enhanced Measurement in the property settings/i),
  ).toBeVisible();
  await expect(
    page.getByText(/configure and publish the container so tags fire only/i),
  ).toBeVisible();
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
  await expect(providers).toHaveText(["Google Analytics 4", "Meta Pixel"]);
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
  await expect.poll(() => vendors.requests.length).toBe(2);

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
  ]);
  expect(vendors.unexpected).toEqual([]);
  expect(vendors.vendorReferrers).toEqual(["", ""]);
  vendors.releaseScripts();
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
  await expect(page).toHaveURL(/127\.0\.0\.3:8799\/landing\?/);
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
