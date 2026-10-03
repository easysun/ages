import { describe, expect, it } from "vitest";
import {
  fitViewport,
  panViewport,
  resizeViewport,
  screenToWorld,
  type Viewport,
  worldToScreen,
  zoomViewport,
} from "../../src/timeline/viewport";

const limits = { minSpan: 10, maxSpan: 100_000 };
const options = { ...limits, extent: 1000, padding: 50 };

describe("Initial timeline framing", () => {
  it("fits story bounds with exact screen padding when within scale limits", () => {
    const bounds = Object.freeze({ start: -200, end: 400 });
    const view = fitViewport(bounds, options);
    expect(view).not.toBeNull();
    expect(worldToScreen(view as Viewport, bounds.start, 1000)).toBeCloseTo(50);
    expect(worldToScreen(view as Viewport, bounds.end, 1000)).toBeCloseTo(950);
    expect(bounds).toEqual({ start: -200, end: 400 });
  });

  it("keeps empty and single-event timelines usable without infinite magnification", () => {
    expect(fitViewport(null, options)).toEqual({ center: 0, span: 10 });
    expect(fitViewport({ start: 42, end: 42 }, options)).toEqual({
      center: 42,
      span: 10,
    });
  });

  it.each([0, 50, 100])(
    "defers initial fit when the measured extent is %s",
    (extent) => {
      expect(
        fitViewport({ start: 1, end: 2 }, { ...options, extent }),
      ).toBeNull();
    },
  );

  it("obeys configured limits rather than claiming every range can fit at readable scale", () => {
    expect(fitViewport({ start: 0, end: 200_000 }, options)).toEqual({
      center: 100_000,
      span: limits.maxSpan,
    });
  });
});

describe("Content-independent viewport navigation", () => {
  it.each([0, 0.25, 0.5, 0.75, 1])(
    "preserves the world coordinate at zoom anchor %s",
    (anchor) => {
      const view = Object.freeze({ center: 1500, span: 1000 });
      const before = screenToWorld(view, anchor * 1000, 1000);
      for (const [factor, expectedSpan] of [
        [0.5, 2000],
        [2, 500],
        [1e8, 10],
        [1e-4, 100_000],
      ] as const) {
        const zoomed = zoomViewport(view, factor, anchor, limits);
        expect(zoomed.span).toBe(expectedSpan);
        expect(screenToWorld(zoomed, anchor * 1000, 1000)).toBeCloseTo(before);
        expect(zoomed.span).toBeGreaterThanOrEqual(limits.minSpan);
        expect(zoomed.span).toBeLessThanOrEqual(limits.maxSpan);
      }
      expect(view).toEqual({ center: 1500, span: 1000 });
    },
  );

  it("round-trips large event-time coordinates within one millisecond", () => {
    const view = { center: 1_800_000_000_000, span: 86_400_000 };
    for (let index = -100; index <= 100; index++) {
      const coordinate = view.center + index * 123_456.789;
      const result = screenToWorld(
        view,
        worldToScreen(view, coordinate, 375),
        375,
      );
      expect(Math.abs(result - coordinate)).toBeLessThan(0.001);
    }
  });

  it("does not accumulate visible drift from repeated reciprocal zoom operations", () => {
    const initial = { center: 1_800_000_000_000, span: 1000 };
    let view = initial;
    for (let index = 0; index < 1000; index++) {
      view = zoomViewport(view, 1.25, 0.37, limits);
      view = zoomViewport(view, 0.8, 0.37, limits);
    }
    expect(
      Math.abs(worldToScreen(view, initial.center, 1000) - 500),
    ).toBeLessThan(0.1);
    expect(view.span).toBeCloseTo(initial.span);
  });

  it("moves content with the pointer without rewriting coordinates", () => {
    const initial = Object.freeze({ center: 100, span: 1000 });
    const moved = panViewport(initial, 50, 500);
    expect(worldToScreen(moved, 100, 500)).toBe(300);
    expect(panViewport(moved, -50, 500)).toEqual(initial);
  });

  it("preserves manual focus and units per pixel on responsive resize", () => {
    const view = { center: 4200, span: 1000 };
    const mobile = resizeViewport(view, 1000, 375, limits);
    expect(mobile).toEqual({ center: 4200, span: 375 });
    expect(worldToScreen(mobile, 4200, 375)).toBe(187.5);
    expect(resizeViewport(mobile, 375, 1000, limits)).toEqual(view);
    expect(resizeViewport(view, 1000, 1, limits)).toEqual({
      center: 4200,
      span: 10,
    });
    expect(resizeViewport(view, 1000, 1_000_000, limits)).toEqual({
      center: 4200,
      span: 100_000,
    });
  });

  it("rejects invalid geometry instead of leaking NaN into a renderer", () => {
    const view = { center: 100, span: 1000 };
    const invalid = [
      () => fitViewport({ start: 2, end: 1 }, options),
      () => fitViewport({ start: Number.NaN, end: 1 }, options),
      () => fitViewport(null, { ...options, minSpan: 0 }),
      () => fitViewport(null, { ...options, maxSpan: 1 }),
      () => fitViewport(null, { ...options, padding: -1 }),
      () => fitViewport(null, { ...options, extent: Number.POSITIVE_INFINITY }),
      () => worldToScreen({ center: 0, span: 0 }, 0, 100),
      () => screenToWorld(view, 0, 0),
      () => zoomViewport(view, 0, 0.5, limits),
      () => zoomViewport(view, 2, 1.1, limits),
      () => panViewport(view, Number.NaN, 100),
      () => resizeViewport(view, 0, 100, limits),
    ];
    for (const operation of invalid) expect(operation).toThrow(RangeError);
  });
});
