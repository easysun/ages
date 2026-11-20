import { expect, it } from "vitest";
import { browserLocale } from "../../src/client/locale";

it("selects the first supported browser preference after unsupported languages", () => {
  expect(browserLocale(["fr-FR", "zh-TW", "en-US"], "fr-FR")).toBe("zh-Hant");
  expect(browserLocale(["fr-FR", "en-US", "zh-TW"], "fr-FR")).toBe("en");
});

it("uses navigator.language when the preference list is empty or unavailable", () => {
  expect(browserLocale([], "zh-TW")).toBe("zh-Hant");
  expect(browserLocale(undefined, "zh-TW")).toBe("zh-Hant");
});

it("uses the default when no listed language is supported", () => {
  expect(browserLocale(["fr-FR"], "zh-TW")).toBe("en");
});
