import { expect, test } from "@playwright/test";
import { e2eOrigin, seedLibrary, seedTimeline } from "./fixtures";

test("language selection persists across reload and updates the document and navigation", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  const language = page.getByLabel("Language / 語言");
  await language.selectOption("zh-Hant");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(
    page.getByRole("navigation", { name: "主要導覽" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "時間軸", exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "ages_locale")
      ?.value,
  ).toBe("zh-Hant");
  await page.reload();
  await expect(language).toHaveValue("zh-Hant");
  await expect(
    page.getByRole("link", { name: "時間軸", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "時間軸", exact: true }).click();
  await expect(page).toHaveURL(/\/timelines$/);
  await language.selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("link", { name: "Timelines", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(language).toHaveValue("en");
});

test("first-time visitors can select Chinese before signing in", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(
    page.getByRole("heading", { name: "珍藏你的每個時刻。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "使用 Google 繼續" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "珍藏你的每個時刻。" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Chinese library and proposed pricing remain usable after navigation", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/library");
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(page.getByRole("heading", { name: "你的素材庫" })).toBeVisible();
  await expect(page.getByLabel("選擇照片或影片")).toBeAttached();
  await expect(page.getByLabel("依標籤篩選")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "開啟 Coastal light.png" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "垃圾桶", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "垃圾桶是空的" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "方案", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "為回憶選擇適合的方案" }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "規劃中的月費" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "為回憶選擇適合的方案" }),
  ).toBeVisible();
});

test("Chinese owners can start a timeline and write a text moment", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  await page.goto("/timelines");
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(page.getByRole("heading", { name: "你的時間軸" })).toBeVisible();
  await page.getByLabel("新時間軸標題").fill("旅行日記");
  await page.getByRole("button", { name: "建立時間軸" }).click();
  await expect(page.getByRole("heading", { name: "旅行日記" })).toBeVisible();
  await page.getByRole("button", { name: "撰寫文字" }).click();
  await page.getByRole("textbox", { name: "時刻文字" }).fill("第一次出發");
  await page.getByRole("button", { name: "新增文字時刻" }).click();
  await expect(page.getByText("第一次出發", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "編輯時刻" }).click();
  await expect(page.getByRole("textbox", { name: "時刻文字" })).toHaveValue(
    "第一次出發",
  );
  await page.reload();
  await expect(page.getByText("第一次出發", { exact: true })).toBeVisible();
});

test("language choice remains available when local storage is blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(
    page.getByRole("heading", { name: "珍藏你的每個時刻。" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Language / 語言")).toHaveValue("zh-Hant");
  await expect(
    page.getByRole("heading", { name: "珍藏你的每個時刻。" }),
  ).toBeVisible();
});

test("Chinese privacy and share settings accurately reflect visibility", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids, 1);
  await page.goto(`/timelines/${id}`);
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(page.getByLabel("可見範圍")).toHaveValue("private");
  await expect(
    page.getByText("這個故事是私人的。選擇「知道連結的人」即可分享。"),
  ).toBeVisible();
  await page.getByLabel("可見範圍").selectOption("unlisted");
  await page.getByRole("button", { name: "儲存時間軸" }).click();
  await expect(
    page.getByRole("link", { name: "開啟分享的時間軸" }),
  ).toHaveAttribute("href", `${e2eOrigin}/t/${id}`);
  await page.reload();
  await expect(page.getByLabel("可見範圍")).toHaveValue("unlisted");
});

test("Chinese conflict notice preserves an unsaved caption", async ({
  page,
  context,
}) => {
  const { owner, ids } = await seedLibrary(context);
  const { id } = seedTimeline(owner, ids);
  await page.goto(`/timelines/${id}`);
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  const first = page.getByRole("group", { name: "Moment 1", exact: true });
  await first.getByRole("button", { name: "編輯時刻" }).click();
  await first.getByRole("textbox", { name: "照片說明" }).fill("保留我的草稿");
  const external = await context.request.patch(`/api/timelines/${id}`, {
    headers: { Origin: e2eOrigin },
    data: { expected_version: 1, title: "Changed in another window" },
  });
  expect(external.ok()).toBe(true);
  await first.getByRole("button", { name: "儲存時刻" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "未儲存的草稿已保留" }),
  ).toBeVisible();
  await expect(first.getByRole("textbox", { name: "照片說明" })).toHaveValue(
    "保留我的草稿",
  );
});
