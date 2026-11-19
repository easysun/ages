import { expect, test } from "@playwright/test";
import { seedLibrary } from "./fixtures";

test("legacy /pricing shows a Chinese notice linking to canonical official pricing", async ({
  page,
}) => {
  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", { name: "價格方案已移至 AGES 官網" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("lang", "zh-Hant-TW");
  const official = page.getByRole("link", { name: "查看官方價格方案" });
  await expect(official).toHaveAttribute("href", "https://ages.tw/pricing");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /購買|訂閱|subscribe|purchase/i }),
  ).toHaveCount(0);
});

test("visitors can navigate from the landing page to official pricing", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Explore plans" }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
});

test("signed-in owners find official plan link without quota changes", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  const before = await (await context.request.get("/api/me")).json();
  await page.goto("/library");
  await expect(
    page.getByRole("link", { name: "Plans", exact: true }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  const after = await (await context.request.get("/api/me")).json();
  expect(after.quota).toEqual(before.quota);
});
