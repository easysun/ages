import { expect, type Page, test } from "@playwright/test";
import { e2eOrigin, photo, putFixture, seedLibrary } from "./fixtures";

async function createStory(page: Page, title: string) {
  await page.goto("/timelines");
  await page.getByRole("textbox", { name: "New timeline title" }).fill(title);
  await page.getByRole("button", { name: "Create timeline" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return page.url();
}

async function uploadPhoto(page: Page, name: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload photo", exact: true }).click();
  await (await chooser).setFiles({
    name,
    mimeType: "image/png",
    buffer: photo(160, 100),
  });
}

async function simulateStorage(page: Page) {
  // Only the external signed PUT is simulated. The real local Worker checks the
  // intent, R2 object, upload completion and timeline append.
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      expect(route.request().method()).toBe("PUT");
      const bytes = route.request().postDataBuffer();
      expect(bytes).toEqual(photo(160, 100));
      const path = new URL(route.request().url()).pathname;
      putFixture(path.split("/").slice(2).join("/"), photo(160, 100));
      await route.fulfill({ status: 200 });
    },
  );
}

test("a first photo goes directly from an empty timeline to a photo-only story", async ({
  page,
  context,
  browser,
}) => {
  await seedLibrary(context, { empty: true });
  const url = await createStory(page, "First photo");
  await simulateStorage(page);
  await uploadPhoto(page, "First visit.png");
  const moment = page.getByRole("group", { name: "Moment 1", exact: true });
  await moment.scrollIntoViewIfNeeded();
  await expect(moment.getByRole("img")).toBeVisible();
  await expect(page).toHaveURL(url);
  await page.reload();
  await moment.scrollIntoViewIfNeeded();
  await expect(moment.getByRole("img")).toBeVisible();
  const storyId = new URL(url).pathname.split("/").at(-1);
  const summary = await context.request.get(
    `/api/timelines/${storyId}/overview`,
  );
  expect(summary.ok()).toBe(true);
  const { timeline } = await summary.json();
  const result = await context.request.get(
    `/api/timelines/${storyId}/items?version=${timeline.version}`,
  );
  expect(result.ok()).toBe(true);
  const { items } = await result.json();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    caption: "",
    asset: { original_name: "First visit.png" },
  });
  const visitor = await browser.newContext();
  try {
    expect(
      (await visitor.request.get(`${e2eOrigin}/t/${storyId}`)).status(),
    ).toBe(404);
  } finally {
    await visitor.close();
  }
});

