import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  e2eOrigin,
  executeFixtureSql,
  seedLibrary,
  seedTimeline,
} from "./fixtures";

type NodePayload = {
  id: string;
  kind: "timeline" | "external";
  visibility: "private" | "unlisted" | "public";
  timeline_id: string | null;
  url: string | null;
  title: string | null;
};

async function createNode(context: BrowserContext, input: unknown) {
  const response = await context.request.post("/api/content-nodes", {
    headers: await ownerHeaders(context),
    data: input,
  });
  expect(response.status()).toBe(201);
  return (await response.json()).node as NodePayload;
}

async function createExternal(
  context: BrowserContext,
  visibility: NodePayload["visibility"],
  title = "A shared memory",
) {
  return createNode(context, {
    kind: "external",
    url: "https://example.test/story",
    title,
    visibility,
  });
}

async function ownerFixture(context: BrowserContext) {
  const { owner, ids } = await seedLibrary(context);
  const timeline = seedTimeline(owner, ids, 1, "A private memory");
  return { owner, ids, timeline };
}

async function seedNodeCollections(
  context: BrowserContext,
  liveCount = 31,
  removedCount = 31,
  ownerId?: string,
) {
  const owner = ownerId ?? (await seedLibrary(context)).owner;
  const firstTimestamp = Date.now() - (ownerId ? 60_000 : 0);
  const makeNodes = (collection: "live" | "removed", count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `cn_${randomUUID()}`,
      title: `${collection === "live" ? "Live" : "Removed"} page ${index}`,
      url: `https://example.test/${collection}/${index}`,
      createdAt: new Date(
        firstTimestamp +
          (collection === "live" ? removedCount + index : index) * 1000,
      ).toISOString(),
      removed: collection === "removed",
    }));
  const liveNodes = makeNodes("live", liveCount);
  const removedNodes = makeNodes("removed", removedCount);
  const inserts = [...removedNodes, ...liveNodes].map((node) => {
    const removedAt = node.removed ? `'${node.createdAt}'` : "NULL";
    return (
      "INSERT INTO content_nodes (id, owner_id, kind, visibility, timeline_id, url, title, created_at, updated_at, removed_at) " +
      `VALUES ('${node.id}', '${owner}', 'external', 'private', NULL, '${node.url}', '${node.title}', '${node.createdAt}', '${node.createdAt}', ${removedAt});`
    );
  });
  executeFixtureSql(inserts.join("\n"));
  return { owner, liveNodes, removedNodes };
}

type CollectionMode = "live" | "removed";
type PageResponseGate = {
  collection: CollectionMode;
  hasCursor: boolean;
  fail?: boolean;
  titles: Promise<string[]>;
  resume: Promise<void>;
  release: () => void;
  finished: Promise<void>;
  complete: () => void;
  setTitles: (titles: string[]) => void;
};

function pageResponseGate(
  collection: CollectionMode,
  hasCursor: boolean,
  fail = false,
): PageResponseGate {
  let resolveTitles!: (titles: string[]) => void;
  let resolveResume!: () => void;
  let resolveFinished!: () => void;
  return {
    collection,
    hasCursor,
    fail,
    titles: new Promise((resolve) => {
      resolveTitles = resolve;
    }),
    resume: new Promise((resolve) => {
      resolveResume = resolve;
    }),
    release: () => resolveResume(),
    finished: new Promise((resolve) => {
      resolveFinished = resolve;
    }),
    complete: () => resolveFinished(),
    setTitles: (titles) => resolveTitles(titles),
  };
}

async function waitForBrowserRender(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function interceptPageGates(page: Page, gates: PageResponseGate[]) {
  await page.route("**/api/content-nodes?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const collection: CollectionMode =
      url.searchParams.get("removed") === "true" ? "removed" : "live";
    const hasCursor = url.searchParams.has("cursor");
    const gateIndex = gates.findIndex(
      (gate) => gate.collection === collection && gate.hasCursor === hasCursor,
    );
    if (gateIndex < 0) return route.continue();
    const [gate] = gates.splice(gateIndex, 1);
    if (!gate) return route.continue();

    try {
      const response = await route.fetch();
      const payload = (await response.json()) as { nodes: NodePayload[] };
      gate.setTitles(payload.nodes.map((node) => node.title ?? ""));
      await gate.resume;
      if (gate.fail) {
        await route
          .fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "A stale page read failed.",
              },
            }),
          })
          .catch(() => undefined);
      } else {
        await route.fulfill({ response }).catch(() => undefined);
      }
    } finally {
      gate.complete();
    }
  });
}

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
    Cookie: `ages_session=${cookie?.value}`,
    Origin: e2eOrigin,
  };
}

function setOwnerSessionExpired(owner: string, expired: boolean) {
  const offset = expired ? -60_000 : 3_600_000;
  const expiresAt = new Date(Date.now() + offset).toISOString();
  executeFixtureSql(
    `UPDATE sessions SET expires_at='${expiresAt}' WHERE user_id='${owner}';`,
  );
}

async function ownerWithPaginatedNodes(context: BrowserContext) {
  const { owner, timeline } = await ownerFixture(context);
  const seeded = await seedNodeCollections(context, 31, 0, owner);
  const node = await createExternal(
    context,
    "private",
    "Auth private reference",
  );
  return { owner, timeline, node, liveNodes: seeded.liveNodes };
}

