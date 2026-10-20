import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { contentEdgePageFixture } from "../helpers/content-edge-pages";
import { e2eOrigin, executeFixtureSql, seedLibrary } from "./fixtures";

type Visibility = "private" | "unlisted" | "public";
type Edge = { id: string; type: string };
type OwnerEdgePage = {
  edges: {
    id: string;
    source: { id: string; title: string | null };
    target: { id: string; title: string | null };
  }[];
  next_cursor: string | null;
};

async function ownerCookie(context: BrowserContext) {
  const cookie = (await context.cookies(e2eOrigin)).find(
    (entry) => entry.name === "ages_session",
  );
  if (!cookie) throw new Error("Expected the synthetic owner session cookie");
  return cookie;
}

async function ownerHeaders(context: BrowserContext) {
  const cookie = await ownerCookie(context);
  return {
    Cookie: `ages_session=${cookie.value}`,
    Origin: e2eOrigin,
  };
}

async function createExternal(
  context: BrowserContext,
  title: string,
  visibility: Visibility,
) {
  const response = await context.request.post(
    `${e2eOrigin}/api/content-nodes`,
    {
      headers: await ownerHeaders(context),
      data: {
        kind: "external",
        url: `https://example.test/${encodeURIComponent(title)}`,
        title,
        visibility,
      },
    },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).node as { id: string; title: string };
}

async function createEdge(
  context: BrowserContext,
  sourceId: string,
  targetId: string,
  type: "related_to" | "references" | "continuation" = "references",
) {
  const response = await context.request.post(
    `${e2eOrigin}/api/content-edges`,
    {
      headers: await ownerHeaders(context),
      data: { source_id: sourceId, target_id: targetId, type },
    },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).edge as Edge;
}

async function readOwnerEdgePage(
  context: BrowserContext,
  nodeId: string,
  direction: "incoming" | "outgoing" | "incoming-review",
  cursor?: string,
) {
  const path =
    direction === "incoming-review"
      ? `/api/content-nodes/${encodeURIComponent(nodeId)}/incoming-review`
      : `/api/content-nodes/${encodeURIComponent(nodeId)}/edges`;
  const url = new URL(path, e2eOrigin);
  url.searchParams.set("limit", "30");
  if (direction !== "incoming-review")
    url.searchParams.set("direction", direction);
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await context.request.get(url.href, {
    headers: await ownerHeaders(context),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as OwnerEdgePage;
}

async function edgeAction(
  context: BrowserContext,
  edgeId: string,
  action: "accept" | "suppress" | "unsuppress" | "block" | "unblock",
) {
  const response = await context.request.patch(
    `${e2eOrigin}/api/content-edges/${edgeId}`,
    { headers: await ownerHeaders(context), data: { action } },
  );
  expect(response.status()).toBe(200);
  return response;
}

async function reportEdge(context: BrowserContext, edgeId: string) {
  const response = await context.request.post(
    `${e2eOrigin}/api/content-edges/${edgeId}/reports`,
    {
      headers: await ownerHeaders(context),
      data: { category: "abuse", detail: "Review this synthetic relation." },
    },
  );
  expect(response.status()).toBe(201);
}

async function moderateEdge(
  context: BrowserContext,
  edgeId: string,
  blocked: boolean,
) {
  const response = await context.request.patch(
    `${e2eOrigin}/api/admin/content-edges/${edgeId}`,
    {
      headers: await ownerHeaders(context),
      data: { blocked, reason: "Synthetic review state." },
    },
  );
  expect(response.status()).toBe(200);
}

async function moderateNode(
  context: BrowserContext,
  nodeId: string,
  blocked: boolean,
) {
  const response = await context.request.patch(
    `${e2eOrigin}/api/admin/content-nodes/${nodeId}`,
    {
      headers: await ownerHeaders(context),
      data: { blocked, reason: "Synthetic node review state." },
    },
  );
  expect(response.status()).toBe(200);
}

async function makeOwner(browser: Browser) {
  const context = await browser.newContext();
  const { owner } = await seedLibrary(context);
  return { context, owner };
}

function artifactPath(name: string, project: string) {
  const directory = resolve(
    ".superpowers/sdd/2026-10-05-content-edges/task-2-artifacts",
  );
  mkdirSync(directory, { recursive: true });
  return join(directory, `${name}-${project}.png`);
}

async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
}

function deferredSignal() {
  let release!: () => void;
  let signal!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      signal = resolve;
    }),
    release: () => release(),
    signal: () => signal(),
  };
}

test("public_relation_appears_as_a_backlink_from_a_typed_owner_edge", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(context, "Public target story", "public");
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Public source story",
    "public",
  );
  const sourcePage = await sourceContext.newPage();
  await sourcePage.goto(`${e2eOrigin}/content`);
  const sourceChoice = sourcePage.getByRole("button", {
    name: `Edit ${source.title}`,
  });
  await expect(sourceChoice).toBeVisible();
  await sourceChoice.focus();
  await sourcePage.keyboard.press("Enter");
  await sourcePage
    .getByLabel("Target reference URL or ID")
    .fill(`${e2eOrigin}/c/${target.id}`);
  await sourcePage.getByLabel("Relationship type").selectOption("continuation");
  await sourcePage.getByRole("button", { name: "Add relationship" }).click();
  const outgoing = sourcePage.getByRole("region", {
    name: "Outgoing relationships",
  });
  await expect(
    outgoing.getByText("continuation", { exact: true }),
  ).toBeVisible();
  await expect(
    outgoing.getByText("Public target story", { exact: true }),
  ).toBeVisible();

  const targetCookie = await ownerCookie(context);
  await context.clearCookies();
  const publicPage = await page.goto(`${e2eOrigin}/c/${target.id}`);
  expect(publicPage?.status()).toBe(200);
  expect(publicPage?.headers()["cache-control"]).toContain("no-store");
  await expect(
    page.getByRole("link", { name: "Public source story" }),
  ).toHaveAttribute("href", `/c/${source.id}`);
  await expect(page.locator("body")).toContainText("added by source owner");
  await expect(page.locator("body")).not.toContainText("@example.test");
  await page.screenshot({
    path: artifactPath("public-backlink", test.info().project.name),
    fullPage: true,
  });

  await context.addCookies([targetCookie]);
  await page.goto(`${e2eOrigin}/content`);
  const targetChoice = page.getByRole("button", {
    name: `Edit ${target.title}`,
  });
  await expect(targetChoice).toBeVisible();
  await targetChoice.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: target.title })).toBeVisible();
  const incoming = page.getByRole("region", {
    name: "Incoming relationships",
  });
  const visibleIncoming = incoming.getByRole("list").first();
  await expect(
    visibleIncoming.getByText("Public source story", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    visibleIncoming.getByText("Public source story", { exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: artifactPath("owner-backlinks", test.info().project.name),
    fullPage: true,
  });
  await sourceContext.close();
});

