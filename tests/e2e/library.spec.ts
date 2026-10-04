import { expect, test } from "@playwright/test";
import { photo, putFixture, seedLibrary } from "./fixtures";

test("anonymous library shows sign-in and keeps the API authenticated", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/me")).status()).toBe(401);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Keep your moments close." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/google");
  await page.screenshot({
    path: `test-results/landing-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("owner library streams actual media, hides foreign assets, and supports keyboard selection", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  await expect(page.getByText("Foreign secret.png")).toHaveCount(0);
  const image = page.getByRole("img", { name: "Coastal light.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(600);
  await page
    .getByRole("checkbox", { name: "Select Coastal light.png" })
    .focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("checkbox", { name: "Select Coastal light.png" }),
  ).toBeChecked();
  await expect(
    page.getByRole("status").filter({ hasText: "1 selected" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select Coastal light.png" }),
  ).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/library-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("tag editing and exact filtering persist across a deep-link refresh", async ({
  page,
  context,
  request,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Open Coastal light.png" }).tap();
  else
    await page.getByRole("button", { name: "Open Coastal light.png" }).focus();
  if (test.info().project.name !== "mobile") await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Coastal light.png" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Tags" }).fill("Coast\nSummer");
  await page.getByRole("button", { name: "Save tags" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Tags saved" }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/details-${test.info().project.name}.png`,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Filter by tag" }).fill("Coast");
  await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Mountain air.png" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Filter by tag" }),
  ).toHaveValue("Coast");
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  const response = await request.get("/api/missing-client-route");
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
});

test("simulated direct R2 transport recovers a failed PUT without sending binary to the Worker", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  const workerBodies: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().startsWith("http://127.0.0.1:8791") &&
      request.method() !== "GET"
    )
      workerBodies.push(request.headers()["content-type"] ?? "");
  });
  let puts = 0;
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe("PUT");
      expect(request.headers()["if-none-match"]).toBe("*");
      expect(request.headers()["content-type"]).toBe("image/png");
      expect(request.postDataBuffer()).toEqual(photo(120, 80));
      puts++;
      if (puts === 1)
        return route.fulfill({
          status: 503,
          body: "Synthetic transport failure",
        });
      const key = new URL(request.url()).pathname.split("/").slice(2).join("/");
      putFixture(key, photo(120, 80));
      await route.fulfill({ status: 200 });
    },
  );
  await page.goto("/library");
  await page.getByLabel("Choose photos or videos").setInputFiles({
    name: "New memory.png",
    mimeType: "image/png",
    buffer: photo(120, 80),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Upload interrupted" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry New memory.png" }).click();
  await expect(
    page.getByRole("button", { name: "Open New memory.png" }),
  ).toBeVisible();
  expect(puts).toBe(2);
  expect(workerBodies.length).toBeGreaterThan(0);
  expect(workerBodies.every((type) => type === "application/json")).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open New memory.png" }),
  ).toBeVisible();
});

