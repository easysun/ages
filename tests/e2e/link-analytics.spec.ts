import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";
import { googleCustomParameterName } from "../../src/tracking/google-parameters";
import {
  e2eOrigin,
  executeFixtureSql,
  seedLibrary,
  seedTaggedLinks,
  seedTimeline,
} from "./fixtures";

type LinkTarget =
  | { kind: "url"; url: string }
  | { kind: "timeline"; timeline_id: string }
  | { kind: "asset"; asset_id: string };

async function ownerHeaders(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "ages_session",
  );
  if (!cookie) throw new Error("The browser fixture did not create a session.");
  return { Cookie: `ages_session=${cookie.value}`, Origin: e2eOrigin };
}

async function createLink(
  request: APIRequestContext,
  context: BrowserContext,
  target: LinkTarget,
  slug: string,
) {
  const response = await request.post(`${e2eOrigin}/api/links`, {
    headers: await ownerHeaders(context),
    data: { target, slug, expires_at: null },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).link as {
    id: string;
    slug: string;
    short_url: string;
  };
}

async function saveTracking(
  request: APIRequestContext,
  context: BrowserContext,
  linkId: string,
  tracking: unknown,
) {
  const response = await request.put(
    `${e2eOrigin}/api/links/${encodeURIComponent(linkId)}/tracking`,
    { headers: await ownerHeaders(context), data: tracking },
  );
  expect(response.status()).toBe(200);
  return response;
}

async function readTracking(
  request: APIRequestContext,
  context: BrowserContext,
  linkId: string,
) {
  const response = await request.get(
    `${e2eOrigin}/api/links/${encodeURIComponent(linkId)}/tracking`,
    { headers: await ownerHeaders(context) },
  );
  expect(response.status()).toBe(200);
  return (await response.json()).tracking as {
    tags: string[];
    channels: string[];
    utm: Record<string, string>;
    custom: { key: string; value: string }[];
  };
}

async function expectNoHorizontalOverflow(
  page: import("@playwright/test").Page,
) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

test("owner_sees_default_click_and_source_report", async ({
  page,
  context,
  request,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/story?keep=1" },
    `journey-${crypto.randomUUID().slice(0, 8)}`,
  );
  const settings = {
    tags: ["旅行", "Trip Case "],
    channels: ["Newsletter"],
    utm: { utm_source: "newsletter" },
    custom: [{ key: "note", value: "Taipei & friends" }],
  };
  const saved = await saveTracking(request, context, link.id, settings);
  expect(await saved.json()).toMatchObject({ tracking: settings });

  const attributed = await request.get(
    `${e2eOrigin}/s/${link.slug}?ages_channel=Newsletter`,
    {
      maxRedirects: 0,
      headers: { Referer: "https://news.example.org/story?private=discard" },
    },
  );
  expect(attributed.status()).toBe(302);
  expect(attributed.headers().location).toBe(
    "https://example.org/story?keep=1&utm_source=newsletter&note=Taipei+%26+friends",
  );
  const direct = await request.get(`${e2eOrigin}/s/${link.slug}`, {
    maxRedirects: 0,
  });
  expect(direct.status()).toBe(302);
  const inactive = await request.patch(
    `${e2eOrigin}/api/links/${encodeURIComponent(link.id)}`,
    { headers: await ownerHeaders(context), data: { active: false } },
  );
  expect(inactive.status()).toBe(200);

  const timeline = seedTimeline(owner, ids, 1, "A saved afternoon");
  executeFixtureSql(
    `UPDATE timelines SET visibility='unlisted' WHERE id='${timeline.id}';`,
  );
  const timelineLink = await createLink(
    request,
    context,
    { kind: "timeline", timeline_id: timeline.id },
    `timeline-${crypto.randomUUID().slice(0, 8)}`,
  );
  const assetLink = await createLink(
    request,
    context,
    { kind: "asset", asset_id: ids[0] as string },
    `asset-${crypto.randomUUID().slice(0, 8)}`,
  );
  const timelineResolution = await request.get(
    `${e2eOrigin}/s/${timelineLink.slug}`,
    { maxRedirects: 0 },
  );
  expect(timelineResolution.status()).toBe(302);
  const assetResolution = await request.get(`${e2eOrigin}/s/${assetLink.slug}`);
  expect(assetResolution.status()).toBe(200);
  expect(assetResolution.headers()["content-type"]).toContain("image/png");

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/links");
  await expect(page.getByRole("heading", { name: "Your links" })).toBeVisible();
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByLabel(`Short URL for ${link.slug}`)).toHaveValue(
    link.short_url,
  );
  await page.getByRole("button", { name: `Copy ${link.slug}` }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Link copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    link.short_url,
  );

  const report = page.getByRole("region", { name: "Click source report" });
  await expect(report.getByLabel("Clicks")).toHaveText("2");
  await expect(
    report.getByText("Asia/Taipei", { exact: true }).first(),
  ).toBeVisible();
  await expect(report.getByText("Newsletter", { exact: true })).toBeVisible();
  await expect(
    report.getByText("news.example.org", { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText("Direct/unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Inactive", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Bots and link previews may count/),
  ).toBeVisible();
  await expect(
    page.getByText(/Other includes source-bucket overflow/),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: `test-results/link-analytics-${test.info().project.name}.png`,
    fullPage: true,
  });

  await page
    .getByRole("button", { name: `Select ${timelineLink.slug}` })
    .click();
  await expect(
    page.getByText(`Timeline · ${timeline.id}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Select ${assetLink.slug}` }).click();
  await expect(
    page.getByText(`Asset · ${ids[0]}`, { exact: true }),
  ).toBeVisible();
});

test("configuration_and_tags_survive_refresh", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/family" },
    `family-${crypto.randomUUID().slice(0, 8)}`,
  );
  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Link tags" })
    .fill("旅行\nTrip Case ");
  await page
    .getByRole("textbox", { name: "Sharing channels" })
    .fill("Newsletter\nFriends & family");
  await page.getByRole("button", { name: "Add custom parameter" }).click();
  await page
    .getByRole("textbox", { name: "Custom parameter 1 key" })
    .fill("note");
  await page
    .getByRole("textbox", { name: "Custom parameter 1 value" })
    .fill("Shared by a friend");
  await expect(
    page.getByText("GA4 parameter: ages_c_note", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save tracking settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  expect((await readTracking(request, context, link.id)).utm).toEqual({});
  expect((await readTracking(request, context, link.id)).custom).toEqual([
    { key: "note", value: "Shared by a friend" },
  ]);

  await page.getByRole("textbox", { name: "UTM source" }).fill("friend share");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "旅行\nTrip Case ",
  );
  await expect(
    page.getByRole("textbox", { name: "Sharing channels" }),
  ).toHaveValue("Newsletter\nFriends & family");
  await expect(page.getByRole("textbox", { name: "UTM source" })).toHaveValue(
    "friend share",
  );
  await expect(
    page.getByRole("textbox", { name: "Custom parameter 1 key" }),
  ).toHaveValue("note");
  await expect(
    page.getByRole("textbox", { name: "Custom parameter 1 value" }),
  ).toHaveValue("Shared by a friend");
  await expect(page.getByLabel(`Short URL for ${link.slug}`)).toHaveValue(
    link.short_url,
  );
  await expectNoHorizontalOverflow(page);

  await page.getByRole("checkbox", { name: "Include UTM source" }).uncheck();
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  expect((await readTracking(request, context, link.id)).utm).toEqual({});

  await page.getByRole("checkbox", { name: "Include UTM source" }).check();
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  expect((await readTracking(request, context, link.id)).utm).toEqual({
    utm_source: "",
  });
});

