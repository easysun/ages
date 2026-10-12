import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { timelinePayload } from "../timeline/model";
import type { EventAt } from "../timeline/validation";
import {
  api,
  errorMessage,
  jsonBody,
  type LibraryAsset,
  type LibraryPage,
  mediaUrl,
  RequestError,
} from "./api";
import { StoryViewport } from "./story-viewport";

type Summary = Omit<ReturnType<typeof timelinePayload>, "items">;
type Item = NonNullable<ReturnType<typeof timelinePayload>["items"]>[number];
type Story = Summary & { items: Item[] };
type Page = { timelines: Summary[]; next_cursor: string | null };
type OverviewItem = { id: string; position: number };
type MomentAsset = {
  id: string;
  kind: "image" | "video";
  original_name: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
};
type ItemDetail = {
  id: string;
  asset_id: string;
  position: number;
  caption: string;
  event_at: EventAt | null;
  asset: MomentAsset;
};
type OverviewPage = {
  timeline: Summary;
  total_items: number;
  items: OverviewItem[];
  next_cursor: string | null;
};
type DetailsPage = { version: number; items: ItemDetail[] };
type TimelineDraft = {
  caption: string;
  eventKind: "none" | "date" | "instant";
  eventValue: string;
  timeZone: string;
  dirty: { caption: boolean; event: boolean };
};
type Navigate = (path: string) => void;