test("a text-first story supports inline edits and keeps its share URL and mixed order", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await seedLibrary(context, { empty: true });
  const url = await createStory(page, "A walk by the sea");
  const addText = page.getByRole("button", { name: "Write text", exact: true });
  await addText.click();
  const entry = page.getByRole("textbox", { name: "Moment text", exact: true });
  await expect(entry).toBeFocused();
  await entry.fill("  ");
  const add = page.getByRole("button", { name: "Add text moment" });
  await expect(add).toBeDisabled();
  await entry.fill("A quiet morning.\nThe tide was low.");
  await page.getByRole("region", { name: "Add to timeline" }).screenshot({
    path: `test-results/mixed-story-composer-${testInfo.project.name}.png`,
  });
  await add.click();
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await expect(
    first.getByText("A quiet morning.", { exact: false }),
  ).toBeVisible();
  await expect(first.getByRole("img")).toHaveCount(0);
  await first.getByRole("button", { name: "Edit moment" }).click();
  const draft = first.getByRole("textbox", { name: "Moment text" });
  await draft.fill("An abandoned draft");
  await first.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    first.getByText("A quiet morning.", { exact: false }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Edit moment" }).click();
  await draft.fill("Morning at the coast.\nA page of my story.");
  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(
    first.getByText("Morning at the coast.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Visibility", { exact: true }).selectOption("unlisted");
  await page.getByRole("button", { name: "Save timeline" }).click();
  const ownerShare = page.getByRole("link", { name: "Open shared timeline" });
  const shareUrl = `${e2eOrigin}/t/${new URL(url).pathname.split("/").at(-1)}`;
  await expect(ownerShare).toHaveAttribute("href", shareUrl);
  const visitor = await browser.newContext();
  try {
    const reader = await visitor.newPage();
    const viewport = page.viewportSize();
    if (viewport) await reader.setViewportSize(viewport);
    const response = await reader.goto(shareUrl);
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    const list = reader.locator("ol > li");
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText("A page of my story.");
    await expect(list.locator("img, video, audio")).toHaveCount(0);
    await expect(reader.locator('meta[property="og:image"]')).toHaveCount(0);
    await simulateStorage(page);
    await uploadPhoto(page, "Morning shore.png");
    const second = page.getByRole("group", { name: "Moment 2", exact: true });
    await second.getByRole("button", { name: "Edit moment" }).click();
    await second
      .getByRole("textbox", { name: "Caption" })
      .fill("The beach at sunrise");
    await second.getByRole("button", { name: "Save moment" }).click();
    await expect(
      second.getByText("The beach at sunrise", { exact: true }),
    ).toBeVisible();
    await uploadPhoto(page, "Waves.png");
    const third = page.getByRole("group", { name: "Moment 3", exact: true });
    await third.scrollIntoViewIfNeeded();
    await expect(third.getByRole("img")).toBeVisible();
    await second.getByRole("button", { name: "Move earlier" }).click();
    await expect(
      first.getByText("The beach at sunrise", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      first.getByText("The beach at sunrise", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByText("A page of my story.", { exact: false }),
    ).toBeVisible();
    await expect(ownerShare).toHaveAttribute("href", shareUrl);
    await reader.reload();
    await expect(list).toHaveCount(3);
    await expect(list.nth(2).getByRole("img")).toHaveCount(1);
    await expect(list.nth(2).locator(".caption")).toHaveCount(0);
    await expect(list.nth(0)).toContainText("The beach at sunrise");
    await expect(list.nth(0).getByRole("img")).toHaveCount(1);
    await expect(list.nth(1)).toContainText("A page of my story.");
    await expect(list.nth(1).locator("img, video, audio")).toHaveCount(0);
    await reader.screenshot({
      path: `test-results/mixed-story-viewer-${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await visitor.close();
  }
});

for (const kind of ["photo", "text"] as const) {
  test(`retrying a ${kind} after a lost append response creates exactly one moment`, async ({
    page,
    context,
  }) => {
    await seedLibrary(context, { empty: true });
    const editor = await createStory(page, "Safe retries");
    const id = new URL(editor).pathname.split("/").at(-1);
    const apiPath = `/api/timelines/${id}`;
    const attempts: { item_id: string; expected_version: number }[] = [];
    await page.route(`**${apiPath}/items`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const committed = await route.fetch();
      expect(committed.status()).toBe(204);
      // Another edit lands before the browser can learn whether its first POST committed.
      const { timeline } = await (await context.request.get(apiPath)).json();
      const edited = await context.request.patch(apiPath, {
        headers: { Origin: e2eOrigin },
        data: {
          expected_version: timeline.version,
          title: "Changed in another tab",
        },
      });
      expect(edited.ok()).toBe(true);
      await route.abort("connectionreset");
    });
    if (kind === "photo") {
      await simulateStorage(page);
      await uploadPhoto(page, "One photo.png");
      await page.getByRole("button", { name: "Retry adding photo" }).click();
    } else {
      await page.getByRole("button", { name: "Write text" }).click();
      await page
        .getByRole("textbox", { name: "Moment text" })
        .fill("Save once");
      const add = page.getByRole("button", { name: "Add text moment" });
      await add.click();
      await expect(
        page.getByText(/The save could not be confirmed/),
      ).toBeVisible();
      await add.click();
    }
    await expect(
      page.getByRole("heading", { name: "Changed in another tab" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: /^Moment \d+$/ })).toHaveCount(
      1,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.item_id).toMatch(/^ti_client_/);
    expect(attempts[1]).toEqual(attempts[0]);
    const { timeline } = await (await context.request.get(apiPath)).json();
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0].id).toBe(attempts[0]?.item_id);
    expect(timeline.version).toBe((attempts[0]?.expected_version ?? -1) + 2);
  });
}

test("an undelivered note can be retried after another tab advances the story", async ({
  page,
  context,
}) => {
  await seedLibrary(context, { empty: true });
  const url = await createStory(page, "Retry before commit");
  const path = `/api/timelines/${new URL(url).pathname.split("/").at(-1)}`;
  const attempts: { item_id: string; expected_version: number }[] = [];
  await page.route(`**${path}/items`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    attempts.push(body);
    if (attempts.length > 1) return route.continue();
    const edited = await context.request.patch(path, {
      headers: { Origin: e2eOrigin },
      data: { expected_version: body.expected_version, title: "A newer title" },
    });
    expect(edited.ok()).toBe(true);
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Write text" }).click();
  await page
    .getByRole("textbox", { name: "Moment text" })
    .fill("Keep this draft");
  const save = page.getByRole("button", { name: "Add text moment" });
  await save.click();
  await expect(page.getByText(/The save could not be confirmed/)).toBeVisible();
  await save.click();
  await expect(
    page.getByRole("heading", { name: "A newer title" }),
  ).toBeVisible();
  await save.click();
  await expect(
    page.getByRole("group", { name: "Moment 1", exact: true }),
  ).toContainText("Keep this draft");
  expect(attempts).toHaveLength(3);
  expect(attempts[2]?.item_id).toBe(attempts[0]?.item_id);
  expect(attempts[2]?.expected_version).toBe(
    (attempts[0]?.expected_version ?? -1) + 1,
  );
});
