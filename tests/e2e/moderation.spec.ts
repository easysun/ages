import { expect, test } from "@playwright/test";
import {
  e2eOrigin,
  executeFixtureSql,
  seedLibrary,
  seedTimeline,
} from "./fixtures";

async function operator(context: Parameters<typeof seedLibrary>[0], count = 1) {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids);
  executeFixtureSql(
    `UPDATE users SET plan='admin' WHERE id='${owner}'; UPDATE timelines SET visibility='unlisted' WHERE id='${id}';`,
  );
  for (let i = 0; i < count; i++) {
    executeFixtureSql(
      `INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at,observed_timeline_version) VALUES('rp_${owner}_${i}','${owner}','timeline','${id}','abuse','Review ${i} <script>literal</script>','${new Date(Date.now() + i).toISOString()}',1);`,
    );
  }
  return { owner, id, ids };
}

test("administrator queue paginates and retries without losing reports", async ({
  page,
  context,
}) => {
  await operator(context, 21);
  await page.goto("/admin/reports");
  await expect(
    page.getByRole("heading", { name: "Content reports" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Moderation", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  let fail = true;
  await page.route("**/api/admin/reports?*", async (route) => {
    if (route.request().url().includes("cursor=") && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "SERVICE_UNAVAILABLE", message: "Queue unavailable." },
        },
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Load older reports" }).click();
  await expect(page.getByRole("alert")).toContainText("Queue unavailable");
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  await page.getByRole("button", { name: "Load older reports" }).click();
  await expect
    .poll(() => page.getByTestId("report-event").count())
    .toBeGreaterThanOrEqual(21);
  await page.getByRole("button", { name: "Refresh reports" }).click();
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  await expect(
    page.getByText(/<script>literal<\/script>/).first(),
  ).toBeVisible();
});

test("empty queue and ordinary or anonymous accounts cannot review reports", async ({
  page,
  context,
}) => {
  const { owner } = await operator(context, 0);
  // Other browser fixtures may have reports; the empty response only isolates this UI state.
  await page.route("**/api/admin/reports?*", (route) =>
    route.fulfill({ json: { reports: [], next_cursor: null } }),
  );
  await page.goto("/admin/reports");
  await expect(page.getByText("No reports yet.")).toBeVisible();
  executeFixtureSql(`UPDATE users SET plan='free' WHERE id='${owner}';`);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Access denied" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Moderation", exact: true }),
  ).toHaveCount(0);
  await context.clearCookies();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.getByTestId("report-event")).toHaveCount(0);
});