test("custom_parameter_keys_with_equals_survive_unrelated_settings_save", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/custom-key" },
    `custom-key-${crypto.randomUUID().slice(0, 8)}`,
  );
  await saveTracking(request, context, link.id, {
    tags: [],
    channels: [],
    utm: {},
    custom: [{ key: "a=b", value: "x=y" }],
  });

  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(
    page.getByText(`GA4 parameter: ${await googleCustomParameterName("a=b")}`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Link tags" }).fill("Unrelated");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  expect((await readTracking(request, context, link.id)).custom).toEqual([
    { key: "a=b", value: "x=y" },
  ]);
});

test("confirmed_write_remains_visible_when_saved_tag_leaves_exact_filter", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/tag-change" },
    `tag-change-${crypto.randomUUID().slice(0, 8)}`,
  );
  await saveTracking(request, context, link.id, {
    tags: ["旅行"],
    channels: [],
    utm: {},
    custom: [],
  });
  await page.goto("/links");
  await page
    .getByRole("textbox", { name: "Filter links by exact tag" })
    .fill("旅行");
  await page.getByRole("button", { name: "Apply tag filter" }).click();
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "旅行",
  );
  await page.getByRole("textbox", { name: "Link tags" }).fill("Case");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByText("No links have this exact tag yet."),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({
      hasText: `Tracking settings saved for ${link.slug}.`,
    }),
  ).toBeVisible();
  await expect(page.getByLabel(`Short URL for ${link.slug}`)).toHaveCount(0);
});

