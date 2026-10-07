import { type BrowserContext, expect, test } from "@playwright/test";
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
