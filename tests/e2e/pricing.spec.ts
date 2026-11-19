import { expect, test } from "@playwright/test";
import { seedLibrary } from "./fixtures";

test("visitors see the proposed plans in Traditional Chinese without a checkout", async ({
  page,
}) => {
  await page.goto("/pricing");
  await expect(page.getByRole("main")).toHaveAttribute("lang", "zh-Hant-TW");
  await expect(page.getByRole("heading", { name: "AGES 價格方案" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "訂閱月費" })).toBeVisible();
  const plans = page.getByRole("table", { name: "規劃中的每月訂閱價格" });
  for (const row of [
    "Free NT$0 / 月",
    "Plus NT$99 / 月",
    "Creator NT$299 / 月",
    "Pro NT$599 / 月",
  ]) {
    await expect(plans.getByRole("row", { name: row })).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "創作者贊助服務費" }),
  ).toBeVisible();
  const fees = page.getByRole("table", {
    name: "規劃中的創作者贊助平台服務費",
  });
  for (const row of ["Free 20%", "Plus 10%", "Creator 5%", "Pro 2.5%"]) {
    await expect(fees.getByRole("row", { name: row })).toBeVisible();
  }
  await expect(plans.getByText(/%/)).toHaveCount(0);
  await expect(fees.getByText(/NT\$/)).toHaveCount(0);
  await expect(
    page.getByText("尚未開放付費訂閱與創作者贊助付款。", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("方案功能、儲存容量與年繳價格尚未定案。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /訂閱|付款|subscribe|purchase/i }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "AGES 價格方案" })).toBeVisible();
});

test("a future English locale can be selected without changing plan values", async ({
  page,
}) => {
  await page.goto("/pricing?lang=en");
  await expect(page.getByRole("main")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Plans for your memories" }),
  ).toBeVisible();
  const plans = page.getByRole("table", { name: "Proposed monthly prices" });
  await expect(
    plans.getByRole("row", { name: "Creator NT$299 / month" }),
  ).toBeVisible();
  const fees = page.getByRole("table", {
    name: "Proposed platform fees on creator support",
  });
  await expect(fees.getByRole("row", { name: "Pro 2.5%" })).toBeVisible();
});

test("unsupported locales safely use the Traditional Chinese default", async ({
  page,
}) => {
  await page.goto("/pricing?lang=fr");
  await expect(page.getByRole("main")).toHaveAttribute("lang", "zh-Hant-TW");
  await expect(page.getByRole("heading", { name: "AGES 價格方案" })).toBeVisible();
});

test("signed-in owners can find localized plans without changing their storage quota", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  const before = await (await context.request.get("/api/me")).json();
  await page.goto("/library");
  await page.getByRole("link", { name: "價格方案", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AGES 價格方案" }),
  ).toBeVisible();
  const after = await (await context.request.get("/api/me")).json();
  expect(after.quota).toEqual(before.quota);
});
