import { useEffect, useRef, useState } from "react";
import { api, errorMessage, jsonBody } from "./api";

type Visibility = "private" | "unlisted" | "public";
type ContentNode = {
  id: string;
  kind: "timeline" | "external";
  visibility: Visibility;
  timeline_id: string | null;
  url: string | null;
  title: string | null;
};
type NodePage = { nodes: ContentNode[]; next_cursor: string | null };
type NodeDetail = {
  node: ContentNode;
  effective_visibility: Visibility | null;
};
type TimelinePage = {
  timelines: { id: string; title: string; visibility: Visibility }[];
};

const visibilityOptions: { value: Visibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "unlisted", label: "Unlisted" },
  { value: "public", label: "Public" },
];

function nodeLabel(node: ContentNode) {
  return node.title || node.url || "Untitled reference";
}

function collectionPath(removed: boolean) {
  return `/api/content-nodes?limit=30${removed ? "&removed=true" : ""}`;
}

export function ContentNodesScreen({
  authGeneration,
}: {
  authGeneration: number;
}): React.JSX.Element {
  const authGenerationRef = useRef(authGeneration);
  authGenerationRef.current = authGeneration;
  const collectionGenerationRef = useRef(0);
  const [nodes, setNodes] = useState<ContentNode[]>([]);
  const [timelines, setTimelines] = useState<TimelinePage["timelines"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [removedMode, setRemovedMode] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [status, setStatus] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [externalTitle, setExternalTitle] = useState("");
  const [externalVisibility, setExternalVisibility] =
    useState<Visibility>("private");
  const [timelineId, setTimelineId] = useState("");
  const [timelineVisibility, setTimelineVisibility] =
    useState<Visibility>("private");
  const [editTitle, setEditTitle] = useState("");
  const [editVisibility, setEditVisibility] = useState<Visibility>("private");

  function refreshCollection() {
    collectionGenerationRef.current += 1;
    setRefreshVersion((version) => version + 1);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshVersion intentionally triggers a fresh collection read.
  useEffect(() => {
    const generation = ++collectionGenerationRef.current;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api<NodePage>(collectionPath(removedMode), {
        signal: controller.signal,
      }),
      api<TimelinePage>("/api/timelines?limit=100", {
        signal: controller.signal,
      }),
    ])
      .then(([page, timelinePage]) => {
        if (
          !active ||
          authGenerationRef.current !== authGeneration ||
          collectionGenerationRef.current !== generation
        )
          return;
        setNodes(page.nodes);
        setNextCursor(page.next_cursor);
        setTimelines(timelinePage.timelines);
        setSelectedId((current) =>
          current && page.nodes.some((node) => node.id === current)
            ? current
            : (page.nodes[0]?.id ?? null),
        );
      })
      .catch((reason: unknown) => {
        if (
          !active ||
          controller.signal.aborted ||
          authGenerationRef.current !== authGeneration ||
          collectionGenerationRef.current !== generation
        )
          return;
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (
          active &&
          authGenerationRef.current === authGeneration &&
          collectionGenerationRef.current === generation
        )
          setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [authGeneration, refreshVersion, removedMode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshVersion intentionally triggers a fresh detail read.
  useEffect(() => {
    if (removedMode || !selectedId) {
      setDetail(null);
      setDetailError("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    api<NodeDetail>(`/api/content-nodes/${encodeURIComponent(selectedId)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!active || authGenerationRef.current !== authGeneration) return;
        setDetail(result);
        setEditTitle(result.node.title ?? "");
        setEditVisibility(result.node.visibility);
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        setDetailError(errorMessage(reason));
      })
      .finally(() => {
        if (active && authGenerationRef.current === authGeneration)
          setDetailLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [authGeneration, refreshVersion, removedMode, selectedId]);

  async function createExternal(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const generation = authGeneration;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ node: ContentNode }>("/api/content-nodes", {
        method: "POST",
        ...jsonBody({
          kind: "external",
          url: externalUrl,
          title: externalTitle.trim() || null,
          visibility: externalVisibility,
        }),
      });
      if (authGenerationRef.current !== generation) return;
      setSelectedId(result.node.id);
      setExternalUrl("");
      setExternalTitle("");
      setStatus("Reference added.");
      refreshCollection();
    } catch (reason) {
      if (authGenerationRef.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (authGenerationRef.current === generation) setSaving(false);
    }
  }

  async function createTimelineReference(
    event: React.SubmitEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const generation = authGeneration;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ node: ContentNode }>("/api/content-nodes", {
        method: "POST",
        ...jsonBody({
          kind: "timeline",
          timeline_id: timelineId,
          visibility: timelineVisibility,
        }),
      });
      if (authGenerationRef.current !== generation) return;
      setSelectedId(result.node.id);
      setStatus("Timeline reference added.");
      refreshCollection();
    } catch (reason) {
      if (authGenerationRef.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (authGenerationRef.current === generation) setSaving(false);
    }
  }

  async function saveSelected(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const generation = authGeneration;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await api<{ node: ContentNode }>(
        `/api/content-nodes/${encodeURIComponent(detail.node.id)}`,
        {
          method: "PATCH",
          ...jsonBody({
            ...(detail.node.kind === "external"
              ? { title: editTitle.trim() || null }
              : {}),
            visibility: editVisibility,
          }),
        },
      );
      if (authGenerationRef.current !== generation) return;
      setStatus("Reference saved.");
      refreshCollection();
    } catch (reason) {
      if (authGenerationRef.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (authGenerationRef.current === generation) setSaving(false);
    }
  }

  async function removeSelected() {
    if (!detail) return;
    const generation = authGeneration;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await api<{ node: ContentNode }>(
        `/api/content-nodes/${encodeURIComponent(detail.node.id)}`,
        { method: "DELETE" },
      );
      if (authGenerationRef.current !== generation) return;
      setSelectedId(null);
      setStatus("Reference removed. The original content is still intact.");
      refreshCollection();
    } catch (reason) {
      if (authGenerationRef.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (authGenerationRef.current === generation) setSaving(false);
    }
  }

  async function restore(node: ContentNode) {
    const generation = authGeneration;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ node: ContentNode }>(
        `/api/content-nodes/${encodeURIComponent(node.id)}`,
        { method: "PATCH", ...jsonBody({ removed: false }) },
      );
      if (authGenerationRef.current !== generation) return;
      setRemovedMode(false);
      setSelectedId(result.node.id);
      setStatus("Reference restored.");
      refreshCollection();
    } catch (reason) {
      if (authGenerationRef.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (authGenerationRef.current === generation) setSaving(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    const generation = authGeneration;
    const collectionGeneration = collectionGenerationRef.current;
    setLoading(true);
    setError("");
    try {
      const page = await api<NodePage>(
        `${collectionPath(removedMode)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (
        authGenerationRef.current !== generation ||
        collectionGenerationRef.current !== collectionGeneration
      )
        return;
      setNodes((current) => [
        ...current,
        ...page.nodes.filter(
          (node) => !current.some((item) => item.id === node.id),
        ),
      ]);
      setNextCursor(page.next_cursor);
    } catch (reason) {
      if (
        authGenerationRef.current === generation &&
        collectionGenerationRef.current === collectionGeneration
      )
        setError(errorMessage(reason));
    } finally {
      if (
        authGenerationRef.current === generation &&
        collectionGenerationRef.current === collectionGeneration
      )
        setLoading(false);
    }
  }

  function changeCollection() {
    collectionGenerationRef.current += 1;
    setNodes([]);
    setNextCursor(null);
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setLoading(true);
    setError("");
    setStatus("");
    setRemovedMode((removed) => !removed);
  }

  const selectedLabel = detail ? nodeLabel(detail.node) : "";

  return (
    <main id="main" className="content-nodes-page">
      <div className="content-nodes-intro">
        <p className="eyebrow">Your collection, connected</p>
        <h1>Your content</h1>
        <p>
          Keep stable references to your Timelines and pages. Removing a
          reference leaves the original content intact.
        </p>
      </div>

      <div className="content-nodes-toolbar">
        <button
          type="button"
          className="text-button"
          onClick={changeCollection}
          aria-pressed={removedMode}
        >
          {removedMode ? "Show live references" : "Show removed references"}
        </button>
        {status ? <p role="status">{status}</p> : null}
      </div>

      {error ? (
        <div className="content-node-error">
          <p className="error" role="alert">
            {error}
          </p>
          <button type="button" className="button" onClick={refreshCollection}>
            Try again
          </button>
        </div>
      ) : null}

      {!removedMode ? (
        <div className="content-node-forms">
          <form
            className="content-node-form"
            onSubmit={createTimelineReference}
          >
            <h2>Add an existing Timeline</h2>
            <label htmlFor="content-node-timeline">Timeline</label>
            <select
              id="content-node-timeline"
              value={timelineId}
              onChange={(event) => setTimelineId(event.target.value)}
              disabled={!timelines.length || saving}
              required
            >
              <option value="">Choose a Timeline</option>
              {timelines.map((timeline) => (
                <option key={timeline.id} value={timeline.id}>
                  {timeline.title}
                </option>
              ))}
            </select>
            <label htmlFor="content-node-timeline-visibility">
              Timeline reference visibility
            </label>
            <select
              id="content-node-timeline-visibility"
              value={timelineVisibility}
              onChange={(event) =>
                setTimelineVisibility(event.target.value as Visibility)
              }
              disabled={saving}
            >
              {visibilityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="button primary"
              type="submit"
              disabled={!timelines.length || saving}
            >
              Add Timeline reference
            </button>
          </form>

          <form className="content-node-form" onSubmit={createExternal}>
            <h2>Add an external page</h2>
            <label htmlFor="content-node-url">External page URL</label>
            <input
              id="content-node-url"
              type="url"
              maxLength={4096}
              required
              value={externalUrl}
              onChange={(event) => setExternalUrl(event.target.value)}
              placeholder="https://example.com/story"
            />
            <label htmlFor="content-node-title">External title</label>
            <input
              id="content-node-title"
              maxLength={200}
              value={externalTitle}
              onChange={(event) => setExternalTitle(event.target.value)}
              placeholder="A place or story to remember"
            />
            <label htmlFor="content-node-visibility">Visibility</label>
            <select
              id="content-node-visibility"
              value={externalVisibility}
              onChange={(event) =>
                setExternalVisibility(event.target.value as Visibility)
              }
              disabled={saving}
            >
              {visibilityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="button primary" type="submit" disabled={saving}>
              Add reference
            </button>
          </form>
        </div>
      ) : null}

      <div className="content-node-workspace">
        <section className="content-node-list-panel" aria-label="References">
          <h2>{removedMode ? "Removed references" : "Your references"}</h2>
          {loading && nodes.length === 0 ? (
            <p role="status">Loading references…</p>
          ) : nodes.length === 0 ? (
            <p>
              {removedMode
                ? "There are no removed references."
                : "Your references will appear here."}
            </p>
          ) : (
            <ul className="content-node-list">
              {nodes.map((node) => (
                <li key={node.id}>
                  {removedMode ? (
                    <div className="content-node-removed-row">
                      <span>{nodeLabel(node)}</span>
                      <button
                        type="button"
                        className="button"
                        disabled={saving}
                        onClick={() => restore(node)}
                        aria-label={`Restore ${nodeLabel(node)}`}
                      >
                        Restore
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="content-node-select"
                      aria-label={`Edit ${nodeLabel(node)}`}
                      aria-pressed={selectedId === node.id}
                      onClick={() => setSelectedId(node.id)}
                    >
                      <span>{nodeLabel(node)}</span>
                      <span className="content-node-kind">
                        {node.kind === "timeline"
                          ? "Timeline"
                          : "External page"}
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {nextCursor ? (
            <button
              type="button"
              className="button"
              onClick={loadMore}
              disabled={loading}
            >
              Load more references
            </button>
          ) : null}
        </section>

        {!removedMode ? (
          <section
            className="content-node-detail-panel"
            aria-label="Selected reference"
          >
            {detailLoading ? <p role="status">Loading reference…</p> : null}
            {detailError ? (
              <div className="content-node-error">
                <p className="error" role="alert">
                  {detailError}
                </p>
                <button
                  type="button"
                  className="button"
                  onClick={refreshCollection}
                >
                  Try again
                </button>
              </div>
            ) : null}
            {detail ? (
              <>
                <h2>{selectedLabel}</h2>
                <p className="content-node-visibility">
                  Reference visibility: {detail.node.visibility}
                </p>
                <p className="content-node-visibility">
                  Effective visibility:{" "}
                  {detail.effective_visibility ?? "unavailable"}
                </p>
                <p className="content-node-reference-url">
                  Reference URL:{" "}
                  <a href={`/c/${encodeURIComponent(detail.node.id)}`}>
                    /c/{detail.node.id}
                  </a>
                </p>
                {detail.node.timeline_id ? (
                  <p>
                    <a
                      href={`/timelines/${encodeURIComponent(detail.node.timeline_id)}`}
                    >
                      Open Timeline editor
                    </a>
                  </p>
                ) : null}
                <form className="content-node-form" onSubmit={saveSelected}>
                  {detail.node.kind === "external" ? (
                    <>
                      <label htmlFor="content-node-edit-title">Title</label>
                      <input
                        id="content-node-edit-title"
                        maxLength={200}
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                      />
                      <p className="field-help">{detail.node.url}</p>
                    </>
                  ) : null}
                  <label htmlFor="content-node-edit-visibility">
                    Node visibility
                  </label>
                  <select
                    id="content-node-edit-visibility"
                    value={editVisibility}
                    onChange={(event) =>
                      setEditVisibility(event.target.value as Visibility)
                    }
                    disabled={saving}
                  >
                    {visibilityOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={saving}
                  >
                    Save changes
                  </button>
                </form>
                <div className="content-node-remove">
                  <p>
                    Removing this reference leaves its Timeline, original
                    Assets, and independent Links intact.
                  </p>
                  <button
                    type="button"
                    className="button danger"
                    disabled={saving}
                    onClick={removeSelected}
                    aria-label={`Remove reference to ${selectedLabel}`}
                  >
                    Remove reference
                  </button>
                </div>
              </>
            ) : !detailLoading && !detailError ? (
              <p>Select a reference to view its access and edit it.</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
