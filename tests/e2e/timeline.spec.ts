import { expect, type Page, test } from "@playwright/test";
import {
  e2eOrigin,
  photo,
  putFixture,
  seedLargeTimeline,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deferredSignal() {
  const gate = deferred();
  const signal = deferred();
  return {
    promise: gate.promise,
    release: gate.resolve,
    started: signal.promise,
    signal: signal.resolve,
  };
}

test("10,000-item editor reads a lightweight index and bounded detail windows", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedLargeTimeline(owner, ids[0] as string);
  const overviewRequests: URL[] = [];
  const detailRequests: URL[] = [];
  const fullDetailRequests: URL[] = [];
  const assetDetailRequests: URL[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const url = new URL(request.url());
    if (url.pathname === `/api/timelines/${id}/overview`)
      overviewRequests.push(url);
    else if (url.pathname === `/api/timelines/${id}/items`)
      detailRequests.push(url);
    else if (url.pathname === `/api/timelines/${id}`)
      fullDetailRequests.push(url);
    else if (/^\/api\/assets\/[^/]+$/.test(url.pathname))
      assetDetailRequests.push(url);
  });
  await page.route("**/api/assets**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/assets")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assets: [], next_cursor: null }),
      });
    else await route.continue();
  });
  await page.route(`**/api/timelines/${id}`, async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        timeline: {
          id,
          owner_id: owner,
          title: "A large story",
          visibility: "private",
          cover_asset_id: null,
          version: 1,
          created_at: now,
          updated_at: now,
          items: [
            {
              id: itemIds[0],
              asset_id: ids[0],
              position: 0,
              caption: "Moment 1",
              event_at: null,
            },
            {
              id: itemIds[1],
              asset_id: ids[0],
              position: 10,
              caption: "Moment 2",
              event_at: null,
            },
          ],
        },
      }),
    });
  });
  await page.goto(`/timelines/${id}`);
  await expect(
    page.getByRole("heading", { name: "A large story", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Moments 1–100 of 10000" }),
  ).toBeVisible();
  const firstMoment = page.getByRole("group", {
    name: "Moment 1",
    exact: true,
  });
  const firstListItem = page.getByRole("listitem").filter({ has: firstMoment });
  await expect(firstListItem).toHaveAttribute("aria-posinset", "1");
  await expect(firstListItem).toHaveAttribute("aria-setsize", "10000");

  const goToMoment = page.getByLabel("Go to moment");
  await goToMoment.fill("5001");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Moments 5001–5100 of 10000" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Moments 5001–5100 of 10000" }),
  ).toBeVisible();
  const middleListItem = page.getByRole("listitem").filter({
    has: page.getByRole("group", { name: "Moment 5001", exact: true }),
  });
  await expect(middleListItem).toHaveAttribute("aria-posinset", "5001");

  await goToMoment.fill("10000");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Moments 9901–10000 of 10000" }),
  ).toBeVisible();
  const lastListItem = page.getByRole("listitem").filter({
    has: page.getByRole("group", { name: "Moment 10000", exact: true }),
  });
  await expect(lastListItem).toHaveAttribute("aria-setsize", "10000");

  expect(fullDetailRequests).toEqual([]);
  expect(assetDetailRequests).toEqual([]);
  expect(overviewRequests).toHaveLength(10);
  expect(overviewRequests[0]?.searchParams.get("version")).toBeNull();
  expect(
    overviewRequests
      .slice(1)
      .every(
        (url) =>
          url.searchParams.get("version") === "1" &&
          url.searchParams.get("cursor") !== null,
      ),
  ).toBe(true);
  expect(
    overviewRequests.every(
      (url) => Number(url.searchParams.get("limit")) <= 1000,
    ),
  ).toBe(true);
  expect(detailRequests).toHaveLength(3);
  expect(
    detailRequests.every((url) => url.searchParams.get("version") === "1"),
  ).toBe(true);
  expect(
    detailRequests.every((url) => Number(url.searchParams.get("limit")) <= 100),
  ).toBe(true);
  expect(
    detailRequests.map((url) => url.searchParams.get("from_position")),
  ).toEqual(["0", "50000", "99000"]);
});

