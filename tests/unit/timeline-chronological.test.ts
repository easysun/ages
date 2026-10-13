import { describe, expect, it, vi } from "vitest";
import {
  aggregateDateBins,
  buildChronologicalIndex,
  type ChronologicalIndex,
  type ChronologicalOverviewRow,
  pageChoices,
} from "../../src/timeline/chronological";
import { eventAtSchema } from "../../src/timeline/validation";
import { groupPositionsByScreenBin } from "../../src/timeline/viewport";

const epochDayMs = 86_400_000;

function dateEvent(date: string, time_zone = "UTC") {
  return { kind: "date", date, time_zone, calendar: "iso8601" };
}

function instantEvent(instant: string, time_zone = "UTC") {
  return { kind: "instant", instant, time_zone };
}

function row(
  id: string,
  position: number,
  event_at: unknown,
): ChronologicalOverviewRow {
  return { id, position, event_at };
}

function dateAtOrdinal(dayOrdinal: number, time_zone = "UTC") {
  const date = new Date(dayOrdinal * epochDayMs).toISOString().slice(0, 10);
  return dateEvent(date, time_zone);
}

function tracked<T>(values: readonly T[]) {
  let indexedReads = 0;
  const items = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property))
        indexedReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  return { items, indexedReads: () => indexedReads };
}

function withTrackedDates(
  index: ChronologicalIndex,
  dates: readonly ChronologicalIndex["dates"][number][],
) {
  return { ...index, dates };
}

