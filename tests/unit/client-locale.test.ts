import { expect, it } from "vitest";
import { supportedLocale } from "../../src/client/locale";

it("recognizes a saved Taiwan locale without rejecting the user's language", () => {
  expect(supportedLocale("zh-TW")).toBe("zh-Hant");
});

it("keeps canonical choices and ignores unsupported saved preferences", () => {
  expect(supportedLocale("en")).toBe("en");
  expect(supportedLocale("zh-Hant")).toBe("zh-Hant");
  expect(supportedLocale("fr")).toBeNull();
  expect(supportedLocale(null)).toBeNull();
});
