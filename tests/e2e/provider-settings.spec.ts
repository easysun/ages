import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";
import { e2eOrigin, executeFixtureSql, seedLibrary } from "./fixtures";

async function ownerHeaders(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "ages_session",
  );
  if (!cookie) throw new Error("The browser fixture did not create a session.");
  return { Cookie: `ages_session=${cookie.value}`, Origin: e2eOrigin };
}

async function createLink(request: APIRequestContext, context: BrowserContext) {
  const slug = `providers-${crypto.randomUUID().slice(0, 8)}`;
  const response = await request.post(`${e2eOrigin}/api/links`, {
    headers: await ownerHeaders(context),
    data: { target: { kind: "url", url: "https://example.test/story" }, slug },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).link as { id: string; slug: string };
}

test("tracking and moderation navigation fits the mobile viewport", async ({
  page,
  context,
}) => {
  const { owner } = await seedLibrary(context);
  executeFixtureSql(`UPDATE users SET plan='admin' WHERE id='${owner}';`);

  await page.goto("/admin/reports");
  const nav = page.getByRole("navigation", { name: "Your collections" });
  await expect(
    nav.getByRole("link", { name: "Tracking settings" }),
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Moderation" })).toBeVisible();
  await expect
    .poll(() => nav.evaluate((element) => element.scrollWidth))
    .toBeLessThanOrEqual(await nav.evaluate((element) => element.clientWidth));
});

test("provider settings and Link opt-outs persist across refresh", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(request, context);

  await page.goto("/settings/tracking");
  await page.getByLabel("Google Analytics 4 measurement ID").fill("G-ABC123");
  await page.getByLabel("Meta Pixel ID").fill("1234567890");
  await page.getByLabel("Google Tag Manager container ID").fill("GTM-ABC123");
  await page.getByLabel("GA4 delivery").selectOption("gtm");
  await page.getByRole("button", { name: "Save account providers" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking providers saved" }),
  ).toContainText("saved");

  await page.reload();
  await expect(
    page.getByLabel("Google Analytics 4 measurement ID"),
  ).toHaveValue("G-ABC123");
  await expect(page.getByLabel("Meta Pixel ID")).toHaveValue("1234567890");
  await expect(page.getByLabel("Google Tag Manager container ID")).toHaveValue(
    "GTM-ABC123",
  );
  await expect(page.getByLabel("GA4 delivery")).toHaveValue("gtm");
  await page.screenshot({
    path: `test-results/tracking-settings-${test.info().project.name}.png`,
    fullPage: true,
  });

  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(
    page.getByText(
      /Turning off Google Tag Manager also disables its container and any GTM-routed/i,
    ),
  ).toBeVisible();
  const ga4OptIn = page.getByLabel("Allow Google Analytics 4");
  await expect(ga4OptIn).toBeChecked();
  await ga4OptIn.uncheck();
  const gtmOptIn = page.getByLabel("Allow Google Tag Manager");
  await expect(gtmOptIn).toBeChecked();
  await gtmOptIn.uncheck();
  await page.getByRole("button", { name: "Save provider choices" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Provider choices saved" }),
  ).toContainText("saved");

  await page.reload();
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByLabel("Allow Google Analytics 4")).not.toBeChecked();
  await expect(page.getByLabel("Allow Google Tag Manager")).not.toBeChecked();
  await page
    .getByRole("region", { name: "Link tracking providers" })
    .screenshot({
      path: `test-results/link-provider-choices-${test.info().project.name}.png`,
    });
});

test("ordinary provider save failure keeps the editable draft", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.route("**/api/me/tracking/providers", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "SERVICE_UNAVAILABLE", message: "Try again later." },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/settings/tracking");
  const ga4Id = page.getByLabel("Google Analytics 4 measurement ID");
  await ga4Id.fill("G-KEEP123");
  await page.getByRole("button", { name: "Save account providers" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  await expect(ga4Id).toHaveValue("G-KEEP123");
});

test("delayed account 401 clears an unsaved provider draft", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let started: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejected = false;
  await page.route("**/api/me/tracking/providers", async (route) => {
    if (route.request().method() === "PUT" && !rejected) {
      rejected = true;
      started();
      await held;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/settings/tracking");
  const ga4Id = page.getByLabel("Google Analytics 4 measurement ID");
  await ga4Id.fill("G-STALE123");
  await page.getByRole("button", { name: "Save account providers" }).click();
  await requestStarted;
  release();
  await expect(page.getByRole("alert")).toContainText("session has ended");
  await page.getByRole("button", { name: "Retry tracking settings" }).click();
  await expect(ga4Id).toHaveValue("");
});

test("delayed Link provider 403 clears the unsaved opt-out draft", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(request, context);
  let started: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejected = false;
  await page.route("**/api/links/*/tracking/providers", async (route) => {
    if (route.request().method() === "PUT" && !rejected) {
      rejected = true;
      started();
      await held;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "Access denied." },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  const ga4OptIn = page.getByLabel("Allow Google Analytics 4");
  await expect(ga4OptIn).toBeChecked();
  await ga4OptIn.uncheck();
  await page.getByRole("button", { name: "Save provider choices" }).click();
  await requestStarted;
  release();
  await expect(page.getByRole("alert")).toContainText("no longer available");
  await expect(ga4OptIn).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByLabel("Allow Google Analytics 4")).toBeChecked();
});
