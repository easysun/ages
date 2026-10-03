import { describe, expect, it } from "vitest";
import { eventAtSchema } from "../../src/timeline/validation";

describe("Timeline calendar and instant semantics", () => {
  it("accepts named timezone aliases and preserves leap calendar dates", () => {
    for (const time_zone of [
      "UTC",
      "Asia/Taipei",
      "America/New_York",
      "US/Eastern",
    ]) {
      const value = {
        kind: "date",
        date: "2000-02-29",
        time_zone,
        calendar: "iso8601",
      };
      expect(eventAtSchema.parse(value)).toEqual(value);
    }
  });
  it("rejects numeric offsets as named timezones and invalid century leap dates", () => {
    for (const time_zone of ["+08:00", "-04:00", "Not/A_Zone", ""]) {
      expect(
        eventAtSchema.safeParse({
          kind: "date",
          date: "2024-02-29",
          time_zone,
          calendar: "iso8601",
        }).success,
      ).toBe(false);
    }
    for (const date of [
      "1900-02-29",
      "2100-02-29",
      "2024-04-31",
      "2024-13-01",
      "2024-00-01",
    ]) {
      expect(
        eventAtSchema.safeParse({
          kind: "date",
          date,
          time_zone: "UTC",
          calendar: "iso8601",
        }).success,
      ).toBe(false);
    }
  });
  it("normalizes an instant across a calendar boundary without dropping its named timezone", () => {
    expect(
      eventAtSchema.parse({
        kind: "instant",
        instant: "2026-01-01T00:30:00+08:00",
        time_zone: "Asia/Taipei",
      }),
    ).toEqual({
      kind: "instant",
      instant: "2025-12-31T16:30:00.000Z",
      time_zone: "Asia/Taipei",
    });
  });
  it("rejects missing precision metadata, unsupported calendars and mixed discriminators", () => {
    for (const value of [
      { kind: "date", date: "2024-01-01", time_zone: "UTC" },
      {
        kind: "date",
        date: "2024-01-01",
        time_zone: "UTC",
        calendar: "buddhist",
      },
      { kind: "instant", instant: "2024-01-01T00:00:00", time_zone: "UTC" },
      {
        kind: "instant",
        instant: "2024-01-01T00:00:00Z",
        time_zone: "UTC",
        date: "2024-01-01",
      },
    ])
      expect(eventAtSchema.safeParse(value).success).toBe(false);
  });
});
