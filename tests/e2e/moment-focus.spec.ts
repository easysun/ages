import { expect, test } from "@playwright/test";
import { photo, putFixture, seedLibrary, seedTimeline } from "./fixtures";

test("a photo uploaded during the initial library read remains available for reuse and cover selection", async ({
  page,
  context,
}) => {
  const { owner } = await seedLibrary(context, { empty: true });
  const { id } = seedTimeline(owner, [], 0);
  const initialPage = await context.request.get("/api/assets?limit=100");
  expect((await initialPage.json()).assets).toEqual([]);
  const picker = page.getByRole("dialog", { name: "Add moments" });
  await page.route("**/api/assets?limit=100", async (route) => {
    await picker.waitFor();
    await route.fulfill({ response: initialPage });
  });
  const file = photo(160, 100);
  await page.route("https://*.r2.cloudflarestorage.com/**", async (route) => {
    const key = new URL(route.request().url()).pathname
      .split("/")
      .slice(2)
      .join("/");
    putFixture(key, file);
    await route.fulfill({ status: 200 });
  });
  await page.goto(`/timelines/${id}`);
  await expect(
    page.getByRole("button", { name: "Upload photo" }),
  ).toBeEnabled();
  await page.getByLabel("Choose a photo").setInputFiles({
    name: "Late library.png",
    mimeType: "image/png",
    buffer: file,
  });
  await expect(
    page
      .getByRole("group", { name: "Moment 1", exact: true })
      .getByRole("button", { name: "Edit moment" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Add moments", exact: true }).click();
  await expect(picker.getByText("Loading library…")).toBeHidden();
  await expect(
    picker.getByRole("checkbox", { name: "Select Late library.png" }),
  ).toHaveCount(1);
  await picker.getByRole("button", { name: "Close moment picker" }).click();
  await expect(
    page
      .getByLabel("Cover", { exact: true })
      .getByRole("option", { name: "Late library.png" }),
  ).toHaveCount(1);
});

for (const lost of ["append response", "tail page"] as const) {
  test(`a lost ${lost} returns keyboard focus to the appended moment across a page boundary`, async ({
    page,
    context,
  }) => {
    const { owner, ids } = await seedLibrary(context);
    const { id } = seedTimeline(owner, ids, 100);
    const path = `**/api/timelines/${id}`;
    if (lost === "append response") {
      await page.route(
        `${path}/items`,
        async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(204);
          await route.abort("connectionreset");
        },
        { times: 1 },
      );
    } else {
      await page.route(`${path}/overview?**`, (route) => {
        if (new URL(route.request().url()).searchParams.get("limit") === "2")
          return route.abort("connectionreset");
        return route.continue();
      });
    }
    await page.goto(`/timelines/${id}`);
    await page.getByRole("button", { name: "Write text" }).click();
    await page
      .getByRole("textbox", { name: "Moment text" })
      .fill("An accessible ending");
    const add = page.getByRole("button", { name: "Add text moment" });
    await add.press("Enter");
    if (lost === "append response") {
      await expect(
        page.getByText(/The save could not be confirmed/),
      ).toBeVisible();
      await add.press("Enter");
    }
    const ending = page.getByRole("group", { name: "Moment 101", exact: true });
    await expect(
      ending.getByRole("button", { name: "Edit moment" }),
    ).toBeFocused();
    await expect(ending.getByText("An accessible ending")).toBeVisible();
  });
}