test("late detail responses cannot replace a newer range or timeline", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const first = seedLargeTimeline(
    owner,
    ids[0] as string,
    250,
    "First large story",
  );
  const second = seedTimeline(owner, ids, 3, "Second story");
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const settledUrls: string[] = [];
    Object.defineProperty(window, "__timelineFetchSettled", {
      value: settledUrls,
    });
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, location.href)
          : input instanceof URL
            ? input
            : new URL(input.url, location.href);
      if (/^\/api\/timelines\/[^/]+\/items$/.test(url.pathname)) {
        const options = { ...init };
        delete options.signal;
        return nativeFetch(input, options).then(async (response) => {
          await response.clone().arrayBuffer();
          settledUrls.push(url.href);
          return response;
        });
      }
      return nativeFetch(input, init);
    };
  });

  const oldRangeSuccess = deferred();
  const oldRangeSuccessStarted = deferred();
  const oldTimelineError = deferred();
  const oldTimelineErrorStarted = deferred();
  let holdRangeSuccess = true;
  let holdTimelineError = true;
  await page.route(`**/api/timelines/${first.id}/items?**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("from_position") === "1000" && holdRangeSuccess) {
      holdRangeSuccess = false;
      oldRangeSuccessStarted.resolve();
      await oldRangeSuccess.promise;
      await route.continue();
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/timelines/${second.id}/items?**`, async (route) => {
    if (holdTimelineError) {
      holdTimelineError = false;
      oldTimelineErrorStarted.resolve();
      await oldTimelineError.promise;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.goto(`/timelines/${first.id}`);
  const goToMoment = page.getByLabel("Go to moment");
  await goToMoment.fill("101");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await oldRangeSuccessStarted.promise;
  await goToMoment.fill("201");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Moments 201–250 of 250" }),
  ).toBeVisible();
  const lateRangeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/timelines/${first.id}/items` &&
      url.searchParams.get("from_position") === "1000"
    );
  });
  oldRangeSuccess.resolve();
  await (await lateRangeResponse).finished();
  await expect
    .poll(() =>
      page.evaluate(
        (timelineId) =>
          (
            window as unknown as {
              __timelineFetchSettled?: string[];
            }
          ).__timelineFetchSettled?.some((url) =>
            url.includes(`/api/timelines/${timelineId}/items?`),
          ) ?? false,
        first.id,
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("heading", { name: "Moments 201–250 of 250" }),
  ).toBeFocused();
  await expect(
    page.getByRole("group", { name: "Moment 201", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Timelines", exact: true }).click();
  await page.getByRole("link", { name: /Second story/ }).click();
  await oldTimelineErrorStarted.promise;
  await page.getByRole("link", { name: "Timelines", exact: true }).click();
  await page.getByRole("link", { name: /First large story/ }).click();
  await expect(
    page.getByRole("heading", { name: "First large story", exact: true }),
  ).toBeVisible();
  const oldTimelineRequestFailed = page.waitForEvent(
    "requestfailed",
    (request) => {
      const url = new URL(request.url());
      return url.pathname === `/api/timelines/${second.id}/items`;
    },
  );
  oldTimelineError.resolve();
  await oldTimelineRequestFailed;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("heading", { name: "First large story", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("caption and date drafts stay attached to their items when leaving a window", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedLargeTimeline(owner, ids[0] as string, 250);
  await page.goto(`/timelines/${id}`);

  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first
    .getByRole("textbox", { name: "Caption" })
    .fill("Draft on page one");
  await first.getByLabel("Date type").selectOption("date");
  await first.getByLabel("Event date", { exact: true }).fill("2024-02-29");
  await first.getByLabel("Time zone").fill("Asia/Taipei");

  const goToMoment = page.getByLabel("Go to moment");
  await goToMoment.fill("151");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Moments 101–200 of 250" }),
  ).toBeFocused();
  await goToMoment.fill("1");
  await page.getByRole("button", { name: "Go", exact: true }).click();

  await expect(first.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "Draft on page one",
  );
  await expect(first.getByLabel("Event date", { exact: true })).toHaveValue(
    "2024-02-29",
  );
  await expect(first.getByLabel("Time zone")).toHaveValue("Asia/Taipei");
});

test("a pending save clears only its submitted fields and keeps newer typing focused", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedTimeline(owner, ids, 1);
  const itemId = itemIds[0];
  if (!itemId) throw new Error("The seeded timeline item is missing.");
  const response = deferredSignal();
  const responseDelivered = deferredSignal();
  await page.addInitScript(
    ({ timelineId, itemId }) => {
      const nativeFetch = window.fetch.bind(window);
      const settled: string[] = [];
      Object.defineProperty(window, "__timelineMutationSettled", {
        value: settled,
      });
      window.fetch = (input, init) => {
        const url =
          typeof input === "string"
            ? new URL(input, location.href)
            : input instanceof URL
              ? input
              : new URL(input.url, location.href);
        if (
          url.pathname === `/api/timelines/${timelineId}/items/${itemId}` &&
          init?.method === "PATCH"
        )
          return nativeFetch(input, init).then(async (result) => {
            await result.clone().arrayBuffer();
            settled.push(url.href);
            return result;
          });
        return nativeFetch(input, init);
      };
    },
    { timelineId: id, itemId },
  );
  let held = true;
  await page.route(`**/api/timelines/${id}/items/${itemId}`, async (route) => {
    if (held && route.request().method() === "PATCH") {
      held = false;
      const result = await route.fetch();
      response.signal();
      await response.promise;
      await route.fulfill({ response: result }).catch(() => undefined);
      responseDelivered.signal();
      return;
    }
    await route.continue();
  });
  await page.goto(`/timelines/${id}`);
  const moment = page.getByRole("group", { name: "Moment 1", exact: true });
  const caption = moment.getByRole("textbox", { name: "Caption" });
  await caption.fill("Committed snapshot");
  await moment.getByLabel("Date type").selectOption("date");
  await moment.getByLabel("Event date", { exact: true }).fill("2024-02-29");
  await moment.getByLabel("Time zone").fill("Asia/Taipei");
  await moment.getByRole("button", { name: "Save moment" }).click();
  await response.started;
  await caption.fill("Newer typing during save");
  response.release();
  await responseDelivered.started;
  await expect
    .poll(() =>
      page.evaluate(
        (itemId) =>
          (
            window as unknown as {
              __timelineMutationSettled?: string[];
            }
          ).__timelineMutationSettled?.some((url) => url.endsWith(itemId)) ??
          false,
        itemId,
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(caption).toHaveValue("Newer typing during save");
  await expect(moment.getByLabel("Event date", { exact: true })).toHaveValue(
    "2024-02-29",
  );
  await expect(moment.getByLabel("Time zone")).toHaveValue("Asia/Taipei");
  await expect(caption).toBeFocused();
  await expect(
    moment.getByRole("button", { name: "Save moment" }),
  ).toBeEnabled();

  await moment.getByRole("button", { name: "Save moment" }).click();
  await expect(moment.getByRole("status")).toHaveText("Moment saved");
  const stored = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  expect(stored.timeline.items[0]).toMatchObject({
    id: itemIds[0],
    caption: "Newer typing during save",
    event_at: {
      kind: "date",
      date: "2024-02-29",
      time_zone: "Asia/Taipei",
    },
  });
});

test("drafts follow stable item IDs through a remote reorder and conflict refresh", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedLargeTimeline(owner, ids[0] as string, 250);
  await page.goto(`/timelines/${id}`);
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first
    .getByRole("textbox", { name: "Caption" })
    .fill("Follow this item");
  await first.getByLabel("Date type").selectOption("instant");
  await first.getByLabel("Event instant").fill("2026-10-04T10:30:00+08:00");
  await first.getByLabel("Time zone").fill("Asia/Taipei");

  const reordered = [...itemIds.slice(1), itemIds[0]];
  const external = await context.request.put(`/api/timelines/${id}/order`, {
    headers: { Origin: e2eOrigin },
    data: { expected_version: 1, item_ids: reordered },
  });
  expect(external.ok()).toBe(true);

  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Moments 201–250 of 250" }),
  ).toBeVisible();
  const moved = page.getByRole("group", { name: "Moment 250", exact: true });
  const caption = moved.getByRole("textbox", { name: "Caption" });
  await expect(caption).toHaveValue("Follow this item");
  await expect(caption).toBeFocused();
  await expect(moved.getByLabel("Event instant")).toHaveValue(
    "2026-10-04T10:30:00+08:00",
  );
  await expect(moved.getByLabel("Time zone")).toHaveValue("Asia/Taipei");

  await moved.getByRole("button", { name: "Save moment" }).click();
  await expect(moved.getByRole("status")).toHaveText("Moment saved");
  const stored = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  const storedMoment = stored.timeline.items.at(-1);
  expect(storedMoment).toMatchObject({
    id: itemIds[0],
    caption: "Follow this item",
    event_at: {
      kind: "instant",
      time_zone: "Asia/Taipei",
    },
  });
  expect(Date.parse(storedMoment.event_at.instant)).toBe(
    Date.parse("2026-10-04T10:30:00+08:00"),
  );
});

test("a remotely removed dirty moment remains copyable or discardable", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedLargeTimeline(owner, ids[0] as string, 2);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/timelines/${id}`);
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first
    .getByRole("textbox", { name: "Caption" })
    .fill("Keep this removed moment draft");
  await first.getByLabel("Date type").selectOption("date");
  await first.getByLabel("Event date", { exact: true }).fill("2025-07-16");
  await first.getByLabel("Time zone").fill("UTC");

  const removed = await context.request.delete(
    `/api/timelines/${id}/items/${itemIds[0]}`,
    { headers: { Origin: e2eOrigin }, data: { expected_version: 1 } },
  );
  expect(removed.ok()).toBe(true);
  await first.getByRole("button", { name: "Save moment" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  const unresolved = page.getByRole("region", { name: "Unresolved drafts" });
  await expect(unresolved).toBeVisible();
  await expect(unresolved).toContainText("Keep this removed moment draft");
  await expect(
    unresolved.getByRole("button", { name: "Save draft" }),
  ).toBeDisabled();
  await unresolved.getByRole("button", { name: "Copy draft" }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("Keep this removed moment draft");
  expect(clipboard).toContain("2025-07-16");
  expect(clipboard).toContain("UTC");
  await unresolved.getByRole("button", { name: "Discard draft" }).click();
  await expect(unresolved).toHaveCount(0);
});

test("removing a dirty moment requires confirmation and discards only after acceptance", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedTimeline(owner, ids, 2);
  await page.goto(`/timelines/${id}`);
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first
    .getByRole("textbox", { name: "Caption" })
    .fill("A draft that needs confirmation");
  let dialogMessage = "";
  const remove = first.getByRole("button", { name: "Remove moment" });
  await expect(remove).toBeVisible();
  page.once("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await remove.click();
  expect(dialogMessage).toContain("discard");
  await expect(first.getByRole("textbox", { name: "Caption" })).toHaveValue(
    "A draft that needs confirmation",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.locator(`#item-${itemIds[0]}-caption`)).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Moment 1", exact: true }),
  ).toBeVisible();
  const stored = await (
    await context.request.get(`/api/timelines/${id}`)
  ).json();
  expect(stored.timeline.items.map((item: { id: string }) => item.id)).toEqual([
    itemIds[1],
  ]);
});

test("empty and sparse appends reconcile one bounded pinned tail page", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const cases = [
    {
      timeline: seedLargeTimeline(owner, ids[0] as string, 0, "Empty story"),
      assetName: "Coastal light.png",
      priorCount: 0,
    },
    {
      timeline: seedLargeTimeline(owner, ids[0] as string, 3, "Sparse story"),
      assetName: "A quiet afternoon.png",
      priorCount: 3,
    },
  ];

  for (const { timeline, assetName, priorCount } of cases) {
    const overviewRequests: URL[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname ===
          `/api/timelines/${timeline.id}/overview`
      )
        overviewRequests.push(new URL(request.url()));
    });
    await page.goto(`/timelines/${timeline.id}`);
    await expect(
      page.getByRole("heading", {
        name: priorCount ? "Sparse story" : "Empty story",
      }),
    ).toBeVisible();
    overviewRequests.length = 0;
    await addMoments(page, [assetName]);
    const tail = overviewRequests.filter(
      (url) =>
        url.searchParams.get("version") === "2" &&
        url.searchParams.get("limit") === "2",
    );
    expect(tail).toHaveLength(1);
    if (priorCount) {
      expect(tail[0]?.searchParams.get("from_position")).toBe("20");
      expect(tail[0]?.searchParams.get("from_id")).toContain("_00002");
    } else {
      expect(tail[0]?.searchParams.get("from_position")).toBeNull();
      expect(tail[0]?.searchParams.get("from_id")).toBeNull();
    }
    expect(
      overviewRequests.filter(
        (url) => url.searchParams.get("version") === null,
      ),
    ).toHaveLength(0);
    const stored = await (
      await context.request.get(`/api/timelines/${timeline.id}`)
    ).json();
    expect(stored.timeline.items).toHaveLength(priorCount + 1);
    expect(stored.timeline.items.at(-1).position).toBe(priorCount ? 21 : 0);
  }
});

