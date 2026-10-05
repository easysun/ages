import { describe, expect, it } from "vitest";
import {
  applyLinkParameters,
  type LinkTracking,
  linkTrackingSchema,
} from "../../src/links/tracking";

const emptyTracking: LinkTracking = {
  tags: [],
  channels: [],
  utm: {},
  custom: [],
};

describe("Link tracking parameters", () => {
  it("literal_query_values_preserve_unrelated_fields", () => {
    const settings: LinkTracking = {
      ...emptyTracking,
      utm: { utm_source: "travel" },
    };
    expect(
      applyLinkParameters(
        "https://example.org/?keep=1#part",
        settings,
        "https://ages.test",
      ),
    ).toBe("https://example.org/?keep=1&utm_source=travel#part");

    const changed = applyLinkParameters(
      "https://example.org/?keep=1&keep=2&utm_source=old#part",
      {
        ...emptyTracking,
        utm: { utm_source: "a+b & c" },
        custom: [
          { key: "note", value: "旅行 / one" },
          { key: "empty", value: "" },
        ],
      },
      "https://ages.test",
    );
    const url = new URL(changed);
    expect(url.searchParams.getAll("keep")).toEqual(["1", "2"]);
    expect(url.searchParams.get("utm_source")).toBe("a+b & c");
    expect(url.searchParams.get("note")).toBe("旅行 / one");
    expect(url.searchParams.get("empty")).toBe("");
    expect(url.hash).toBe("#part");
  });

  it("leaves application-origin destinations untouched and rejects non-HTTP URLs", () => {
    const destination = "https://ages.test/t/private?utm_source=old#part";
    expect(
      applyLinkParameters(
        destination,
        { ...emptyTracking, utm: { utm_source: "travel" } },
        "https://ages.test",
      ),
    ).toBe(destination);
    expect(() =>
      applyLinkParameters(
        "javascript:alert(1)",
        emptyTracking,
        "https://ages.test",
      ),
    ).toThrow();
  });

  it("accepts the exact label, custom parameter, and UTM limits", () => {
    const value = {
      tags: Array.from({ length: 20 }, (_, index) => `tag${index}`),
      channels: Array.from({ length: 20 }, (_, index) => `channel${index}`),
      utm: {
        utm_source: "",
        utm_medium: "medium",
        utm_campaign: "campaign",
        utm_term: "term",
        utm_content: "content",
      },
      custom: Array.from({ length: 10 }, (_, index) => ({
        key: `${index}${"k".repeat(39)}`,
        value: "v".repeat(100),
      })),
    };
    expect(linkTrackingSchema.safeParse(value).success).toBe(true);
    expect(
      linkTrackingSchema.safeParse({ ...value, tags: [...value.tags, "extra"] })
        .success,
    ).toBe(false);
    expect(
      linkTrackingSchema.safeParse({
        ...value,
        channels: [...value.channels, "extra"],
      }).success,
    ).toBe(false);
    expect(
      linkTrackingSchema.safeParse({
        ...value,
        custom: [...value.custom, { key: "extra", value: "" }],
      }).success,
    ).toBe(false);
    expect(
      linkTrackingSchema.safeParse({
        ...emptyTracking,
        custom: [{ key: "k".repeat(41), value: "" }],
      }).success,
    ).toBe(false);
    expect(
      linkTrackingSchema.safeParse({
        ...emptyTracking,
        custom: [{ key: "key", value: "v".repeat(101) }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicates, reserved keys, and parameter control characters", () => {
    for (const value of [
      { ...emptyTracking, tags: ["same", "same"] },
      { ...emptyTracking, channels: ["same", "same"] },
      {
        ...emptyTracking,
        custom: [
          { key: "key", value: "one" },
          { key: "key", value: "two" },
        ],
      },
      ...[
        "utm_source",
        "UTM_value",
        "ages_channel",
        "__proto__",
        "prototype",
        "constructor",
      ].map((key) => ({ ...emptyTracking, custom: [{ key, value: "x" }] })),
      { ...emptyTracking, custom: [{ key: "bad\u0001key", value: "x" }] },
      { ...emptyTracking, custom: [{ key: "key", value: "bad\u007fvalue" }] },
    ])
      expect(linkTrackingSchema.safeParse(value).success).toBe(false);
  });
});
