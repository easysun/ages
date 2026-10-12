/** Logical coordinates may represent story layout or interpreted event time. */
export type Interval = Readonly<{ start: number; end: number }>;
export type Viewport = Readonly<{ center: number; span: number }>;
export type SpanLimits = Readonly<{ minSpan: number; maxSpan: number }>;
export type MarkerGroup = Readonly<{
  bin: number;
  first: number;
  last: number;
  count: number;
}>;
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

function lowerBoundByScreen(
  positions: readonly number[],
  view: Viewport,
  extent: number,
  pixel: number,
  start: number,
  end: number,
) {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (worldToScreen(view, positions[middle] as number, extent) < pixel)
      low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundByScreen(
  positions: readonly number[],
  view: Viewport,
  extent: number,
  pixel: number,
) {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (worldToScreen(view, positions[middle] as number, extent) <= pixel)
      low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Group sorted positions into occupied screen bins without scanning them. */
export function groupPositionsByScreenBin(
  positions: readonly number[],
  view: Viewport,
  extent: number,
  binWidth = 48,
): MarkerGroup[] {
  checkViewport(view);
  positive(extent);
  positive(binWidth);

  const clipEnd = extent + 12;
  finite(clipEnd);
  const firstVisible = lowerBoundByScreen(
    positions,
    view,
    extent,
    -12,
    0,
    positions.length,
  );
  const afterLastVisible = upperBoundByScreen(positions, view, extent, clipEnd);
  const groups: MarkerGroup[] = [];

  let index = firstVisible;
  while (index < afterLastVisible) {
    const screenPosition = worldToScreen(
      view,
      positions[index] as number,
      extent,
    );
    const bin = Math.floor(screenPosition / binWidth);
    const binEnd = (bin + 1) * binWidth;
    finite(bin, binEnd);
    if (binEnd <= screenPosition)
      throw new RangeError("Screen bin width is too small for this viewport.");

    const nextIndex = lowerBoundByScreen(
      positions,
      view,
      extent,
      binEnd,
      index + 1,
      afterLastVisible,
    );
    groups.push({
      bin,
      first: index + 1,
      last: nextIndex,
      count: nextIndex - index,
    });
    index = nextIndex;
  }

  return groups;
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
