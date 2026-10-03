/** Logical coordinates may represent story layout or interpreted event time. */
export type Interval = Readonly<{ start: number; end: number }>;
export type Viewport = Readonly<{ center: number; span: number }>;
export type SpanLimits = Readonly<{ minSpan: number; maxSpan: number }>;
export type FitOptions = SpanLimits &
  Readonly<{ extent: number; padding: number }>;

function finite(...values: number[]) {
  if (!values.every(Number.isFinite))
    throw new RangeError("Viewport values must be finite.");
}

function positive(value: number) {
  finite(value);
  if (value <= 0) throw new RangeError("Viewport size must be positive.");
}

function checkViewport(view: Viewport) {
  finite(view.center);
  positive(view.span);
}

function clampSpan(span: number, limits: SpanLimits) {
  finite(span);
  positive(limits.minSpan);
  positive(limits.maxSpan);
  if (limits.minSpan > limits.maxSpan)
    throw new RangeError("Viewport span limits are reversed.");
  return Math.min(limits.maxSpan, Math.max(limits.minSpan, span));
}

/** Null defers framing until a hidden or undersized container is measurable. */
export function fitViewport(
  bounds: Interval | null,
  options: FitOptions,
): Viewport | null {
  const { extent, padding } = options;
  finite(extent, padding);
  if (extent < 0 || padding < 0)
    throw new RangeError("Viewport extent and padding cannot be negative.");
  clampSpan(options.minSpan, options);
  if (bounds) {
    finite(bounds.start, bounds.end);
    if (bounds.start > bounds.end)
      throw new RangeError("Timeline bounds are reversed.");
  }
  if (extent <= 2 * padding) return null;
  if (!bounds) return { center: 0, span: options.minSpan };
  const dataSpan = bounds.end - bounds.start;
  const span = clampSpan(dataSpan * (extent / (extent - 2 * padding)), options);
  const center = bounds.start + dataSpan / 2;
  finite(center);
  return { center, span };
}

/** Reproject geometry instead of scaling rasterized text or storing pixel data. */
export function worldToScreen(
  view: Viewport,
  coordinate: number,
  extent: number,
) {
  checkViewport(view);
  finite(coordinate);
  positive(extent);
  const result = ((coordinate - view.center) / view.span + 0.5) * extent;
  finite(result);
  return result;
}

export function screenToWorld(view: Viewport, pixel: number, extent: number) {
  checkViewport(view);
  finite(pixel);
  positive(extent);
  const result = view.center + (pixel / extent - 0.5) * view.span;
  finite(result);
  return result;
}

/** Factor > 1 zooms in; anchor is a fraction of the visible axis in [0, 1]. */
export function zoomViewport(
  view: Viewport,
  factor: number,
  anchor: number,
  limits: SpanLimits,
): Viewport {
  checkViewport(view);
  positive(factor);
  finite(anchor);
  if (anchor < 0 || anchor > 1)
    throw new RangeError("Zoom anchor must be inside the viewport.");
  const span = clampSpan(view.span / factor, limits);
  const center = view.center + (anchor - 0.5) * (view.span - span);
  finite(center);
  return { center, span };
}

/** Positive pointer movement moves content forward without changing its order. */
export function panViewport(
  view: Viewport,
  pixels: number,
  extent: number,
): Viewport {
  checkViewport(view);
  finite(pixels);
  positive(extent);
  const center = view.center - (pixels / extent) * view.span;
  finite(center);
  return { center, span: view.span };
}

/** Preserve the focal coordinate and scale on resize, subject to span limits. */
export function resizeViewport(
  view: Viewport,
  previousExtent: number,
  nextExtent: number,
  limits: SpanLimits,
): Viewport {
  checkViewport(view);
  positive(previousExtent);
  positive(nextExtent);
  return {
    center: view.center,
    span: clampSpan(view.span * (nextExtent / previousExtent), limits),
  };
}