test("pending_unlisted_relation_is_owner_review_only_and_controls_do_not_endorse", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(
    context,
    "Public review target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Unlisted private source title",
    "unlisted",
  );
  const edge = await createEdge(
    sourceContext,
    source.id,
    target.id,
    "references",
  );
  const targetCookie = await ownerCookie(context);

  await context.clearCookies();
  await page.goto(`${e2eOrigin}/c/${target.id}`);
  await expect(page.locator("body")).not.toContainText(source.title);
  await expect(page.locator("body")).not.toContainText(source.id);

  await context.addCookies([targetCookie]);
  await page.goto(`${e2eOrigin}/content`);
  const incoming = page.getByRole("region", { name: "Incoming relationships" });
  await expect(
    page.getByRole("button", { name: `Edit ${target.title}` }),
  ).toBeVisible();
  await expect(incoming.getByText(source.title, { exact: true })).toBeVisible();
  await expect(
    incoming.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText("added by source owner");
  await expect(
    page.getByRole("region", { name: "Content relationships" }),
  ).toContainText("does not mean the target owner endorses it");

  await incoming.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(
    incoming.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(incoming.getByText(source.title, { exact: true })).toBeVisible();
  await expect(incoming.getByText("Accepted", { exact: true })).toBeVisible();
  await edgeAction(context, edge.id, "accept");

  const reportToggle = incoming.getByRole("button", {
    name: "Report relationship",
    exact: true,
  });
  await reportToggle.click();
  await page.getByLabel("Report category").selectOption("abuse");
  await page.getByLabel("Report detail").fill("Review this incoming relation.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(
    page
      .getByRole("region", { name: "Content relationships" })
      .getByRole("status"),
  ).toContainText("Report received");

  await incoming.getByRole("button", { name: "Suppress relationship" }).click();
  await expect(incoming.getByText("Suppressed", { exact: true })).toBeVisible();
  await incoming.getByRole("button", { name: "Block relationship" }).click();
  await expect(
    incoming.getByText("Blocked by you", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(incoming.getByText("Suppressed", { exact: true })).toBeVisible();
  await expect(
    incoming.getByText("Blocked by you", { exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: artifactPath("owner-incoming-review", test.info().project.name),
    fullPage: true,
  });

  await context.clearCookies();
  await page.goto(`${e2eOrigin}/c/${target.id}`);
  await expect(page.locator("body")).not.toContainText(source.title);
  await expect(page.locator("body")).not.toContainText(source.id);
  await sourceContext.close();
});

test("authorization_failures_clear_private_relation_state_for_401_and_403_even_with_malformed_bodies", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(
    context,
    "Private review target",
    "public",
  );
  const draftTarget = await createExternal(
    context,
    "Relationship recovery draft target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Unlisted review source",
    "unlisted",
  );
  await createEdge(sourceContext, source.id, target.id);
  const pairSource = await createExternal(
    sourceContext,
    "Suppressed known pair source",
    "unlisted",
  );
  const pairEdge = await createEdge(sourceContext, pairSource.id, target.id);
  await edgeAction(context, pairEdge.id, "accept");
  await edgeAction(context, pairEdge.id, "suppress");
  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  await expect(page.getByRole("heading", { name: target.title })).toBeVisible();
  const targetInput = page.getByLabel("Target reference URL or ID");
  await targetInput.fill(draftTarget.id);
  await expect(
    page.getByRole("button", { name: "Add relationship" }),
  ).toBeEnabled();
  await expect(page.getByText(source.title, { exact: true })).toBeVisible();
  const incoming = page.getByRole("region", {
    name: "Incoming relationships",
  });
  const reviewList = incoming.getByRole("list").last();
  const pendingReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: source.title });
  const suppressedReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: "Suppressed" });
  await expect(suppressedReview).toBeVisible();

  const privateReportDraft =
    "Keep this private report draft only while authorized.";
  await pendingReview
    .getByRole("button", { name: "Report relationship" })
    .click();
  await page.getByLabel("Report detail").fill(privateReportDraft);

  await suppressedReview
    .getByRole("button", { name: "Open known pair" })
    .click();
  await expect(
    page.getByRole("region", { name: "Known pair relationship" }),
  ).toContainText(pairSource.id);

  let nextStatus: number | null = null;
  let delayedResponse: {
    status: number | null;
    gate: ReturnType<typeof deferredSignal>;
  } | null = null;
  await page.route(
    `**/api/content-nodes/${target.id}/incoming-review*`,
    async (route) => {
      const status = nextStatus;
      nextStatus = null;
      if (delayedResponse && delayedResponse.status === status) {
        const pending = delayedResponse;
        delayedResponse = null;
        if (status === null) {
          const response = await route.fetch();
          pending.gate.signal();
          await pending.gate.promise;
          await route.fulfill({ response }).catch(() => undefined);
          return;
        }
        pending.gate.signal();
        await pending.gate.promise;
      }
      if (status === null) return route.continue();
      await route.fulfill({
        status,
        contentType: "application/json",
        body: "{",
      });
    },
  );

  const privacySnapshots: Array<{
    stage: string;
    knownPairIdVisible: boolean;
    reportDraftValue: string | null;
  }> = [];
  for (const status of [401, 403]) {
    if (status === 403) {
      const reportDetail = page.getByLabel("Report detail");
      if ((await reportDetail.count()) === 0) {
        await pendingReview
          .getByRole("button", { name: "Report relationship" })
          .click();
        await expect(reportDetail).toHaveValue("");
      }
      await page
        .getByLabel("Report detail")
        .fill("Private report draft after the first recovery.");
      const openKnownPair = suppressedReview.getByRole("button", {
        name: "Open known pair",
      });
      if ((await openKnownPair.count()) > 0) await openKnownPair.click();
      await expect(
        page.getByRole("region", { name: "Known pair relationship" }),
      ).toContainText(pairSource.id);
    }
    nextStatus = status;
    await page.getByRole("button", { name: "Refresh relationships" }).click();
    await expect(page.getByRole("alert")).toContainText(
      status === 401 ? "session has ended" : "Access to these relationships",
    );
    await expect(page.getByText(source.title, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Report detail")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Accept", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add relationship" }),
    ).toBeDisabled();
    privacySnapshots.push({
      stage: `HTTP ${status} access blocked`,
      knownPairIdVisible: (await page.locator("body").innerText()).includes(
        pairSource.id,
      ),
      reportDraftValue: null,
    });

    const failedRefresh = deferredSignal();
    nextStatus = status;
    delayedResponse = { status, gate: failedRefresh };
    await page
      .getByRole("button", { name: "Refresh relationship access" })
      .click();
    await failedRefresh.started;
    await expect(
      page.getByRole("button", { name: "Add relationship" }),
    ).toBeDisabled();
    failedRefresh.release();
    await expect(page.getByRole("alert")).toContainText(
      status === 401 ? "session has ended" : "Access to these relationships",
    );
    await expect(
      page.getByRole("button", { name: "Add relationship" }),
    ).toBeDisabled();

    const successfulRefresh = deferredSignal();
    delayedResponse = { status: null, gate: successfulRefresh };
    await page
      .getByRole("button", { name: "Refresh relationship access" })
      .click();
    await successfulRefresh.started;
    await expect(
      page.getByRole("button", { name: "Add relationship" }),
    ).toBeDisabled();
    successfulRefresh.release();
    await expect(page.getByText(source.title, { exact: true })).toBeVisible();
    await expect(targetInput).toHaveValue(draftTarget.id);
    await expect(
      page.getByRole("button", { name: "Accept", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add relationship" }),
    ).toBeEnabled();
    const recoveredReportDetail = page.getByLabel("Report detail");
    const recoveredReportCount = await recoveredReportDetail.count();
    privacySnapshots.push({
      stage: `HTTP ${status} access refreshed`,
      knownPairIdVisible: (await page.locator("body").innerText()).includes(
        pairSource.id,
      ),
      reportDraftValue:
        recoveredReportCount > 0
          ? await recoveredReportDetail.inputValue()
          : null,
    });
    if (status === 401) {
      const openKnownPair = suppressedReview.getByRole("button", {
        name: "Open known pair",
      });
      if ((await openKnownPair.count()) > 0) {
        await openKnownPair.click();
        await expect(
          page.getByRole("region", { name: "Known pair relationship" }),
        ).toContainText(pairSource.id);
      }
    }
  }

  expect(privacySnapshots).toEqual(
    [401, 403].flatMap((status) => [
      {
        stage: `HTTP ${status} access blocked`,
        knownPairIdVisible: false,
        reportDraftValue: null,
      },
      {
        stage: `HTTP ${status} access refreshed`,
        knownPairIdVisible: false,
        reportDraftValue: null,
      },
    ]),
  );

  await page.unrouteAll();
  await sourceContext.close();
});

test("known_pair_selection_is_disabled_during_relationship_refresh", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(context, "Refresh lock target", "public");
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Refresh lock unlisted source",
    "unlisted",
  );
  const edge = await createEdge(sourceContext, source.id, target.id);
  await edgeAction(context, edge.id, "accept");
  await edgeAction(context, edge.id, "suppress");

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  const incoming = page.getByRole("region", {
    name: "Incoming relationships",
  });
  const reviewList = incoming.getByRole("list").last();
  const suppressedReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: "Suppressed" });
  await expect(suppressedReview).toHaveCount(1);

  const outgoing = deferredSignal();
  const visibleIncoming = deferredSignal();
  const reviewRead = deferredSignal();
  await page.route(
    `**/api/content-nodes/${target.id}/edges?direction=outgoing*`,
    async (route) => {
      const response = await route.fetch();
      outgoing.signal();
      await outgoing.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.route(
    `**/api/content-nodes/${target.id}/edges?direction=incoming*`,
    async (route) => {
      const response = await route.fetch();
      visibleIncoming.signal();
      await visibleIncoming.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.route(
    `**/api/content-nodes/${target.id}/incoming-review*`,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response });
      reviewRead.signal();
    },
  );

  await page.getByRole("button", { name: "Refresh relationships" }).click();
  try {
    await Promise.all([
      outgoing.started,
      visibleIncoming.started,
      reviewRead.started,
    ]);
    await expect(suppressedReview).toBeVisible();
    await expect(
      suppressedReview.getByRole("button", { name: "Open known pair" }),
    ).toBeDisabled();
  } finally {
    outgoing.release();
    visibleIncoming.release();
  }

  await expect(
    page.getByRole("button", { name: "Refresh relationships" }),
  ).toBeEnabled();
  await suppressedReview
    .getByRole("button", { name: "Open known pair" })
    .click();
  await expect(
    page.getByRole("region", { name: "Known pair relationship" }),
  ).toContainText(source.id);
  await sourceContext.close();
});