describe("Chronological timeline projection", () => {
  it("maps_date_labels_to_gregorian_ordinals_without_timezone_conversion", () => {
    const index = buildChronologicalIndex([
      row("year-zero", 0, dateEvent("0000-01-01")),
      row("year-zero-leap", 1, dateEvent("0000-02-29")),
      row("century-leap", 2, dateEvent("1600-02-29")),
      row("century-common", 3, dateEvent("1900-02-28")),
      row("millennium-leap", 4, dateEvent("2000-02-29")),
      row("next-century", 5, dateEvent("2100-03-01")),
      row("epoch", 6, dateEvent("1970-01-01")),
      row("last-label", 7, dateEvent("9999-12-31")),
      row("apia-before", 8, dateEvent("2011-12-29", "Pacific/Apia")),
      row("apia-skipped", 9, dateEvent("2011-12-30", "Pacific/Apia")),
      row("z-utc", 10, dateEvent("2011-12-29", "UTC")),
      row("a-utc", 0, dateEvent("2011-12-29", "UTC")),
      row("m-pacific", 5, dateEvent("2011-12-29", "Pacific/Auckland")),
    ]);
    const byId = new Map(index.dates.map((item) => [item.id, item]));

    expect(byId.get("year-zero")?.dayOrdinal).toBe(-719528);
    expect(byId.get("year-zero-leap")?.dayOrdinal).toBe(-719469);
    expect(byId.get("century-leap")?.dayOrdinal).toBe(-135081);
    expect(byId.get("century-common")?.dayOrdinal).toBe(-25509);
    expect(byId.get("millennium-leap")?.dayOrdinal).toBe(11016);
    expect(byId.get("next-century")?.dayOrdinal).toBe(47541);
    expect(byId.get("epoch")?.dayOrdinal).toBe(0);
    expect(byId.get("last-label")?.dayOrdinal).toBe(2932896);
    expect(byId.get("apia-skipped")?.dayOrdinal).toBe(
      (byId.get("apia-before")?.dayOrdinal as number) + 1,
    );
    expect(byId.get("apia-skipped")).toMatchObject({
      date: "2011-12-30",
      time_zone: "Pacific/Apia",
      start: (byId.get("apia-before")?.dayOrdinal as number) + 1,
      end: (byId.get("apia-before")?.dayOrdinal as number) + 2,
    });
    expect(
      index.dates.every(
        (item, position, items) =>
          position === 0 ||
          (items[position - 1]?.dayOrdinal as number) <= item.dayOrdinal,
      ),
    ).toBe(true);
    expect(
      index.dates
        .filter((item) => item.date === "2011-12-29")
        .map((item) => item.id),
    ).toEqual(["apia-before", "m-pacific", "a-utc", "z-utc"]);

    const realDate = Date;
    const dateInputs: string[] = [];
    vi.stubGlobal(
      "Date",
      new Proxy(realDate, {
        construct(target, args, newTarget) {
          if (typeof args[0] === "string") dateInputs.push(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
        get(target, property, receiver) {
          if (property === "parse")
            return (value: string | number) => {
              dateInputs.push(String(value));
              return Reflect.apply(target.parse, target, [value]);
            };
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    let labelOnlyIndex: ChronologicalIndex | undefined;
    try {
      labelOnlyIndex = buildChronologicalIndex([
        row("skipped-label", 0, dateEvent("2011-12-30", "Pacific/Apia")),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(labelOnlyIndex?.dates[0]?.date).toBe("2011-12-30");
    expect(dateInputs).toEqual([]);
  });

  it("normalizes_exact_instants_to_utc_epochs_and_orders_equal_points_by_id", () => {
    const taipeiEvent = eventAtSchema.parse({
      kind: "instant",
      instant: "2026-01-01T00:30:00+08:00",
      time_zone: "Asia/Taipei",
    });
    const utcEvent = eventAtSchema.parse({
      kind: "instant",
      instant: "2025-12-31T16:30:00Z",
      time_zone: "UTC",
    });
    if (taipeiEvent.kind !== "instant" || utcEvent.kind !== "instant")
      throw new Error("Expected the event schema to return instant values.");
    expect(taipeiEvent.instant).toBe("2025-12-31T16:30:00.000Z");
    expect(utcEvent.instant).toBe(taipeiEvent.instant);

    const index = buildChronologicalIndex([
      row("same-b", 0, taipeiEvent),
      row("same-a", 9, utcEvent),
      row("earlier", 1, instantEvent("2025-12-31T15:30:00.000Z")),
      row("date-label", 20, dateEvent("2024-01-01")),
    ]);
    expect(index.instants.map((item) => item.id)).toEqual([
      "earlier",
      "same-a",
      "same-b",
    ]);
    expect(index.instants.map((item) => item.time_zone)).toEqual([
      "UTC",
      "UTC",
      "Asia/Taipei",
    ]);
    expect(index.instantCoordinates).toEqual([
      Date.parse("2025-12-31T15:30:00.000Z"),
      Date.parse("2025-12-31T16:30:00.000Z"),
      Date.parse("2025-12-31T16:30:00.000Z"),
    ]);

    const movedStory = buildChronologicalIndex([
      row("same-b", 12, taipeiEvent),
      row("same-a", 0, utcEvent),
      row("earlier", 99, instantEvent("2025-12-31T15:30:00.000Z")),
      row("date-label", 100, dateEvent("2024-01-01")),
    ]);
    expect(movedStory.instantCoordinates).toEqual(index.instantCoordinates);
    expect(
      movedStory.dates.map(({ id, start, end }) => ({ id, start, end })),
    ).toEqual(index.dates.map(({ id, start, end }) => ({ id, start, end })));
    expect(index.storyOrdinalById.get("same-a")).toBe(3);
    expect(movedStory.storyOrdinalById.get("same-a")).toBe(1);

    const boundaryIndex = buildChronologicalIndex([
      row("minimum", 0, instantEvent("-271821-04-20T00:00:00.000Z")),
      row("maximum", 1, instantEvent("+275760-09-13T00:00:00.000Z")),
    ]);
    expect(boundaryIndex.instantCoordinates).toEqual([-8.64e15, 8.64e15]);
    for (const instant of [
      "2024-02-30T00:00:00.000Z",
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00.000+01:00",
      "+275760-09-13T00:00:00.001Z",
      "-271821-04-19T23:59:59.999Z",
    ]) {
      expect(() =>
        buildChronologicalIndex([row("invalid", 0, instantEvent(instant))]),
      ).toThrow();
    }
  });

  it("keeps_null_events_undated_and_rejects_malformed_projection_rows", () => {
    const index = buildChronologicalIndex([
      row("null-last", 2, null),
      row("null-z", 1, null),
      row("null-a", 1, null),
      row("dated", 0, dateEvent("2024-03-01")),
    ]);
    expect(index.undated).toEqual([
      { id: "null-a", position: 1 },
      { id: "null-z", position: 1 },
      { id: "null-last", position: 2 },
    ]);
    expect(index.dates.map((item) => item.id)).toEqual(["dated"]);
    expect(index.storyOrdinalById).toEqual(
      new Map([
        ["dated", 1],
        ["null-a", 2],
        ["null-z", 3],
        ["null-last", 4],
      ]),
    );

    const malformedEvents: unknown[] = [
      undefined,
      "",
      {},
      { kind: "date", date: "2024-03-01", time_zone: "UTC" },
      { ...dateEvent("2024-03-01"), extra: true },
      dateEvent("1900-02-29"),
      dateEvent("2024-03-01", "+08:00"),
      { ...dateEvent("2024-03-01"), calendar: "buddhist" },
      { kind: "instant", instant: "2024-03-01", time_zone: "UTC" },
      { ...instantEvent("2024-03-01T00:00:00.000Z"), date: "2024-03-01" },
    ];
    for (const event_at of malformedEvents)
      expect(() =>
        buildChronologicalIndex([row("invalid", 0, event_at)]),
      ).toThrow();

    expect(() =>
      buildChronologicalIndex([
        { id: "missing-event", position: 0 } as ChronologicalOverviewRow,
      ]),
    ).toThrow();
    expect(() =>
      buildChronologicalIndex([
        {
          ...row("fallback", 0, null),
          captured_at: "2024-03-01",
        } as ChronologicalOverviewRow,
      ]),
    ).toThrow();
    expect(() =>
      buildChronologicalIndex([
        row("duplicate", 0, null),
        row("duplicate", 1, dateEvent("2024-03-01")),
      ]),
    ).toThrow();
  });

  it("aggregates_clipped_date_spans_with_unique_midpoint_membership", () => {
    const index = buildChronologicalIndex([
      row("viewport-left-touch", 0, dateAtOrdinal(-2)),
      row("before-b", 2, dateAtOrdinal(-1)),
      row("before-a", 1, dateAtOrdinal(-1)),
      row("after", 3, dateAtOrdinal(0)),
      row("viewport-right-touch", 4, dateAtOrdinal(1)),
    ]);
    const view = { center: 0, span: 2 };
    const aggregates = aggregateDateBins(index, view, 192);

    expect(aggregates).toEqual([
      {
        bin: 0,
        pixelStart: 0,
        pixelEnd: 48,
        spanCoverageCount: 2,
        itemCount: 0,
        firstItemIndex: 1,
        endItemIndex: 1,
        firstDate: null,
        lastDate: null,
      },
      {
        bin: 1,
        pixelStart: 48,
        pixelEnd: 96,
        spanCoverageCount: 2,
        itemCount: 2,
        firstItemIndex: 1,
        endItemIndex: 3,
        firstDate: "1969-12-31",
        lastDate: "1969-12-31",
      },
      {
        bin: 2,
        pixelStart: 96,
        pixelEnd: 144,
        spanCoverageCount: 1,
        itemCount: 0,
        firstItemIndex: 3,
        endItemIndex: 3,
        firstDate: null,
        lastDate: null,
      },
      {
        bin: 3,
        pixelStart: 144,
        pixelEnd: 192,
        spanCoverageCount: 1,
        itemCount: 1,
        firstItemIndex: 3,
        endItemIndex: 4,
        firstDate: "1970-01-01",
        lastDate: "1970-01-01",
      },
    ]);

    const clippedView = { center: 0, span: 1 };
    const clipped = aggregateDateBins(index, clippedView, 192);
    expect(clipped).toHaveLength(4);
    for (const aggregate of clipped) {
      const left =
        clippedView.center -
        clippedView.span / 2 +
        (aggregate.pixelStart / 192) * clippedView.span;
      const right =
        clippedView.center -
        clippedView.span / 2 +
        (aggregate.pixelEnd / 192) * clippedView.span;
      const coverageOracle = index.dates.filter(
        (item) => item.start < right && item.end > left,
      );
      expect(aggregate.spanCoverageCount).toBe(coverageOracle.length);
      const memberOracle = index.dates.filter((item) => {
        if (item.end <= -0.5 || item.start >= 0.5) return false;
        const clippedStart = Math.max(item.start, -0.5);
        const clippedEnd = Math.min(item.end, 0.5);
        const midpoint = (clippedStart + clippedEnd) / 2;
        const pixel = ((midpoint + 0.5) / 1) * 192;
        return pixel >= aggregate.pixelStart && pixel < aggregate.pixelEnd;
      });
      expect(aggregate.itemCount).toBe(memberOracle.length);
    }
    const membership = new Map<string, number>();
    for (const aggregate of clipped) {
      const page = pageChoices(index.dates, {
        firstItemIndex: aggregate.firstItemIndex,
        endItemIndex: aggregate.endItemIndex,
      });
      for (const item of page.items)
        membership.set(item.id, (membership.get(item.id) ?? 0) + 1);
    }
    expect([...membership.entries()].sort()).toEqual([
      ["after", 1],
      ["before-a", 1],
      ["before-b", 1],
    ]);
    expect(
      clipped.filter((aggregate) => aggregate.spanCoverageCount > 0),
    ).toHaveLength(4);
  });

  it("performs_bounded_binary_search_work_for_fit_all_10k_dates", () => {
    const index = buildChronologicalIndex(
      Array.from({ length: 10_000 }, (_, position) =>
        row(
          `date-${String(position).padStart(5, "0")}`,
          position,
          dateEvent("1970-01-01"),
        ),
      ),
    );
    const fixture = tracked(index.dates);
    const aggregates = aggregateDateBins(
      withTrackedDates(index, fixture.items),
      { center: 0.5, span: 1 },
      960,
    );
    const binCount = 20;
    const maximumSearchReads =
      4 * Math.ceil(Math.log2(index.dates.length + 1)) * binCount;

    expect(aggregates).toHaveLength(binCount);
    expect(
      aggregates.every((aggregate) => aggregate.spanCoverageCount === 10_000),
    ).toBe(true);
    expect(
      aggregates.reduce((sum, aggregate) => sum + aggregate.itemCount, 0),
    ).toBe(10_000);
    expect(
      aggregates.filter((aggregate) => aggregate.itemCount > 0),
    ).toHaveLength(1);
    expect(fixture.indexedReads()).toBeLessThanOrEqual(
      maximumSearchReads + 2 * binCount,
    );
  });

  it("bounds_sparse_date_queries_and_excludes_offscreen_rows", () => {
    const index = buildChronologicalIndex(
      Array.from({ length: 10_000 }, (_, year) =>
        row(
          `year-${String(year).padStart(4, "0")}`,
          year,
          dateEvent(`${String(year).padStart(4, "0")}-01-01`),
        ),
      ),
    );
    const center = (index.dates[5_000]?.dayOrdinal as number) + 0.5;
    const fixture = tracked(index.dates);
    const aggregates = aggregateDateBins(
      withTrackedDates(index, fixture.items),
      { center, span: 2 },
      960,
    );
    const maximumSearchReads =
      4 * Math.ceil(Math.log2(index.dates.length + 1)) * 20;

    expect(aggregates).toHaveLength(10);
    expect(
      aggregates.reduce((sum, aggregate) => sum + aggregate.itemCount, 0),
    ).toBe(1);
    expect(
      aggregates.reduce(
        (sum, aggregate) => sum + aggregate.spanCoverageCount,
        0,
      ),
    ).toBe(10);
    expect(fixture.indexedReads()).toBeLessThanOrEqual(
      maximumSearchReads + 2 * aggregates.length,
    );
  });

  it("pages_group_choices_without_enumerating_remaining_ids", () => {
    const dateRows = Array.from({ length: 10_000 }, (_, index) =>
      row(
        `date-${String(index).padStart(5, "0")}`,
        index,
        dateEvent("2024-01-01"),
      ),
    );
    const instantRows = Array.from({ length: 10_000 }, (_, index) =>
      row(
        `instant-${String(index).padStart(5, "0")}`,
        index,
        instantEvent("2024-01-01T00:00:00.000Z"),
      ),
    );
    const undatedRows = Array.from({ length: 10_000 }, (_, index) =>
      row(`undated-${String(index).padStart(5, "0")}`, index % 2, null),
    );
    const index = buildChronologicalIndex([
      ...dateRows,
      ...instantRows,
      ...undatedRows,
    ]);
    const dateGroup = aggregateDateBins(
      index,
      {
        center: (index.dates[0]?.dayOrdinal as number) + 0.5,
        span: 1,
      },
      960,
    ).find((aggregate) => aggregate.itemCount > 0);
    if (!dateGroup) throw new Error("Expected a nonempty date group.");
    const dateFixture = tracked(index.dates);
    const datePage = pageChoices(
      dateFixture.items,
      {
        firstItemIndex: dateGroup.firstItemIndex,
        endItemIndex: dateGroup.endItemIndex,
      },
      0,
      1000,
    );
    expect(datePage.items).toHaveLength(100);
    expect(datePage.items[0]?.id).toBe("date-00000");
    expect(datePage.items[99]?.id).toBe("date-00099");
    expect(datePage.nextOffset).toBe(100);
    expect(dateFixture.indexedReads()).toBe(100);
    expect(
      pageChoices(
        dateFixture.items,
        {
          firstItemIndex: dateGroup.firstItemIndex,
          endItemIndex: dateGroup.endItemIndex,
        },
        9900,
        100,
      ).nextOffset,
    ).toBe(null);

    const instantGroup = groupPositionsByScreenBin(
      index.instantCoordinates,
      { center: index.instantCoordinates[0] as number, span: 1000 },
      960,
    )[0];
    if (!instantGroup) throw new Error("Expected a nonempty instant group.");
    const instantFixture = tracked(index.instants);
    const instantPage = pageChoices(
      instantFixture.items,
      {
        firstItemIndex: instantGroup.first - 1,
        endItemIndex: instantGroup.last,
      },
      0,
      1000,
    );
    expect(instantPage.items).toHaveLength(100);
    expect(instantPage.items[0]?.id).toBe("instant-00000");
    expect(instantPage.items[99]?.id).toBe("instant-00099");
    expect(instantPage.nextOffset).toBe(100);
    expect(instantFixture.indexedReads()).toBe(100);

    const undatedFixture = tracked(index.undated);
    const undatedPage = pageChoices(
      undatedFixture.items,
      { firstItemIndex: 0, endItemIndex: index.undated.length },
      0,
      1000,
    );
    expect(undatedPage.items).toHaveLength(100);
    expect(undatedPage.items[0]?.id).toBe("undated-00000");
    expect(undatedPage.items[99]?.id).toBe("undated-00198");
    expect(undatedPage.nextOffset).toBe(100);
    expect(undatedFixture.indexedReads()).toBe(100);
  });
});