test("details wait for authoritative metadata before allowing tag edits", async ({
  page,
  context,
}) => {
  const { ids } = await seedLibrary(context);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/assets/${ids[0]}`, async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  try {
    await expect(page.getByRole("textbox", { name: "Tags" })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("textbox", { name: "Tags" })).toBeEnabled();
});

test("keyboard filtering has an empty recovery state and sign out revokes the session", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page
    .getByRole("textbox", { name: "Filter by tag" })
    .fill("Not tagged yet");
  await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "No moments with this tag yet" }),
  ).toBeVisible();
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Show all moments" }).tap();
  else await page.getByRole("button", { name: "Show all moments" }).click();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  expect((await context.request.get("/api/me")).status()).toBe(401);
});

test("simulated lost PUT response completes the original asset without sending it twice", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let puts = 0;
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      puts++;
      const key = new URL(route.request().url()).pathname
        .split("/")
        .slice(2)
        .join("/");
      putFixture(key, photo(100, 100));
      await route.abort("failed");
    },
  );
  await page.goto("/library");
  await page.getByLabel("Choose photos or videos").setInputFiles({
    name: "Saved despite interruption.png",
    mimeType: "image/png",
    buffer: photo(100, 100),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Upload interrupted" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry Saved despite interruption.png" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Saved despite interruption.png" }),
  ).toBeVisible();
  expect(puts).toBe(1);
});

test("an old pagination response cannot reappear after changing the exact tag", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paginationStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    paginationStarted = resolve;
  });
  await page.route("**/api/assets?*", async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("limit", "1");
    const response = await route.fetch({ url: url.toString() });
    if (url.searchParams.has("cursor")) {
      paginationStarted();
      await gate;
    }
    await route.fulfill({ response });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Load more moments" }).click();
  await started;
  await page.getByRole("textbox", { name: "Filter by tag" }).fill("No match");
  await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "No moments with this tag yet" }),
  ).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No moments with this tag yet" }),
  ).toBeVisible();
});

test("pagination appends real owned results and a failed library request can be retried", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let fail = true;
  await page.route("**/api/assets?*", async (route) => {
    if (fail) {
      fail = false;
      return route.abort("failed");
    }
    const url = new URL(route.request().url());
    url.searchParams.set("limit", "2");
    const response = await route.fetch({ url: url.toString() });
    await route.fulfill({ response });
  });
  await page.goto("/library");
  await expect(
    page.getByRole("alert").filter({ hasText: "connection was interrupted" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry library" }).click();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(2);
  await page.getByRole("button", { name: "Load more moments" }).click();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Load more moments" }),
  ).toHaveCount(0);
});

test("exact tags preserve intentional spaces when edited and filtered", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page.getByRole("textbox", { name: "Tags" }).fill(" Coast ");
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tags saved" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Tags" })).toHaveValue(
    " Coast ",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Filter by tag" }).fill(" Coast ");
  await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Filter by tag" }),
  ).toHaveValue(" Coast ");
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
});

test("a quota refresh failure does not turn a completed upload into a failed upload", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let profileReads = 0;
  await page.route("**/api/me", async (route) => {
    profileReads++;
    if (profileReads > 1) return route.abort("failed");
    await route.continue();
  });
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      const key = new URL(route.request().url()).pathname
        .split("/")
        .slice(2)
        .join("/");
      putFixture(key, photo(120, 90));
      await route.fulfill({ status: 200 });
    },
  );
  await page.goto("/library");
  await page.getByLabel("Choose photos or videos").setInputFiles({
    name: "Already safe.png",
    mimeType: "image/png",
    buffer: photo(120, 90),
  });
  await expect(
    page.getByRole("button", { name: "Open Already safe.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved to your library" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Already safe.png" }),
  ).toHaveCount(0);
});

test("upload completion preserves a newer exact tag filter", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const completing = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/assets/*/complete", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    started();
    await gate;
    await route.fulfill({ response });
  });
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      const key = new URL(route.request().url()).pathname
        .split("/")
        .slice(2)
        .join("/");
      putFixture(key, photo(120, 90));
      await route.fulfill({ status: 200 });
    },
  );
  try {
    await page.goto("/library");
    await page.getByLabel("Choose photos or videos").setInputFiles({
      name: "Filter race.png",
      mimeType: "image/png",
      buffer: photo(120, 90),
    });
    await completing;
    await page.getByRole("textbox", { name: "Filter by tag" }).fill("No match");
    await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
    release();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved to your library" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tagged “No match”", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
  } finally {
    release();
  }
});

test("delayed upload profile cannot restore a signed-out library", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  await page.route("**/api/me", async (route) => {
    if (++reads === 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    started();
    await gate;
    await route.fulfill({ response });
  });
  await page.route(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
    async (route) => {
      const key = new URL(route.request().url()).pathname
        .split("/")
        .slice(2)
        .join("/");
      putFixture(key, photo(120, 90));
      await route.fulfill({ status: 200 });
    },
  );
  try {
    await page.goto("/library");
    await page.getByLabel("Choose photos or videos").setInputFiles({
      name: "Logout race.png",
      mimeType: "image/png",
      buffer: photo(120, 90),
    });
    await refreshing;
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("heading", { name: "Keep your moments close." }),
    ).toBeVisible();
    expect((await context.request.get("/api/me")).status()).toBe(401);
    const delivered = page.waitForResponse("**/api/me");
    release();
    await delivered;
    // Let the fulfilled response and its client continuation settle.
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: "Keep your moments close." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  } finally {
    release();
  }
});

test("short link namespace returns Worker JSON errors instead of the client shell", async ({
  request,
}) => {
  for (const path of ["/s", "/s/missing"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
});

test("closing details focuses the filter when edited tags remove its opener", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page.getByRole("textbox", { name: "Tags" }).fill("Coast");
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tags saved" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/library?tag=Coast");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page.getByRole("textbox", { name: "Tags" }).fill("Other");
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tags saved" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Filter by tag" }),
  ).toBeFocused();
});

test("Escape dismisses details before a queued native close notification can steal filter focus", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Native close notifications can arrive after focus has already returned outside the dialog.
  // Hold that notification so dismissal must happen during the Escape cancellation itself.
  await page.evaluate(() => {
    window.addEventListener(
      "close",
      (event) => event.stopImmediatePropagation(),
      {
        capture: true,
        once: true,
      },
    );
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(
    0,
  );
  await page.getByRole("textbox", { name: "Filter by tag" }).fill("Coast");
  await page.getByRole("textbox", { name: "Filter by tag" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Open Mountain air.png" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Filter by tag" }),
  ).toBeFocused();
});
