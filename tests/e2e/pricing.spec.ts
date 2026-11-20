import { expect, test } from "@playwright/test";
import { seedLibrary } from "./fixtures";

test("legacy pricing bookmarks offer a localized link without enabling payment", async ({
  page,
}) => {
  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", {
      name: "Pricing has moved to the Ages website",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View official pricing" }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /subscribe|purchase/i }),
  ).toHaveCount(0);
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(
    page.getByRole("heading", { name: "價格方案已移至 AGES 官網" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看官方價格方案" }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "價格方案已移至 AGES 官網" }),
  ).toBeVisible();
});

test("landing and owner navigation link to the canonical page without changing quota", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Explore plans" }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  await seedLibrary(context);
  const before = await (await context.request.get("/api/me")).json();
  await page.goto("/library");
  await expect(
    page.getByRole("link", { name: "Plans", exact: true }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  await page.getByLabel("Language / 語言").selectOption("zh-Hant");
  await expect(
    page.getByRole("link", { name: "方案", exact: true }),
  ).toHaveAttribute("href", "https://ages.tw/pricing");
  const after = await (await context.request.get("/api/me")).json();
  expect(after.quota).toEqual(before.quota);
});
