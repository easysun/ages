import { expect, it } from "vitest";
import { errorMessage, RequestError } from "../../src/client/api";

it("keeps the existing English error messages for callers without a locale", () => {
  expect(
    errorMessage(new RequestError("RATE_LIMITED", "Too many requests.", 429)),
  ).toBe("Too many requests.");
  expect(errorMessage(new Error("network"))).toContain(
    "connection was interrupted",
  );
});

it("uses Chinese messages for known error codes without exposing unknown server messages", () => {
  expect(
    errorMessage(
      new RequestError("RATE_LIMITED", "Too many requests.", 429),
      "zh-Hant",
    ),
  ).toBe("操作太頻繁，請稍後再試。");
  expect(
    errorMessage(
      new RequestError("QUOTA_EXCEEDED", "Storage quota exceeded.", 403),
      "zh-Hant",
    ),
  ).toContain("儲存空間不足");
  expect(
    errorMessage(
      new RequestError("NEW_CODE", "Unexpected server message", 500),
      "zh-Hant",
    ),
  ).toBe("目前無法完成操作，請稍後再試。");
  expect(errorMessage(new Error("network"), "zh-Hant")).toBe(
    "連線中斷，請檢查網路後再試。",
  );
});