export function TimelineScreen({
  id,
  navigate,
  authGeneration,
}: {
  id?: string;
  navigate: Navigate;
  authGeneration: number;
}) {
  return id ? (
    <TimelineEditor key={id} id={id} authGeneration={authGeneration} />
  ) : (
    <TimelineList navigate={navigate} authGeneration={authGeneration} />
  );
}
function TimelineList({
  navigate,
  authGeneration,
}: {
  navigate: Navigate;
  authGeneration: number;
}) {
  const [stories, setStories] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [request, setRequest] = useState({ path: "/api/timelines?limit=30" });
  const live = useRef(true);
  const authGenerationRef = useRef(authGeneration);
  authGenerationRef.current = authGeneration;
  useEffect(() => {
    live.current = true;
    const requestAuthGeneration = authGeneration;
    const ownsRequest = () =>
      live.current && authGenerationRef.current === requestAuthGeneration;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Page>(request.path, { signal: controller.signal })
      .then((page) => {
        if (ownsRequest() && !controller.signal.aborted) {
          setStories(page.timelines);
          setCursor(page.next_cursor);
        }
      })
      .catch((reason) => {
        if (ownsRequest() && !controller.signal.aborted)
          setError(errorMessage(reason));
      })
      .finally(() => {
        if (ownsRequest() && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [request, authGeneration]);
  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError("");
    const requestAuthGeneration = authGenerationRef.current;
    try {
      const result = await api<{ timeline: Story }>("/api/timelines", {
        method: "POST",
        ...jsonBody({ title }),
      });
      if (live.current && authGenerationRef.current === requestAuthGeneration)
        navigate(`/timelines/${encodeURIComponent(result.timeline.id)}`);
    } catch (reason) {
      if (live.current && authGenerationRef.current === requestAuthGeneration)
        setError(errorMessage(reason));
    } finally {
      if (live.current && authGenerationRef.current === requestAuthGeneration)
        setCreating(false);
    }
  }
  async function more() {
    if (!cursor || loading) return;
    const requestAuthGeneration = authGenerationRef.current;
    setLoading(true);
    try {
      const page = await api<Page>(
        `/api/timelines?limit=30&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!live.current || authGenerationRef.current !== requestAuthGeneration)
        return;
      setStories((current) => [
        ...current,
        ...page.timelines.filter(
          (row) => !current.some((item) => item.id === row.id),
        ),
      ]);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (live.current && authGenerationRef.current === requestAuthGeneration)
        setError(errorMessage(reason));
    } finally {
      if (live.current && authGenerationRef.current === requestAuthGeneration)
        setLoading(false);
    }
  }
  return (
    <main id="main" className="timeline-page">
      <div className="timeline-intro">
        <p className="eyebrow">A story that keeps growing</p>
        <h1>Your timelines</h1>
        <p>Bring moments together. Describe them. Keep adding.</p>
      </div>
      <form className="timeline-create" onSubmit={create}>
        <label htmlFor="new-timeline-title">New timeline title</label>
        <input
          id="new-timeline-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
          placeholder="A summer, a place, a life…"
        />
        <button className="button primary" disabled={creating} type="submit">
          {creating ? "Creating…" : "Create timeline"}
        </button>
        <p className="field-help">
          New timelines are private. Your original media stays in your library.
        </p>
      </form>
      {error ? (
        <div className="error" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setRequest({ path: "/api/timelines?limit=30" })}
          >
            Retry timelines
          </button>
        </div>
      ) : null}
      <div className="timeline-list">
        {stories.map((story) => (
          <a
            key={story.id}
            className="timeline-tile"
            href={`/timelines/${encodeURIComponent(story.id)}`}
            onClick={(event) => {
              if (
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigate(event.currentTarget.pathname);
            }}
          >
            <h2>{story.title}</h2>
            <span>
              {story.visibility === "private"
                ? "Private"
                : story.visibility === "unlisted"
                  ? "Anyone with the link"
                  : "Public"}
            </span>
          </a>
        ))}
      </div>
      {loading ? (
        <p role="status">Opening timelines…</p>
      ) : cursor ? (
        <button
          type="button"
          className="button secondary"
          onClick={() => void more()}
        >
          More timelines
        </button>
      ) : stories.length === 0 && !error ? (
        <p className="empty-state">Your first story starts with a moment.</p>
      ) : null}
    </main>
  );
}

function TimelineEditor({
  id,
  authGeneration,
}: {
  id: string;
  authGeneration: number;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [indexItems, setIndexItems] = useState<OverviewItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [snapshotVersion, setSnapshotVersion] = useState<number | null>(null);
  const [itemDetails, setItemDetails] = useState<ItemDetail[]>([]);
  const [itemDetailsVersion, setItemDetailsVersion] = useState<number | null>(
    null,
  );
  const [rangeStart, setRangeStart] = useState(0);
  const [goToValue, setGoToValue] = useState("1");
  const [drafts, setDrafts] = useState<Record<string, TimelineDraft>>({});
  const [itemNotices, setItemNotices] = useState<Record<string, string>>({});
  const [assets, setAssets] = useState<Record<string, LibraryAsset>>({});
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [assetError, setAssetError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewProgress, setOverviewProgress] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [writePaused, setWritePaused] = useState(false);
  const [picker, setPicker] = useState(false);
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [focusRequestVersion, setFocusRequestVersion] = useState(0);
  const [focusHeadingRequested, setFocusHeadingRequested] = useState(false);
  const live = useRef(true);
  const writing = useRef(false);
  const writeVersion = useRef<number | null>(null);
  const overviewGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const mutationController = useRef<AbortController | null>(null);
  const reconciliationPending = useRef(false);
  const authGenerationRef = useRef(authGeneration);
  const previousAuthGeneration = useRef(authGeneration);
  const overviewAuthGeneration = useRef(authGeneration);
  const overviewRequestRef = useRef(overviewRequest);
  const detailRetryRef = useRef(detailRetry);
  const detailsReadyRef = useRef(false);
  const writePausedRef = useRef(writePaused);
  const indexItemsRef = useRef(indexItems);
  const totalItemsRef = useRef(totalItems);
  const readinessWaiters = useRef<Array<() => void>>([]);
  const pendingFocus = useRef<{ id: string; field: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pickerOpener = useRef<HTMLButtonElement>(null);

  const releaseReadinessWaiters = useCallback(() => {
    for (const resolve of readinessWaiters.current.splice(0)) resolve();
  }, []);
  overviewRequestRef.current = overviewRequest;
  detailRetryRef.current = detailRetry;

  const visibleIndexItems = indexItems.slice(rangeStart, rangeStart + 100);
  const viewportPositions = useMemo(
    () => indexItems.map((item) => item.position),
    [indexItems],
  );
  const indexedIds = new Set(indexItems.map((item) => item.id));
  const unresolvedDrafts = Object.entries(drafts).filter(
    ([itemId, draft]) =>
      !indexedIds.has(itemId) && (draft.dirty.caption || draft.dirty.event),
  );
  const detailsReady =
    previousAuthGeneration.current === authGeneration &&
    snapshotVersion !== null &&
    itemDetailsVersion === snapshotVersion &&
    itemDetails.length === visibleIndexItems.length &&
    itemDetails.every(
      (item, index) => item.id === visibleIndexItems[index]?.id,
    );
  authGenerationRef.current = authGeneration;
  const authGenerationIsCurrent =
    previousAuthGeneration.current === authGeneration;
  detailsReadyRef.current = detailsReady && authGenerationIsCurrent;
  writePausedRef.current = writePaused || !authGenerationIsCurrent;
  indexItemsRef.current = indexItems;
  totalItemsRef.current = totalItems;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      overviewGeneration.current++;
      detailGeneration.current++;
      mutationGeneration.current++;
      mutationController.current?.abort();
      releaseReadinessWaiters();
    };
  }, [releaseReadinessWaiters]);

  useEffect(() => {
    if (previousAuthGeneration.current === authGeneration) return;
    previousAuthGeneration.current = authGeneration;
    overviewGeneration.current++;
    detailGeneration.current++;
    mutationGeneration.current++;
    mutationController.current?.abort();
    writing.current = false;
    reconciliationPending.current = true;
    releaseReadinessWaiters();
    setBusy(false);
    setError("");
    setWritePaused(true);
    setSnapshotVersion(null);
    setOverviewRequest((current) => current + 1);
  }, [authGeneration, releaseReadinessWaiters]);

  useEffect(() => {
    if (!detailsReady || writePaused) return;
    for (const resolve of readinessWaiters.current.splice(0)) resolve();
  }, [detailsReady, writePaused]);

  useEffect(() => {
    const generation = ++overviewGeneration.current;
    const requestOverviewRevision = overviewRequest;
    const requestAuthGeneration = authGeneration;
    const controller = new AbortController();
    const ownsRequest = () =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      generation === overviewGeneration.current &&
      overviewRequestRef.current === requestOverviewRevision &&
      !controller.signal.aborted;
    setOverviewLoading(true);
    setOverviewProgress(0);
    async function load() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let version: number | null = null;
          let firstPage: OverviewPage | null = null;
          let cursorValue: string | null = null;
          const allItems: OverviewItem[] = [];
          do {
            const params = new URLSearchParams({ limit: "1000" });
            if (version !== null) params.set("version", String(version));
            if (cursorValue) params.set("cursor", cursorValue);
            const page = await api<OverviewPage>(
              `/api/timelines/${encodeURIComponent(id)}/overview?${params}`,
              { signal: controller.signal },
            );
            if (!ownsRequest()) return;
            if (!firstPage) {
              firstPage = page;
              version = page.timeline.version;
            } else if (page.timeline.version !== version) {
              throw new RequestError(
                "CONFLICT",
                "The timeline changed while its index was loading.",
                409,
              );
            }
            allItems.push(...page.items);
            cursorValue = page.next_cursor;
            setOverviewProgress(allItems.length);
          } while (cursorValue);
          if (!ownsRequest() || !firstPage || version === null) return;
          overviewAuthGeneration.current = requestAuthGeneration;
          if (
            pendingFocus.current &&
            !allItems.some((item) => item.id === pendingFocus.current?.id)
          )
            pendingFocus.current = null;
          setSummary(firstPage.timeline);
          setIndexItems(allItems);
          setTotalItems(firstPage.total_items);
          setSnapshotVersion(version);
          writeVersion.current = version;
          setRangeStart((current) => {
            const focused = pendingFocus.current;
            if (focused) {
              const index = allItems.findIndex(
                (item) => item.id === focused.id,
              );
              if (index >= 0) return Math.floor(index / 100) * 100;
            }
            if (!allItems.length) return 0;
            const lastPageStart = Math.floor((allItems.length - 1) / 100) * 100;
            return Math.min(current, lastPageStart);
          });
          setGoToValue((current) => {
            if (!allItems.length) return "1";
            return String(
              Math.min(Math.max(Number(current) || 1, 1), allItems.length),
            );
          });
          return;
        } catch (reason) {
          if (!ownsRequest()) return;
          if (
            attempt === 0 &&
            reason instanceof RequestError &&
            reason.code === "CONFLICT"
          )
            continue;
          setError(errorMessage(reason));
          releaseReadinessWaiters();
          return;
        }
      }
    }
    void load().finally(() => {
      if (ownsRequest()) setOverviewLoading(false);
    });
    return () => controller.abort();
  }, [id, overviewRequest, authGeneration, releaseReadinessWaiters]);

  const firstVisibleItem = indexItems[rangeStart];

  useEffect(() => {
    if (
      !summary?.id ||
      snapshotVersion === null ||
      overviewAuthGeneration.current !== authGeneration
    )
      return;
    const generation = ++detailGeneration.current;
    const requestAuthGeneration = authGeneration;
    const controller = new AbortController();
    const requestedVersion = snapshotVersion;
    const requestedRetryGeneration = detailRetry;
    const first = firstVisibleItem;
    const ownsRequest = () =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      generation === detailGeneration.current &&
      requestedVersion === snapshotVersion &&
      detailRetryRef.current === requestedRetryGeneration &&
      !controller.signal.aborted;
    setDetailError("");
    if (!first) {
      setItemDetails([]);
      setItemDetailsVersion(requestedVersion);
      setDetailLoading(false);
      setFocusRequestVersion((current) => current + 1);
      if (reconciliationPending.current) {
        reconciliationPending.current = false;
        setWritePaused(false);
      }
      return () => controller.abort();
    }
    setDetailLoading(true);
    const params = new URLSearchParams({
      version: String(requestedVersion),
      limit: "100",
      from_position: String(first.position),
      from_id: first.id,
    });
    api<DetailsPage>(
      `/api/timelines/${encodeURIComponent(id)}/items?${params}`,
      { signal: controller.signal },
    )
      .then((page) => {
        if (!ownsRequest()) return;
        if (page.version !== requestedVersion) return;
        setItemDetails(page.items);
        setItemDetailsVersion(page.version);
        setFocusRequestVersion((current) => current + 1);
        if (reconciliationPending.current) {
          reconciliationPending.current = false;
          setWritePaused(false);
        }
      })
      .catch((reason) => {
        if (!ownsRequest()) return;
        if (reason instanceof RequestError && reason.code === "CONFLICT") {
          reconciliationPending.current = true;
          setWritePaused(true);
          setOverviewRequest((current) => current + 1);
        } else {
          setDetailError(errorMessage(reason));
          releaseReadinessWaiters();
        }
      })
      .finally(() => {
        if (ownsRequest()) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [
    id,
    summary?.id,
    snapshotVersion,
    firstVisibleItem,
    detailRetry,
    authGeneration,
    releaseReadinessWaiters,
  ]);

  useEffect(() => {
    if (focusHeadingRequested && !detailLoading) {
      heading.current?.focus();
      setFocusHeadingRequested(false);
    }
  }, [focusHeadingRequested, detailLoading]);

  useEffect(() => {
    if (!focusRequestVersion || !detailsReady || !pendingFocus.current) return;
    const focus = pendingFocus.current;
    const target = document.getElementById(`item-${focus.id}-${focus.field}`);
    if (target instanceof HTMLElement) {
      pendingFocus.current = null;
      target.focus();
    }
  }, [detailsReady, focusRequestVersion]);

  useEffect(() => {
    const coverId = summary?.cover_asset_id;
    if (!coverId || assets[coverId]) {
      setAssetError("");
      return;
    }
    const requestAuthGeneration = authGeneration;
    const controller = new AbortController();
    const ownsRequest = () =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      previousAuthGeneration.current === requestAuthGeneration &&
      !controller.signal.aborted;
    api<{ asset: LibraryAsset }>(`/api/assets/${encodeURIComponent(coverId)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (ownsRequest())
          setAssets((current) => ({ ...current, [coverId]: result.asset }));
      })
      .catch((reason) => {
        if (ownsRequest()) setAssetError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [summary?.cover_asset_id, assets, authGeneration]);

  useEffect(() => {
    const requestAuthGeneration = authGeneration;
    const controller = new AbortController();
    const ownsRequest = () =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      previousAuthGeneration.current === requestAuthGeneration &&
      !controller.signal.aborted;
    setLibraryLoading(true);
    api<LibraryPage>("/api/assets?limit=100", { signal: controller.signal })
      .then((page) => {
        if (!ownsRequest()) return;
        setLibrary(page.assets);
        setCursor(page.next_cursor);
        setAssets(
          Object.fromEntries(page.assets.map((asset) => [asset.id, asset])),
        );
      })
      .catch((reason) => {
        if (ownsRequest()) setLibraryError(errorMessage(reason));
      })
      .finally(() => {
        if (ownsRequest()) setLibraryLoading(false);
      });
    return () => controller.abort();
  }, [authGeneration]);

  async function libraryPage(next?: string) {
    if (libraryLoading) return;
    const requestAuthGeneration = authGenerationRef.current;
    if (
      requestAuthGeneration !== authGeneration ||
      previousAuthGeneration.current !== requestAuthGeneration
    )
      return;
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const page = await api<LibraryPage>(
        `/api/assets?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      if (
        !live.current ||
        authGenerationRef.current !== requestAuthGeneration ||
        previousAuthGeneration.current !== requestAuthGeneration
      )
        return;
      setLibrary((existing) =>
        next
          ? [
              ...existing,
              ...page.assets.filter(
                (row) => !existing.some((item) => item.id === row.id),
              ),
            ]
          : page.assets,
      );
      setCursor(page.next_cursor);
      setAssets((existing) => ({
        ...existing,
        ...Object.fromEntries(page.assets.map((asset) => [asset.id, asset])),
      }));
    } catch (reason) {
      if (
        live.current &&
        authGenerationRef.current === requestAuthGeneration &&
        previousAuthGeneration.current === requestAuthGeneration
      )
        setLibraryError(errorMessage(reason));
    } finally {
      if (
        live.current &&
        authGenerationRef.current === requestAuthGeneration &&
        previousAuthGeneration.current === requestAuthGeneration
      )
        setLibraryLoading(false);
    }
  }

  function draftFor(item: ItemDetail): TimelineDraft {
    return (
      drafts[item.id] ?? {
        caption: item.caption,
        eventKind: item.event_at?.kind ?? "none",
        eventValue:
          item.event_at?.kind === "date"
            ? item.event_at.date
            : item.event_at?.kind === "instant"
              ? item.event_at.instant
              : "",
        timeZone:
          item.event_at?.time_zone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        dirty: { caption: false, event: false },
      }
    );
  }

  function changeDraft(
    item: ItemDetail,
    patch: Partial<Omit<TimelineDraft, "dirty">>,
    field: "caption" | "event",
  ) {
    setItemNotices((current) => {
      if (!current[item.id]) return current;
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setDrafts((current) => {
      const previous = current[item.id] ?? {
        caption: item.caption,
        eventKind: item.event_at?.kind ?? "none",
        eventValue:
          item.event_at?.kind === "date"
            ? item.event_at.date
            : item.event_at?.kind === "instant"
              ? item.event_at.instant
              : "",
        timeZone:
          item.event_at?.time_zone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        dirty: { caption: false, event: false },
      };
      return {
        ...current,
        [item.id]: {
          ...previous,
          ...patch,
          dirty: { ...previous.dirty, [field]: true },
        },
      };
    });
  }

  function refreshOverview() {
    reconciliationPending.current = true;
    writePausedRef.current = true;
    setWritePaused(true);
    setOverviewRequest((current) => current + 1);
  }

  function waitUntilReady(requestAuthGeneration: number) {
    if (
      !live.current ||
      authGenerationRef.current !== requestAuthGeneration ||
      previousAuthGeneration.current !== requestAuthGeneration
    )
      return Promise.resolve(false);
    if (detailsReadyRef.current && !writePausedRef.current)
      return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      readinessWaiters.current.push(() =>
        resolve(
          live.current &&
            authGenerationRef.current === requestAuthGeneration &&
            previousAuthGeneration.current === requestAuthGeneration &&
            detailsReadyRef.current &&
            !writePausedRef.current,
        ),
      );
    });
  }

  function beginDetailReconciliation() {
    reconciliationPending.current = true;
    writePausedRef.current = true;
    setWritePaused(true);
  }

  function requestFieldFocus(itemId: string, field: string) {
    pendingFocus.current = { id: itemId, field };
  }

  async function mutation(
    path: string,
    method: string,
    change: Record<string, unknown>,
    updateDisplayedSnapshot = path === "" && method === "PATCH",
  ) {
    if (
      writing.current ||
      writePausedRef.current ||
      !summary ||
      !detailsReadyRef.current ||
      authGenerationRef.current !== authGeneration ||
      previousAuthGeneration.current !== authGeneration ||
      writeVersion.current === null
    )
      return false;
    writing.current = true;
    const operation = ++mutationGeneration.current;
    const requestAuthGeneration = authGenerationRef.current;
    const expectedVersion = writeVersion.current;
    const controller = new AbortController();
    mutationController.current = controller;
    const ownsMutation = () =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      previousAuthGeneration.current === requestAuthGeneration &&
      !controller.signal.aborted &&
      operation === mutationGeneration.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = jsonBody({ expected_version: expectedVersion, ...change });
      await api<void>(`/api/timelines/${encodeURIComponent(id)}${path}`, {
        method,
        ...body,
        headers: { ...body.headers, Prefer: "return=minimal" },
        signal: controller.signal,
      });
      if (!ownsMutation()) return false;
      const nextVersion = expectedVersion + 1;
      writeVersion.current = nextVersion;
      setSummary((current) =>
        current ? { ...current, version: nextVersion } : current,
      );
      if (updateDisplayedSnapshot) {
        setSnapshotVersion(nextVersion);
        setItemDetailsVersion(nextVersion);
      }
      if (path === "" && method === "PATCH")
        setSummary((current) =>
          current ? { ...current, ...change, version: nextVersion } : current,
        );
      return true;
    } catch (reason) {
      if (!ownsMutation()) return false;
      if (reason instanceof RequestError && reason.code === "CONFLICT") {
        setError(
          "This timeline changed elsewhere. The latest story is loading and your unsaved drafts are kept. Review them and try again.",
        );
        refreshOverview();
      } else setError(errorMessage(reason));
      return false;
    } finally {
      if (
        operation === mutationGeneration.current &&
        authGenerationRef.current === requestAuthGeneration &&
        previousAuthGeneration.current === requestAuthGeneration
      ) {
        writing.current = false;
        mutationController.current = null;
        if (live.current) setBusy(false);
      }
    }
  }

  function sameEventDraft(left: TimelineDraft, right: TimelineDraft) {
    return (
      left.eventKind === right.eventKind &&
      left.eventValue === right.eventValue &&
      left.timeZone === right.timeZone
    );
  }

  async function saveMoment(
    item: ItemDetail,
    change: Record<string, unknown>,
    submitted: TimelineDraft,
  ) {
    requestFieldFocus(item.id, "caption");
    const saved = await mutation(
      `/items/${encodeURIComponent(item.id)}`,
      "PATCH",
      change,
      false,
    );
    if (!saved) return false;
    const nextVersion = writeVersion.current;
    if (nextVersion === null) return false;
    setItemDetails((current) =>
      current.map((detail) =>
        detail.id === item.id
          ? {
              ...detail,
              ...(typeof change.caption === "string"
                ? { caption: change.caption }
                : {}),
              ...(Object.hasOwn(change, "event_at")
                ? { event_at: change.event_at as EventAt | null }
                : {}),
            }
          : detail,
      ),
    );
    setSnapshotVersion(nextVersion);
    setItemDetailsVersion(nextVersion);
    setItemNotices((current) => ({ ...current, [item.id]: "Moment saved" }));
    setFocusRequestVersion((current) => current + 1);
    setDrafts((current) => {
      const latest = current[item.id];
      if (!latest) return current;
      const next = {
        ...latest,
        dirty: {
          caption:
            latest.dirty.caption &&
            (!("caption" in change) || latest.caption !== submitted.caption),
          event:
            latest.dirty.event &&
            (!("event_at" in change) || !sameEventDraft(latest, submitted)),
        },
      };
      if (!next.dirty.caption && !next.dirty.event) {
        const result = { ...current };
        delete result[item.id];
        return result;
      }
      return { ...current, [item.id]: next };
    });
    return true;
  }

  async function append(ids: string[], onCommitted: (assetId: string) => void) {
    const added: string[] = [];
    const requestAuthGeneration = authGenerationRef.current;
    for (const assetId of ids) {
      if (
        !live.current ||
        authGenerationRef.current !== requestAuthGeneration ||
        previousAuthGeneration.current !== requestAuthGeneration
      )
        return added;
      const previousItems = indexItemsRef.current;
      const previousCount = totalItemsRef.current;
      if (!(await mutation("/items", "POST", { asset_id: assetId }, false)))
        return added;
      const expectedVersion = writeVersion.current;
      if (expectedVersion === null) return added;
      added.push(assetId);
      onCommitted(assetId);
      beginDetailReconciliation();
      const params = new URLSearchParams({
        limit: "2",
        version: String(expectedVersion),
      });
      const anchor = previousItems.at(-1);
      if (anchor) {
        params.set("from_position", String(anchor.position));
        params.set("from_id", anchor.id);
      }
      try {
        const tail = await api<OverviewPage>(
          `/api/timelines/${encodeURIComponent(id)}/overview?${params}`,
        );
        if (
          !live.current ||
          authGenerationRef.current !== requestAuthGeneration ||
          previousAuthGeneration.current !== requestAuthGeneration ||
          writeVersion.current !== expectedVersion
        )
          return added;
        const newRow = anchor ? tail.items[1] : tail.items[0];
        const validTail =
          tail.timeline.id === id &&
          tail.timeline.version === expectedVersion &&
          tail.total_items === previousCount + 1 &&
          tail.items.length === (anchor ? 2 : 1) &&
          tail.next_cursor === null &&
          (!anchor ||
            (tail.items[0]?.id === anchor.id &&
              tail.items[0].position === anchor.position)) &&
          !!newRow &&
          !previousItems.some((row) => row.id === newRow.id) &&
          (!anchor || newRow.position === anchor.position + 1) &&
          (anchor || newRow.position === 0);
        if (!validTail || !newRow)
          throw new Error("The timeline tail could not be verified.");
        const nextItems = [...previousItems, newRow];
        if (
          nextItems.length !== tail.total_items ||
          new Set(nextItems.map((row) => row.id)).size !== nextItems.length
        )
          throw new Error("The timeline index could not be verified.");
        setSummary(tail.timeline);
        setIndexItems(nextItems);
        setTotalItems(tail.total_items);
        setSnapshotVersion(expectedVersion);
        setGoToValue((current) =>
          String(
            Math.min(Math.max(Number(current) || 1, 1), tail.total_items || 1),
          ),
        );
      } catch {
        if (
          !live.current ||
          authGenerationRef.current !== requestAuthGeneration ||
          previousAuthGeneration.current !== requestAuthGeneration
        )
          return added;
        setError(
          "A moment was added, but the timeline could not confirm its latest order. Reloading the timeline before more changes.",
        );
        refreshOverview();
        return added;
      }
      if (!(await waitUntilReady(requestAuthGeneration))) return added;
    }
    if (live.current)
      setNotice(
        `${added.length} ${added.length === 1 ? "moment" : "moments"} added`,
      );
    return added;
  }

  async function move(itemId: string, direction: number) {
    const currentItems = indexItemsRef.current;
    if (currentItems.length > 1000 || writeVersion.current === null) return;
    const nextIds = currentItems.map((item) => item.id);
    const index = nextIds.indexOf(itemId);
    if (index < 0 || !nextIds[index + direction]) return;
    const [moved] = nextIds.splice(index, 1);
    if (!moved) return;
    nextIds.splice(index + direction, 0, moved);
    requestFieldFocus(itemId, "caption");
    if (await mutation("/order", "PUT", { item_ids: nextIds }, false)) {
      const nextItems = nextIds.map((idValue, position) => ({
        id: idValue,
        position,
      }));
      const movedTo = nextIds.indexOf(itemId);
      beginDetailReconciliation();
      setIndexItems(nextItems);
      setTotalItems(nextItems.length);
      setRangeStart(Math.floor(movedTo / 100) * 100);
      const nextVersion = writeVersion.current;
      if (nextVersion !== null) setSnapshotVersion(nextVersion);
      setNotice("Story order saved");
    }
  }

  async function removeMoment(item: ItemDetail) {
    const draft = draftFor(item);
    if (
      (draft.dirty.caption || draft.dirty.event) &&
      !window.confirm("Remove this moment and discard its unsaved changes?")
    )
      return;
    const currentItems = indexItemsRef.current;
    const index = currentItems.findIndex((row) => row.id === item.id);
    if (index < 0) return;
    const target = currentItems[index + 1] ?? currentItems[index - 1];
    if (target) requestFieldFocus(target.id, "caption");
    else pendingFocus.current = null;
    if (
      !(await mutation(
        `/items/${encodeURIComponent(item.id)}`,
        "DELETE",
        {},
        false,
      ))
    )
      return;
    setDrafts((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setItemNotices((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    const nextItems = currentItems.filter((row) => row.id !== item.id);
    const nextCount = Math.max(0, totalItemsRef.current - 1);
    const maxStart = Math.floor(Math.max(0, nextCount - 1) / 100) * 100;
    beginDetailReconciliation();
    setIndexItems(nextItems);
    setTotalItems(nextCount);
    setRangeStart((current) => Math.min(current, maxStart));
    setGoToValue((current) =>
      String(Math.min(Math.max(Number(current) || 1, 1), nextCount || 1)),
    );
    const nextVersion = writeVersion.current;
    if (nextVersion !== null) setSnapshotVersion(nextVersion);
    if (!target) pickerOpener.current?.focus();
  }

  function goToMoment(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ordinal = Number(goToValue);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > totalItems)
      return;
    setFocusHeadingRequested(true);
    setRangeStart(Math.floor((ordinal - 1) / 100) * 100);
  }

  function navigateRange(nextStart: number) {
    if (nextStart < 0 || nextStart >= totalItems || nextStart === rangeStart)
      return;
    setFocusHeadingRequested(true);
    setRangeStart(nextStart);
    setGoToValue(String(nextStart + 1));
  }

  if (!summary)
    return (
      <main id="main" className="timeline-page">
        {error ? (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setError("");
                setOverviewRequest((current) => current + 1);
              }}
            >
              Retry timeline
            </button>
          </>
        ) : (
          <p role="status">
            {overviewLoading
              ? `Loading timeline index… ${overviewProgress} moments`
              : "Opening your story…"}
          </p>
        )}
      </main>
    );

  return (
    <main id="main" className="timeline-page">
      <div className="timeline-intro editor-intro">
        <div>
          <p className="eyebrow">
            Living timeline ·{" "}
            {summary.visibility === "private"
              ? "Private"
              : summary.visibility === "unlisted"
                ? "Anyone with the link"
                : "Public"}
          </p>
          <h1>{summary.title}</h1>
          <p>{totalItems} moments, with more to come.</p>
        </div>
        <button
          className="button primary"
          type="button"
          ref={pickerOpener}
          onClick={() => setPicker(true)}
        >
          Add moments
        </button>
      </div>
      {error ? (
        <div className="error editor-notice" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setError("");
              refreshOverview();
            }}
          >
            Reload timeline
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="editor-notice">
          {notice}
        </p>
      ) : null}
      {unresolvedDrafts.length ? (
        <section className="editor-notice" aria-label="Unresolved drafts">
          <h2>Unresolved drafts</h2>
          <p>
            These moments were removed from the timeline elsewhere. Copy or
            discard each local draft; it cannot be saved to a removed moment.
          </p>
          <ul>
            {unresolvedDrafts.map(([itemId, draft]) => {
              const eventDescription =
                draft.eventKind === "none"
                  ? "No event date"
                  : `${draft.eventKind === "date" ? "Event date" : "Event time"}: ${draft.eventValue}\nTime zone: ${draft.timeZone}`;
              const copyText = `Caption: ${draft.caption}\n${eventDescription}`;
              return (
                <li key={itemId}>
                  <h3>Removed moment draft</h3>
                  <p>{draft.caption || "No caption"}</p>
                  <p>{eventDescription}</p>
                  <button type="button" disabled>
                    Save draft
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(copyText)
                        .catch((reason: unknown) =>
                          setError(errorMessage(reason)),
                        );
                    }}
                  >
                    Copy draft
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[itemId];
                        return next;
                      });
                      setItemNotices((current) => {
                        const next = { ...current };
                        delete next[itemId];
                        return next;
                      });
                    }}
                  >
                    Discard draft
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {assetError ? (
        <div role="alert" className="error editor-notice">
          {assetError}
          <button
            type="button"
            className="text-button"
            onClick={() => setAssets((existing) => ({ ...existing }))}
          >
            Retry media details
          </button>
        </div>
      ) : null}
      <StoryViewport positions={viewportPositions} />
      {totalItems > 0 ? (
        <section className="moment-range" aria-label="Moment range navigation">
          <h2 ref={heading} tabIndex={-1} id="moment-range-heading">
            Moments {rangeStart + 1}–{Math.min(rangeStart + 100, totalItems)} of{" "}
            {totalItems}
          </h2>
          <form onSubmit={goToMoment}>
            <label htmlFor="go-to-moment">Go to moment</label>
            <input
              id="go-to-moment"
              type="number"
              min={1}
              max={totalItems}
              value={goToValue}
              onChange={(event) => setGoToValue(event.target.value)}
            />
            <button className="button secondary" type="submit">
              Go
            </button>
          </form>
          <div className="range-actions">
            <button
              className="button secondary"
              type="button"
              disabled={rangeStart === 0}
              onClick={() => navigateRange(rangeStart - 100)}
            >
              Previous 100 moments
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={rangeStart + 100 >= totalItems}
              onClick={() => navigateRange(rangeStart + 100)}
            >
              Next 100 moments
            </button>
          </div>
        </section>
      ) : null}
      {detailError ? (
        <div className="error editor-notice" role="alert">
          {detailError}
          <button
            className="text-button"
            type="button"
            onClick={() => setDetailRetry((current) => current + 1)}
          >
            Retry moments
          </button>
        </div>
      ) : null}
      {overviewLoading ? (
        <p role="status">
          Refreshing timeline index… {overviewProgress} moments
        </p>
      ) : null}
      <div className="editor-layout">
        <div className="story-items">
          {totalItems ? (
            detailsReady ? (
              <ol>
                {itemDetails.map((item, index) => (
                  <li
                    key={item.id}
                    aria-posinset={rangeStart + index + 1}
                    aria-setsize={totalItems}
                  >
                    <Moment
                      item={item}
                      index={rangeStart + index}
                      asset={item.asset}
                      draft={draftFor(item)}
                      changeDraft={(patch, field) =>
                        changeDraft(item, patch, field)
                      }
                      busy={busy || writePaused || !detailsReady}
                      last={rangeStart + index + 1 === totalItems}
                      notice={itemNotices[item.id] ?? ""}
                      setNotice={(value) =>
                        setItemNotices((current) => ({
                          ...current,
                          [item.id]: value,
                        }))
                      }
                      save={(change, submitted) =>
                        saveMoment(item, change, submitted)
                      }
                      move={(direction) => void move(item.id, direction)}
                      remove={() => void removeMoment(item)}
                      showMoveControls={totalItems <= 1000}
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p role="status">
                {detailLoading
                  ? "Loading moments…"
                  : "Moments are not available yet."}
              </p>
            )
          ) : (
            <div className="empty-state">
              <h2>A first moment, then another.</h2>
              <p>Choose photos or videos from your private library to begin.</p>
            </div>
          )}
        </div>
        <aside className="story-settings">
          <Settings
            story={summary}
            assets={Object.values(assets)}
            busy={busy || writePaused || !detailsReady}
            save={(change) => mutation("", "PATCH", change)}
          />
          <ShareLink id={id} visibility={summary.visibility} />
        </aside>
      </div>
      {picker ? (
        <LibraryPicker
          assets={library}
          loading={libraryLoading}
          error={libraryError}
          writeError={error}
          busy={busy || writePaused || !detailsReady}
          cursor={cursor}
          more={() => void libraryPage(cursor ?? undefined)}
          retry={() => void libraryPage()}
          append={append}
          close={() => {
            setPicker(false);
            if (pickerOpener.current?.isConnected) pickerOpener.current.focus();
          }}
        />
      ) : null}
    </main>
  );
}

function momentMediaUrl(asset: MomentAsset) {
  return `/api/assets/${encodeURIComponent(asset.id)}/media`;
}

function Moment({
  item,
  index,
  asset,
  draft,
  changeDraft,
  busy,
  last,
  notice,
  setNotice,
  save,
  move,
  remove,
  showMoveControls,
}: {
  item: ItemDetail;
  index: number;
  asset?: MomentAsset;
  draft: TimelineDraft;
  changeDraft: (
    patch: Partial<Omit<TimelineDraft, "dirty">>,
    field: "caption" | "event",
  ) => void;
  busy: boolean;
  last: boolean;
  notice: string;
  setNotice: (value: string) => void;
  save: (
    change: Record<string, unknown>,
    submitted: TimelineDraft,
  ) => Promise<boolean>;
  move: (direction: number) => void;
  remove: () => void;
  showMoveControls: boolean;
}) {
  const mediaPlaceholder = useRef<HTMLDivElement>(null);
  const [mediaInBand, setMediaInBand] = useState(false);
  const [explicitMediaLoad, setExplicitMediaLoad] = useState(false);
  const assetId = asset?.id;
  const observerSupported =
    typeof window !== "undefined" &&
    typeof window.IntersectionObserver === "function";

  useEffect(() => {
    const node = mediaPlaceholder.current;
    if (!node || !assetId || !observerSupported) return;
    let observer: IntersectionObserver | null = null;
    const observeWithViewportOverscan = () => {
      observer?.disconnect();
      const overscan = window.innerHeight;
      observer = new IntersectionObserver(
        (entries) => {
          setMediaInBand(entries.some((entry) => entry.isIntersecting));
        },
        { rootMargin: `${overscan}px 0px ${overscan}px 0px` },
      );
      observer.observe(node);
    };
    observeWithViewportOverscan();
    window.addEventListener("resize", observeWithViewportOverscan);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", observeWithViewportOverscan);
    };
  }, [assetId, observerSupported]);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const eventAt: EventAt | null =
      draft.eventKind === "date"
        ? {
            kind: "date",
            date: draft.eventValue,
            time_zone: draft.timeZone,
            calendar: "iso8601",
          }
        : draft.eventKind === "instant"
          ? {
              kind: "instant",
              instant: draft.eventValue,
              time_zone: draft.timeZone,
            }
          : null;
    const change = {
      ...(draft.dirty.caption ? { caption: draft.caption } : {}),
      ...(draft.dirty.event ? { event_at: eventAt } : {}),
    };
    if (!Object.keys(change).length) {
      setNotice("Moment is up to date");
      return;
    }
    await save(change, draft);
  }
  const field = `item-${item.id}`;
  const hasDimensions =
    asset !== undefined &&
    asset.width !== null &&
    asset.height !== null &&
    Number.isFinite(asset.width) &&
    Number.isFinite(asset.height) &&
    asset.width > 0 &&
    asset.height > 0;
  const aspectRatio =
    hasDimensions && asset ? `${asset.width} / ${asset.height}` : undefined;
  const mountMedia = observerSupported ? mediaInBand : explicitMediaLoad;
  return (
    <fieldset className="moment" aria-label={`Moment ${index + 1}`}>
      <legend>Moment {index + 1}</legend>
      <div
        ref={mediaPlaceholder}
        className={`moment-media${aspectRatio ? " has-aspect-ratio" : ""}`}
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        {asset?.kind === "image" && mountMedia ? (
          <img
            src={momentMediaUrl(asset)}
            alt={asset.original_name}
            loading="lazy"
          />
        ) : asset?.kind === "video" && mountMedia ? (
          <video
            src={momentMediaUrl(asset)}
            controls
            preload="none"
            aria-label={asset.original_name}
          >
            <track kind="captions" />
          </video>
        ) : asset && !observerSupported && !explicitMediaLoad ? (
          <button
            className="button secondary moment-media-load"
            type="button"
            onClick={() => setExplicitMediaLoad(true)}
          >
            Load media
          </button>
        ) : (
          <span className="sr-only">
            {asset
              ? "Media loads when this moment approaches the viewport."
              : "Loading this moment’s media…"}
          </span>
        )}
      </div>
      <div className="moment-content">
        <h2>{asset?.original_name ?? "Library moment"}</h2>
        <p className="field-help">
          This caption and date belong to this story. The original media stays
          unchanged.
        </p>
        <form onSubmit={submit}>
          <label htmlFor={`${field}-caption`}>Caption</label>
          <textarea
            id={`${field}-caption`}
            value={draft.caption}
            maxLength={10000}
            rows={3}
            onChange={(event) => {
              changeDraft({ caption: event.target.value }, "caption");
              setNotice("");
            }}
          />
          <div className="event-fields">
            <div>
              <label htmlFor={`${field}-kind`}>Date type</label>
              <select
                id={`${field}-kind`}
                value={draft.eventKind}
                onChange={(event) => {
                  changeDraft(
                    {
                      eventKind: event.target
                        .value as TimelineDraft["eventKind"],
                    },
                    "event",
                  );
                  setNotice("");
                }}
              >
                <option value="none">No event date</option>
                <option value="date">Calendar date</option>
                <option value="instant">Exact time</option>
              </select>
            </div>
            {draft.eventKind === "date" ? (
              <div>
                <label htmlFor={`${field}-date`}>Event date</label>
                <input
                  id={`${field}-date`}
                  type="date"
                  value={draft.eventValue}
                  required
                  onChange={(event) => {
                    changeDraft({ eventValue: event.target.value }, "event");
                  }}
                />
              </div>
            ) : draft.eventKind === "instant" ? (
              <div>
                <label htmlFor={`${field}-instant`}>Event instant</label>
                <input
                  id={`${field}-instant`}
                  value={draft.eventValue}
                  required
                  placeholder="2026-10-04T10:30:00+08:00"
                  onChange={(event) => {
                    changeDraft({ eventValue: event.target.value }, "event");
                  }}
                />
              </div>
            ) : null}
            {draft.eventKind !== "none" ? (
              <div>
                <label htmlFor={`${field}-zone`}>Time zone</label>
                <input
                  id={`${field}-zone`}
                  value={draft.timeZone}
                  required
                  maxLength={100}
                  placeholder="Asia/Taipei"
                  onChange={(event) => {
                    changeDraft({ timeZone: event.target.value }, "event");
                  }}
                />
              </div>
            ) : null}
          </div>
          {draft.eventKind === "instant" ? (
            <p className="field-help">
              Use an ISO timestamp with an explicit offset. The named time zone
              controls presentation.
            </p>
          ) : null}
          <div className="moment-actions">
            <button className="button secondary" type="submit" disabled={busy}>
              Save moment
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={remove}
            >
              Remove moment
            </button>
            {notice ? <p role="status">{notice}</p> : null}
          </div>
        </form>
        {showMoveControls ? (
          <div className="order-actions">
            <button
              className="text-button"
              type="button"
              disabled={busy || index === 0}
              onClick={() => void move(-1)}
            >
              Move earlier
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy || last}
              onClick={() => void move(1)}
            >
              Move later
            </button>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

function Settings({
  story,
  assets,
  busy,
  save,
}: {
  story: Summary;
  assets: LibraryAsset[];
  busy: boolean;
  save: (change: Record<string, unknown>) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(story.title);
  const [visibility, setVisibility] = useState(story.visibility);
  const [cover, setCover] = useState(story.cover_asset_id ?? "");
  const [dirty, setDirty] = useState({
    title: false,
    visibility: false,
    cover: false,
  });
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!dirty.title) setTitle(story.title);
    if (!dirty.visibility) setVisibility(story.visibility);
    if (!dirty.cover) setCover(story.cover_asset_id ?? "");
  }, [story.title, story.visibility, story.cover_asset_id, dirty]);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const change = {
      ...(dirty.title ? { title } : {}),
      ...(dirty.visibility ? { visibility } : {}),
      ...(dirty.cover ? { cover_asset_id: cover || null } : {}),
    };
    if (!Object.keys(change).length) {
      setNotice("Timeline is up to date");
      return;
    }
    if (await save(change)) {
      setDirty({ title: false, visibility: false, cover: false });
      setNotice("Timeline saved");
    }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <h2>About this story</h2>
      <label htmlFor="story-title">Timeline title</label>
      <input
        id="story-title"
        value={title}
        maxLength={200}
        required
        onChange={(event) => {
          setTitle(event.target.value);
          setDirty((value) => ({ ...value, title: true }));
        }}
      />
      <label htmlFor="story-cover">Cover</label>
      <select
        id="story-cover"
        value={cover}
        onChange={(event) => {
          setCover(event.target.value);
          setDirty((value) => ({ ...value, cover: true }));
        }}
      >
        <option value="">No cover</option>
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.original_name}
          </option>
        ))}
      </select>
      <label htmlFor="story-visibility">Visibility</label>
      <select
        id="story-visibility"
        value={visibility}
        onChange={(event) => {
          setVisibility(event.target.value as typeof visibility);
          setDirty((value) => ({ ...value, visibility: true }));
        }}
      >
        <option value="private">Private</option>
        <option value="unlisted">Anyone with the link</option>
        <option value="public">Public</option>
      </select>
      <p className="field-help">
        Private is only for you. Anyone with the link can view an unlisted
        story; it asks search engines not to index it. Public stories permit
        indexing.
      </p>
      <button type="submit" className="button secondary" disabled={busy}>
        Save timeline
      </button>
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  );
}

function ShareLink({
  id,
  visibility,
}: {
  id: string;
  visibility: Story["visibility"];
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [request, setRequest] = useState({
    path: `/t/${encodeURIComponent(id)}`,
  });
  useEffect(() => {
    setUrl("");
    setError("");
    if (visibility === "private") return;
    const controller = new AbortController();
    const path = request.path;
    fetch(path, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer unavailable");
        const html = await response.text();
        const value = new DOMParser()
          .parseFromString(html, "text/html")
          .querySelector('link[rel="canonical"]')
          ?.getAttribute("href");
        if (!value) throw new Error("Canonical link unavailable");
        const canonical = new URL(value);
        if (
          !["http:", "https:"].includes(canonical.protocol) ||
          canonical.pathname !== path ||
          canonical.search ||
          canonical.hash ||
          canonical.username ||
          canonical.password
        )
          throw new Error("Invalid canonical link");
        if (!controller.signal.aborted) setUrl(canonical.href);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The share link could not be loaded. Please retry.");
      });
    return () => controller.abort();
  }, [visibility, request]);
  return (
    <section className="share-panel" aria-label="Share timeline">
      <h2>Keep the story going</h2>
      {visibility === "private" ? (
        <p>This story is private. Choose “Anyone with the link” to share it.</p>
      ) : error ? (
        <>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            className="button secondary"
            type="button"
            onClick={() => setRequest({ path: `/t/${encodeURIComponent(id)}` })}
          >
            Retry share link
          </button>
        </>
      ) : url ? (
        <>
          <label htmlFor="canonical-share-link">Share URL</label>
          <input
            id="canonical-share-link"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <a className="text-button" href={url}>
            Open shared timeline
          </a>
          <p className="field-help">
            This link stays the same when you add more moments.
          </p>
        </>
      ) : (
        <p role="status">Loading share link…</p>
      )}
    </section>
  );
}

function LibraryPicker({
  assets,
  loading,
  error,
  writeError,
  busy,
  cursor,
  more,
  retry,
  append,
  close,
}: {
  assets: LibraryAsset[];
  loading: boolean;
  error: string;
  writeError: string;
  busy: boolean;
  cursor: string | null;
  more: () => void;
  retry: () => void;
  append: (
    ids: string[],
    onCommitted: (assetId: string) => void,
  ) => Promise<string[]>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismissed = useRef(false);
  const mounted = useRef(true);
  const [selected, setSelected] = useState(new Set<string>());
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  function notifyDismissal() {
    if (dismissed.current || !mounted.current) return;
    dismissed.current = true;
    close();
  }
  function dismiss() {
    dialog.current?.close();
    notifyDismissal();
  }
  async function add() {
    setAdding(true);
    const ids = [...selected];
    const added = await append(ids, (assetId) => {
      if (!mounted.current) return;
      setSelected((current) => {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
    });
    if (!mounted.current) return;
    setSelected(
      (current) => new Set([...current].filter((id) => !added.includes(id))),
    );
    setAdding(false);
    if (added.length === ids.length && added.length > 0) dismiss();
  }
  return (
    <dialog
      ref={dialog}
      className="detail-dialog moment-picker"
      aria-labelledby="picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!adding) dismiss();
      }}
      onClose={notifyDismissal}
    >
      <div className="detail-header">
        <h2 id="picker-title">Add moments</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close moment picker"
          disabled={adding}
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      <p>
        Your private library. Reuse media without copying it; each story has its
        own captions and dates.
      </p>
      {error ? (
        <div role="alert" className="error">
          {error}
          <button type="button" className="text-button" onClick={retry}>
            Retry library
          </button>
        </div>
      ) : null}
      {writeError ? (
        <div role="alert" className="error">
          {writeError}
          <button type="button" className="text-button" onClick={retry}>
            Refresh library
          </button>
        </div>
      ) : null}
      <div className="picker-grid">
        {assets.map((asset) => (
          <label key={asset.id} className="picker-card">
            <input
              type="checkbox"
              aria-label={`Select ${asset.original_name}`}
              checked={selected.has(asset.id)}
              disabled={adding}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(asset.id);
                  else next.delete(asset.id);
                  return next;
                })
              }
            />
            {asset.kind === "image" ? (
              <img
                src={mediaUrl(asset)}
                alt={asset.original_name}
                loading="lazy"
              />
            ) : (
              <span className="picker-video">Video</span>
            )}
            <span>{asset.original_name}</span>
          </label>
        ))}
      </div>
      {loading ? (
        <p role="status">Loading library…</p>
      ) : cursor ? (
        <button type="button" className="button secondary" onClick={more}>
          More library moments
        </button>
      ) : !assets.length && !error ? (
        <p>Your library is empty. Add photos or videos in Library first.</p>
      ) : null}
      <div className="picker-actions">
        <p>{selected.size} selected</p>
        {selected.size > 0 ? (
          <button
            type="button"
            className="text-button"
            disabled={adding}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        ) : null}
        <button
          type="button"
          className="button primary"
          disabled={!selected.size || adding || busy}
          onClick={() => void add()}
        >
          {adding ? "Adding moments…" : "Add selected moments"}
        </button>
      </div>
    </dialog>
  );
}
