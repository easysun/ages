import { expect, test } from "@playwright/test";
import { e2eOrigin } from "./fixtures";

test("local test account signs in without Google, survives refresh, and signs out", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Use local test account" }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/local-login-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use local test account" }).click();
  await expect(page).toHaveURL(`${e2eOrigin}/library`);
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  await expect(
    page.getByText("Local test account", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "ages_session")
      ?.httpOnly,
  ).toBe(true);
  await page.getByRole("link", { name: "Timelines", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your timelines" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Use local test account" }),
  ).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
});
