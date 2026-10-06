import { expect, type Page, test } from "@playwright/test";
import {
  e2eOrigin,
  executeFixtureSql,
  seedLibrary,
  seedProviderLink,
  seedTimeline,
} from "./fixtures";

async function visibleTimeline(context: Parameters<typeof seedLibrary>[0]) {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1, "Public report story");
  executeFixtureSql(
    `UPDATE timelines SET visibility='public' WHERE id='${id}';`,
  );
  return { owner, id };
}

async function selectCategory(page: Page, category = "spam") {
  await page.getByLabel("Category", { exact: true }).selectOption(category);
}

test("timeline footer opens the report form and shows a neutral receipt", async ({
  page,
  context,
}) => {
  const { id } = await visibleTimeline(context);
  let reportPosts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/reports") && request.method() === "POST")
      reportPosts++;
  });
  await page.goto(`/t/${id}`);
  await page.screenshot({
    path: `test-results/reporting-timeline-footer-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Report this Timeline" }).click();
  await expect(page).toHaveURL(
    `${e2eOrigin}/report?kind=timeline&timeline_id=${id}`,
  );
  await expect(
    page.getByText(`Timeline: ${id}`, { exact: true }),
  ).toBeVisible();
  const category = page.getByLabel("Category", { exact: true });
  await expect(category.locator("option")).toHaveText([
    "Choose a category",
    "Spam",
    "Abuse",
    "Copyright",
    "Illegal content",
    "Other",
  ]);
  await selectCategory(page, "copyright");
  const detail = page.getByLabel("Report details (optional)", { exact: true });
  await expect(detail).toHaveAttribute("maxlength", "1000");
  await detail.fill("x".repeat(1001));
  await expect(detail).toHaveValue("x".repeat(1000));
  await detail.fill("A short explanation for the reviewer.");
  await expect(page).not.toHaveURL(/detail|category/);
  const first = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit report" }).click();
  expect((await first).status()).toBe(201);
  await expect(page.getByRole("status")).toHaveText(
    "Thank you. Your report has been received.",
  );
  expect(reportPosts).toBe(1);
  await page.reload();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("Report details (optional)", { exact: true }),
  ).toHaveValue("");
  expect(reportPosts).toBe(1);
  await selectCategory(page, "copyright");
  await page
    .getByLabel("Report details (optional)", { exact: true })
    .fill("A short explanation for the reviewer.");
  const duplicate = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit report" }).click();
  expect((await duplicate).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText(
    "Thank you. Your report has been received.",
  );
  expect(reportPosts).toBe(2);
});

test("anonymous visitors carry only the target through sign-in", async ({
  page,
  context,
}) => {
  const { owner, id } = await visibleTimeline(context);
  const { slug } = seedProviderLink(owner);
  await context.clearCookies();
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Report an Ages Link", exact: true }),
  ).toHaveAttribute("href", "/report");
  for (const targetUrl of [
    `/report?kind=timeline&timeline_id=${id}`,
    `/report?kind=link&slug=${slug}`,
  ]) {
    await page.goto(targetUrl);
    const link = page.getByRole("link", {
      name: "Continue with Google",
      exact: true,
    });
    await expect(link).toBeVisible();
    const destination = new URL(
      (await link.getAttribute("href")) as string,
      e2eOrigin,
    );
    expect(destination.pathname).toBe("/auth/google");
    expect([...destination.searchParams.entries()]).toEqual(
      targetUrl.includes("timeline_id")
        ? [
            ["report_kind", "timeline"],
            ["report_value", id],
          ]
        : [
            ["report_kind", "link"],
            ["report_value", slug],
          ],
    );
    await expect(page.getByLabel("Category", { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel("Report details (optional)", { exact: true }),
    ).toHaveCount(0);
  }
});

test("the Link companion accepts only same-origin short URLs or slugs", async ({
  page,
}) => {
  let reportPosts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/reports") && request.method() === "POST")
      reportPosts++;
  });
  const slug = "story-link-123";
  for (const value of [
    `${e2eOrigin}/s/${slug}?campaign=one&campaign=two#part`,
    `/s/${slug}?campaign=one&campaign=two#part`,
    slug,
  ]) {
    await page.goto("/report");
    await page.getByLabel("Ages Link URL or slug", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Use this Link" }).click();
    await expect(
      page.getByLabel("Ages Link URL or slug", { exact: true }),
    ).toHaveValue("");
    await expect(page).toHaveURL(`${e2eOrigin}/report?kind=link&slug=${slug}`);
    await expect(
      page.getByText(`Ages Link: ${slug}`, { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText(`Ages Link: ${slug}`, { exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: `test-results/reporting-link-companion-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.goto("/report");
  const input = page.getByLabel("Ages Link URL or slug", { exact: true });
  const port = new URL(e2eOrigin).port;
  for (const value of [
    `https://outside.example/s/${slug}`,
    `${e2eOrigin}/elsewhere/${slug}`,
    `//127.0.0.1:${port}/s/${slug}`,
    `http://user:pass@127.0.0.1:${port}/s/${slug}`,
    "UPPERCASE",
    "ab",
  ]) {
    await input.fill(value);
    await page.getByRole("button", { name: "Use this Link" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(`${e2eOrigin}/report`);
  }
  for (const invalid of [
    `/report?kind=link&slug=${slug}&slug=another-link`,
    `/report?kind=link&slug=${slug}&extra=value`,
    `/report?kind=timeline&timeline_id=story&slug=${slug}`,
  ]) {
    await page.goto(invalid);
    await expect(page.getByRole("alert")).toBeVisible();
  }
  expect(reportPosts).toBe(0);
});

test("unavailable targets show no visibility or content details", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1, "Private story headline");
  let timelineReads = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/t/${id}`) && request.method() === "GET")
      timelineReads++;
  });
  await page.goto(`/report?kind=timeline&timeline_id=${id}`);
  await selectCategory(page, "abuse");
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit report" }).click();
  expect((await submitted).status()).toBe(404);
  await expect(page.getByRole("alert")).toHaveText(
    "This share is unavailable.",
  );
  await expect(
    page.getByText("Private story headline", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Coastal light.png", { exact: true }),
  ).toHaveCount(0);
  expect(timelineReads).toBe(0);
});

test("401 clears report text while retryable failures keep it", async ({
  page,
  context,
}) => {
  const { id } = await visibleTimeline(context);
  let status = 401;
  let reportPosts = 0;
  await page.route("**/api/reports", async (route) => {
    reportPosts++;
    if (status === 0) return route.abort("failed");
    const code =
      status === 401
        ? "UNAUTHENTICATED"
        : status === 403
          ? "FORBIDDEN"
          : status === 429
            ? "RATE_LIMITED"
            : "SERVICE_UNAVAILABLE";
    await route.fulfill({
      status,
      json: { error: { code, message: "Please try again." } },
    });
  });
  for (const failure of [401, 403, 429, 503, 0]) {
    status = failure;
    await page.goto(`/report?kind=timeline&timeline_id=${id}`);
    await selectCategory(page);
    await page
      .getByLabel("Report details (optional)", { exact: true })
      .fill("Sensitive draft");
    await page.getByRole("button", { name: "Submit report" }).click();
    if (failure === 401 || failure === 403) {
      await expect(
        page.getByRole("link", { name: "Continue with Google", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Category", { exact: true })).toHaveCount(0);
      await expect(
        page.getByLabel("Report details (optional)", { exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(
        `${e2eOrigin}/report?kind=timeline&timeline_id=${id}`,
      );
    } else {
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByLabel("Category", { exact: true })).toHaveValue(
        "spam",
      );
      await expect(
        page.getByLabel("Report details (optional)", { exact: true }),
      ).toHaveValue("Sensitive draft");
    }
    const requestsAtResponse = reportPosts;
    await page.waitForTimeout(250);
    expect(reportPosts).toBe(requestsAtResponse);
  }
});

function responseGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("target switches, logout and stale authorization cannot restore report details", async ({
  page,
  context,
}) => {
  const { owner, id } = await visibleTimeline(context);
  const { slug } = seedProviderLink(owner);
  let status = 200;
  let gate = responseGate();
  let started = responseGate();
  await page.route("**/api/reports", async (route) => {
    const requestGate = gate;
    const requestStarted = started;
    const requestStatus = status;
    requestStarted.release();
    await requestGate.promise;
    const body =
      requestStatus === 200
        ? { report: { id: "rp_delayed", status: "received" } }
        : {
            error: {
              code: requestStatus === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
              message: "Please sign in again.",
            },
          };
    await route.fulfill({ status: requestStatus, json: body });
  });

  await page.goto(`/report?kind=timeline&timeline_id=${id}`);
  await selectCategory(page);
  await page
    .getByLabel("Report details (optional)", { exact: true })
    .fill("Old target draft");
  await page.getByRole("button", { name: "Submit report" }).click();
  await started.promise;
  await page.getByLabel("Ages Link URL or slug", { exact: true }).fill(slug);
  await page.getByRole("button", { name: "Use this Link" }).click();
  await expect(page).toHaveURL(`${e2eOrigin}/report?kind=link&slug=${slug}`);
  await expect(
    page.getByLabel("Report details (optional)", { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel("Report details (optional)", { exact: true })
    .fill("Current target draft");
  const delayedSuccess = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  gate.release();
  expect((await delayedSuccess).status()).toBe(200);
  await expect(
    page.getByLabel("Report details (optional)", { exact: true }),
  ).toHaveValue("Current target draft");
  await expect(
    page.getByText("Thank you. Your report has been received.", {
      exact: true,
    }),
  ).toHaveCount(0);

  for (const authorizationStatus of [401, 403]) {
    status = authorizationStatus;
    gate = responseGate();
    started = responseGate();
    await page.goto(`/report?kind=timeline&timeline_id=${id}`);
    await selectCategory(page);
    await page
      .getByLabel("Report details (optional)", { exact: true })
      .fill("Old authorized draft");
    await page.getByRole("button", { name: "Submit report" }).click();
    await started.promise;
    await page.getByLabel("Ages Link URL or slug", { exact: true }).fill(slug);
    await page.getByRole("button", { name: "Use this Link" }).click();
    await expect(page).toHaveURL(`${e2eOrigin}/report?kind=link&slug=${slug}`);
    await page
      .getByLabel("Report details (optional)", { exact: true })
      .fill("New sensitive draft");
    const delayedAuthorization = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/reports") && r.request().method() === "POST",
    );
    gate.release();
    expect((await delayedAuthorization).status()).toBe(authorizationStatus);
    await expect(
      page.getByRole("link", { name: "Continue with Google", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Report details (optional)", { exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(`${e2eOrigin}/report?kind=link&slug=${slug}`);
  }

  status = 200;
  gate = responseGate();
  started = responseGate();
  await page.goto(`/report?kind=timeline&timeline_id=${id}`);
  await selectCategory(page);
  await page
    .getByLabel("Report details (optional)", { exact: true })
    .fill("Clear on sign out");
  await page.getByRole("button", { name: "Submit report" }).click();
  await started.promise;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google", exact: true }),
  ).toBeVisible();
  const lateLogoutResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  gate.release();
  expect((await lateLogoutResponse).status()).toBe(200);
  await expect(
    page.getByLabel("Report details (optional)", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Thank you. Your report has been received.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("keyboard submission and refresh do not leak or repeat details", async ({
  page,
  context,
}) => {
  const { id } = await visibleTimeline(context);
  let reportPosts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/reports") && request.method() === "POST")
      reportPosts++;
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/report?kind=timeline&timeline_id=${id}`);
  const category = page.getByLabel("Category", { exact: true });
  await category.focus();
  await expect(category).toBeFocused();
  await page.keyboard.press("s");
  await expect(category).toHaveValue("spam");
  const detail = page.getByLabel("Report details (optional)", { exact: true });
  await detail.focus();
  await page.keyboard.type("Keyboard only detail");
  await page.getByRole("button", { name: "Submit report" }).focus();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/reports") && r.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("status")).toHaveText(
    "Thank you. Your report has been received.",
  );
  expect(reportPosts).toBe(1);
  await page.reload();
  await expect(
    page.getByLabel("Report details (optional)", { exact: true }),
  ).toHaveValue("");
  expect(reportPosts).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