test("reasoned block and unblock persist without changing reports or quota", async ({
  page,
  context,
}) => {
  const { id } = await operator(context);
  await page.goto("/admin/reports");
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  const reason = page.getByLabel("Moderation reason");
  const block = page.getByRole("button", {
    name: "Block content",
    exact: true,
  });
  await expect(block).toBeDisabled();
  await reason.fill("  ");
  await expect(block).toBeDisabled();
  await reason.fill("Policy review of reported content");
  const before = await (await page.request.get("/api/me")).json();
  const reports = await (
    await page.request.get("/api/admin/reports?limit=20")
  ).json();
  await block.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Current state: Blocked", { exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`/t/${id}`)).status()).toBe(404);
  await page.reload();
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Blocked", { exact: true }),
  ).toBeVisible();
  await reason.fill("Review complete; restore eligible visibility");
  await page
    .getByRole("button", { name: "Unblock content", exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`/t/${id}`)).status()).toBe(200);
  expect((await (await page.request.get("/api/me")).json()).quota).toEqual(
    before.quota,
  );
  expect(
    (await (await page.request.get("/api/admin/reports?limit=20")).json())
      .reports,
  ).toEqual(reports.reports);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/moderation-${test.info().project.name}.png`,
    fullPage: false,
  });
});

test("failed mutation keeps the reason and denied access clears the queue", async ({
  page,
  context,
}) => {
  const { id, owner } = await operator(context);
  await page.goto("/admin/reports");
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Moderation reason")
    .fill("Keep this draft after failure");
  await page.route("**/api/admin/content", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "SERVICE_UNAVAILABLE", message: "Write unavailable." },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Block content", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Write unavailable");
  await expect(page.getByLabel("Moderation reason")).toHaveValue(
    "Keep this draft after failure",
  );
  await page.unroute("**/api/admin/content");
  executeFixtureSql(`UPDATE users SET plan='free' WHERE id='${owner}';`);
  await page
    .getByRole("button", { name: "Block content", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Access denied" }),
  ).toBeVisible();
  await expect(page.getByTestId("report-event")).toHaveCount(0);
  await expect(page.getByLabel("Moderation reason")).toHaveCount(0);
});

test("a delayed older page cannot restore rows after refresh or logout", async ({
  page,
  context,
}) => {
  await operator(context, 21);
  await page.goto("/admin/reports");
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/admin/reports?*", async (route) => {
    if (!route.request().url().includes("cursor=")) return route.continue();
    const result = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response: result });
  });
  await page.getByRole("button", { name: "Load older reports" }).click();
  await hit;
  await page.getByRole("button", { name: "Refresh reports" }).click();
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  const done = page.waitForResponse((response) =>
    response.url().includes("cursor="),
  );
  release();
  await done;
  await expect(page.getByTestId("report-event")).toHaveCount(20);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.getByTestId("report-event")).toHaveCount(0);
});

test("switching target ignores a late state read and clears its draft", async ({
  page,
  context,
}) => {
  const { owner, id } = await operator(context);
  const { id: other } = seedTimeline(owner, [], 0);
  executeFixtureSql(
    `INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES('rp_other_${owner}','${owner}','timeline','${other}','spam','Other target','${new Date().toISOString()}');`,
  );
  await page.goto("/admin/reports");
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/admin/content?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("id") !== id)
      return route.continue();
    const result = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response: result });
  });
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await hit;
  await page
    .getByRole("button", { name: `Review timeline ${other}`, exact: true })
    .click();
  await expect(page.getByTestId("selected-target")).toHaveText(
    `timeline ${other}`,
  );
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Moderation reason")
    .fill("A draft for the second target");
  const done = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("id") === id,
  );
  release();
  await done;
  await expect(page.getByTestId("selected-target")).toHaveText(
    `timeline ${other}`,
  );
  await expect(page.getByLabel("Moderation reason")).toHaveValue(
    "A draft for the second target",
  );
  await page.unroute("**/api/admin/content?*");
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(page.getByLabel("Moderation reason")).toHaveValue("");
});

test("confirmed mutation survives refresh failure and duplicate submission is prevented", async ({
  page,
  context,
}) => {
  const { id } = await operator(context);
  await page.goto("/admin/reports");
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Moderation reason").fill("x".repeat(501));
  await expect(page.getByLabel("Moderation reason")).toHaveValue(
    "x".repeat(500),
  );
  await page.route("**/api/admin/content?*", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "State refresh unavailable.",
        },
      },
    }),
  );
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/admin/content", async (route) => {
    const result = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response: result });
  });
  await page
    .getByRole("button", { name: "Block content", exact: true })
    .click();
  await hit;
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "Content blocked." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "State refresh unavailable",
  );
  await page
    .getByLabel("Moderation reason")
    .fill("Still cannot write without fresh state");
  await expect(
    page.getByRole("button", { name: "Block content", exact: true }),
  ).toBeDisabled();
  await page.unroute("**/api/admin/content?*");
  await page.getByRole("button", { name: "Retry content state" }).click();
  await expect(
    page.getByText("Current state: Blocked", { exact: true }),
  ).toBeVisible();
});

test("a late successful moderation response cannot repopulate a logged-out screen", async ({
  page,
  context,
}) => {
  const { id } = await operator(context);
  await page.goto("/admin/reports");
  await page
    .getByRole("button", { name: `Review timeline ${id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Moderation reason")
    .fill("Explicit moderation before sign-out");
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/admin/content", async (route) => {
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Block content", exact: true })
    .click();
  await hit;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  const done = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/content"),
  );
  release();
  await done;
  await expect(page.getByTestId("report-event")).toHaveCount(0);
  await expect(page.getByTestId("selected-target")).toHaveCount(0);
});