test("late_relation_response_after_logout_or_auth_generation_change_is_discarded", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(context, "Logout target", "public");
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Delayed private source",
    "unlisted",
  );
  await createEdge(sourceContext, source.id, target.id);

  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    `**/api/content-nodes/${target.id}/incoming-review*`,
    async (route) => {
      const response = await route.fetch();
      started();
      await pending;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.goto(`${e2eOrigin}/content`);
  await hit;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(source.title);
  await sourceContext.close();
});

test("late_acceptance_after_node_switch_is_discarded", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(context, "Accept old target", "public");
  const next = await createExternal(context, "Accept current target", "public");
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Pending source",
    "unlisted",
  );
  await createEdge(sourceContext, source.id, target.id);

  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/content-edges/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await hit;
  await page.getByRole("button", { name: `Edit ${next.title}` }).click();
  await expect(page.getByRole("heading", { name: next.title })).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: next.title })).toBeVisible();
  const currentPanel = page.locator(".content-edges-panel");
  await expect(currentPanel).toBeVisible();
  await expect(currentPanel).not.toContainText("Relationship accepted.");
  await expect(page.getByLabel("Target reference URL or ID")).toBeEnabled();
  await expect(page.getByText(source.title, { exact: true })).toHaveCount(0);
  await sourceContext.close();
});

