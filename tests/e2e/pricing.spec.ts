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
    page.getByRole("heading", { name: "Monthly plans" }),
  ).toBeVisible();
  const plans = page.getByRole("table", { name: "Proposed monthly prices" });
  for (const row of [
    "Free NT$0 / month",
    "Plus NT$99 / month",
    "Creator NT$299 / month",
    "Pro NT$599 / month",
  ]) {
    await expect(plans.getByRole("row", { name: row })).toBeVisible();
  }

  await expect(
    page.getByRole("heading", { name: "Creator-support fees" }),
  ).toBeVisible();
  const fees = page.getByRole("table", {
    name: "Proposed platform fees on creator support",
  });
  for (const row of ["Free 20%", "Plus 10%", "Creator 5%", "Pro 2.5%"]) {
    await expect(fees.getByRole("row", { name: row })).toBeVisible();
  }
  await expect(plans.getByText(/%/)).toHaveCount(0);
  await expect(fees.getByText(/NT\$/)).toHaveCount(0);
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
