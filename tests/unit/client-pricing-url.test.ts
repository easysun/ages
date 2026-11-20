import { expect, it } from "vitest";
import { officialPricingUrl } from "../../src/client/pricing-url";

it("routes each supported locale to its fixed official pricing page", () => {
  expect(officialPricingUrl("en")).toBe("https://ages.tw/pricing-en");
  expect(officialPricingUrl("zh-Hant")).toBe("https://ages.tw/pricing");
});
