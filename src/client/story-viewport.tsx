import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  aggregateDateBins,
  type ChoiceRange,
  type ChronologicalIndex,
  pageChoices,
} from "../timeline/chronological";
import {
  fitViewport,
  groupPositionsByScreenBin,
  type Interval,
  panViewport,
  resizeViewport,
  type Viewport,
  zoomViewport,
} from "../timeline/viewport";

type Point = { x: number; y: number; startX: number; startY: number };
type Mode = "story" | "chronological";
type Track = "story" | "calendar-date" | "exact-instant";
type Frame = { view: Viewport | null; extent: number; manual: boolean };
type ChoiceKind = "date" | "instant" | "undated";
type ChoiceSelection = { kind: ChoiceKind; range: ChoiceRange };
type ChoiceEntry = { id: string; storyOrdinal: number; label: string };

export function StoryViewport({
  positions,
  index,
  snapshotVersion,
  chronologicalLoading,
  chronologicalError,
  retryChronological,
  onSelectItem,
}: {
  positions: number[];
  index: ChronologicalIndex | null;
  snapshotVersion: number | null;
  chronologicalLoading: boolean;
  chronologicalError: string;
  retryChronological: () => void;
  onSelectItem: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("story");
  const [undatedSelection, setUndatedSelection] =
    useState<ChoiceSelection | null>(null);
  const [undatedOffset, setUndatedOffset] = useState(0);
  const previousUndatedSnapshotVersion = useRef(snapshotVersion);
  const storyBounds = useMemo<Interval | null>(
    () =>
      positions.length
        ? {
            start: positions[0] ?? 0,
            end: positions.at(-1) ?? 0,
          }
        : null,
    [positions],
  );
  const dateBounds = useMemo<Interval | null>(() => {
    if (!index?.dates.length) return null;
    return {
      start: index.dates[0]?.start ?? 0,
      end: index.dates.at(-1)?.end ?? 0,
    };
  }, [index]);
  const instantBounds = useMemo<Interval | null>(() => {
    if (!index?.instants.length) return null;
    return {
      start: index.instants[0]?.epochMs ?? 0,
      end: index.instants.at(-1)?.epochMs ?? 0,
    };
  }, [index]);
  const undatedPage =
    index && undatedSelection
      ? pageChoices(index.undated, undatedSelection.range, undatedOffset)
      : null;
  const undatedEntries: ChoiceEntry[] =
    index && undatedPage
      ? undatedPage.items.map((item) => ({
          id: item.id,
          storyOrdinal: index.storyOrdinalById.get(item.id) ?? 0,
          label: "No event date",
        }))
      : [];

  useEffect(() => {
    if (previousUndatedSnapshotVersion.current === snapshotVersion) return;
    previousUndatedSnapshotVersion.current = snapshotVersion;
    setUndatedSelection(null);
    setUndatedOffset(0);
  }, [snapshotVersion]);

  function chooseUndated() {
    if (!index?.undated.length) return;
    setUndatedSelection({
      kind: "undated",
      range: { firstItemIndex: 0, endItemIndex: index.undated.length },
    });
    setUndatedOffset(0);
  }

  return (
    <section className="story-navigation" aria-label="Timeline navigation">
      <div className="viewport-toolbar">
        <div>
          <p className="eyebrow">Timeline overview</p>
          <p>
            Story order is your narrative. Calendar labels and exact instants
            preserve different precision and are not comparable on one UTC
            scale.
          </p>
        </div>
        <fieldset className="viewport-buttons">
          <legend className="sr-only">Timeline view mode</legend>
          <button
            type="button"
            className="button secondary"
            aria-pressed={mode === "story"}
            onClick={() => setMode("story")}
          >
            Story
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={mode === "chronological"}
            onClick={() => setMode("chronological")}
          >
            Chronological
          </button>
        </fieldset>
      </div>

      <TrackViewport
        track="story"
        active={mode === "story"}
        positions={positions}
        chronologicalLoading={false}
        bounds={storyBounds}
      />

      <div className="chronological-tracks" hidden={mode !== "chronological"}>
        {chronologicalLoading ? (
          <p role="status">Loading complete chronological overview…</p>
        ) : chronologicalError ? (
          <div role="alert" className="error editor-notice">
            {chronologicalError}
            <button
              type="button"
              className="text-button"
              onClick={retryChronological}
            >
              Retry chronological overview
            </button>
          </div>
        ) : null}
        <TrackViewport
          track="calendar-date"
          active={mode === "chronological" && !!index}
          positions={[]}
          bounds={dateBounds}
          index={index}
          chronologicalLoading={chronologicalLoading}
          snapshotVersion={snapshotVersion}
          onSelectItem={onSelectItem}
        />
        <TrackViewport
          track="exact-instant"
          active={mode === "chronological" && !!index}
          positions={index?.instantCoordinates ?? []}
          bounds={instantBounds}
          index={index}
          chronologicalLoading={chronologicalLoading}
          snapshotVersion={snapshotVersion}
          onSelectItem={onSelectItem}
        />
        <section className="undated-track" aria-label="Undated items">
          <div className="undated-track-heading">
            <div>
              <h3>Undated</h3>
              <p>
                No event date is assigned; these moments stay outside both axes.
              </p>
            </div>
            <button
              className="button secondary"
              type="button"
              disabled={!index?.undated.length || chronologicalLoading}
              aria-label={`Undated · ${index?.undated.length ?? 0} moments`}
              onClick={chooseUndated}
            >
              Browse {index?.undated.length ?? 0} undated moments
            </button>
          </div>
          {index?.undated.length ? (
            <p className="field-help">
              One aggregate contains {index.undated.length} moments. Choices
              follow story order and load 100 at a time.
            </p>
          ) : (
            <p className="field-help">No undated moments.</p>
          )}
        </section>
      </div>

      {index && undatedSelection && undatedPage ? (
        <ChoiceDialog
          kind="undated"
          entries={undatedEntries}
          nextOffset={undatedPage.nextOffset}
          offset={undatedOffset}
          total={undatedSelection.range.endItemIndex}
          onNext={() => {
            if (undatedPage.nextOffset !== null)
              setUndatedOffset(undatedPage.nextOffset);
          }}
          onPrevious={() => setUndatedOffset(Math.max(0, undatedOffset - 100))}
          onClose={() => setUndatedSelection(null)}
          onChoose={(itemId) => {
            setUndatedSelection(null);
            onSelectItem(itemId);
          }}
        />
      ) : null}
    </section>
  );
}

function TrackViewport({
  track,
  active,
  positions,
  bounds,
  index,
  chronologicalLoading,
  snapshotVersion,
  onSelectItem,
}: {
  track: Track;
  active: boolean;
  positions: number[];
  bounds: Interval | null;
  index?: ChronologicalIndex | null;
  chronologicalLoading: boolean;
  snapshotVersion?: number | null;
  onSelectItem?: (id: string) => void;
}) {
  const element = useRef<HTMLElement>(null);
  const [model, setModel] = useState<Frame>({
    view: null,
    extent: 0,
    manual: false,
  });
  const current = useRef(model);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; middle: number } | null>(null);
  const [selection, setSelection] = useState<ChoiceSelection | null>(null);
  const [choiceOffset, setChoiceOffset] = useState(0);
  const previousSnapshotVersion = useRef(snapshotVersion);
  current.current = model;

  const limits = useMemo(() => {
    const minimum = track === "exact-instant" ? 1 : 0.5;
    const width = bounds ? Math.abs(bounds.end - bounds.start) : 0;
    return {
      minSpan: minimum,
      maxSpan: Math.max(track === "exact-instant" ? 1000 : 10, (width + 1) * 4),
    };
  }, [bounds, track]);
  const trackTitle =
    track === "story"
      ? "Story viewport"
      : track === "calendar-date"
        ? "Calendar dates viewport"
        : "Exact instants viewport";

  useEffect(() => {
    if (previousSnapshotVersion.current === snapshotVersion) return;
    previousSnapshotVersion.current = snapshotVersion;
    setSelection(null);
    setChoiceOffset(0);
  }, [snapshotVersion]);

  useEffect(() => {
    let previousSize = { width: window.outerWidth, height: window.outerHeight };
    const closeChoices = () => {
      const nextSize = { width: window.outerWidth, height: window.outerHeight };
      if (
        previousSize.width === nextSize.width &&
        previousSize.height === nextSize.height
      )
        return;
      previousSize = nextSize;
      setSelection(null);
      setChoiceOffset(0);
    };
    window.addEventListener("resize", closeChoices);
    return () => window.removeEventListener("resize", closeChoices);
  }, []);

  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !active) return;
    const measure = () => {
      const extent = node.getBoundingClientRect().width;
      if (extent <= 80) return;
      const previous = current.current;
      const view =
        previous.manual && previous.view && previous.extent > 0
          ? resizeViewport(previous.view, previous.extent, extent, limits)
          : fitViewport(bounds, {
              ...limits,
              extent,
              padding: 35,
            });
      if (view) {
        const next = { view, extent, manual: previous.manual };
        current.current = next;
        setModel(next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, bounds, limits]);

  const navigate = useCallback((view: Viewport) => {
    const next = { view, extent: current.current.extent, manual: true };
    current.current = next;
    setSelection(null);
    setChoiceOffset(0);
    setModel(next);
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      const { view, extent } = current.current;
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
    const view = fitViewport(bounds, { ...limits, extent, padding: 35 });
    if (view) navigate(view);
  }

  function pointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        "button, a, input, select, textarea, [role='button'], [contenteditable='true']",
      )
    )
      return;
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

  const view = model.view;
  const storyGroups =
    track === "story" && view && model.extent > 0
      ? groupPositionsByScreenBin(positions, view, model.extent)
      : [];
  const dateGroups =
    track === "calendar-date" && index && view && model.extent > 0
      ? aggregateDateBins(index, view, model.extent)
      : [];
  const instantGroups =
    track === "exact-instant" && index && view && model.extent > 0
      ? groupPositionsByScreenBin(index.instantCoordinates, view, model.extent)
      : [];
  const choiceData = useMemo(() => {
    if (!index || !selection || selection.kind === "undated") return null;
    return selection.kind === "date"
      ? pageChoices(index.dates, selection.range, choiceOffset)
      : pageChoices(index.instants, selection.range, choiceOffset);
  }, [choiceOffset, index, selection]);
  const choiceEntries: ChoiceEntry[] =
    index && choiceData && selection
      ? choiceData.items.map((item) => ({
          id: item.id,
          storyOrdinal: index.storyOrdinalById.get(item.id) ?? 0,
          label:
            selection.kind === "date"
              ? `${item.date} · ${item.time_zone}`
              : `${item.instant} UTC · ${item.time_zone}`,
        }))
      : [];
  const choiceTotal = selection
    ? selection.range.endItemIndex - selection.range.firstItemIndex
    : 0;

  function openChoices(kind: "date" | "instant", range: ChoiceRange) {
    setChoiceOffset(0);
    setSelection({ kind, range });
  }

  return (
    <>
      <section
        ref={element}
        aria-label={trackTitle}
        className={
          track === "story" ? "story-viewport" : "chronological-viewport"
        }
        data-viewport={track}
        data-center={model.view?.center}
        data-span={model.view?.span}
        data-extent={model.extent}
        hidden={!active}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
      >
        <div className="track-heading">
          <div>
            <h3>
              {track === "story"
                ? "Story order"
                : track === "calendar-date"
                  ? "Calendar dates"
                  : "Exact instants"}
            </h3>
            <p>
              {track === "story"
                ? "Dates are labels. Your order tells the story."
                : track === "calendar-date"
                  ? "Gregorian date labels stay in their saved time zone; they are not converted to UTC."
                  : "Points use normalized UTC instants; the saved time zone is event context."}
            </p>
          </div>
          <fieldset className="viewport-buttons">
            <legend className="sr-only">{`${trackTitle} controls`}</legend>
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
          </fieldset>
        </div>

        {track === "story" ? (
          <svg
            width="100%"
            height="150"
            aria-label="Narrative order overview"
            role="img"
          >
            <title>Narrative order overview</title>
            <line x1="0" x2={model.extent} y1="75" y2="75" />
            {storyGroups.map((group) => {
              const x = (group.bin + 0.5) * 48;
              return (
                <g
                  key={group.bin}
                  data-bin={group.bin}
                  data-first-ordinal={group.first}
                  data-last-ordinal={group.last}
                  data-moment-count={group.count}
                >
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
        ) : track === "calendar-date" ? (
          <div className="chronological-bin-layer">
            {dateGroups.map((group) => {
              const label =
                group.itemCount > 0
                  ? `${group.itemCount} calendar date choices, ${group.firstDate} through ${group.lastDate}; ${group.spanCoverageCount} date spans cross this bin`
                  : `${group.spanCoverageCount} date spans cross this bin; no date midpoint is in this group`;
              const style = {
                left: `${(group.pixelStart + group.pixelEnd) / 2}px`,
              };
              return group.itemCount > 0 ? (
                <button
                  key={group.bin}
                  type="button"
                  className="chronological-bin date-bin"
                  data-chronological-bin
                  data-bin={group.bin}
                  data-item-count={group.itemCount}
                  data-span-coverage-count={group.spanCoverageCount}
                  data-first-date={group.firstDate ?? ""}
                  data-last-date={group.lastDate ?? ""}
                  style={style}
                  aria-label={label}
                  title={label}
                  disabled={chronologicalLoading}
                  onClick={() =>
                    openChoices("date", {
                      firstItemIndex: group.firstItemIndex,
                      endItemIndex: group.endItemIndex,
                    })
                  }
                >
                  <span aria-hidden="true">
                    {group.itemCount > 1 ? `${group.itemCount}×` : "•"}
                  </span>
                </button>
              ) : (
                <span
                  key={group.bin}
                  className="chronological-bin date-bin coverage-only"
                  data-chronological-bin
                  data-bin={group.bin}
                  data-item-count={group.itemCount}
                  data-span-coverage-count={group.spanCoverageCount}
                  data-first-date=""
                  data-last-date=""
                  style={style}
                  role="img"
                  aria-label={label}
                  title={label}
                >
                  {group.spanCoverageCount}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="chronological-bin-layer">
            {instantGroups.map((group) => {
              const first = index?.instants[group.first - 1];
              const last = index?.instants[group.last - 1];
              if (!first || !last) return null;
              const label =
                first.epochMs === last.epochMs
                  ? `${group.count} exact instants at ${first.instant} UTC; display time zone ${first.time_zone}`
                  : `${group.count} exact instants from ${first.instant} UTC to ${last.instant} UTC`;
              return (
                <button
                  key={group.bin}
                  type="button"
                  className="chronological-bin instant-bin"
                  data-chronological-bin
                  data-bin={group.bin}
                  data-item-count={group.count}
                  data-span-coverage-count={group.count}
                  style={{ left: `${(group.bin + 0.5) * 48}px` }}
                  aria-label={label}
                  title={label}
                  disabled={chronologicalLoading}
                  onClick={() =>
                    openChoices("instant", {
                      firstItemIndex: group.first - 1,
                      endItemIndex: group.last,
                    })
                  }
                >
                  <span aria-hidden="true">
                    {group.count > 1 ? `${group.count}×` : "•"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <p
          className="track-empty"
          hidden={
            track === "story" ||
            (track === "calendar-date"
              ? !!index?.dates.length
              : !!index?.instants.length)
          }
        >
          No {track === "calendar-date" ? "calendar dates" : "exact instants"}{" "}
          yet.
        </p>
      </section>

      {index && selection && selection.kind !== "undated" && choiceData ? (
        <ChoiceDialog
          kind={selection.kind}
          entries={choiceEntries}
          nextOffset={choiceData.nextOffset}
          offset={choiceOffset}
          total={choiceTotal}
          onNext={() => {
            if (choiceData.nextOffset !== null)
              setChoiceOffset(choiceData.nextOffset);
          }}
          onPrevious={() => setChoiceOffset(Math.max(0, choiceOffset - 100))}
          onClose={() => setSelection(null)}
          onChoose={(id) => {
            setSelection(null);
            onSelectItem?.(id);
          }}
        />
      ) : null}
    </>
  );
}

function ChoiceDialog({
  kind,
  entries,
  nextOffset,
  offset,
  total,
  onNext,
  onPrevious,
  onClose,
  onChoose,
}: {
  kind: ChoiceKind;
  entries: ChoiceEntry[];
  nextOffset: number | null;
  offset: number;
  total: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onChoose: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (dialog.current?.open) dialog.current.close();
    };
  }, []);
  const title =
    kind === "date"
      ? "Calendar date choices"
      : kind === "instant"
        ? "Exact instant choices"
        : "Undated moments";
  return (
    <dialog
      ref={dialog}
      className="detail-dialog chronological-choices"
      aria-labelledby="chronological-choices-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="detail-header">
        <div>
          <h2 id="chronological-choices-title">{title}</h2>
          <p>
            {Math.min(offset + 1, total)}–
            {Math.min(offset + entries.length, total)} of {total}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close choices"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <ol className="chronological-choice-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="chronological-choice"
              aria-label={`Moment ${entry.storyOrdinal} · ${entry.label}`}
              onClick={() => onChoose(entry.id)}
            >
              <span>Moment {entry.storyOrdinal}</span>
              <span>{entry.label}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="viewport-buttons chooser-paging">
        <button
          type="button"
          className="button secondary"
          disabled={offset === 0}
          onClick={onPrevious}
        >
          Previous choices
        </button>
        {nextOffset !== null ? (
          <button type="button" className="button secondary" onClick={onNext}>
            Next choices
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
