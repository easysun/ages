import { expect, type Page, test } from "@playwright/test";
import {
  e2eOrigin,
  photo,
  putFixture,
  seedLibrary,
  seedTimeline,
} from "./fixtures";

async function addMoments(page: Page, names: string[]) {
  await page.getByRole("button", { name: "Add moments", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add moments" });
  for (const name of names)
    await dialog.getByRole("checkbox", { name: `Select ${name}` }).check();
  await dialog.getByRole("button", { name: "Add selected moments" }).click();
  await expect(dialog).toHaveCount(0);
}

test("create, describe, share and append through simulated upload transport keep one canonical story", async ({
  page,
  context,
  browser,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("link", { name: "Timelines", exact: true }).click();
  await page
    .getByRole("textbox", { name: "New timeline title" })
    .fill("Days by the coast");
  await page.getByRole("button", { name: "Create timeline" }).click();
  await expect(
    page.getByRole("heading", { name: "Days by the coast" }),
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1);
  expect(id).toMatch(/^tl_/);
  await addMoments(page, [
    "Coastal light.png",
    "A quiet afternoon.png",
    "Mountain air.png",
  ]);
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first
    .getByRole("textbox", { name: "Caption" })
    .fill("The first light of summer");
  await first.getByLabel("Date type").selectOption("date");
  await first.getByLabel("Event date", { exact: true }).fill("2024-02-29");
  await first.getByLabel("Time zone").fill("Asia/Taipei");
  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(first.getByRole("status")).toHaveText("Moment saved");
  await first.getByRole("button", { name: "Move later" }).focus();
  await page.keyboard.press("Enter");
  const second = page.getByRole("group", { name: "Moment 2", exact: true });
  await expect(second.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "The first light of summer",
  );
  await page
    .getByLabel("Cover", { exact: true })
    .selectOption({ label: "Coastal light.png" });
  await page.getByLabel("Visibility", { exact: true }).selectOption("unlisted");
  await page.getByRole("button", { name: "Save timeline" }).click();
  const share = page.getByRole("link", { name: "Open shared timeline" });
  await expect(share).toHaveAttribute("href", `${e2eOrigin}/t/${id}`);
  const canonical = await share.getAttribute("href");
  const anonymous = await browser.newContext();
  try {
    const viewer = await anonymous.newPage();
    await viewer.goto(canonical as string);
    await expect(
      viewer.getByRole("heading", { name: "Days by the coast" }),
    ).toBeVisible();
    await expect(viewer.locator("ol > li")).toHaveCount(3);
    await expect(viewer.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      canonical as string,
    );
    expect(await viewer.locator("script").count()).toBe(0);
    const result = await anonymous.request.get(canonical as string);
    expect(result.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    // Only the synthetic signed S3 transport is intercepted; intent/completion stay real.
    const workerBodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(e2eOrigin) && request.method() !== "GET")
        workerBodies.push(request.headers()["content-type"] ?? "");
    });
    await page.route(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/**`,
      async (route) => {
        expect(route.request().method()).toBe("PUT");
        expect(route.request().headers()["if-none-match"]).toBe("*");
        expect(route.request().postDataBuffer()).toEqual(photo(160, 100));
        const key = new URL(route.request().url()).pathname
          .split("/")
          .slice(2)
          .join("/");
        putFixture(key, photo(160, 100));
        await route.fulfill({ status: 200 });
      },
    );
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await page.getByLabel("Choose photos or videos").setInputFiles({
      name: "Evening light.png",
      mimeType: "image/png",
      buffer: photo(160, 100),
    });
    await expect(
      page.getByRole("button", { name: "Open Evening light.png" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved to your library" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Timelines", exact: true }).click();
    await page.getByRole("link", { name: /Days by the coast/ }).click();
    await addMoments(page, ["Evening light.png"]);
    expect(workerBodies.length).toBeGreaterThan(0);
    expect(workerBodies.every((type) => type === "application/json")).toBe(
      true,
    );
    await expect(share).toHaveAttribute("href", canonical as string);
    await viewer.reload();
    await expect(viewer.locator("ol > li")).toHaveCount(4);
    await expect(
      viewer.getByText("The first light of summer", { exact: true }),
    ).toBeVisible();
    await viewer.screenshot({
      path: `test-results/editor-viewer-${test.info().project.name}.png`,
      fullPage: true,
    });
  } finally {
    await anonymous.close();
  }
  await page.reload();
  await expect(page.getByRole("group", { name: /^Moment \d+$/ })).toHaveCount(
    4,
  );
  await expect(
    page
      .getByRole("group", { name: "Moment 2", exact: true })
      .getByRole("textbox", { name: "Caption" }),
  ).toHaveValue("The first light of summer");
  await expect(
    page
      .getByRole("group", { name: "Moment 2", exact: true })
      .getByLabel("Event date", { exact: true }),
  ).toHaveValue("2024-02-29");
  await expect(share).toHaveAttribute("href", canonical as string);
  await page.getByRole("link", { name: "Timelines", exact: true }).click();
  await page.getByRole("link", { name: /Days by the coast/ }).click();
  await expect(page.getByRole("group", { name: /^Moment \d+$/ })).toHaveCount(
    4,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/editor-viewport-${test.info().project.name}.png`,
    fullPage: false,
  });
  await page.screenshot({
    path: `test-results/editor-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("reusing an asset keeps each story caption and event date independent", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const first = seedTimeline(owner, ids, 1, "First story");
  const second = seedTimeline(owner, ids, 1, "Second story");
  const assetBefore = await (
    await context.request.get(`/api/assets/${ids[0]}`)
  ).json();
  await page.goto(`/timelines/${first.id}`);
  const moment = page.getByRole("group", { name: "Moment 1", exact: true });
  await moment
    .getByRole("textbox", { name: "Caption" })
    .fill("Only in the first story");
  await moment.getByLabel("Date type").selectOption("date");
  await moment.getByLabel("Event date", { exact: true }).fill("2025-07-16");
  await moment.getByLabel("Time zone").fill("UTC");
  await moment.getByRole("button", { name: "Save moment" }).click();
  await expect(moment.getByRole("status")).toHaveText("Moment saved");
  await page.goto(`/timelines/${second.id}`);
  await expect(moment.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "Moment 1",
  );
  await expect(moment.getByLabel("Date type")).toHaveValue("none");
  expect(
    await (await context.request.get(`/api/assets/${ids[0]}`)).json(),
  ).toEqual(assetBefore);
  await page.goto(`/timelines/${first.id}`);
  await expect(moment.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "Only in the first story",
  );
  await expect(moment.getByLabel("Event date", { exact: true })).toHaveValue(
    "2025-07-16",
  );
});

test("100-item keyboard and touch moves submit the complete unique narrative order", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedTimeline(owner, ids, 100);
  let reordered: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/timelines/${id}/order`))
      reordered = request.postDataJSON().item_ids;
  });
  await page.goto(`/timelines/${id}`);
  const last = page.getByRole("group", { name: "Moment 100", exact: true });
  const earlier = last.getByRole("button", { name: "Move earlier" });
  if (test.info().project.name === "mobile") await earlier.tap();
  else {
    await earlier.focus();
    await page.keyboard.press("Enter");
  }
  await expect(
    page
      .getByRole("group", { name: "Moment 99", exact: true })
      .getByRole("textbox", { name: "Caption" }),
  ).toHaveValue("Moment 100");
  expect(reordered).toHaveLength(100);
  expect(new Set(reordered).size).toBe(100);
  expect(reordered.slice(-2)).toEqual([itemIds[99], itemIds[98]]);
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "Moment 99", exact: true })
      .getByRole("textbox", { name: "Caption" }),
  ).toHaveValue("Moment 100");
});

test("a real stale version refetches the story while preserving the unsaved caption", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedTimeline(owner, ids);
  await page.goto(`/timelines/${id}`);
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first.getByRole("textbox", { name: "Caption" }).fill("Keep my draft");
  const external = await context.request.patch(`/api/timelines/${id}`, {
    headers: { Origin: e2eOrigin },
    data: { expected_version: 1, title: "Changed in another window" },
  });
  expect(external.ok()).toBe(true);
  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Changed in another window" }),
  ).toBeVisible();
  await expect(first.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "Keep my draft",
  );
  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(first.getByRole("status")).toHaveText("Moment saved");
  const actual = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  expect(
    actual.timeline.items.find((item: { id: string }) => item.id === itemIds[0])
      .caption,
  ).toBe("Keep my draft");
  expect(actual.timeline.title).toBe("Changed in another window");
});

test("share URL failure retries the actual canonical response instead of guessing a URL", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1);
  let fail = true;
  await page.route(`**/t/${id}`, async (route) => {
    if (fail) {
      fail = false;
      return route.abort("failed");
    }
    await route.continue();
  });
  await page.goto(`/timelines/${id}`);
  await page.getByLabel("Visibility", { exact: true }).selectOption("unlisted");
  await page.getByRole("button", { name: "Save timeline" }).click();
  await expect(
    page.getByRole("button", { name: "Retry share link" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open shared timeline" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry share link" }).click();
  await expect(
    page.getByRole("link", { name: "Open shared timeline" }),
  ).toHaveAttribute("href", `${e2eOrigin}/t/${id}`);
});

async function viewport(page: Page) {
  return page
    .getByRole("region", { name: "Story viewport" })
    .evaluate((element) => ({
      center: Number((element as HTMLElement).dataset.center),
      span: Number((element as HTMLElement).dataset.span),
      extent: Number((element as HTMLElement).dataset.extent),
    }));
}

test("anchored navigation stays readable, preserves data and manual framing, and cleans up on exit", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    let observers = 0;
    const NativeObserver = ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      private active = false;
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (!this.active) {
          observers++;
          this.active = true;
        }
        super.observe(target, options);
      }
      override disconnect() {
        if (this.active) {
          observers--;
          this.active = false;
        }
        super.disconnect();
      }
    };
    Object.defineProperty(window, "__activeResizeObservers", {
      get: () => observers,
    });
    let listeners = 0;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if (
        type === "wheel" &&
        this instanceof HTMLElement &&
        this.dataset.viewport === "story"
      )
        listeners++;
      add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ) {
      if (
        type === "wheel" &&
        this instanceof HTMLElement &&
        this.dataset.viewport === "story"
      )
        listeners--;
      remove.call(this, type, listener, options);
    };
    Object.defineProperty(window, "__activeViewportListeners", {
      get: () => listeners,
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 100);
  const before = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  await page.goto(`/timelines/${id}`);
  const map = page.getByRole("region", { name: "Story viewport" });
  await expect(map).toBeVisible();
  await expect
    .poll(async () => (await viewport(page)).extent)
    .toBeGreaterThan(0);
  const initial = await viewport(page);
  expect(initial.span).toBeLessThan(10);
  const bounds = await map.boundingBox();
  expect(bounds).not.toBeNull();
  const pointerX = Math.round((bounds?.x ?? 0) + (bounds?.width ?? 0) * 0.25);
  const anchor = (pointerX - (bounds?.x ?? 0)) / (bounds?.width ?? 1);
  await page.mouse.move(pointerX, (bounds?.y ?? 0) + 60);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => (await viewport(page)).span)
    .toBeLessThan(initial.span);
  const zoomed = await viewport(page);
  expect(zoomed.center + (anchor - 0.5) * zoomed.span).toBeCloseTo(
    initial.center + (anchor - 0.5) * initial.span,
    5,
  );
  await page.getByRole("button", { name: "Pan later", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Pan later", exact: true }),
  ).toBeFocused();
  const manual = await viewport(page);
  const oldSize = page.viewportSize();
  await page.setViewportSize({
    width: test.info().project.name === "mobile" ? 430 : 900,
    height: oldSize?.height ?? 812,
  });
  await expect
    .poll(async () => (await viewport(page)).extent)
    .not.toBe(manual.extent);
  expect((await viewport(page)).center).toBeCloseTo(manual.center, 5);
  expect(
    await (await context.request.get(`/api/timelines/${id}`)).json(),
  ).toEqual(before);
  await addMoments(page, ["Coastal light.png"]);
  expect((await viewport(page)).center).toBeCloseTo(manual.center, 5);
  await page.getByRole("button", { name: "Fit all", exact: true }).click();
  await expect
    .poll(async () => (await viewport(page)).span)
    .toBeGreaterThan(100);
  expect(await map.locator("svg g").count()).toBeLessThanOrEqual(
    Math.ceil((await viewport(page)).extent / 48) + 2,
  );
  expect(
    await map.evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __activeResizeObservers: number })
          .__activeResizeObservers,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __activeViewportListeners: number })
          .__activeViewportListeners,
    ),
  ).toBe(0);
});

test("mobile native touch pan and pinch navigate the story without disabling page magnification", async ({
  page,
  context,
}) => {
  test.skip(
    test.info().project.name !== "mobile",
    "Native touch is a mobile Chromium gate",
  );
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 3);
  await page.goto(`/timelines/${id}`);
  const map = page.getByRole("region", { name: "Story viewport" });
  await expect(map).toBeVisible();
  await map.scrollIntoViewIfNeeded();
  let box = await map.boundingBox();
  expect(box).not.toBeNull();
  const cdp = await context.newCDPSession(page);
  const scrollingX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const scrollingY = (box?.y ?? 0) + 70;
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: scrollingX, y: scrollingY, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: scrollingX, y: scrollingY - 40, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: scrollingX, y: scrollingY - 80, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(scrollBefore);
  await map.scrollIntoViewIfNeeded();
  box = await map.boundingBox();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + 70;
  const before = await viewport(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: x - 35, y, id: 1 },
      { x: x + 35, y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: x - 60, y, id: 1 },
      { x: x + 60, y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () => (await viewport(page)).span)
    .toBeLessThan(before.span);
  const zoomed = await viewport(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: x - 40, y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x + 30, y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x + 60, y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () => (await viewport(page)).center)
    .not.toBe(zoomed.center);
  await page
    .getByRole("group", { name: "Moment 1", exact: true })
    .scrollIntoViewIfNeeded();
  // CDP's synthesized pinch changes visualViewport.scale inconsistently across
  // headless platforms, so verify the browser policy that permits page zoom.
  const magnificationPolicy = await page.evaluate(() => {
    const viewport = document
      .querySelector('meta[name="viewport"]')
      ?.getAttribute("content");
    const target = document.elementFromPoint(180, 600);
    const touchActions: string[] = [];
    for (
      let element: Element | null = target;
      element;
      element = element.parentElement
    )
      touchActions.push(getComputedStyle(element).touchAction);
    return {
      viewport,
      target: target?.tagName ?? null,
      touchActions,
    };
  });
  expect(magnificationPolicy.viewport).toMatch(/\bwidth=device-width\b/);
  expect(magnificationPolicy.viewport).not.toMatch(
    /\b(?:maximum-scale|user-scalable\s*=\s*no)\b/i,
  );
  expect(magnificationPolicy.target).not.toBeNull();
  expect(magnificationPolicy.touchActions.length).toBeGreaterThan(0);
  expect(
    magnificationPolicy.touchActions.every((action) => {
      const values = action.split(/\s+/);
      return (
        action === "auto" ||
        action === "manipulation" ||
        values.includes("pinch-zoom")
      );
    }),
  ).toBe(true);
  const actual = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  expect(actual.timeline.version).toBe(1);
  await cdp.detach();
});

test("a picker conflict stays visible and selected moments can be retried with the refreshed version", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1);
  await page.goto(`/timelines/${id}`);
  await page.getByRole("button", { name: "Add moments", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add moments" });
  await dialog
    .getByRole("checkbox", { name: "Select Mountain air.png" })
    .check();
  const external = await context.request.patch(`/api/timelines/${id}`, {
    headers: { Origin: e2eOrigin },
    data: { expected_version: 1, title: "Edited elsewhere" },
  });
  expect(external.ok()).toBe(true);
  await dialog.getByRole("button", { name: "Add selected moments" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Select Mountain air.png" }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Add selected moments" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("group", { name: /^Moment \d+$/ })).toHaveCount(
    2,
  );
});

test("adding from the keyboard restores focus to its surviving Add moments opener", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1);
  await page.goto(`/timelines/${id}`);
  const opener = page.getByRole("button", { name: "Add moments", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add moments" });
  await dialog
    .getByRole("checkbox", { name: "Select Mountain air.png" })
    .focus();
  await page.keyboard.press("Space");
  await dialog.getByRole("button", { name: "Add selected moments" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("failed media metadata reads show a retry instead of remaining in a loading state", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids);
  let fail = true;
  await page.route("**/api/assets**", async (route) => {
    if (fail && route.request().method() === "GET")
      return route.abort("failed");
    await route.continue();
  });
  await page.goto(`/timelines/${id}`);
  await expect(
    page.getByRole("button", { name: "Retry media details" }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry media details" }).click();
  await expect(
    page.getByRole("img", { name: "Coastal light.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry media details" }),
  ).toHaveCount(0);
});

test("Escape dismisses the picker synchronously when its native close notification is held", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1);
  await page.goto(`/timelines/${id}`);
  const opener = page.getByRole("button", { name: "Add moments", exact: true });
  await opener.click();
  await expect(page.getByRole("dialog", { name: "Add moments" })).toBeVisible();
  await page.evaluate(() =>
    window.addEventListener(
      "close",
      (event) => event.stopImmediatePropagation(),
      { capture: true, once: true },
    ),
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(
    0,
  );
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add moments" })).toBeVisible();
});
