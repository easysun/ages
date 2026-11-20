import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { LocaleProvider, useLocale } from "../../src/client/i18n";

function CurrentLocale() {
  return createElement("span", null, useLocale().locale);
}

function renderLocale(
  languages: readonly string[],
  language: string,
  saved: string | null = null,
  cookie = "",
) {
  vi.stubGlobal("window", { localStorage: { getItem: () => saved } });
  vi.stubGlobal("document", { cookie });
  vi.stubGlobal("navigator", { language, languages });
  return renderToString(
    createElement(LocaleProvider, null, createElement(CurrentLocale)),
  );
}

afterEach(() => vi.unstubAllGlobals());

it("selects the first supported browser preference when earlier languages are unsupported", () => {
  expect(renderLocale(["fr-FR", "zh-TW", "en-US"], "fr-FR")).toContain(
    ">zh-Hant<",
  );
  expect(renderLocale(["fr-FR", "en-US", "zh-TW"], "fr-FR")).toContain(">en<");
});

it("uses the single browser language only when its preference list is empty", () => {
  expect(renderLocale([], "zh-TW")).toContain(">zh-Hant<");
  expect(renderLocale(["fr-FR"], "zh-TW")).toContain(">en<");
});

it("keeps saved and cookie preferences ahead of browser preferences", () => {
  expect(
    renderLocale(["zh-TW"], "zh-TW", "en", "ages_locale=zh-Hant"),
  ).toContain(">en<");
  expect(renderLocale(["zh-TW"], "zh-TW", null, "ages_locale=en")).toContain(
    ">en<",
  );
});

it("falls back to cookie and then browser preferences when local storage is unavailable", () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw new Error("storage blocked");
      },
    },
  });
  vi.stubGlobal("document", { cookie: "ages_locale=zh-Hant" });
  vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
  expect(
    renderToString(
      createElement(LocaleProvider, null, createElement(CurrentLocale)),
    ),
  ).toContain(">zh-Hant<");
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("navigator", {
    language: "fr-FR",
    languages: ["fr-FR", "zh-TW"],
  });
  expect(
    renderToString(
      createElement(LocaleProvider, null, createElement(CurrentLocale)),
    ),
  ).toContain(">zh-Hant<");
});

it("uses navigator.language when the preference list is unavailable", () => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("navigator", { language: "zh-TW" });
  expect(
    renderToString(
      createElement(LocaleProvider, null, createElement(CurrentLocale)),
    ),
  ).toContain(">zh-Hant<");
});