test("failed or conflicted append tails stop the batch and resume only after fresh reads", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);

  for (const failure of ["network", "conflict"] as const) {
    const { id } = seedLargeTimeline(owner, ids[0] as string, 2);
    const tail = deferredSignal();
    const releaseTail = deferredSignal();
    const freshOverview = deferredSignal();
    const releaseOverview = deferredSignal();
    const activeDetail = deferredSignal();
    const releaseDetail = deferredSignal();
    let injectTailFailure = true;
    let holdOverview = true;
    let holdDetail = true;
    const appendPosts: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url() === `${e2eOrigin}/api/timelines/${id}/items`
      )
        appendPosts.push(request.postDataJSON().asset_id);
    });
    await page.goto(`/timelines/${id}`);
    const first = page.getByRole("group", { name: "Moment 1", exact: true });
    const caption = first.getByRole("textbox", { name: "Caption" });
    await caption.fill(`Draft survives ${failure}`);
    await page.route(`**/api/timelines/${id}/overview?**`, async (route) => {
      const url = new URL(route.request().url());
      if (
        injectTailFailure &&
        url.searchParams.get("version") === "2" &&
        url.searchParams.get("limit") === "2"
      ) {
        injectTailFailure = false;
        if (failure === "network") {
          tail.signal();
          await releaseTail.promise;
          await route.abort("failed");
        } else {
          const changed = await context.request.patch(`/api/timelines/${id}`, {
            headers: { Origin: e2eOrigin },
            data: { expected_version: 2, title: "Changed during append" },
          });
          expect(changed.ok()).toBe(true);
          const conflict = await route.fetch();
          expect(conflict.status()).toBe(409);
          tail.signal();
          await releaseTail.promise;
          await route.fulfill({ response: conflict }).catch(() => undefined);
        }
        return;
      }
      if (holdOverview && !url.searchParams.has("version")) {
        holdOverview = false;
        freshOverview.signal();
        await releaseOverview.promise;
        await route.continue();
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/timelines/${id}/items?**`, async (route) => {
      if (holdDetail && route.request().method() === "GET") {
        holdDetail = false;
        activeDetail.signal();
        await releaseDetail.promise;
      }
      await route.continue();
    });

    await page
      .getByRole("button", { name: "Add moments", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add moments" });
    await dialog
      .getByRole("checkbox", { name: "Select A quiet afternoon.png" })
      .check();
    await dialog
      .getByRole("checkbox", { name: "Select Mountain air.png" })
      .check();
    const add = dialog.getByRole("button", {
      name: /Add selected moments|Adding moments…/,
    });
    await add.click();
    const firstRead = await Promise.race([
      tail.started.then(() => "tail"),
      freshOverview.started.then(() => "full refresh"),
    ]);
    expect(firstRead).toBe("tail");
    await expect(
      dialog.getByRole("checkbox", { name: "Select A quiet afternoon.png" }),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Select Mountain air.png" }),
    ).toBeChecked();
    await expect(add).toBeDisabled();
    expect(appendPosts).toEqual([ids[1]]);
    releaseTail.release();

    await freshOverview.started;
    await expect(add).toBeDisabled();
    releaseOverview.release();
    await activeDetail.started;
    await expect(add).toBeDisabled();
    releaseDetail.release();
    await expect(add).toBeEnabled();
    await expect(caption).toHaveValue(`Draft survives ${failure}`);

    await add.click();
    await expect(dialog).toHaveCount(0);
    expect(appendPosts).toEqual([ids[1], ids[2]]);
    const stored = await (
      await context.request.get(`/api/timelines/${id}`)
    ).json();
    expect(stored.timeline.items).toHaveLength(4);
    expect(
      stored.timeline.items.filter(
        (item: { asset_id: string }) => item.asset_id === ids[1],
      ),
    ).toHaveLength(1);
    expect(
      stored.timeline.items.filter(
        (item: { asset_id: string }) => item.asset_id === ids[2],
      ),
    ).toHaveLength(1);
    expect(stored.timeline.items[0].caption).toBe("Moment 1");
    await expect(caption).toHaveValue(`Draft survives ${failure}`);
    await page.unroute(`**/api/timelines/${id}/overview?**`);
    await page.unroute(`**/api/timelines/${id}/items?**`);
  }
});

test("a held timeline conflict cannot update the editor after logout starts", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id, itemIds } = seedTimeline(owner, ids, 1);
  await page.addInitScript(
    ({ timelineId, itemId }) => {
      const nativeFetch = window.fetch.bind(window);
      const settled: string[] = [];
      Object.defineProperty(window, "__timelineMutationSettled", {
        value: settled,
      });
      window.fetch = (input, init) => {
        const url =
          typeof input === "string"
            ? new URL(input, location.href)
            : input instanceof URL
              ? input
              : new URL(input.url, location.href);
        if (
          url.pathname === `/api/timelines/${timelineId}/items/${itemId}` &&
          init?.method === "PATCH"
        ) {
          const options = { ...init };
          delete options.signal;
          return nativeFetch(input, options).then(async (response) => {
            await response.clone().arrayBuffer();
            settled.push(url.href);
            return response;
          });
        }
        return nativeFetch(input, init);
      };
    },
    { timelineId: id, itemId: itemIds[0] },
  );
  const conflictResponse = deferredSignal();
  const conflictRequestFinished = deferredSignal();
  const logout = deferredSignal();
  const logoutFinished = deferredSignal();
  await page.route(
    `**/api/timelines/${id}/items/${itemIds[0]}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      conflictResponse.signal();
      await conflictResponse.promise;
      await route.fulfill({ response }).catch(() => undefined);
      conflictRequestFinished.signal();
    },
  );
  await page.route("**/auth/logout", async (route) => {
    logout.signal();
    await logout.promise;
    await route.fulfill({ status: 500, body: "logout failed" });
    logoutFinished.signal();
  });
  await page.goto(`/timelines/${id}`);
  const moment = page.getByRole("group", { name: "Moment 1", exact: true });
  const caption = moment.getByRole("textbox", { name: "Caption" });
  await caption.fill("Keep draft while sign out is pending");
  const changed = await context.request.patch(`/api/timelines/${id}`, {
    headers: { Origin: e2eOrigin },
    data: { expected_version: 1, title: "Another window changed this" },
  });
  expect(changed.ok()).toBe(true);
  await moment.getByRole("button", { name: "Save moment" }).click();
  await conflictResponse.started;

  try {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout.started;
    conflictResponse.release();
    await conflictRequestFinished.started;
    await expect
      .poll(() =>
        page.evaluate(
          (timelineId) =>
            (
              window as unknown as {
                __timelineMutationSettled?: string[];
              }
            ).__timelineMutationSettled?.some((url) =>
              url.includes(`/api/timelines/${timelineId}/items/`),
            ) ?? false,
          id,
        ),
      )
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
  } finally {
    conflictResponse.release();
    logout.release();
    await logoutFinished.started;
  }
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Sign out could not be completed" }),
  ).toBeVisible();
});

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

test("failed detail window reads show a retry instead of remaining in a loading state", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids);
  let fail = true;
  await page.route(`**/api/timelines/${id}/items?**`, async (route) => {
    if (fail) return route.abort("failed");
    await route.continue();
  });
  await page.goto(`/timelines/${id}`);
  await expect(
    page.getByRole("button", { name: "Retry moments" }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry moments" }).click();
  await expect(
    page.getByRole("img", { name: "Coastal light.png" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry moments" })).toHaveCount(
    0,
  );
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