test("pending report data cannot render after logout", async ({
  page,
  context,
}) => {
  await operator(context);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/admin/reports?*", async (route) => {
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto("/admin/reports");
  await hit;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  const done = page.waitForResponse((response) =>
    response.url().includes("/api/admin/reports?"),
  );
  release();
  await done;
  await expect(page.getByTestId("report-event")).toHaveCount(0);
});

test("a reported Asset Link and its related Asset have separate moderation controls", async ({
  page,
  context,
}) => {
  const { ids } = await operator(context, 0);
  const response = await page.request.post("/api/links", {
    headers: { Origin: e2eOrigin },
    data: { target: { kind: "asset", asset_id: ids[0] } },
  });
  expect(response.status()).toBe(201);
  const { link } = await response.json();
  expect(
    (
      await page.request.post("/api/reports", {
        headers: { Origin: e2eOrigin },
        data: {
          target: { kind: "link", slug: link.slug },
          category: "abuse",
          detail: "Review Link and Asset separately",
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/admin/reports");
  await page
    .getByRole("button", { name: `Review link ${link.id}`, exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Moderation reason").fill("A Link-specific draft");
  await page
    .getByRole("button", {
      name: `Review related asset ${ids[0]}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("selected-target")).toHaveText(
    `asset ${ids[0]}`,
  );
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Moderation reason")).toHaveValue("");
  await page.getByLabel("Moderation reason").fill("Block the reported Asset");
  await page
    .getByRole("button", { name: "Block content", exact: true })
    .click();
  await expect(
    page.getByText("Current state: Blocked", { exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`/s/${link.slug}`)).status()).toBe(404);
  await page
    .getByLabel("Moderation reason")
    .fill("Restore eligible Asset delivery");
  await page
    .getByRole("button", { name: "Unblock content", exact: true })
    .click();
  await expect(
    page.getByText("Current state: Unblocked", { exact: true }),
  ).toBeVisible();
  const media = await page.request.get(`/s/${link.slug}`);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toBe("image/png");
  expect((await media.body()).byteLength).toBeGreaterThan(100);
});

for (const source of ["target", "queue"] as const) {
  test(`a stale ${source} authorization failure clears newer data`, async ({
    page,
    context,
  }) => {
    const { owner, id } = await operator(context, 21);
    const { id: other } = seedTimeline(owner, [], 0);
    executeFixtureSql(
      `INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at) VALUES('rp_denied_${owner}','${owner}','timeline','${other}','spam','Delayed authorization fixture','${new Date().toISOString()}');`,
    );
    await page.goto("/admin/reports");
    await expect(page.getByTestId("report-event")).toHaveCount(20);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hit = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pattern =
      source === "target" ? "**/api/admin/content?*" : "**/api/admin/reports?*";
    await page.route(pattern, async (route) => {
      const url = new URL(route.request().url());
      const held =
        source === "target"
          ? url.searchParams.get("id") === id
          : url.searchParams.has("cursor");
      if (!held) return route.continue();
      started();
      await pending;
      await route.fulfill({
        status: 403,
        json: { error: { code: "FORBIDDEN", message: "Access revoked." } },
      });
    });
    if (source === "target") {
      await page
        .getByRole("button", { name: `Review timeline ${id}`, exact: true })
        .first()
        .click();
      await hit;
      await page
        .getByRole("button", { name: `Review timeline ${other}`, exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Load older reports" }).click();
      await hit;
      const refreshed = page.waitForResponse(
        (response) =>
          response.url().includes("/api/admin/reports?") &&
          !response.url().includes("cursor="),
      );
      await page.getByRole("button", { name: "Refresh reports" }).click();
      await refreshed;
      await page
        .getByRole("button", { name: `Review timeline ${other}`, exact: true })
        .click();
    }
    await expect(
      page.getByText("Current state: Unblocked", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Moderation reason").fill("A newer sensitive draft");
    release();
    await expect(
      page.getByRole("heading", { name: "Access denied" }),
    ).toBeVisible();
    await expect(page.getByTestId("report-event")).toHaveCount(0);
    await expect(page.getByLabel("Moderation reason")).toHaveCount(0);
  });
}
