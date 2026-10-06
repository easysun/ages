import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { e2eOrigin, executeFixtureSql, seedLibrary } from "./fixtures";

const origin = e2eOrigin;

test("private Asset sharing creates, copies and independently decodes a QR; grants and trash remain recoverable", async ({
  page,
  context,
  request,
}) => {
  const { ids } = await seedLibrary(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page.getByRole("textbox", { name: "Tags" }).fill("Coast");
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Tags saved" }),
  ).toBeVisible();
  const slug = `moment-${randomUUID().slice(0, 8)}`;
  await page.getByRole("textbox", { name: "Link name (optional)" }).fill(slug);
  await page.getByRole("button", { name: "Create share link" }).click();
  const sharing = page.getByRole("region", { name: "Share this moment" });
  await expect(
    sharing.getByRole("textbox", { name: `Short URL for ${slug}` }),
  ).toHaveValue(`${origin}/s/${slug}`);
  await sharing.getByRole("button", { name: `Copy ${slug}` }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${origin}/s/${slug}`);
  await sharing.getByRole("button", { name: `Show QR for ${slug}` }).click();
  const image = sharing.getByRole("img", { name: `QR code for ${slug}` });
  await expect(image).toBeVisible();
  const pixels = await image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw Error("Missing2Dcanvas");
    drawing.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(
        drawing.getImageData(0, 0, canvas.width, canvas.height).data,
      ),
    };
  });
  expect(
    jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data,
  ).toBe(`${origin}/s/${slug}`);
  const cookie = (await context.cookies())[0];
  expect(cookie).toBeDefined();
  const headers = { Cookie: `ages_session=${cookie?.value}` };
  const asset = await request.get(`/api/assets/${ids[0]}`, { headers });
  expect((await asset.json()).asset.visibility).toBe("private");
  const usage = (await (await request.get("/api/me", { headers })).json()).quota
    .storage_used_bytes;
  expect((await request.get(`/api/assets/${ids[0]}/media`)).status()).toBe(401);
  expect((await request.get(`/s/${slug}`)).status()).toBe(200);
  expect((await request.head(`/s/${slug}`)).status()).toBe(200);
  expect(
    (
      await request.get(`/s/${slug}`, { headers: { Range: "bytes=0-7" } })
    ).status(),
  ).toBe(206);
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Turn off active share links" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: `test-results/sharing-${test.info().project.name}.png`,
    fullPage: true,
  });
  await sharing.getByRole("button", { name: `Deactivate ${slug}` }).click();
  expect((await request.get(`/s/${slug}`)).status()).toBe(404);
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Filter by tag" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Trash", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/me", { headers })).json()).quota
      .storage_used_bytes,
  ).toBe(usage);
  await page.screenshot({
    path: `test-results/trash-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Restore Coastal light.png" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Trash", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "All moments", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/me", { headers })).json()).quota
      .storage_used_bytes,
  ).toBe(usage);
});

