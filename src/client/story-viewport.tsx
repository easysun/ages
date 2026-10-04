import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fitViewport,
  panViewport,
  resizeViewport,
  type Viewport,
  worldToScreen,
  zoomViewport,
} from "../timeline/viewport";

type Point = { x: number; y: number; startX: number; startY: number };

export function StoryViewport({ positions }: { positions: number[] }) {
  const element = useRef<HTMLElement>(null);
  const start = positions[0] ?? 0;
  const end = positions.at(-1) ?? 0;
  const limits = useMemo(
    () => ({ minSpan: 0.5, maxSpan: Math.max(10, (end - start + 1) * 4) }),
    [start, end],
  );
  const [model, setModel] = useState<{ view: Viewport | null; extent: number }>(
    {
      view: null,
      extent: 0,
    },
  );
  const current = useRef(model);
  const manual = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; middle: number } | null>(null);
  const navigate = useCallback((view: Viewport) => {
    manual.current = true;
    const next = { view, extent: current.current.extent };
    current.current = next;
    setModel(next);
  }, []);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const extent = node.getBoundingClientRect().width;
      if (extent <= 80) return;
      const previous = current.current;
      const view =
        manual.current && previous.view && previous.extent > 0
          ? resizeViewport(previous.view, previous.extent, extent, limits)
          : fitViewport(
              positions.length
                ? { start, end: Math.min(end, start + 5) }
                : null,
              { ...limits, extent, padding: 35 },
            );
      const next = { view, extent };
      current.current = next;
      setModel(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [start, end, limits, positions.length]);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      const { view, extent } = current.current;
      // Normal scrolling and browser Ctrl/Meta magnification remain available.
      if (!event.shiftKey || event.ctrlKey || event.metaKey || !view || !extent)
        return;
      event.preventDefault();
      const anchor = Math.max(
        0,
        Math.min(
          1,
          (event.clientX - node.getBoundingClientRect().left) / extent,
        ),
      );
      navigate(
        zoomViewport(view, Math.exp(-event.deltaY * 0.002), anchor, limits),
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [limits, navigate]);
  function zoom(factor: number) {
    const { view } = current.current;
    if (view) navigate(zoomViewport(view, factor, 0.5, limits));
  }
  function pan(direction: number) {
    const { view, extent } = current.current;
    if (view && extent)
      navigate(panViewport(view, (direction * extent) / 3, extent));
  }
  function fit() {
    const { extent } = current.current;
    const view = fitViewport(positions.length ? { start, end } : null, {
      ...limits,
      extent,
      padding: 35,
    });
    if (view) navigate(view);
  }
  function pointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    if (event.pointerType === "mouse")
      event.currentTarget.setPointerCapture(event.pointerId);
    const pair = [...pointers.current.values()];
    if (pair.length === 2) {
      const [a, b] = pair;
      if (a && b)
        pinch.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          middle: (a.x + b.x) / 2,
        };
    }
  }
  function pointerMove(event: React.PointerEvent<HTMLElement>) {
    const previous = pointers.current.get(event.pointerId);
    const { view, extent } = current.current;
    if (!previous || !view || !extent) return;
    pointers.current.set(event.pointerId, {
      ...previous,
      x: event.clientX,
      y: event.clientY,
    });
    const pair = [...pointers.current.values()];
    if (pair.length === 2 && pinch.current) {
      const [a, b] = pair;
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const middle = (a.x + b.x) / 2;
      if (distance > 0 && pinch.current.distance > 0) {
        event.preventDefault();
        const anchor = Math.max(
          0,
          Math.min(
            1,
            (pinch.current.middle -
              event.currentTarget.getBoundingClientRect().left) /
              extent,
          ),
        );
        const zoomed = zoomViewport(
          view,
          distance / pinch.current.distance,
          anchor,
          limits,
        );
        navigate(panViewport(zoomed, middle - pinch.current.middle, extent));
      }
      pinch.current = { distance, middle };
      return;
    }
    if (
      event.pointerType === "touch" &&
      (Math.abs(event.clientX - previous.startX) < 8 ||
        Math.abs(event.clientX - previous.startX) <=
          Math.abs(event.clientY - previous.startY))
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    navigate(panViewport(view, event.clientX - previous.x, extent));
  }
  function pointerEnd(event: React.PointerEvent<HTMLElement>) {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
  }
  const groups = new Map<
    number,
    { sum: number; first: number; last: number; count: number }
  >();
  const view = model.view;
  if (view && model.extent > 0) {
    positions.forEach((position, index) => {
      const x = worldToScreen(view, position, model.extent);
      if (x < -12 || x > model.extent + 12) return;
      const bin = Math.floor(x / 48);
      const group = groups.get(bin);
      if (group) {
        group.sum += x;
        group.last = index + 1;
        group.count++;
      } else
        groups.set(bin, {
          sum: x,
          first: index + 1,
          last: index + 1,
          count: 1,
        });
    });
  }
  return (
    <section className="story-navigation" aria-label="Story navigation">
      <div className="viewport-toolbar">
        <div>
          <p className="eyebrow">Story order</p>
          <p>Dates are labels. Your order tells the story.</p>
        </div>
        <div className="viewport-buttons">
          <button
            type="button"
            className="button secondary"
            onClick={() => pan(1)}
          >
            Pan earlier
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => zoom(1.5)}
          >
            Zoom in
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => zoom(1 / 1.5)}
          >
            Zoom out
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => pan(-1)}
          >
            Pan later
          </button>
          <button type="button" className="button secondary" onClick={fit}>
            Fit all
          </button>
        </div>
      </div>
      <section
        ref={element}
        aria-label="Story viewport"
        className="story-viewport"
        data-viewport="story"
        data-center={model.view?.center}
        data-span={model.view?.span}
        data-extent={model.extent}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
      >
        <svg
          width="100%"
          height="150"
          aria-label="Narrative order overview"
          role="img"
        >
          <title>Narrative order overview</title>
          <line x1="0" x2={model.extent} y1="75" y2="75" />
          {[...groups].map(([bin, group]) => {
            const x = group.sum / group.count;
            return (
              <g key={bin} data-moment-count={group.count}>
                <title>
                  {group.count === 1
                    ? `Moment ${group.first}`
                    : `Moments ${group.first} through ${group.last}`}
                </title>
                <circle cx={x} cy="75" r={group.count === 1 ? 8 : 11} />
                <text x={x} y="108" textAnchor="middle">
                  {group.count === 1 ? group.first : `${group.count}×`}
                </text>
              </g>
            );
          })}
        </svg>
      </section>
      <p className="field-help">
        Drag horizontally or pinch in this overview. Hold Shift and scroll to
        zoom at the pointer. Vertical scrolling stays available. Grouped markers
        show counts; zoom in for story numbers. All moments remain in the
        editable list below.
      </p>
    </section>
  );
}