async function fillOwnerDrafts(page: Page, timelineId: string) {
  await page.getByLabel("External page URL").fill("https://example.test/draft");
  await page.getByLabel("External title").fill("Unsaved external draft");
  await page.getByLabel("Visibility", { exact: true }).selectOption("unlisted");
  await page.getByLabel("Timeline", { exact: true }).selectOption(timelineId);
  await page.getByLabel("Timeline reference visibility").selectOption("public");
  await page.getByLabel("Title", { exact: true }).fill("Unsaved edit draft");
}

async function expectOwnerStateCleared(
  page: Page,
  message = "Your session has ended. Sign in again to continue.",
) {
  await expect(
    page.getByRole("alert").filter({ hasText: message }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Restore / })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("External page URL")).toHaveValue("");
  await expect(page.getByLabel("External title")).toHaveValue("");
  await expect(page.getByLabel("Visibility", { exact: true })).toHaveValue(
    "private",
  );
  await expect(page.getByLabel("Timeline", { exact: true })).toHaveValue("");
  await expect(
    page
      .getByLabel("Timeline", { exact: true })
      .getByRole("option", { name: "A private memory" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Timeline reference visibility")).toHaveValue(
    "private",
  );
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^\// })).toHaveCount(0);
}

test("private_nodes_require_owner", async ({ page, context }) => {
  const { owner: ownerUser, timeline } = await ownerFixture(context);
  const node = await createNode(context, {
    kind: "timeline",
    timeline_id: timeline.id,
    visibility: "public",
  });
  const detail = await context.request.get(`/api/content-nodes/${node.id}`, {
    headers: await ownerHeaders(context),
  });
  expect((await detail.json()).effective_visibility).toBe("private");

  const cookie = await ownerCookie(context);
  await context.clearCookies();
  await context.addCookies([
    {
      name: "ages_session",
      value: "invalid-session-token",
      url: e2eOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const anonymous = await page.goto(`/c/${node.id}`);
  expect(anonymous?.status()).toBe(404);
  expect(anonymous?.headers()["cache-control"]).toContain("no-store");
  expect(anonymous?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.getByText("A private memory", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator("body")).toContainText("unavailable");
  const anonymousHead = await context.request.head(`/c/${node.id}`);
  expect(anonymousHead.status()).toBe(404);
  expect(anonymousHead.headers()["cache-control"]).toContain("no-store");
  expect(anonymousHead.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(await anonymousHead.text()).toBe("");

  await context.clearCookies();
  await context.addCookies([cookie]);
  const owner = await page.goto(`/c/${node.id}`);
  expect(owner?.status()).toBe(200);
  expect(owner?.headers()["cache-control"]).toContain("no-store");
  expect(owner?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex,nofollow",
  );
  await expect(
    page.getByRole("heading", { name: "A private memory", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Timeline editor", exact: true }),
  ).toHaveAttribute("href", `/timelines/${timeline.id}`);
  await expect(page.locator("body")).not.toContainText("@example.test");
  await expect(page.locator(".site-header")).toHaveCount(0);
  const ownerHead = await context.request.head(`/c/${node.id}`, {
    headers: await ownerHeaders(context),
  });
  expect(ownerHead.status()).toBe(200);
  expect(ownerHead.headers()["cache-control"]).toBe(
    owner?.headers()["cache-control"],
  );
  expect(ownerHead.headers()["x-robots-tag"]).toBe(
    owner?.headers()["x-robots-tag"],
  );
  expect(await ownerHead.text()).toBe("");

  executeFixtureSql(
    `UPDATE timelines SET moderation_blocked=1 WHERE id='${timeline.id}';`,
  );
  const unavailable = await context.request.get(
    `/api/content-nodes/${node.id}`,
    {
      headers: await ownerHeaders(context),
    },
  );
  expect((await unavailable.json()).effective_visibility).toBeNull();

  executeFixtureSql(
    `UPDATE timelines SET moderation_blocked=0 WHERE id='${timeline.id}';`,
  );
  const availableOwner = await page.goto(`/c/${node.id}`);
  expect(availableOwner?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "A private memory", exact: true }),
  ).toBeVisible();

  executeFixtureSql(
    `UPDATE sessions SET expires_at='${new Date(Date.now() - 60_000).toISOString()}' WHERE user_id='${ownerUser}';`,
  );
  const expiredOwner = await page.goto(`/c/${node.id}`);
  expect(expiredOwner?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("unavailable");
  await expect(
    page.getByRole("heading", { name: "A private memory", exact: true }),
  ).toHaveCount(0);
});

test("unlisted_node_has_noindex", async ({ context }) => {
  await ownerFixture(context);
  const node = await createExternal(context, "unlisted");
  const response = await context.request.get(`/c/${node.id}`, {
    headers: { Cookie: "ages_session=invalid-session-token" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");

  const head = await context.request.head(`/c/${node.id}`);
  expect(head.status()).toBe(response.status());
  expect(head.headers()["cache-control"]).toBe(
    response.headers()["cache-control"],
  );
  expect(head.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(await head.text()).toBe("");

  const unknown = await context.request.get("/c/missing-node/extra");
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()["content-type"]).toContain("application/json");
});

test("external_title_is_inert", async ({ page, context }) => {
  await ownerFixture(context);
  const title =
    '<script>window.__nodeTitleRan = true</script><img src="https://tracker.invalid/pixel" onerror="window.__nodeTitleRan = true">';
  const node = await createExternal(context, "public", title);
  const dangerous = await context.request.post("/api/content-nodes", {
    headers: await ownerHeaders(context),
    data: {
      kind: "external",
      url: "javascript:alert(1)",
      title: "Never accepted",
      visibility: "public",
    },
  });
  expect(dangerous.status()).toBe(400);
  await context.clearCookies();
  await context.addCookies([
    {
      name: "ages_session",
      value: "invalid-session-token",
      url: e2eOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith(".invalid"))
      externalRequests.push(request.url());
  });

  const response = await page.goto(`/c/${node.id}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  expect(response?.headers()["x-robots-tag"]).toBe("index, follow");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "index,follow",
  );
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.locator("img, script")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __nodeTitleRan?: boolean }).__nodeTitleRan,
    ),
  ).toBeUndefined();
  await expect(page.locator(".site-header")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("@example.test");
  await expect(
    page.getByRole("link", { name: "Open external page" }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  expect(externalRequests).toEqual([]);
  await page.screenshot({
    path: `test-results/content-node-public-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("reference_removal_preserves_story_and_link", async ({
  page,
  context,
  request,
}) => {
  const { ids, timeline } = await ownerFixture(context);
  executeFixtureSql(
    `UPDATE timelines SET visibility='public' WHERE id='${timeline.id}';`,
  );
  const node = await createNode(context, {
    kind: "timeline",
    timeline_id: timeline.id,
    visibility: "public",
  });
  const stableNodeUrl = `/c/${node.id}`;
  const cookie = await ownerCookie(context);
  const headers = {
    Cookie: `ages_session=${cookie?.value}`,
    Origin: e2eOrigin,
  };
  const linkResponse = await request.post("/api/links", {
    headers,
    data: { target: { kind: "timeline", timeline_id: timeline.id } },
  });
  expect(linkResponse.status()).toBe(201);
  const link = (await linkResponse.json()).link as { slug: string };
  const publicTimeline = await context.request.get(stableNodeUrl);
  expect(publicTimeline.status()).toBe(200);
  expect(publicTimeline.headers()["x-robots-tag"]).toBe("index, follow");
  expect(
    (
      await context.request.get(`/s/${link.slug}`, {
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(302);

  executeFixtureSql(
    `UPDATE distribution_links SET expires_at='${new Date(Date.now() - 60_000).toISOString()}' WHERE slug='${link.slug}';`,
  );
  expect(
    (
      await context.request.get(`/s/${link.slug}`, {
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(404);
  expect((await context.request.get(stableNodeUrl)).status()).toBe(200);

  await page.goto("/content");
  await page.getByRole("button", { name: "Edit A private memory" }).click();
  await page
    .getByRole("button", { name: "Remove reference to A private memory" })
    .click();
  await expect(
    page.locator(".content-nodes-toolbar [role='status']"),
  ).toContainText("Reference removed");

  const story = await context.request.get(`/api/timelines/${timeline.id}`, {
    headers: await ownerHeaders(context),
  });
  expect(story.status()).toBe(200);
  expect((await story.json()).timeline.items).toHaveLength(1);
  expect(
    (
      await context.request.get(`/api/assets/${ids[0]}`, {
        headers: await ownerHeaders(context),
      })
    ).status(),
  ).toBe(200);
  const removedReferences = await context.request.get(
    "/api/content-nodes?limit=30&removed=true",
    { headers: await ownerHeaders(context) },
  );
  const removedNodes = (await removedReferences.json()).nodes as NodePayload[];
  expect(removedNodes.some((removedNode) => removedNode.id === node.id)).toBe(
    true,
  );
  expect((await context.request.get(stableNodeUrl)).status()).toBe(404);
});

test("restore_removed_reference_after_refresh", async ({ page, context }) => {
  await ownerFixture(context);
  const node = await createExternal(
    context,
    "public",
    "Restore this reference",
  );
  await page.goto("/content");
  await page
    .getByRole("button", { name: "Remove reference to Restore this reference" })
    .click();
  await expect(
    page.locator(".content-nodes-toolbar [role='status']"),
  ).toContainText("Reference removed");
  const stableNodeUrl = `/c/${node.id}`;
  expect((await context.request.get(stableNodeUrl)).status()).toBe(404);
  await page.reload();
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Restore this reference" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore Restore this reference" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".content-nodes-toolbar [role='status']"),
  ).toContainText("Reference restored");
  expect((await context.request.get(stableNodeUrl)).status()).toBe(200);
  expect(node.id).toMatch(/^cn_/);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("restore_clears_removed_rows_and_cursor_before_failed_live_read", async ({
  page,
  context,
}) => {
  await seedNodeCollections(context, 1, 31);
  const gates: PageResponseGate[] = [];
  await interceptPageGates(page, gates);
  await page.goto("/content");
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Removed page 30" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();

  const liveRead = pageResponseGate("live", false, true);
  gates.push(liveRead);
  await page.getByRole("button", { name: "Restore Removed page 30" }).click();
  expect(await liveRead.titles).toContain("Removed page 30");
  await expect(
    page.getByRole("button", { name: "Edit Removed page 29" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toHaveCount(0);

  liveRead.release();
  await liveRead.finished;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit Removed page 29" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Edit Removed page 30" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit Removed page 29" }),
  ).toHaveCount(0);
});

test("save_keeps_newer_title_typed_in_the_same_editor", async ({
  page,
  context,
}) => {
  await ownerFixture(context);
  const node = await createExternal(context, "private", "Original title");
  let releaseSave!: () => void;
  let saveHeld!: () => void;
  const saveResume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const heldSave = new Promise<void>((resolve) => {
    saveHeld = resolve;
  });
  await page.route(`**/api/content-nodes/${node.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    saveHeld();
    await saveResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("Original title");
  await title.fill("Saved title");
  await page.getByRole("button", { name: "Save changes" }).click();
  await heldSave;
  await title.fill("Newer unsaved title");
  const refreshedDetail = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${node.id}`) &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  releaseSave();
  await refreshedDetail;
  await waitForBrowserRender(page);
  await expect(title).toHaveValue("Newer unsaved title");
});

test("older_save_refresh_keeps_newer_selected_reference_draft", async ({
  page,
  context,
}) => {
  await ownerFixture(context);
  const first = await createExternal(context, "private", "First reference");
  const second = await createExternal(context, "private", "Second reference");
  let releaseSave!: () => void;
  let saveHeld!: () => void;
  const saveResume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const heldSave = new Promise<void>((resolve) => {
    saveHeld = resolve;
  });
  await page.route(`**/api/content-nodes/${first.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    saveHeld();
    await saveResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  await page.getByRole("button", { name: "Edit First reference" }).click();
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("First reference");
  await title.fill("First saved title");
  await page.getByRole("button", { name: "Save changes" }).click();
  await heldSave;
  await page.getByRole("button", { name: "Edit Second reference" }).click();
  await expect(title).toHaveValue("Second reference");
  await title.fill("Second unsaved title");
  const refreshedDetail = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${second.id}`) &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  releaseSave();
  await refreshedDetail;
  await waitForBrowserRender(page);
  await expect(title).toHaveValue("Second unsaved title");
});

test("page_two_save_keeps_newer_title_and_selection_after_first_page_refresh", async ({
  page,
  context,
}) => {
  const { liveNodes } = await seedNodeCollections(context, 31, 0);
  const pageTwo = liveNodes[0];
  if (!pageTwo) throw new Error("Expected a second-page reference");
  let releaseSave!: () => void;
  let saveHeld!: () => void;
  const saveResume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const heldSave = new Promise<void>((resolve) => {
    saveHeld = resolve;
  });
  await page.route(`**/api/content-nodes/${pageTwo.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    saveHeld();
    await saveResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  await page.getByRole("button", { name: "Load more references" }).click();
  await page.getByRole("button", { name: "Edit Live page 0" }).click();
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("Live page 0");
  await title.fill("Saved page-two title");
  await page.getByRole("button", { name: "Save changes" }).click();
  await heldSave;
  await title.fill("Newer page-two draft");
  const refreshedList = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/content-nodes" &&
      !url.searchParams.has("cursor") &&
      response.request().method() === "GET" &&
      response.status() === 200
    );
  });
  releaseSave();
  await refreshedList;
  await waitForBrowserRender(page);
  await expect(
    page.getByRole("link", { name: `/c/${pageTwo.id}` }),
  ).toBeVisible();
  await expect(title).toHaveValue("Newer page-two draft");
});

test("older_save_keeps_newer_page_two_selection_after_loading_more", async ({
  page,
  context,
}) => {
  const { liveNodes } = await seedNodeCollections(context, 31, 0);
  const pageOne = liveNodes[30];
  const pageTwo = liveNodes[0];
  if (!pageOne || !pageTwo)
    throw new Error("Expected references on both pages");
  let releaseSave!: () => void;
  let saveHeld!: () => void;
  const saveResume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const heldSave = new Promise<void>((resolve) => {
    saveHeld = resolve;
  });
  await page.route(`**/api/content-nodes/${pageOne.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    saveHeld();
    await saveResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Saved page-one title");
  await page.getByRole("button", { name: "Save changes" }).click();
  await heldSave;
  await page.getByRole("button", { name: "Load more references" }).click();
  await page.getByRole("button", { name: "Edit Live page 0" }).click();
  await expect(title).toHaveValue("Live page 0");
  await title.fill("Newer page-two draft");
  releaseSave();
  await expect(
    page.getByRole("button", { name: "Edit Saved page-one title" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `/c/${pageTwo.id}` }),
  ).toBeVisible();
  await expect(title).toHaveValue("Newer page-two draft");
});

test("missing_page_two_selection_shows_detail_failure_after_refresh", async ({
  page,
  context,
}) => {
  const { liveNodes } = await seedNodeCollections(context, 31, 0);
  const pageOne = liveNodes[30];
  const pageTwo = liveNodes[0];
  if (!pageOne || !pageTwo)
    throw new Error("Expected references on both pages");
  let releaseSave!: () => void;
  let saveHeld!: () => void;
  const saveResume = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const heldSave = new Promise<void>((resolve) => {
    saveHeld = resolve;
  });
  await page.route(`**/api/content-nodes/${pageOne.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    saveHeld();
    await saveResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await heldSave;
  await page.getByRole("button", { name: "Load more references" }).click();
  await page.getByRole("button", { name: "Edit Live page 0" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Live page 0",
  );
  const deleted = await context.request.delete(
    `/api/content-nodes/${pageTwo.id}`,
    { headers: await ownerHeaders(context) },
  );
  expect(deleted.status()).toBe(200);
  releaseSave();
  await expect(
    page.locator(".content-node-detail-panel [role='alert']"),
  ).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
});

test("collection_switch_discards_delayed_pages_in_both_directions", async ({
  page,
  context,
}) => {
  await seedNodeCollections(context);
  const gates: PageResponseGate[] = [];
  await interceptPageGates(page, gates);
  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();

  const livePage = pageResponseGate("live", true);
  gates.push(livePage);
  await page.getByRole("button", { name: "Load more references" }).click();
  expect(await livePage.titles).toEqual(["Live page 0"]);
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Removed page 30" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();
  livePage.release();
  await livePage.finished;
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "Restore Live page 0" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();

  const removedPage = pageResponseGate("removed", true);
  gates.push(removedPage);
  await page.getByRole("button", { name: "Load more references" }).click();
  expect(await removedPage.titles).toEqual(["Removed page 0"]);
  await page.getByRole("button", { name: "Show live references" }).click();
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();
  removedPage.release();
  await removedPage.finished;
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "Edit Removed page 0" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeVisible();
});

test("failed_collection_switch_clears_old_rows_and_retry_reloads_both_modes", async ({
  page,
  context,
}) => {
  await ownerFixture(context);
  const live = await createExternal(context, "private", "Live only");
  const removed = await createExternal(context, "private", "Removed only");
  const deleted = await context.request.delete(
    `/api/content-nodes/${removed.id}`,
    { headers: await ownerHeaders(context) },
  );
  expect(deleted.status()).toBe(200);

  let failNext: CollectionMode | null = null;
  await page.route("**/api/content-nodes?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const collection: CollectionMode =
      url.searchParams.get("removed") === "true" ? "removed" : "live";
    if (collection === failNext && !url.searchParams.has("cursor")) {
      failNext = null;
      return route.abort("failed");
    }
    return route.continue();
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: `Edit ${live.title}` }),
  ).toBeVisible();
  failNext = "removed";
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Restore ${live.title}` }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: `Restore ${removed.title}` }),
  ).toBeVisible();

  failNext = "live";
  await page.getByRole("button", { name: "Show live references" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Edit ${removed.title}` }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: `Edit ${live.title}` }),
  ).toBeVisible();
});

test("refresh_discards_stale_pagination_errors_and_loading_state", async ({
  page,
  context,
}) => {
  const { liveNodes } = await seedNodeCollections(context, 31, 0);
  const gates: PageResponseGate[] = [];
  await interceptPageGates(page, gates);
  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();

  const stalePage = pageResponseGate("live", true, true);
  gates.push(stalePage);
  await page.getByRole("button", { name: "Load more references" }).click();
  expect(await stalePage.titles).toEqual(["Live page 0"]);
  const removedPageNode = liveNodes.find(
    (node) => node.title === "Live page 0",
  );
  if (!removedPageNode) throw new Error("Expected a paginated live node");
  const deleted = await context.request.delete(
    `/api/content-nodes/${removedPageNode.id}`,
    { headers: await ownerHeaders(context) },
  );
  expect(deleted.status()).toBe(200);

  const refreshedPage = pageResponseGate("live", false);
  gates.push(refreshedPage);
  await page.getByLabel("Title", { exact: true }).fill("Refresh marker");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect(await refreshedPage.titles).toContain("Refresh marker");
  stalePage.release();
  await stalePage.finished;
  await waitForBrowserRender(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more references" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Edit Live page 0" }),
  ).toHaveCount(0);

  refreshedPage.release();
  await refreshedPage.finished;
  await expect(
    page.getByRole("button", { name: "Edit Refresh marker" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit Live page 0" }),
  ).toHaveCount(0);
});

for (const deniedRequest of [
  "collection refresh",
  "detail read",
  "pagination",
  "mutation",
] as const) {
  test(`expired_session_${deniedRequest.replaceAll(" ", "_")}_clears_private_state`, async ({
    page,
    context,
  }) => {
    const { owner, timeline, node, liveNodes } =
      await ownerWithPaginatedNodes(context);
    await page.goto("/content");
    await expect(
      page.getByRole("button", { name: `Edit ${node.title}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Load more references" }),
    ).toBeVisible();
    await fillOwnerDrafts(page, timeline.id);

    if (deniedRequest === "collection refresh") {
      const retryableMutation = async (
        route: import("@playwright/test").Route,
      ) => {
        if (route.request().method() === "PATCH") {
          await route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "Temporarily unavailable",
          });
          return;
        }
        await route.continue();
      };
      await page.route("**/api/content-nodes/*", retryableMutation);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("alert")).toContainText("Please try again.");
      await expect(page.getByLabel("External page URL")).toHaveValue(
        "https://example.test/draft",
      );
      await expect(page.getByLabel("External title")).toHaveValue(
        "Unsaved external draft",
      );
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
        "Unsaved edit draft",
      );
      await page.unroute("**/api/content-nodes/*", retryableMutation);

      const gates: PageResponseGate[] = [];
      await interceptPageGates(page, gates);
      const oldPage = pageResponseGate("live", true);
      gates.push(oldPage);
      await page.getByRole("button", { name: "Load more references" }).click();
      expect(await oldPage.titles).toContain("Live page 0");

      let timelineReads = 0;
      await page.route(/\/api\/timelines\?limit=100$/, async (route) => {
        timelineReads += 1;
        if (timelineReads === 1) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            timelines: [
              {
                id: timeline.id,
                title: "A private memory",
                visibility: "private",
              },
            ],
          }),
        });
      });
      await page.route("**/api/content-nodes/*", async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        setOwnerSessionExpired(owner, true);
        await route.fulfill({ response });
      });
      const collectionDenied = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/content-nodes" &&
          url.searchParams.get("limit") === "30" &&
          response.status() === 401
        );
      });
      await page.getByRole("button", { name: "Save changes" }).click();
      await collectionDenied;
      await expectOwnerStateCleared(page);

      oldPage.release();
      await oldPage.finished;
      await waitForBrowserRender(page);
      await expectOwnerStateCleared(page);
      return;
    }

    setOwnerSessionExpired(owner, true);
    if (deniedRequest === "detail read") {
      const target = liveNodes.find((item) => item.title === "Live page 30");
      if (!target) throw new Error("Expected a second live reference");
      const deniedDetail = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/content-nodes/${target.id}`) &&
          response.status() === 401,
      );
      await page.getByRole("button", { name: `Edit ${target.title}` }).click();
      await deniedDetail;
    } else if (deniedRequest === "pagination") {
      const deniedPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/content-nodes" &&
          url.searchParams.has("cursor") &&
          response.status() === 401
        );
      });
      await page.getByRole("button", { name: "Load more references" }).click();
      await deniedPage;
    } else {
      const deniedMutation = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/content-nodes/${node.id}`) &&
          response.request().method() === "PATCH" &&
          response.status() === 401,
      );
      await page.getByRole("button", { name: "Save changes" }).click();
      await deniedMutation;
    }
    await expectOwnerStateCleared(page);
  });
}

test("current_content_node_403_with_html_body_clears_sensitive_state", async ({
  page,
  context,
}) => {
  const { timeline, liveNodes } = await ownerWithPaginatedNodes(context);
  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Auth private reference" }),
  ).toBeVisible();
  await fillOwnerDrafts(page, timeline.id);
  const target = liveNodes.find((node) => node.title === "Live page 30");
  if (!target) throw new Error("Expected a second live reference");

  await page.route(`**/api/content-nodes/${target.id}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 403,
        contentType: "text/html",
        body: "Forbidden",
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: `Edit ${target.title}` }).click();
  await expectOwnerStateCleared(
    page,
    "Access to your content is no longer available.",
  );
});

test("stale_content_node_403_does_not_clear_the_newer_collection", async ({
  page,
  context,
}) => {
  await seedNodeCollections(context, 31, 31);
  let release!: () => void;
  let requestHeld!: () => void;
  let requestFinished!: () => void;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    requestHeld = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    requestFinished = resolve;
  });
  await page.route("**/api/content-nodes?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      !url.searchParams.has("removed") &&
      url.searchParams.has("cursor")
    ) {
      await route.fetch();
      requestHeld();
      await resumed;
      await route
        .fulfill({
          status: 403,
          contentType: "text/html",
          body: "Forbidden",
        })
        .catch(() => undefined);
      requestFinished();
      return;
    }
    await route.continue();
  });
  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: "Edit Live page 30" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more references" }).click();
  await held;
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Removed page 30" }),
  ).toBeVisible();

  release();
  await finished;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Restore Removed page 30" }),
  ).toBeVisible();
});

test("stale_save_403_does_not_clear_the_newer_removed_collection", async ({
  page,
  context,
}) => {
  const { owner, timeline, node } = await ownerWithPaginatedNodes(context);
  const { removedNodes } = await seedNodeCollections(context, 0, 1, owner);
  const removedNode = removedNodes[0];
  if (!removedNode) throw new Error("Expected a removed reference");

  let releaseResponse!: () => void;
  let mutationHeld!: () => void;
  let mutationFinished!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const heldMutation = new Promise<void>((resolve) => {
    mutationHeld = resolve;
  });
  const finishedMutation = new Promise<void>((resolve) => {
    mutationFinished = resolve;
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: `Edit ${node.title}` }),
  ).toBeVisible();
  await fillOwnerDrafts(page, timeline.id);
  await page.route(`**/api/content-nodes/${node.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    mutationHeld();
    await heldResponse;
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "Forbidden",
    });
    mutationFinished();
  });

  await page.getByRole("button", { name: "Save changes" }).click();
  await heldMutation;
  await page.getByRole("button", { name: "Show removed references" }).click();
  await expect(
    page.getByRole("button", { name: `Restore ${removedNode.title}` }),
  ).toBeVisible();

  releaseResponse();
  await finishedMutation;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Restore ${removedNode.title}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show live references" }).click();
  await expect(
    page.getByRole("button", { name: "Edit Unsaved edit draft" }),
  ).toBeVisible();
  await expect(page.getByLabel("External page URL")).toHaveValue(
    "https://example.test/draft",
  );
  await expect(page.getByLabel("External title")).toHaveValue(
    "Unsaved external draft",
  );
  await expect(page.getByLabel("Timeline", { exact: true })).toHaveValue(
    timeline.id,
  );
});

test("switching_collections_releases_only_the_obsolete_mutation_lock", async ({
  page,
  context,
}) => {
  const { owner } = await ownerFixture(context);
  const liveNode = await createExternal(context, "private", "Old save target");
  const { removedNodes } = await seedNodeCollections(context, 0, 1, owner);
  const removedNode = removedNodes[0];
  if (!removedNode) throw new Error("Expected a removed reference");

  let releaseOldSave!: () => void;
  let oldSaveHeld!: () => void;
  const oldSaveResume = new Promise<void>((resolve) => {
    releaseOldSave = resolve;
  });
  const oldSaveStarted = new Promise<void>((resolve) => {
    oldSaveHeld = resolve;
  });
  let releaseRestore!: () => void;
  let restoreHeld!: () => void;
  const restoreResume = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  const restoreStarted = new Promise<void>((resolve) => {
    restoreHeld = resolve;
  });

  await page.route(`**/api/content-nodes/${liveNode.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    oldSaveHeld();
    await oldSaveResume;
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "Forbidden",
    });
  });
  await page.route(`**/api/content-nodes/${removedNode.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    restoreHeld();
    await restoreResume;
    await route.fulfill({ response });
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: `Edit ${liveNode.title}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await oldSaveStarted;
  await page.getByRole("button", { name: "Show removed references" }).click();
  const restore = page.getByRole("button", {
    name: `Restore ${removedNode.title}`,
  });
  await expect(restore).toBeEnabled();
  await restore.click();
  await restoreStarted;
  await expect(restore).toBeDisabled();

  const staleDenial = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${liveNode.id}`) &&
      response.request().method() === "PATCH" &&
      response.status() === 403,
  );
  releaseOldSave();
  await staleDenial;
  await waitForBrowserRender(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(restore).toBeDisabled();

  releaseRestore();
  await expect(
    page.getByRole("button", { name: `Edit ${removedNode.title}` }),
  ).toBeVisible();
});

test("retrying_a_collection_read_releases_its_obsolete_mutation_lock", async ({
  page,
  context,
}) => {
  await ownerFixture(context);
  const retryTarget = await createExternal(context, "private", "Retry target");
  const oldTarget = await createExternal(context, "private", "Old retry save");
  let releaseOldSave!: () => void;
  let oldSaveHeld!: () => void;
  const oldSaveResume = new Promise<void>((resolve) => {
    releaseOldSave = resolve;
  });
  const oldSaveStarted = new Promise<void>((resolve) => {
    oldSaveHeld = resolve;
  });
  let failDetailOnce = true;

  await page.route(`**/api/content-nodes/${oldTarget.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    oldSaveHeld();
    await oldSaveResume;
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "Forbidden",
    });
  });
  await page.route(`**/api/content-nodes/${retryTarget.id}`, async (route) => {
    if (route.request().method() === "GET" && failDetailOnce) {
      failDetailOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "READ_FAILED", message: "Detail read needs retry." },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: `Edit ${oldTarget.title}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await oldSaveStarted;
  await page.getByRole("button", { name: `Edit ${retryTarget.title}` }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Detail read needs retry.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: retryTarget.title ?? "" }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeEnabled();
  const newSave = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${retryTarget.id}`) &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await save.click();
  await newSave;
  const staleDenial = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${oldTarget.id}`) &&
      response.request().method() === "PATCH" &&
      response.status() === 403,
  );
  releaseOldSave();
  await staleDenial;
  await waitForBrowserRender(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("stale_save_success_preserves_newer_collection_error_and_drafts", async ({
  page,
  context,
}) => {
  const { owner, timeline, node } = await ownerWithPaginatedNodes(context);
  const { removedNodes } = await seedNodeCollections(context, 0, 1, owner);
  const removedNode = removedNodes[0];
  if (!removedNode) throw new Error("Expected a removed reference");

  let releaseResponse!: () => void;
  let mutationHeld!: () => void;
  let mutationFinished!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const heldMutation = new Promise<void>((resolve) => {
    mutationHeld = resolve;
  });
  const finishedMutation = new Promise<void>((resolve) => {
    mutationFinished = resolve;
  });
  let failRemovedRead = true;

  await page.route("**/api/content-nodes?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.searchParams.get("removed") === "true" &&
      failRemovedRead
    ) {
      failRemovedRead = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "READ_FAILED",
            message: "The newer collection read failed.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/content");
  await expect(
    page.getByRole("button", { name: `Edit ${node.title}` }),
  ).toBeVisible();
  await fillOwnerDrafts(page, timeline.id);
  await page.route(`**/api/content-nodes/${node.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    mutationHeld();
    await heldResponse;
    await route.fulfill({ response });
    mutationFinished();
  });

  await page.getByRole("button", { name: "Save changes" }).click();
  await heldMutation;
  const failedCollectionRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/content-nodes" &&
      url.searchParams.get("removed") === "true" &&
      response.status() === 503
    );
  });
  await page.getByRole("button", { name: "Show removed references" }).click();
  await failedCollectionRead;
  await expect(page.getByRole("alert")).toContainText(
    "The newer collection read failed.",
  );

  releaseResponse();
  await finishedMutation;
  await expect(page.getByRole("alert")).toContainText(
    "The newer collection read failed.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: `Restore ${removedNode.title}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show live references" }).click();
  await expect(
    page.getByRole("button", { name: "Edit Unsaved edit draft" }),
  ).toBeVisible();
  await expect(page.getByLabel("External page URL")).toHaveValue(
    "https://example.test/draft",
  );
  await expect(page.getByLabel("External title")).toHaveValue(
    "Unsaved external draft",
  );
});

test("logout_discards_delayed_node_result", async ({ page, context }) => {
  await ownerFixture(context);
  const node = await createExternal(
    context,
    "public",
    "Delayed private result",
  );
  let release!: () => void;
  let responseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    responseHeld = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayFirstResponse = true;
  await page.route("**/api/content-nodes?**", async (route) => {
    const response = await route.fetch();
    if (delayFirstResponse) {
      delayFirstResponse = false;
      responseHeld();
      await resume;
    }
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto("/content");
  await held;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep your moments close." }),
  ).toBeVisible();
  release();
  await expect(
    page.getByText("Delayed private result", { exact: true }),
  ).toHaveCount(0);
  expect(node.id).toMatch(/^cn_/);
});

test("content_owner_screen_retries_keyboard_crud_and_fits_mobile", async ({
  page,
  context,
}) => {
  const { timeline } = await ownerFixture(context);
  let failed = false;
  await page.route("**/api/content-nodes?**", async (route) => {
    if (!failed) {
      failed = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.goto("/content");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Your content" }),
  ).toBeVisible();

  await page.getByLabel("Timeline", { exact: true }).selectOption(timeline.id);
  await page
    .getByLabel("Timeline reference visibility", { exact: true })
    .selectOption("public");
  const timelineCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/content-nodes") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add Timeline reference" }).focus();
  await page.keyboard.press("Enter");
  expect((await (await timelineCreated).json()).node.id).toMatch(/^cn_/);
  const timelineReference = page.getByRole("button", {
    name: "Edit A private memory",
  });
  await timelineReference.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Effective visibility: private")).toBeVisible();

  await page
    .getByLabel("External page URL")
    .fill("https://example.test/keyboard");
  await page.getByLabel("External title").fill("Keyboard memory");
  await page.getByLabel("Visibility", { exact: true }).selectOption("public");
  const externalCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/content-nodes") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add reference" }).focus();
  await page.keyboard.press("Enter");
  const externalNode = (await (await externalCreated).json())
    .node as NodePayload;
  const reference = page.getByRole("button", { name: "Edit Keyboard memory" });
  await expect(reference).toBeVisible();
  await reference.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Effective visibility: public")).toBeVisible();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Revised keyboard memory");
  await page
    .getByLabel("Node visibility", { exact: true })
    .selectOption("unlisted");
  const stableNodeUrl = `/c/${externalNode.id}`;
  await expect(
    page.getByRole("link", { name: stableNodeUrl, exact: true }),
  ).toHaveAttribute("href", stableNodeUrl);
  const update = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content-nodes/${externalNode.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).focus();
  await page.keyboard.press("Enter");
  expect((await (await update).json()).node.id).toBe(externalNode.id);
  await expect(
    page.getByRole("link", { name: stableNodeUrl, exact: true }),
  ).toHaveAttribute("href", stableNodeUrl);
  await expect(
    page.getByRole("button", { name: "Edit Revised keyboard memory" }),
  ).toBeVisible();
  const publicPage = await context.request.get(`/c/${externalNode.id}`);
  expect(publicPage.status()).toBe(200);
  expect(publicPage.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(await publicPage.text()).toContain(">Revised keyboard memory</h1>");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit Revised keyboard memory" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  if (test.info().project.name === "mobile") {
    const layout = await page.evaluate(() => {
      const rect = (element: Element | null) => {
        if (!element) throw new Error("Expected content workspace element");
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      };
      const main = document.querySelector(".content-nodes-page");
      const forms = document.querySelector(".content-node-forms");
      const workspace = document.querySelector(".content-node-workspace");
      return {
        main: rect(main),
        firstForm: rect(forms?.children.item(0) ?? null),
        secondForm: rect(forms?.children.item(1) ?? null),
        references: rect(
          workspace?.querySelector(".content-node-list-panel") ?? null,
        ),
        editor: rect(
          workspace?.querySelector(".content-node-detail-panel") ?? null,
        ),
      };
    });
    expect(layout.firstForm.width).toBeGreaterThan(layout.main.width * 0.85);
    expect(layout.secondForm.width).toBeGreaterThan(layout.main.width * 0.85);
    expect(layout.firstForm.x).toBeCloseTo(layout.secondForm.x, 0);
    expect(layout.secondForm.y).toBeGreaterThan(layout.firstForm.y);
    expect(layout.references.width).toBeGreaterThan(layout.main.width * 0.85);
    expect(layout.editor.width).toBeGreaterThan(layout.main.width * 0.85);
    expect(layout.references.y).toBeLessThan(layout.editor.y);
  }
  await page.screenshot({
    path: `test-results/content-node-owner-${test.info().project.name}.png`,
    fullPage: true,
  });
});
