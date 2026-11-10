import { expect, test } from "@playwright/test";
import { seedLibrary } from "./fixtures";

test("visitors can review proposed plans without starting a paid subscription", async ({
  page,
}) => {
  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", { name: "Plans for your memories" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", {
      name: "Proposed monthly plans and creator-support platform fees",
    }),
  ).toBeVisible();
  for (const row of [
    "Free NT$0 / month 20%",
    "Plus NT$99 / month 10%",
    "Creator NT$299 / month 5%",
    "Pro NT$599 / month 2.5%",
  ]) {
    await expect(page.getByRole("row", { name: row })).toBeVisible();
  }
  await expect(
    page.getByText(
      "Plan prices and creator-support fees are proposals. Paid subscriptions and creator-support payments are not available yet.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Plan features, storage limits, and annual pricing have not been finalized.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /subscribe|purchase/i }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Plans for your memories" }),
  ).toBeVisible();
});

test("signed-in owners can find plans without changing their storage quota", async ({
  page,
  context,
}) => {
  await seedLibrary(context);
  const before = await (await context.request.get("/api/me")).json();
  await page.goto("/library");
  await page.getByRole("link", { name: "Plans", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Plans for your memories" }),
  ).toBeVisible();
  const after = await (await context.request.get("/api/me")).json();
  expect(after.quota).toEqual(before.quota);
});
