import { expect, test } from "@playwright/test";
import {
  e2eOrigin,
  e2eTrackingOrigin,
  seedLibrary,
  seedProviderLink,
} from "./fixtures";

test("local harness preserves isolated origins and HTTP behavior", async ({
  page,
}) => {
  const { owner } = await seedLibrary(page.context());
  const destination = "https://destination.example.test/landing?keep=1";
  const link = seedProviderLink(owner, "direct", destination);
  const staticResponses: Array<{ type: string; status: number }> = [];

  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (type === "script" || type === "stylesheet")
      staticResponses.push({ type, status: response.status() });
  });

  const appResponse = await page.goto(e2eOrigin);
  expect(appResponse?.status()).toBe(200);
  expect(
    staticResponses.some(
      ({ type, status }) => type === "script" && status === 200,
    ),
  ).toBe(true);
  expect(
    staticResponses.some(
      ({ type, status }) => type === "stylesheet" && status === 200,
    ),
  ).toBe(true);

  const appCookies = await page.context().cookies(e2eOrigin);
  const trackingCookies = await page.context().cookies(e2eTrackingOrigin);
  expect(appCookies.some((cookie) => cookie.name === "ages_session")).toBe(
    true,
  );
  expect(trackingCookies.some((cookie) => cookie.name === "ages_session")).toBe(
    false,
  );

  const headResponse = await page.request.fetch(`${e2eOrigin}/s/${link.slug}`, {
    method: "HEAD",
    maxRedirects: 0,
  });
  expect(headResponse.status()).toBe(302);
  const redirect = new URL(headResponse.headers().location ?? "");
  expect(redirect.origin).toBe(new URL(destination).origin);
  expect(redirect.pathname).toBe(new URL(destination).pathname);
});