test("stale_pagination_cannot_restore_previous_tag", async ({
  page,
  context,
}) => {
  const { owner } = await seedLibrary(context);
  seedTaggedLinks(owner, "旅行", `old-${crypto.randomUUID().slice(0, 6)}`, 31);
  const newRows = seedTaggedLinks(
    owner,
    "Case",
    `new-${crypto.randomUUID().slice(0, 6)}`,
    1,
  );
  let inspected: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/links?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      const response = await route.fetch();
      inspected();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        // The page may abort the stale pagination request while the new filter loads.
      }
      return;
    }
    await route.continue();
  });
  await page.goto("/links");
  await page
    .getByRole("textbox", { name: "Filter links by exact tag" })
    .fill("旅行");
  await page.getByRole("button", { name: "Apply tag filter" }).click();
  await expect(
    page.getByRole("button", { name: /^Select old-/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more links" }).click();
  await started;
  await page
    .getByRole("textbox", { name: "Filter links by exact tag" })
    .fill("Case");
  await page.getByRole("button", { name: "Apply tag filter" }).click();
  await expect(
    page.getByRole("button", { name: `Select ${newRows[0]?.slug}` }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: `Select ${newRows[0]?.slug}` }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Select old-/ })).toHaveCount(
    0,
  );
});

test("saving_a_page_two_link_keeps_it_selected_and_preserves_edits_during_refresh", async ({
  page,
  context,
  request,
}) => {
  const { owner } = await seedLibrary(context);
  const rows = seedTaggedLinks(
    owner,
    "Shared",
    `page-two-${crypto.randomUUID().slice(0, 6)}`,
    31,
  );
  const firstPageResponse = await request.get(
    `${e2eOrigin}/api/links?limit=30&tag=Shared`,
    { headers: await ownerHeaders(context) },
  );
  expect(firstPageResponse.status()).toBe(200);
  const firstPage = (await firstPageResponse.json()) as {
    links: { id: string; slug: string }[];
  };
  const secondPageLink = rows.find(
    (row) => !firstPage.links.some((link) => link.id === row.id),
  );
  if (!secondPageLink)
    throw new Error("The fixture did not create a second Link page.");

  let holdNextRefresh = false;
  let inspected: () => void = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/links?*", async (route) => {
    const url = new URL(route.request().url());
    if (
      holdNextRefresh &&
      route.request().method() === "GET" &&
      url.searchParams.get("tag") === "Shared" &&
      !url.searchParams.has("cursor")
    ) {
      holdNextRefresh = false;
      inspected();
      await held;
    }
    await route.continue();
  });

  await page.goto("/links");
  await page
    .getByRole("textbox", { name: "Filter links by exact tag" })
    .fill("Shared");
  await page.getByRole("button", { name: "Apply tag filter" }).click();
  await page.getByRole("button", { name: "Load more links" }).click();
  await page
    .getByRole("button", { name: `Select ${secondPageLink.slug}` })
    .click();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "Shared",
  );

  holdNextRefresh = true;
  await page
    .getByRole("textbox", { name: "Link tags" })
    .fill("Shared\nKeep exact");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await refreshStarted;
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  const channels = page.getByRole("textbox", { name: "Sharing channels" });
  await expect(channels).toBeEnabled();
  await channels.fill("Draft while refreshing ");
  release();

  const selectedLink = page.getByRole("button", {
    name: `Select ${secondPageLink.slug}`,
  });
  await expect(selectedLink).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "Shared\nKeep exact",
  );
  await expect(channels).toHaveValue("Draft while refreshing ");

  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  expect(await readTracking(request, context, secondPageLink.id)).toMatchObject(
    {
      tags: ["Shared", "Keep exact"],
      channels: ["Draft while refreshing "],
    },
  );
});