test("late_report_after_node_switch_is_discarded", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(context, "Report old target", "public");
  const next = await createExternal(context, "Report current target", "public");
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Public reported source",
    "public",
  );
  await createEdge(sourceContext, source.id, target.id);

  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/content-edges/*/reports", async (route) => {
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  await page
    .getByRole("button", { name: "Report relationship", exact: true })
    .click();
  await page.getByLabel("Report category").selectOption("abuse");
  await page
    .getByLabel("Report detail")
    .fill("Delayed report for the old target.");
  await page.getByRole("button", { name: "Send report" }).click();
  await hit;
  await page.getByRole("button", { name: `Edit ${next.title}` }).click();
  await expect(page.getByRole("heading", { name: next.title })).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: next.title })).toBeVisible();
  const currentPanel = page.locator(".content-edges-panel");
  await expect(currentPanel).toBeVisible();
  await expect(currentPanel).not.toContainText("Report received");
  await expect(page.getByLabel("Target reference URL or ID")).toBeEnabled();
  await expect(page.getByText(source.title, { exact: true })).toHaveCount(0);
  await sourceContext.close();
});

test("owners_can_create_consecutive_relationships_after_each_confirmed_write", async ({
  context,
  page,
}) => {
  await seedLibrary(context);
  const source = await createExternal(context, "Consecutive source", "public");
  const first = await createExternal(
    context,
    "First relationship target",
    "public",
  );
  const second = await createExternal(
    context,
    "Second relationship target",
    "public",
  );
  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  await expect(page.getByRole("heading", { name: source.title })).toBeVisible();
  const targetInput = page.getByLabel("Target reference URL or ID");
  const addButton = page.getByRole("button", { name: "Add relationship" });
  await targetInput.fill(first.id);
  await expect(targetInput).toHaveValue(first.id);
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.getByRole("status")).toContainText("Relationship added");
  await expect(targetInput).toBeEnabled();

  await targetInput.fill(`${e2eOrigin}/c/${second.id}`);
  await expect(targetInput).toHaveValue(`${e2eOrigin}/c/${second.id}`);
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.getByRole("status")).toContainText("Relationship added");
  const outgoing = page.getByRole("region", { name: "Outgoing relationships" });
  await expect(outgoing.locator(`a[href="/c/${first.id}"]`)).toBeVisible();
  await expect(outgoing.locator(`a[href="/c/${second.id}"]`)).toBeVisible();
});

test("refresh_is_disabled_during_a_write_and_an_old_node_completion_cannot_unlock_the_current_write", async ({
  context,
  page,
}) => {
  await seedLibrary(context);
  const oldSource = await createExternal(
    context,
    "Old writing source",
    "public",
  );
  const currentSource = await createExternal(
    context,
    "Current writing source",
    "public",
  );
  const oldTarget = await createExternal(
    context,
    "Old writing target",
    "public",
  );
  const currentTarget = await createExternal(
    context,
    "Current writing target",
    "public",
  );
  const retryTarget = await createExternal(
    context,
    "Retry writing target",
    "public",
  );
  const oldWrite = deferredSignal();
  const currentWrite = deferredSignal();
  await page.route("**/api/content-edges", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = JSON.parse(route.request().postData() ?? "{}") as {
      target_id?: string;
    };
    const response = await route.fetch();
    const gate = payload.target_id === oldTarget.id ? oldWrite : currentWrite;
    gate.signal();
    await gate.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${oldSource.title}` }).click();
  await expect(
    page.getByRole("heading", { name: oldSource.title }),
  ).toBeVisible();
  const oldInput = page.getByLabel("Target reference URL or ID");
  await oldInput.fill(oldTarget.id);
  await expect(oldInput).toHaveValue(oldTarget.id);
  await expect(
    page.getByRole("button", { name: "Add relationship" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Add relationship" }).click();
  await oldWrite.started;
  await expect(
    page.getByRole("button", { name: "Refresh relationships" }),
  ).toBeDisabled();

  await page
    .getByRole("button", { name: `Edit ${currentSource.title}` })
    .click();
  await expect(
    page.getByRole("heading", { name: currentSource.title }),
  ).toBeVisible();
  const currentInput = page.getByLabel("Target reference URL or ID");
  const currentAdd = page.getByRole("button", { name: "Add relationship" });
  await currentInput.fill(currentTarget.id);
  await currentAdd.click();
  await currentWrite.started;

  oldWrite.release();
  await expect(currentAdd).toBeDisabled();
  await expect(currentInput).toHaveValue(currentTarget.id);
  currentWrite.release();
  await expect(page.getByRole("status")).toContainText("Relationship added");
  await expect(currentInput).toBeEnabled();
  await currentInput.fill(retryTarget.id);
  await expect(currentAdd).toBeEnabled();
});

test("owners_can_page_and_manage_relations_beyond_the_first_thirty", async ({
  browser,
  context,
  page,
}) => {
  const { owner } = await seedLibrary(context);
  const { context: sourceContext, owner: sourceOwner } =
    await makeOwner(browser);
  // Pagination setup must not depend on 125 non-idempotent dev-proxy POSTs.
  // Creation is covered separately; reads and UI mutations below remain real.
  const fixture = contentEdgePageFixture(owner, sourceOwner);
  executeFixtureSql(fixture.sql);
  const { node } = fixture;

  const outgoingFirst = await readOwnerEdgePage(context, node.id, "outgoing");
  expect(outgoingFirst.edges).toHaveLength(30);
  expect(outgoingFirst.next_cursor).not.toBeNull();
  const outgoingLater = await readOwnerEdgePage(
    context,
    node.id,
    "outgoing",
    outgoingFirst.next_cursor ?? undefined,
  );
  expect(outgoingLater.edges).toHaveLength(1);
  expect(outgoingLater.next_cursor).toBeNull();
  expect(
    new Set(
      [...outgoingFirst.edges, ...outgoingLater.edges].map(
        (edge) => edge.target.id,
      ),
    ),
  ).toEqual(new Set(fixture.targets.map((target) => target.id)));
  const laterOutgoingTitle = outgoingLater.edges[0]?.target.title;
  expect(laterOutgoingTitle).toBeTruthy();

  const incomingFirst = await readOwnerEdgePage(context, node.id, "incoming");
  expect(incomingFirst.edges).toHaveLength(30);
  expect(incomingFirst.next_cursor).not.toBeNull();
  const incomingLater = await readOwnerEdgePage(
    context,
    node.id,
    "incoming",
    incomingFirst.next_cursor ?? undefined,
  );
  expect(incomingLater.edges).toHaveLength(1);
  expect(incomingLater.next_cursor).toBeNull();
  expect(
    new Set(
      [...incomingFirst.edges, ...incomingLater.edges].map(
        (edge) => edge.source.id,
      ),
    ),
  ).toEqual(new Set(fixture.sources.map((source) => source.id)));
  const laterIncomingTitle = incomingLater.edges[0]?.source.title;
  expect(laterIncomingTitle).toBeTruthy();

  const reviewFirst = await readOwnerEdgePage(
    context,
    node.id,
    "incoming-review",
  );
  expect(reviewFirst.edges).toHaveLength(30);
  expect(reviewFirst.next_cursor).not.toBeNull();
  const reviewLater = await readOwnerEdgePage(
    context,
    node.id,
    "incoming-review",
    reviewFirst.next_cursor ?? undefined,
  );
  expect(reviewLater.edges).toHaveLength(1);
  expect(reviewLater.next_cursor).toBeNull();
  const laterReviewEdge = reviewLater.edges[0];
  const laterReviewTitle = laterReviewEdge?.source.title;
  expect(laterReviewTitle).toBeTruthy();
  if (
    !laterOutgoingTitle ||
    !laterIncomingTitle ||
    !laterReviewTitle ||
    !laterReviewEdge
  )
    throw new Error(
      "Expected the owner relationship APIs to return page-two rows.",
    );

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${node.title}` }).click();
  const outgoing = page.getByRole("region", { name: "Outgoing relationships" });
  const incoming = page.getByRole("region", { name: "Incoming relationships" });
  const visibleIncomingList = incoming.getByRole("list").first();
  const delayedAppend = deferredSignal();
  await page.route(
    `**/api/content-nodes/${node.id}/edges?direction=outgoing&limit=30&cursor=*`,
    async (route) => {
      const response = await route.fetch();
      delayedAppend.signal();
      await delayedAppend.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page
    .getByRole("button", { name: "Load older outgoing relationships" })
    .click();
  await delayedAppend.started;
  await page.getByRole("button", { name: "Refresh relationships" }).click();
  delayedAppend.release();
  await expect(
    outgoing.getByText(laterOutgoingTitle, { exact: true }),
  ).toHaveCount(0);
  await page.unroute(
    `**/api/content-nodes/${node.id}/edges?direction=outgoing&limit=30&cursor=*`,
  );
  await page
    .getByRole("button", { name: "Load older outgoing relationships" })
    .click();
  await expect(
    outgoing.getByText(laterOutgoingTitle, { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Load older incoming relationships" })
    .click();
  await expect(
    incoming.getByText(laterIncomingTitle, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load older incoming review" })
    .click();
  const reviewList = incoming.getByRole("list").last();
  const laterReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: laterReviewTitle });
  await expect(laterReview).toBeVisible();
  await laterReview
    .getByRole("button", { name: "Suppress relationship" })
    .click();
  const suppressedReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: "Suppressed" });
  await expect(
    suppressedReview.getByText("Suppressed", { exact: true }),
  ).toBeVisible();
  await expect(
    visibleIncomingList.getByText(laterReviewTitle, { exact: true }),
  ).toHaveCount(0);
  await suppressedReview
    .getByRole("button", { name: "Restore relationship" })
    .click();
  const restoredReview = reviewList
    .getByRole("listitem")
    .filter({ hasText: laterReviewTitle });
  await expect(restoredReview).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Known pair relationship" }),
  ).toContainText(laterReviewEdge.source.id);

  await page.route(
    `**/api/content-nodes/${node.id}/incoming-review*`,
    async (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: "{",
      }),
  );
  await page.getByRole("button", { name: "Refresh relationships" }).click();
  await expect(page.getByRole("alert")).toContainText("session has ended");
  await expect(
    outgoing.getByText(laterOutgoingTitle, { exact: true }),
  ).toHaveCount(0);
  await expect(
    incoming.getByText(laterReviewTitle, { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    laterReviewEdge.source.id,
  );
  await expect(
    page.getByRole("button", { name: "Add relationship" }),
  ).toBeDisabled();
  await sourceContext.close();
});

async function verifyOldPairReadIsDiscardedAfterIncomingMutation(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  action: "suppress" | "block",
) {
  await seedLibrary(context);
  const target = await createExternal(
    context,
    "Pair mutation target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Pair mutation unlisted source",
    "unlisted",
  );
  await createEdge(sourceContext, source.id, target.id);

  const stalePair = deferredSignal();
  await page.route(
    `**/api/content-nodes/${target.id}/edges?*`,
    async (route) => {
      const url = new URL(route.request().url());
      if (
        url.searchParams.get("direction") !== "incoming" ||
        url.searchParams.get("known_node") !== source.id
      )
        return route.continue();
      const response = await route.fetch();
      stalePair.signal();
      await stalePair.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  const incoming = page.getByRole("region", {
    name: "Incoming relationships",
  });
  const reviewList = incoming.getByRole("list").last();
  const reviewRow = reviewList
    .getByRole("listitem")
    .filter({ hasText: source.title });
  await expect(reviewRow).toBeVisible();
  await reviewRow.getByRole("button", { name: "Accept", exact: true }).click();
  await stalePair.started;

  await reviewRow
    .getByRole("button", {
      name:
        action === "suppress" ? "Suppress relationship" : "Block relationship",
    })
    .click();
  await expect(reviewRow).toContainText(
    action === "suppress" ? "Suppressed" : "Blocked by you",
  );

  stalePair.release();
  const pair = page.getByRole("region", {
    name: "Known pair relationship",
  });
  await expect(pair).toContainText(
    "No active relationship is visible for this known pair.",
  );
  await expect(pair.getByRole("listitem")).toHaveCount(0);
  await expect(reviewRow).toContainText(
    action === "suppress" ? "Suppressed" : "Blocked by you",
  );
  await expect(
    incoming.getByRole("heading", { name: "Visible incoming references" }),
  ).toHaveCount(0);
  await sourceContext.close();
}

test("late_pair_read_cannot_restore_a_suppressed_incoming_edge", async ({
  browser,
  context,
  page,
}) => {
  await verifyOldPairReadIsDiscardedAfterIncomingMutation(
    browser,
    context,
    page,
    "suppress",
  );
});

test("late_pair_read_cannot_restore_a_blocked_incoming_edge", async ({
  browser,
  context,
  page,
}) => {
  await verifyOldPairReadIsDiscardedAfterIncomingMutation(
    browser,
    context,
    page,
    "block",
  );
});

test("cancelled_incoming_appends_release_only_their_own_loading_state", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(
    context,
    "Append cancellation target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  for (let index = 0; index < 31; index++) {
    const source = await createExternal(
      sourceContext,
      `Append cancellation source ${String(index).padStart(2, "0")}`,
      "public",
    );
    await createEdge(sourceContext, source.id, target.id);
  }

  const appendGates = {
    incoming: [deferredSignal(), deferredSignal()] as const,
    review: [deferredSignal(), deferredSignal()] as const,
  };
  const appendCounts = { incoming: 0, review: 0 };
  await page.route(`**/api/content-nodes/${target.id}/**`, async (route) => {
    const url = new URL(route.request().url());
    const direction = url.searchParams.get("direction");
    const isIncoming =
      url.pathname.endsWith("/edges") &&
      direction === "incoming" &&
      url.searchParams.has("cursor");
    const isReview =
      url.pathname.endsWith("/incoming-review") &&
      url.searchParams.has("cursor");
    const key = isIncoming ? "incoming" : isReview ? "review" : null;
    if (key === null || appendCounts[key] >= 2) return route.continue();

    const index = appendCounts[key];
    const gate = appendGates[key][index];
    if (!gate) return route.continue();
    appendCounts[key] = index + 1;
    const response = await route.fetch();
    gate.signal();
    await gate.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  const incoming = page.getByRole("region", {
    name: "Incoming relationships",
  });
  const incomingMore = incoming
    .getByRole("button")
    .filter({ hasText: /older incoming relationships/ });
  const reviewMore = incoming
    .getByRole("button")
    .filter({ hasText: /older incoming review/ });
  const reviewList = incoming.getByRole("list").last();
  const firstReview = reviewList.getByRole("listitem").first();
  await incomingMore.click();
  await appendGates.incoming[0].started;
  await reviewMore.click();
  await appendGates.review[0].started;

  try {
    await firstReview
      .getByRole("button", { name: "Suppress relationship" })
      .click();
    await expect(firstReview).toContainText("Suppressed");

    const cancelledControlState = await Promise.all(
      [incomingMore, reviewMore].map((button) =>
        button.evaluate((element) => ({
          disabled: (element as HTMLButtonElement).disabled,
          label: element.textContent?.trim(),
        })),
      ),
    );
    expect(cancelledControlState).toEqual([
      { disabled: false, label: "Load older incoming relationships" },
      { disabled: false, label: "Load older incoming review" },
    ]);

    await incomingMore.click();
    await appendGates.incoming[1].started;
    await reviewMore.click();
    await appendGates.review[1].started;
    appendGates.incoming[0].release();
    appendGates.review[0].release();
    await expect(incomingMore).toBeDisabled();
    await expect(incomingMore).toContainText("Loading older");
    await expect(reviewMore).toBeDisabled();
    await expect(reviewMore).toContainText("Loading older");

    appendGates.incoming[1].release();
    appendGates.review[1].release();
    const firstPage = await readOwnerEdgePage(context, target.id, "incoming");
    const laterPage = await readOwnerEdgePage(
      context,
      target.id,
      "incoming",
      firstPage.next_cursor ?? undefined,
    );
    const laterSourceTitle = laterPage.edges[0]?.source.title;
    expect(laterSourceTitle).toBeTruthy();
    const visibleIncoming = incoming.getByRole("list").first();
    await expect(
      visibleIncoming.getByText(laterSourceTitle ?? "missing page-two source", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    for (const gate of [...appendGates.incoming, ...appendGates.review])
      gate.release();
    await page.unrouteAll();
  }

  await sourceContext.close();
});

test("known_target_reopens_an_accepted_unlisted_pair_without_posting", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const source = await createExternal(
    context,
    "Known pair reopening source",
    "public",
  );
  const { context: targetContext } = await makeOwner(browser);
  const target = await createExternal(
    targetContext,
    "Known pair reopening unlisted target",
    "unlisted",
  );
  const edge = await createEdge(context, source.id, target.id);
  await edgeAction(targetContext, edge.id, "accept");

  let postCount = 0;
  let pairReadCount = 0;
  await page.route("**/api/content-edges", async (route) => {
    if (route.request().method() === "POST") postCount += 1;
    await route.continue();
  });
  await page.route(
    `**/api/content-nodes/${source.id}/edges?*`,
    async (route) => {
      const url = new URL(route.request().url());
      if (
        url.searchParams.get("direction") === "outgoing" &&
        url.searchParams.get("known_node") === target.id
      )
        pairReadCount += 1;
      await route.continue();
    },
  );

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  await page.reload();
  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  const outgoing = page.getByRole("region", { name: "Outgoing relationships" });
  await expect(outgoing).not.toContainText(target.title);
  const targetInput = page.getByLabel("Target reference URL or ID");
  await targetInput.fill(`${e2eOrigin}/c/${target.id}`);
  const openPair = page.getByRole("button", {
    name: "Open known target pair",
  });
  await expect(openPair).toBeVisible();
  await openPair.click();
  const pair = page.getByRole("region", {
    name: "Known pair relationship",
  });
  await expect(pair).toContainText(target.id);
  await expect(pair).toContainText(target.title);

  await page.getByRole("button", { name: "Refresh relationships" }).click();
  await expect(pair).toContainText(target.title);
  await expect(
    page.getByRole("button", { name: "Open known target pair" }),
  ).toBeVisible();
  expect(pairReadCount).toBeGreaterThanOrEqual(2);
  expect(postCount).toBe(0);

  const pairResponse = await context.request.get(
    `${e2eOrigin}/api/content-nodes/${source.id}/edges?direction=outgoing&limit=30&known_node=${encodeURIComponent(target.id)}`,
    { headers: await ownerHeaders(context) },
  );
  expect(pairResponse.status()).toBe(200);
  const pairResult = (await pairResponse.json()) as OwnerEdgePage;
  expect(pairResult.edges.map((item) => item.id)).toEqual([edge.id]);
  await targetContext.close();
});

test("late_incoming_pair_read_cannot_overwrite_the_outgoing_pair_view", async ({
  browser,
  context,
  page,
}) => {
  await seedLibrary(context);
  const target = await createExternal(
    context,
    "Pair direction target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Pair direction source",
    "unlisted",
  );
  const incomingEdge = await createEdge(
    sourceContext,
    source.id,
    target.id,
    "references",
  );
  const outgoingEdge = await createEdge(
    context,
    target.id,
    source.id,
    "continuation",
  );
  await edgeAction(sourceContext, outgoingEdge.id, "accept");

  await page.addInitScript(
    ({ nodeId, counterpartId }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.href;
        const url = new URL(requestUrl, window.location.origin);
        const response = await originalFetch(input, init);
        if (
          url.pathname ===
            `/api/content-nodes/${encodeURIComponent(nodeId)}/edges` &&
          url.searchParams.get("direction") === "incoming" &&
          url.searchParams.get("known_node") === counterpartId
        ) {
          const payload = (await response.clone().json()) as {
            edges: { id: string }[];
          };
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          (
            window as Window & { __incomingPairResponseIds?: string[] }
          ).__incomingPairResponseIds = payload.edges.map((edge) => edge.id);
        }
        return response;
      };
    },
    { nodeId: target.id, counterpartId: source.id },
  );

  const delayedPairRead = deferredSignal();
  const pairResponseFinished = deferredSignal();
  let pairReadStarted = false;
  await page.route(
    `**/api/content-nodes/${target.id}/edges?*`,
    async (route) => {
      const url = new URL(route.request().url());
      if (
        url.searchParams.get("direction") !== "incoming" ||
        url.searchParams.get("known_node") !== source.id
      )
        return route.continue();
      const response = await route.fetch();
      pairReadStarted = true;
      delayedPairRead.signal();
      await delayedPairRead.promise;
      try {
        await route.fulfill({ response });
      } finally {
        pairResponseFinished.signal();
      }
    },
  );

  try {
    await page.goto(`${e2eOrigin}/content`);
    await page.getByRole("button", { name: `Edit ${target.title}` }).click();
    const incoming = page.getByRole("region", {
      name: "Incoming relationships",
    });
    const reviewRow = incoming
      .getByRole("list")
      .last()
      .getByRole("listitem")
      .filter({ hasText: source.title });
    await expect(reviewRow).toBeVisible();
    await reviewRow
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await delayedPairRead.started;

    await page.getByLabel("Target reference URL or ID").fill(source.id);
    await page.getByRole("button", { name: "Open known target pair" }).click();
    const pair = page.getByRole("region", {
      name: "Known pair relationship",
    });
    const pairRow = pair.getByRole("listitem");
    await expect(pairRow).toContainText("continuation");
    await expect(pairRow).toContainText(source.title);

    delayedPairRead.release();
    await pairResponseFinished.started;
    await page.waitForFunction(
      (edgeId) =>
        (
          window as Window & { __incomingPairResponseIds?: string[] }
        ).__incomingPairResponseIds?.includes(edgeId),
      incomingEdge.id,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(pairRow).toContainText("continuation");
    await expect(pairRow).toContainText(source.title);
    await expect(pairRow).not.toContainText("references");
    await expect(reviewRow).toContainText("Accepted");
  } finally {
    delayedPairRead.release();
    if (pairReadStarted) await pairResponseFinished.started;
    await sourceContext.close();
  }
});

test("source_owner_can_retract_one_edge_without_removing_nodes_or_other_edges", async ({
  context,
  page,
}) => {
  await seedLibrary(context);
  const source = await createExternal(
    context,
    "Retraction source node",
    "public",
  );
  const target = await createExternal(
    context,
    "Retraction target node",
    "public",
  );
  const retainedTarget = await createExternal(
    context,
    "Retraction retained target",
    "public",
  );
  const nextSource = await createExternal(
    context,
    "Retraction next source node",
    "public",
  );
  const edge = await createEdge(context, source.id, target.id);
  await createEdge(context, source.id, retainedTarget.id, "continuation");
  await createEdge(context, nextSource.id, target.id, "related_to");

  const deletion = deferredSignal();
  await page.route(`**/api/content-edges/${edge.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const response = await route.fetch();
    deletion.signal();
    await deletion.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  const outgoing = page.getByRole("region", { name: "Outgoing relationships" });
  const removedRow = outgoing
    .getByRole("listitem")
    .filter({ hasText: target.title });
  await expect(removedRow).toBeVisible();
  await removedRow.getByRole("button", { name: "Remove relationship" }).click();
  await deletion.started;

  const serverPage = await readOwnerEdgePage(context, source.id, "outgoing");
  expect(serverPage.edges.map((item) => item.id)).not.toContain(edge.id);
  await page.getByRole("button", { name: `Edit ${nextSource.title}` }).click();
  const nextOutgoing = page.getByRole("region", {
    name: "Outgoing relationships",
  });
  await expect(
    nextOutgoing.getByText(target.title, { exact: true }),
  ).toBeVisible();
  deletion.release();
  await expect(
    page.getByRole("heading", { name: nextSource.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Relationship removed" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  const refreshedOutgoing = page.getByRole("region", {
    name: "Outgoing relationships",
  });
  await expect(
    refreshedOutgoing.getByText(target.title, { exact: true }),
  ).toHaveCount(0);
  await expect(
    refreshedOutgoing.getByText(retainedTarget.title, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Edit ${source.title}` }),
  ).toBeVisible();

  const publicTarget = await page.goto(`${e2eOrigin}/c/${target.id}`);
  expect(publicTarget?.status()).toBe(200);
  await expect(page.locator("body")).not.toContainText(source.title);
  await expect(page.locator("body")).toContainText(nextSource.title);
  await expect(page.locator("body")).toContainText(target.title);
});

test("late_creator_delete_after_auth_generation_change_is_discarded", async ({
  context,
  page,
}) => {
  await seedLibrary(context);
  const source = await createExternal(
    context,
    "Auth-generation delete source",
    "public",
  );
  const target = await createExternal(
    context,
    "Auth-generation delete target",
    "public",
  );
  const edge = await createEdge(context, source.id, target.id);

  const deletion = deferredSignal();
  const logout = deferredSignal();
  const logoutFinished = deferredSignal();
  let logoutStarted = false;
  await page.route(`**/api/content-edges/${edge.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const response = await route.fetch();
    deletion.signal();
    await deletion.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.route("**/auth/logout", async (route) => {
    logoutStarted = true;
    logout.signal();
    await logout.promise;
    try {
      await route.continue();
    } finally {
      logoutFinished.signal();
    }
  });

  await page.goto(`${e2eOrigin}/content`);
  await page.getByRole("button", { name: `Edit ${source.title}` }).click();
  const outgoing = page.getByRole("region", { name: "Outgoing relationships" });
  const row = outgoing.getByRole("listitem").filter({ hasText: target.title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove relationship" }).click();
  await deletion.started;

  try {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout.started;
    await expect(
      page.getByRole("button", { name: "Refresh relationships" }),
    ).toBeEnabled();

    deletion.release();
    await expect(
      page.getByRole("status").filter({ hasText: "Relationship removed" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: source.title }),
    ).toBeVisible();
    await expect(outgoing.getByText(target.title, { exact: true })).toHaveCount(
      0,
    );
  } finally {
    deletion.release();
    logout.release();
    if (logoutStarted) await logoutFinished.started;
  }

  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
});

test("admin_content_node_moderation_hides_backlinks_without_deleting_the_relation", async ({
  browser,
  context,
  page,
}) => {
  const { owner: administratorId } = await seedLibrary(context);
  executeFixtureSql(
    `UPDATE users SET plan='admin' WHERE id='${administratorId}';`,
  );
  const target = await createExternal(
    context,
    "Node moderation target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const source = await createExternal(
    sourceContext,
    "Node moderation backlink source",
    "public",
  );
  const edge = await createEdge(sourceContext, source.id, target.id);
  await reportEdge(context, edge.id);
  const administratorCookie = await ownerCookie(context);

  await page.goto(`${e2eOrigin}/admin/reports`);
  const nodePanel = page.getByRole("region", {
    name: "Content node moderation",
  });
  await expect(nodePanel).toBeVisible();
  await nodePanel.getByLabel("Content node ID").fill(target.id);
  await nodePanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await expect(
    nodePanel.getByText("Current content node state: Unblocked", {
      exact: true,
    }),
  ).toBeVisible();
  await nodePanel
    .getByLabel("Content node moderation reason")
    .fill("Hide this reported synthetic node.");
  await nodePanel.getByRole("button", { name: "Block content node" }).click();
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
  await nodePanel
    .getByRole("button", { name: "Refresh content node state" })
    .click();
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();

  await context.clearCookies();
  const unavailable = await page.goto(`${e2eOrigin}/c/${target.id}`);
  expect(unavailable?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText(source.title);
  await context.addCookies([administratorCookie]);
  await page.goto(`${e2eOrigin}/admin/reports`);
  const refreshedPanel = page.getByRole("region", {
    name: "Content node moderation",
  });
  await refreshedPanel.getByLabel("Content node ID").fill(target.id);
  await refreshedPanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await expect(
    refreshedPanel.getByText("Current content node state: Blocked", {
      exact: true,
    }),
  ).toBeVisible();
  await refreshedPanel
    .getByLabel("Content node moderation reason")
    .fill("Restore the original public node.");
  await refreshedPanel
    .getByRole("button", { name: "Unblock content node" })
    .click();
  await expect(
    refreshedPanel.getByText("Current content node state: Unblocked", {
      exact: true,
    }),
  ).toBeVisible();

  await context.clearCookies();
  await page.goto(`${e2eOrigin}/c/${target.id}`);
  await expect(page.getByRole("link", { name: source.title })).toHaveAttribute(
    "href",
    `/c/${source.id}`,
  );
  await sourceContext.close();
});

test("admin_node_auth_failure_can_refresh_and_retry_a_moderation_write", async ({
  context,
  page,
}) => {
  const { owner: administratorId } = await seedLibrary(context);
  executeFixtureSql(
    `UPDATE users SET plan='admin' WHERE id='${administratorId}';`,
  );
  const node = await createExternal(
    context,
    "Node auth retry target",
    "public",
  );
  let nextStatus = 401;
  await page.route(`**/api/admin/content-nodes/${node.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: nextStatus,
      contentType: "application/json",
      body: "{",
    });
  });

  await page.goto(`${e2eOrigin}/admin/reports`);
  const panel = page.getByRole("region", { name: "Content node moderation" });
  await panel.getByLabel("Content node ID").fill(node.id);
  await panel.getByRole("button", { name: "Load content node state" }).click();
  await expect(
    panel.getByText("Current content node state: Unblocked", { exact: true }),
  ).toBeVisible();

  for (const status of [401, 403]) {
    nextStatus = status;
    const reason = `Retry node moderation after HTTP ${status}.`;
    const reasonInput = panel.getByLabel("Content node moderation reason");
    await reasonInput.fill(reason);
    await panel.getByRole("button", { name: "Block content node" }).click();
    await expect(panel.getByRole("alert")).toContainText(
      status === 401 ? "session has ended" : "Access denied",
    );
    await panel
      .getByRole("button", { name: "Refresh content node access" })
      .click();
    await expect(
      panel.getByText("Current content node state: Unblocked", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(reasonInput).toBeEnabled();
    await expect(reasonInput).toHaveValue(reason);
    await expect(
      panel.getByRole("button", { name: "Block content node" }),
    ).toBeEnabled();
  }

  await page.unroute(`**/api/admin/content-nodes/${node.id}`);
  await panel
    .getByLabel("Content node moderation reason")
    .fill("Complete the recovered node moderation write.");
  await panel.getByRole("button", { name: "Block content node" }).click();
  await expect(
    panel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
});

test("admin_node_reads_and_writes_do_not_overwrite_newer_node_or_edge_state", async ({
  browser,
  context,
  page,
}) => {
  const { owner: administratorId } = await seedLibrary(context);
  executeFixtureSql(
    `UPDATE users SET plan='admin' WHERE id='${administratorId}';`,
  );
  const firstNode = await createExternal(
    context,
    "First node selection",
    "public",
  );
  const secondNode = await createExternal(
    context,
    "Second node selection",
    "public",
  );
  await moderateNode(context, secondNode.id, true);
  const { context: sourceContext } = await makeOwner(browser);
  const edgeSource = await createExternal(
    sourceContext,
    "Node review edge source",
    "public",
  );
  const edge = await createEdge(sourceContext, edgeSource.id, firstNode.id);
  await reportEdge(context, edge.id);

  const delayedRead = deferredSignal();
  await page.route(
    `**/api/admin/content-nodes/${firstNode.id}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      delayedRead.signal();
      await delayedRead.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.goto(`${e2eOrigin}/admin/reports`);
  const nodePanel = page.getByRole("region", {
    name: "Content node moderation",
  });
  const nodeInput = nodePanel.getByLabel("Content node ID");
  await nodeInput.fill(firstNode.id);
  await nodePanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await delayedRead.started;
  await nodeInput.fill(secondNode.id);
  await nodePanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await expect(nodePanel.getByTestId("selected-content-node")).toHaveText(
    secondNode.id,
  );
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Review relationship ${edge.id}` })
    .click();
  await expect(
    page.getByText("Current edge state: Unblocked", { exact: true }),
  ).toBeVisible();
  delayedRead.release();
  await expect(nodePanel.getByTestId("selected-content-node")).toHaveText(
    secondNode.id,
  );
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Current edge state: Unblocked", { exact: true }),
  ).toBeVisible();

  await page.unroute(`**/api/admin/content-nodes/${firstNode.id}`);
  await nodeInput.fill(firstNode.id);
  await nodePanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await expect(
    nodePanel.getByText("Current content node state: Unblocked", {
      exact: true,
    }),
  ).toBeVisible();
  const delayedWrite = deferredSignal();
  await page.route(
    `**/api/admin/content-nodes/${firstNode.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      delayedWrite.signal();
      await delayedWrite.promise;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await nodePanel
    .getByLabel("Content node moderation reason")
    .fill("Delayed state for the old node.");
  await nodePanel.getByRole("button", { name: "Block content node" }).click();
  await delayedWrite.started;
  await nodeInput.fill(secondNode.id);
  await nodePanel
    .getByRole("button", { name: "Load content node state" })
    .click();
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
  delayedWrite.release();
  await expect(nodePanel.getByTestId("selected-content-node")).toHaveText(
    secondNode.id,
  );
  await expect(
    nodePanel.getByText("Current content node state: Blocked", { exact: true }),
  ).toBeVisible();
  await expect(
    nodePanel.getByText("Content node blocked. Report history is retained.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Current edge state: Unblocked", { exact: true }),
  ).toBeVisible();
  await sourceContext.close();
});

test("admin_edge_state_reads_and_writes_cannot_overwrite_a_newer_selection", async ({
  browser,
  context,
  page,
}) => {
  const { owner: moderatorId } = await seedLibrary(context);
  executeFixtureSql(`UPDATE users SET plan='admin' WHERE id='${moderatorId}';`);
  const firstTarget = await createExternal(
    context,
    "First moderated target",
    "public",
  );
  const secondTarget = await createExternal(
    context,
    "Second moderated target",
    "public",
  );
  const { context: sourceContext } = await makeOwner(browser);
  const firstSource = await createExternal(
    sourceContext,
    "First source",
    "public",
  );
  const secondSource = await createExternal(
    sourceContext,
    "Second source",
    "public",
  );
  const firstEdge = await createEdge(
    sourceContext,
    firstSource.id,
    firstTarget.id,
  );
  const secondEdge = await createEdge(
    sourceContext,
    secondSource.id,
    secondTarget.id,
  );
  await reportEdge(context, firstEdge.id);
  await reportEdge(context, secondEdge.id);
  await moderateEdge(context, firstEdge.id, true);

  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readPending = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readHit = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  await page.route(
    `**/api/admin/content-edges/${firstEdge.id}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      readStarted();
      await readPending;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.goto(`${e2eOrigin}/admin/reports`);
  await page
    .getByRole("button", { name: `Review relationship ${firstEdge.id}` })
    .click();
  await readHit;
  await page
    .getByRole("button", { name: `Review relationship ${secondEdge.id}` })
    .click();
  await expect(page.getByTestId("selected-edge")).toHaveText(secondEdge.id);
  await expect(
    page.getByText("Current edge state: Unblocked", { exact: true }),
  ).toBeVisible();
  releaseRead();
  await expect(page.getByTestId("selected-edge")).toHaveText(secondEdge.id);
  await expect(
    page.getByText("Current edge state: Unblocked", { exact: true }),
  ).toBeVisible();
  await page.unroute(`**/api/admin/content-edges/${firstEdge.id}`);

  await moderateEdge(context, secondEdge.id, true);
  await page
    .getByRole("button", { name: `Review relationship ${firstEdge.id}` })
    .click();
  await expect(
    page.getByText("Current edge state: Blocked", { exact: true }),
  ).toBeVisible();
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const writePending = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeHit = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  await page.route(
    `**/api/admin/content-edges/${firstEdge.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      writeStarted();
      await writePending;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page
    .getByLabel("Edge moderation reason")
    .fill("Restore the first edge.");
  await page.getByRole("button", { name: "Unblock relationship" }).click();
  await writeHit;
  await page
    .getByRole("button", { name: `Review relationship ${secondEdge.id}` })
    .click();
  await expect(page.getByTestId("selected-edge")).toHaveText(secondEdge.id);
  await expect(
    page.getByText("Current edge state: Blocked", { exact: true }),
  ).toBeVisible();
  releaseWrite();
  await expect(page.getByTestId("selected-edge")).toHaveText(secondEdge.id);
  await expect(
    page.getByText("Current edge state: Blocked", { exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: artifactPath("admin-edge-review", test.info().project.name),
    fullPage: true,
  });
  await sourceContext.close();
});