test("share names and expiry validate; saved expiry updates persist and foreign management stays private", async ({
  page,
  context,
  request,
}) => {
  const { ids } = await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page
    .getByRole("textbox", { name: "Link name (optional)" })
    .fill("UPPER");
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "lowercase" }),
  ).toBeVisible();
  const slug = `expiry-${randomUUID().slice(0, 8)}`;
  await page.getByRole("textbox", { name: "Link name (optional)" }).fill(slug);
  await page
    .getByLabel("Link expiry (your local time)", { exact: true })
    .fill("2000-01-01T00:00");
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "future" }),
  ).toBeVisible();
  await page
    .getByLabel("Link expiry (your local time)", { exact: true })
    .fill("");
  await page.getByRole("button", { name: "Create share link" }).click();
  const sharing = page.getByRole("region", { name: "Share this moment" });
  await expect(
    sharing.getByRole("textbox", { name: `Short URL for ${slug}` }),
  ).toBeVisible();
  await page
    .getByLabel(`Expiry for ${slug} (your local time)`)
    .fill("2099-01-01T12:30");
  await page.getByRole("button", { name: `Save expiry for ${slug}` }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Expiry saved" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await expect(
    page.getByLabel(`Expiry for ${slug} (your local time)`),
  ).toHaveValue("2099-01-01T12:30");
  const cookie = (await context.cookies())[0];
  const headers = { Cookie: `ages_session=${cookie?.value}` };
  const links = await (await request.get("/api/links", { headers })).json();
  const link = links.links.find((item: { slug: string }) => item.slug === slug);
  expect(link).toBeDefined();
  expect(
    (
      await request.patch(`/api/links/${link.id}`, {
        headers: { Origin: origin },
        data: { active: false },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/links", {
        headers: { ...headers, Origin: origin },
        data: { target: { kind: "asset", asset_id: ids[1] }, slug },
      })
    ).status(),
  ).toBe(409);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("timeline references retain the moment when trash conflicts", async ({
  page,
  context,
  request,
}) => {
  const { ids } = await seedLibrary(context);
  const cookie = (await context.cookies())[0];
  const headers = { Cookie: `ages_session=${cookie?.value}`, Origin: origin };
  const created = await request.post("/api/timelines", {
    headers,
    data: { title: "A retained story" },
  });
  expect(created.status()).toBe(201);
  const timeline = (await created.json()).timeline;
  expect(
    (
      await request.post(`/api/timelines/${timeline.id}/items`, {
        headers,
        data: { expected_version: timeline.version, asset_id: ids[0] },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "remove this moment from timelines" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  expect(
    (await request.get(`/api/assets/${ids[0]}`, { headers })).status(),
  ).toBe(200);
});

test("expired recovery errors retain the trash row, isolate foreign trash and offer no permanent deletion", async ({
  page,
  context,
  request,
}) => {
  const { ids } = await seedLibrary(context);
  const cookie = (await context.cookies())[0];
  const headers = { Cookie: `ages_session=${cookie?.value}`, Origin: origin };
  expect(
    (
      await request.post(`/api/assets/${ids[0]}/trash`, { headers, data: {} })
    ).status(),
  ).toBe(200);
  executeFixtureSql(
    `UPDATE assets SET deleted_at='2000-01-01T00:00:00.000Z' WHERE id='${ids[0]}'; UPDATE assets SET status='deleted',deleted_at='2000-01-01T00:00:00.000Z',trash_generation=lower(hex(randomblob(16))) WHERE original_name='Foreign secret.png';`,
  );
  await page.goto("/library?view=trash");
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toBeVisible();
  await expect(page.getByText("Foreign secret.png")).toHaveCount(0);
  await page.getByRole("button", { name: "Restore Coastal light.png" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "recovery window may have ended" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /permanent|purge|delete/i }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Restore Coastal light.png" }),
  ).toBeVisible();
});

test("a delayed real restore response cannot remove a moment from a newer ready collection", async ({
  page,
  context,
  request,
}) => {
  const { ids } = await seedLibrary(context);
  const cookie = (await context.cookies())[0];
  const headers = { Cookie: `ages_session=${cookie?.value}`, Origin: origin };
  expect(
    (
      await request.post(`/api/assets/${ids[0]}/trash`, { headers, data: {} })
    ).status(),
  ).toBe(200);
  let inspected: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/assets/${ids[0]}/restore`, async (route) => {
    const response = await route.fetch();
    inspected();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/library?view=trash");
  await page.getByRole("button", { name: "Restore Coastal light.png" }).click();
  await started;
  await page.getByRole("button", { name: "All moments", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "Open Coastal light.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "All moments", exact: true }),
  ).toBeVisible();
});

test("share-link pagination finds this Asset behind other targets and a closed creation cannot populate another moment", async ({
  page,
  context,
  request,
}) => {
  const { ids, owner } = await seedLibrary(context);
  const cookie = (await context.cookies())[0];
  const headers = { Cookie: `ages_session=${cookie?.value}`, Origin: origin };
  executeFixtureSql(
    `UPDATE usage_quotas SET link_limit=200 WHERE user_id='${owner}';`,
  );
  const slug = `older-${randomUUID().slice(0, 8)}`;
  expect(
    (
      await request.post("/api/links", {
        headers,
        data: { target: { kind: "asset", asset_id: ids[0] }, slug },
      })
    ).status(),
  ).toBe(201);
  const stamp = new Date(Date.now() + 1000).toISOString();
  executeFixtureSql(
    Array.from(
      { length: 101 },
      (_, n) =>
        `INSERT INTO distribution_links(id,owner_id,slug,target_kind,target_url,created_at,updated_at) VALUES('test_${owner}_${n}','${owner}','page-${owner.replaceAll("_", "-")}-${n}','url','https://example.test','${stamp}','${stamp}');`,
    ).join("\n"),
  );
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page.getByRole("button", { name: "Load more share links" }).click();
  await expect(
    page.getByRole("textbox", { name: `Short URL for ${slug}` }),
  ).toBeVisible();
  let inspected: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/links", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    inspected();
    await held;
    await route.fulfill({ response });
  });
  const late = `late-${randomUUID().slice(0, 8)}`;
  await page.getByRole("textbox", { name: "Link name (optional)" }).fill(late);
  await page.getByRole("button", { name: "Create share link" }).click();
  await started;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Mountain air.png" }).click();
  release();
  await expect(
    page.getByRole("dialog", { name: "Mountain air.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: `Short URL for ${late}` }),
  ).toHaveCount(0);
});

test("the supported maximum link name keeps every sharing control inside the mobile dialog", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  const slug = `${randomUUID().replaceAll("-", "")}${"x".repeat(32)}`;
  await page.getByRole("textbox", { name: "Link name (optional)" }).fill(slug);
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(
    page.getByRole("textbox", { name: `Short URL for ${slug}` }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
});

test("a delayed real trash response cannot close a newer moment dialog", async ({
  page,
  context,
}) => {
  const { ids } = await seedLibrary(context);
  let inspected: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/assets/${ids[0]}/trash`, async (route) => {
    const response = await route.fetch();
    inspected();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Open Coastal light.png" }).click();
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await started;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Mountain air.png" }).click();
  const resumed = page.waitForResponse(`**/api/assets/${ids[0]}/trash`);
  release();
  await resumed;
  await expect(
    page.getByRole("dialog", { name: "Mountain air.png" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Link name (optional)" })
    .fill("still-open");
});