test("show_all_clears_old_cursor_when_unfiltered_reload_fails", async ({
  page,
  context,
}) => {
  const { owner } = await seedLibrary(context);
  seedTaggedLinks(
    owner,
    "Shared",
    `cursor-${crypto.randomUUID().slice(0, 6)}`,
    31,
  );
  let failUnfilteredReload = false;
  let cursorRequests = 0;
  await page.route("**/api/links?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) cursorRequests++;
    if (
      failUnfilteredReload &&
      !url.searchParams.has("tag") &&
      !url.searchParams.has("cursor")
    ) {
      failUnfilteredReload = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "Links could not be refreshed.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/links");
  await page
    .getByRole("textbox", { name: "Filter links by exact tag" })
    .fill("Shared");
  await page.getByRole("button", { name: "Apply tag filter" }).click();
  await expect(
    page.getByRole("button", { name: "Load more links" }),
  ).toBeVisible();

  failUnfilteredReload = true;
  await page.getByRole("button", { name: "Show all links" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Links could not be refreshed.",
  );
  await expect(
    page.getByRole("button", { name: "Load more links" }),
  ).toHaveCount(0);
  expect(cursorRequests).toBe(0);

  await page.getByRole("button", { name: "Retry links" }).click();
  await expect(
    page.getByRole("button", { name: /^Select cursor-/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more links" }),
  ).toBeVisible();
});

test("logout_clears_delayed_analytics", async ({ page, context, request }) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/logout" },
    `logout-${crypto.randomUUID().slice(0, 8)}`,
  );
  let inspected: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/links/${link.id}/analytics**`, async (route) => {
    inspected();
    await held;
    try {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "Access denied." },
        }),
      });
    } catch {
      // Unmounting the authenticated screen can abort this delayed response.
    }
  });
  await page.goto("/links");
  await started;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep your moments close." }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("heading", { name: "Keep your moments close." }),
  ).toBeVisible();
  await expect(page.getByLabel(`Short URL for ${link.slug}`)).toHaveCount(0);
});

for (const status of [401, 403] as const) {
  test(`stale_${status}_analytics_clears_sensitive_state`, async ({
    page,
    context,
    request,
  }) => {
    await seedLibrary(context);
    const older = await createLink(
      request,
      context,
      { kind: "url", url: "https://example.org/older" },
      `older-${crypto.randomUUID().slice(0, 8)}`,
    );
    const newer = await createLink(
      request,
      context,
      { kind: "url", url: "https://example.org/newer" },
      `newer-${crypto.randomUUID().slice(0, 8)}`,
    );
    let inspected: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/links/*/analytics**", async (route) => {
      if (
        new URL(route.request().url()).pathname.endsWith(
          `/${older.id}/analytics`,
        )
      ) {
        inspected();
        await held;
        try {
          await route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
                message:
                  status === 401
                    ? "Authentication required."
                    : "Access denied.",
              },
            }),
          });
        } catch {
          // The request has already been aborted if the page was closed.
        }
        return;
      }
      await route.continue();
    });
    await page.goto("/links");
    await page.getByRole("button", { name: `Select ${older.slug}` }).click();
    await started;
    await page.getByRole("button", { name: `Select ${newer.slug}` }).click();
    await expect(page.getByLabel(`Short URL for ${newer.slug}`)).toBeVisible();
    release();
    await expect(page.getByRole("alert")).toContainText(
      status === 401 ? "session has ended" : "no longer available",
    );
    await expect(page.getByLabel(`Short URL for ${older.slug}`)).toHaveCount(0);
    await expect(page.getByLabel(`Short URL for ${newer.slug}`)).toHaveCount(0);
  });
}

test("failed_settings_save_retains_draft", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/save" },
    `save-${crypto.randomUUID().slice(0, 8)}`,
  );
  await page.route(`**/api/links/${link.id}/tracking`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await page
    .getByRole("textbox", { name: "Link tags" })
    .fill("旅行\nKeep Case ");
  await page.getByRole("textbox", { name: "Sharing channels" }).fill("Friends");
  await page.getByRole("textbox", { name: "UTM source" }).fill("family note");
  await page.getByRole("button", { name: "Add custom parameter" }).click();
  await page
    .getByRole("textbox", { name: "Custom parameter 1 key" })
    .fill("note");
  await page
    .getByRole("textbox", { name: "Custom parameter 1 value" })
    .fill("Keep & literal");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "旅行\nKeep Case ",
  );
  await expect(
    page.getByRole("textbox", { name: "Sharing channels" }),
  ).toHaveValue("Friends");
  await expect(page.getByRole("textbox", { name: "UTM source" })).toHaveValue(
    "family note",
  );
  await expect(
    page.getByRole("textbox", { name: "Custom parameter 1 key" }),
  ).toHaveValue("note");
  await expect(
    page.getByRole("textbox", { name: "Custom parameter 1 value" }),
  ).toHaveValue("Keep & literal");
  await expectNoHorizontalOverflow(page);
});

test("confirmed_settings_write_survives_report_read_failure_and_retry", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/retry" },
    `retry-${crypto.randomUUID().slice(0, 8)}`,
  );
  let failNextReport = false;
  await page.route(`**/api/links/${link.id}/analytics**`, async (route) => {
    if (failNextReport) {
      failNextReport = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Service is not ready.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByLabel("Clicks")).toHaveText("0");
  failNextReport = true;
  await page.getByRole("textbox", { name: "Link tags" }).fill("旅行");
  await page.getByRole("button", { name: "Save tracking settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tracking settings saved" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "report could not be refreshed",
  );
  await page.getByRole("button", { name: "Retry report" }).click();
  await expect(page.getByLabel("Clicks")).toHaveText("0");
  await expect(
    page.getByText("No source data recorded in this range yet."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "旅行",
  );
});

test("report_range_change_preserves_unsaved_tracking_draft", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  const link = await createLink(
    request,
    context,
    { kind: "url", url: "https://example.org/range-draft" },
    `range-draft-${crypto.randomUUID().slice(0, 8)}`,
  );
  await page.goto("/links");
  await page.getByRole("button", { name: `Select ${link.slug}` }).click();
  await expect(page.getByRole("textbox", { name: "Link tags" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Link tags" }).fill("未存檔 ");
  await page
    .getByRole("textbox", { name: "Sharing channels" })
    .fill("Draft channel ");
  await page.getByRole("textbox", { name: "UTM source" }).fill("draft utm");

  const throughDate = new Date();
  throughDate.setUTCDate(throughDate.getUTCDate() - 1);
  const fromDate = new Date(throughDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - 2);
  const from = fromDate.toISOString().slice(0, 10);
  const to = throughDate.toISOString().slice(0, 10);
  await page.getByLabel("From").fill(from);
  await page.getByLabel("Through").fill(to);
  await page.getByRole("button", { name: "Apply date range" }).click();
  await expect(
    page.getByRole("region", { name: "Click source report" }),
  ).toContainText(`Showing ${from} through ${to}`);

  await expect(page.getByRole("textbox", { name: "Link tags" })).toHaveValue(
    "未存檔 ",
  );
  await expect(
    page.getByRole("textbox", { name: "Sharing channels" }),
  ).toHaveValue("Draft channel ");
  await expect(page.getByRole("textbox", { name: "UTM source" })).toHaveValue(
    "draft utm",
  );
  expect(await readTracking(request, context, link.id)).toMatchObject({
    tags: [],
    channels: [],
    utm: {},
  });
});
