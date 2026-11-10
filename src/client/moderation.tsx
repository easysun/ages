import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ContentEdgeModerationState,
  type ContentEdgeReportPage,
  type ContentNodeModerationState,
  errorMessage,
  jsonBody,
  type ModerationState,
  type ModerationTarget,
  type ReportPage,
  RequestError,
} from "./api";

function isAuthorizationFailure(reason: unknown): reason is RequestError {
  return (
    reason instanceof RequestError &&
    (reason.status === 401 ||
      reason.status === 403 ||
      reason.code === "UNAUTHENTICATED" ||
      reason.code === "FORBIDDEN")
  );
}

function ContentEdgeReports({
  authGeneration,
}: {
  authGeneration: number;
}): React.JSX.Element {
  const [reports, setReports] = useState<ContentEdgeReportPage["reports"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeState, setEdgeState] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [stateError, setStateError] = useState("");
  const [notice, setNotice] = useState("");
  const [stateLoading, setStateLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const authGenerationRef = useRef(authGeneration);
  authGenerationRef.current = authGeneration;
  const selectedEdgeIdRef = useRef<string | null>(null);
  const live = useRef(false);
  const reportGeneration = useRef(0);
  const edgeGeneration = useRef(0);
  const reportController = useRef<AbortController | null>(null);
  const stateController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);

  const clearPrivateState = useCallback((reason: unknown) => {
    reportGeneration.current++;
    edgeGeneration.current++;
    reportController.current?.abort();
    stateController.current?.abort();
    mutationController.current?.abort();
    selectedEdgeIdRef.current = null;
    setReports([]);
    setCursor(null);
    setError("");
    setSelectedEdgeId(null);
    setEdgeState(null);
    setReason("");
    setStateError("");
    setNotice("");
    setLoading(false);
    setStateLoading(false);
    setSaving(false);
    setDenied(
      reason instanceof RequestError && reason.status === 403
        ? "Access denied"
        : "Your session has ended",
    );
  }, []);

  const loadReports = useCallback(
    async (next: string | null) => {
      const request = ++reportGeneration.current;
      const requestAuthGeneration = authGeneration;
      reportController.current?.abort();
      const controller = new AbortController();
      reportController.current = controller;
      setLoading(true);
      setError("");
      try {
        const result = await api<ContentEdgeReportPage>(
          `/api/admin/content-edge-reports?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
          { signal: controller.signal },
        );
        if (
          !live.current ||
          authGenerationRef.current !== requestAuthGeneration ||
          reportGeneration.current !== request
        )
          return;
        setReports((previous) =>
          next
            ? [
                ...new Map(
                  [...previous, ...result.reports].map((report) => [
                    report.id,
                    report,
                  ]),
                ).values(),
              ]
            : result.reports,
        );
        setCursor(result.next_cursor);
      } catch (reason) {
        if (
          !live.current ||
          controller.signal.aborted ||
          authGenerationRef.current !== requestAuthGeneration ||
          reportGeneration.current !== request
        )
          return;
        if (isAuthorizationFailure(reason)) {
          clearPrivateState(reason);
          return;
        }
        setError(
          reason instanceof RequestError
            ? reason.message
            : errorMessage(reason),
        );
      } finally {
        if (
          live.current &&
          authGenerationRef.current === requestAuthGeneration &&
          reportGeneration.current === request
        )
          setLoading(false);
      }
    },
    [authGeneration, clearPrivateState],
  );

  useEffect(() => {
    live.current = true;
    selectedEdgeIdRef.current = null;
    setReports([]);
    setCursor(null);
    setSelectedEdgeId(null);
    setEdgeState(null);
    setReason("");
    setError("");
    setDenied("");
    void loadReports(null);
    return () => {
      live.current = false;
      reportGeneration.current++;
      edgeGeneration.current++;
      reportController.current?.abort();
      stateController.current?.abort();
      mutationController.current?.abort();
    };
  }, [loadReports]);

  function ownsEdgeOperation(
    id: string,
    request: number,
    requestAuthGeneration: number,
  ) {
    return (
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      selectedEdgeIdRef.current === id &&
      edgeGeneration.current === request
    );
  }

  async function readEdgeState(id: string) {
    stateController.current?.abort();
    const controller = new AbortController();
    stateController.current = controller;
    const request = ++edgeGeneration.current;
    const requestAuthGeneration = authGenerationRef.current;
    setStateLoading(true);
    setStateError("");
    try {
      const result = await api<ContentEdgeModerationState>(
        `/api/admin/content-edges/${encodeURIComponent(id)}`,
        { signal: controller.signal },
      );
      if (!ownsEdgeOperation(id, request, requestAuthGeneration)) return;
      setEdgeState(result.moderation.blocked);
      setStateError("");
    } catch (reason) {
      if (
        controller.signal.aborted ||
        !ownsEdgeOperation(id, request, requestAuthGeneration)
      )
        return;
      if (isAuthorizationFailure(reason)) {
        clearPrivateState(reason);
        return;
      }
      setEdgeState(null);
      setStateError(
        reason instanceof RequestError ? reason.message : errorMessage(reason),
      );
    } finally {
      if (ownsEdgeOperation(id, request, requestAuthGeneration))
        setStateLoading(false);
    }
  }

  function selectEdge(id: string) {
    stateController.current?.abort();
    mutationController.current?.abort();
    edgeGeneration.current++;
    selectedEdgeIdRef.current = id;
    setSelectedEdgeId(id);
    setEdgeState(null);
    setReason("");
    setStateError("");
    setNotice("");
    setSaving(false);
    void readEdgeState(id);
  }

  async function moderateEdge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = selectedEdgeId;
    const trimmedReason = reason.trim();
    if (
      !id ||
      edgeState === null ||
      saving ||
      !trimmedReason ||
      trimmedReason.length > 500
    )
      return;
    stateController.current?.abort();
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    const request = ++edgeGeneration.current;
    const requestAuthGeneration = authGenerationRef.current;
    setSaving(true);
    setStateError("");
    setNotice("");
    try {
      const result = await api<ContentEdgeModerationState>(
        `/api/admin/content-edges/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          ...jsonBody({ blocked: !edgeState, reason: trimmedReason }),
          signal: controller.signal,
        },
      );
      if (!ownsEdgeOperation(id, request, requestAuthGeneration)) return;
      setEdgeState(result.moderation.blocked);
      setNotice(
        result.moderation.blocked
          ? "Relationship blocked. Report history is retained."
          : "Relationship unblocked. Endpoint privacy rules still apply.",
      );
      setReason("");
    } catch (reason) {
      if (
        controller.signal.aborted ||
        !ownsEdgeOperation(id, request, requestAuthGeneration)
      )
        return;
      if (isAuthorizationFailure(reason)) {
        clearPrivateState(reason);
        return;
      }
      setStateError(
        reason instanceof RequestError ? reason.message : errorMessage(reason),
      );
    } finally {
      if (ownsEdgeOperation(id, request, requestAuthGeneration))
        setSaving(false);
    }
  }

  if (denied)
    return (
      <section
        className="moderation-edge-reports"
        aria-label="Relationship reports"
      >
        <h2>Relationship reports</h2>
        <p role="alert" className="error">
          {denied}
        </p>
      </section>
    );

  return (
    <section
      className="moderation-edge-reports"
      aria-label="Relationship reports"
    >
      <div className="moderation-edge-heading">
        <div>
          <h2>Relationship reports</h2>
          <p>
            Review incoming relation reports and manage administrator block
            state.
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => void loadReports(null)}
          disabled={loading}
        >
          Refresh relationship reports
        </button>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading relationship reports…</p> : null}
      {!loading && !error && reports.length === 0 ? (
        <p>No relationship reports yet.</p>
      ) : null}
      <ol className="report-list">
        {reports.map((report) => (
          <li
            key={report.id}
            className="report-event"
            data-testid="content-edge-report-event"
          >
            <h3>{report.category}</h3>
            <p>Report {report.id}</p>
            <time dateTime={report.created_at}>
              {new Date(report.created_at).toLocaleString()}
            </time>
            <p className="report-detail">{report.detail}</p>
            <p>Reported by {report.reporter_id}</p>
            <p>
              Relationship {report.type}: {report.source_id} →{" "}
              {report.target_id}
            </p>
            <button
              type="button"
              className="button"
              onClick={() => selectEdge(report.edge_id)}
            >
              Review relationship {report.edge_id}
            </button>
          </li>
        ))}
      </ol>
      {cursor ? (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => void loadReports(cursor)}
        >
          Load older relationship reports
        </button>
      ) : null}
      {selectedEdgeId ? (
        <section
          className="moderation-selection"
          aria-labelledby="edge-moderation-selection"
        >
          <h3 id="edge-moderation-selection">Review relationship</h3>
          <p data-testid="selected-edge">{selectedEdgeId}</p>
          <p>
            {edgeState === null
              ? "Current edge state: Unavailable"
              : `Current edge state: ${edgeState ? "Blocked" : "Unblocked"}`}
          </p>
          {notice ? <p role="status">{notice}</p> : null}
          {stateError ? (
            <p role="alert" className="error">
              {stateError}
            </p>
          ) : null}
          {edgeState === null ? (
            <button
              type="button"
              className="button"
              disabled={stateLoading}
              onClick={() => void readEdgeState(selectedEdgeId)}
            >
              Retry relationship state
            </button>
          ) : null}
          <form onSubmit={moderateEdge}>
            <label htmlFor="edge-moderation-reason">
              Edge moderation reason
            </label>
            <textarea
              id="edge-moderation-reason"
              value={reason}
              maxLength={500}
              required
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
            />
            <p>
              {edgeState
                ? "Unblocking does not override endpoint privacy or target-owner controls."
                : "Blocking hides the relationship. Nodes and report history are retained."}
            </p>
            <button
              type="submit"
              className="button"
              disabled={
                saving ||
                stateLoading ||
                edgeState === null ||
                !reason.trim() ||
                reason.trim().length > 500
              }
            >
              {saving
                ? "Saving…"
                : edgeState
                  ? "Unblock relationship"
                  : "Block relationship"}
            </button>
          </form>
        </section>
      ) : null}
    </section>
  );
}

function ContentNodeModeration({
  authGeneration,
}: {
  authGeneration: number;
}): React.JSX.Element {
  const authGenerationRef = useRef(authGeneration);
  authGenerationRef.current = authGeneration;
  const selectedNodeIdRef = useRef<string | null>(null);
  const live = useRef(false);
  const generation = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const [nodeInput, setNodeInput] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeBlocked, setNodeBlocked] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [stateError, setStateError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accessBlocked, setAccessBlocked] = useState(true);

  const owns = useCallback(
    (id: string, request: number, requestAuthGeneration: number) =>
      live.current &&
      authGenerationRef.current === requestAuthGeneration &&
      selectedNodeIdRef.current === id &&
      generation.current === request,
    [],
  );

  const readNodeState = useCallback(
    async (id: string) => {
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      const request = ++generation.current;
      const requestAuthGeneration = authGeneration;
      setLoading(true);
      setStateError("");
      try {
        const result = await api<ContentNodeModerationState>(
          `/api/admin/content-nodes/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        if (!owns(id, request, requestAuthGeneration)) return;
        setNodeBlocked(result.moderation.blocked);
        setAccessBlocked(false);
        setStateError("");
      } catch (reason) {
        if (
          controller.signal.aborted ||
          !owns(id, request, requestAuthGeneration)
        )
          return;
        if (isAuthorizationFailure(reason)) {
          generation.current++;
          mutationController.current?.abort();
          setNodeBlocked(null);
          setAccessBlocked(true);
          setStateError(
            reason instanceof RequestError && reason.status === 403
              ? "Access denied. Refresh content node access to continue."
              : "Your session has ended. Refresh content node access to continue.",
          );
          setSaving(false);
          setLoading(false);
          return;
        }
        setNodeBlocked(null);
        setStateError(
          reason instanceof RequestError
            ? reason.message
            : errorMessage(reason),
        );
      } finally {
        if (owns(id, request, requestAuthGeneration)) setLoading(false);
      }
    },
    [authGeneration, owns],
  );

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      readController.current?.abort();
      mutationController.current?.abort();
    };
  }, []);

  useEffect(() => {
    generation.current++;
    readController.current?.abort();
    mutationController.current?.abort();
    setNodeBlocked(null);
    setAccessBlocked(true);
    setLoading(false);
    setSaving(false);
    if (selectedNodeIdRef.current)
      void readNodeState(selectedNodeIdRef.current);
  }, [readNodeState]);

  function selectNode() {
    const id = nodeInput.trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      setStateError("Enter a known content node ID.");
      return;
    }
    readController.current?.abort();
    mutationController.current?.abort();
    generation.current++;
    selectedNodeIdRef.current = id;
    setSelectedNodeId(id);
    setNodeBlocked(null);
    setStateError("");
    setNotice("");
    setSaving(false);
    setAccessBlocked(true);
    void readNodeState(id);
  }

  async function moderateNode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = selectedNodeId;
    const trimmedReason = reason.trim();
    if (
      !id ||
      nodeBlocked === null ||
      accessBlocked ||
      saving ||
      !trimmedReason ||
      trimmedReason.length > 500
    )
      return;
    readController.current?.abort();
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    const request = ++generation.current;
    const requestAuthGeneration = authGenerationRef.current;
    setSaving(true);
    setStateError("");
    setNotice("");
    try {
      const result = await api<ContentNodeModerationState>(
        `/api/admin/content-nodes/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          ...jsonBody({ blocked: !nodeBlocked, reason: trimmedReason }),
          signal: controller.signal,
        },
      );
      if (!owns(id, request, requestAuthGeneration)) return;
      setNodeBlocked(result.moderation.blocked);
      setNotice(
        result.moderation.blocked
          ? "Content node blocked. Report history is retained."
          : "Content node unblocked. Existing visibility rules still apply.",
      );
      setReason("");
    } catch (reason) {
      if (
        controller.signal.aborted ||
        !owns(id, request, requestAuthGeneration)
      )
        return;
      if (isAuthorizationFailure(reason)) {
        generation.current++;
        setNodeBlocked(null);
        setAccessBlocked(true);
        setSaving(false);
        setStateError(
          reason instanceof RequestError && reason.status === 403
            ? "Access denied. Refresh content node access to continue."
            : "Your session has ended. Refresh content node access to continue.",
        );
      } else {
        setStateError(
          reason instanceof RequestError
            ? reason.message
            : errorMessage(reason),
        );
      }
    } finally {
      if (owns(id, request, requestAuthGeneration)) setSaving(false);
    }
  }

  const inputValid = /^[A-Za-z0-9_-]{1,100}$/.test(nodeInput.trim());
  return (
    <section
      className="moderation-selection"
      aria-label="Content node moderation"
    >
      <h2>Content node moderation</h2>
      <p>Enter a known node ID to review its authoritative moderation state.</p>
      <label htmlFor="content-node-moderation-id">Content node ID</label>
      <input
        id="content-node-moderation-id"
        value={nodeInput}
        onChange={(event) => setNodeInput(event.target.value)}
      />
      <button
        type="button"
        className="button"
        disabled={!inputValid}
        onClick={selectNode}
      >
        Load content node state
      </button>
      {selectedNodeId ? (
        <section aria-label="Selected content node">
          <p data-testid="selected-content-node">{selectedNodeId}</p>
          <p>
            {nodeBlocked === null
              ? "Current content node state: Unavailable"
              : `Current content node state: ${nodeBlocked ? "Blocked" : "Unblocked"}`}
          </p>
          {loading ? <p role="status">Loading content node state…</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {stateError ? (
            <p role="alert" className="error">
              {stateError}
            </p>
          ) : null}
          <button
            type="button"
            className="button"
            disabled={loading || saving || accessBlocked}
            onClick={() => void readNodeState(selectedNodeId)}
          >
            Refresh content node state
          </button>
          {accessBlocked ? (
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => void readNodeState(selectedNodeId)}
            >
              Refresh content node access
            </button>
          ) : null}
          <form onSubmit={(event) => void moderateNode(event)}>
            <label htmlFor="content-node-moderation-reason">
              Content node moderation reason
            </label>
            <textarea
              id="content-node-moderation-reason"
              value={reason}
              maxLength={500}
              required
              disabled={accessBlocked || nodeBlocked === null || saving}
              onChange={(event) => setReason(event.target.value)}
            />
            <button
              type="submit"
              className="button"
              disabled={
                accessBlocked ||
                saving ||
                loading ||
                nodeBlocked === null ||
                !reason.trim()
              }
            >
              {saving
                ? "Saving…"
                : nodeBlocked
                  ? "Unblock content node"
                  : "Block content node"}
            </button>
          </form>
        </section>
      ) : null}
    </section>
  );
}

export function ModerationScreen({
  authGeneration,
}: {
  authGeneration: number;
}) {
  const [reports, setReports] = useState<ReportPage["reports"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState("");
  const [selected, setSelected] = useState<ModerationTarget | null>(null);
  const [state, setState] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [stateError, setStateError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const targetGeneration = useRef(0);
  const live = useRef(false);
  const generation = useRef(0);
  const failure = useCallback((reason: unknown) => {
    if (
      reason instanceof RequestError &&
      ["UNAUTHENTICATED", "FORBIDDEN"].includes(reason.code)
    ) {
      generation.current++;
      setReports([]);
      setCursor(null);
      setError("");
      targetGeneration.current++;
      setSelected(null);
      setState(null);
      setReason("");
      setStateError("");
      setNotice("");
      setDenied(
        reason.code === "FORBIDDEN"
          ? "Access denied"
          : "Your session has ended",
      );
    } else
      setError(
        reason instanceof RequestError ? reason.message : errorMessage(reason),
      );
  }, []);
  async function readState(target: ModerationTarget, request: number) {
    try {
      const result = await api<ModerationState>(
        `/api/admin/content?kind=${target.kind}&id=${encodeURIComponent(target.id)}`,
      );
      if (!live.current || request !== targetGeneration.current) return;
      setState(result.moderation.blocked);
      setStateError("");
    } catch (error) {
      if (!live.current) return;
      if (
        error instanceof RequestError &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
      )
        failure(error);
      else if (request === targetGeneration.current) {
        setState(null);
        setStateError(
          error instanceof RequestError ? error.message : errorMessage(error),
        );
      }
    }
  }
  function select(target: ModerationTarget) {
    const request = ++targetGeneration.current;
    setSelected(target);
    setState(null);
    setStateError("");
    setNotice("");
    setReason("");
    void readState(target, request);
  }
  async function moderate(event: React.FormEvent) {
    event.preventDefault();
    if (
      !selected ||
      state === null ||
      saving ||
      !reason.trim() ||
      reason.trim().length > 500
    )
      return;
    const target = selected;
    const request = ++targetGeneration.current;
    setSaving(true);
    setStateError("");
    setNotice("");
    try {
      const result = await api<ModerationState>("/api/admin/content", {
        method: "PUT",
        ...jsonBody({ target, blocked: !state, reason: reason.trim() }),
      });
      if (!live.current || request !== targetGeneration.current) return;
      setNotice(
        result.moderation.blocked
          ? "Content blocked. Report history is retained."
          : "Content unblocked. Other access restrictions still apply.",
      );
      setState(null);
      setReason("");
      await readState(target, request);
    } catch (error) {
      if (live.current && request === targetGeneration.current) {
        if (
          error instanceof RequestError &&
          ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
        )
          failure(error);
        else
          setStateError(
            error instanceof RequestError ? error.message : errorMessage(error),
          );
      }
    } finally {
      if (live.current && request === targetGeneration.current)
        setSaving(false);
    }
  }
  const load = useCallback(
    async (next: string | null) => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<ReportPage>(
          `/api/admin/reports?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (!live.current || generation.current !== request) return;
        setReports((previous) =>
          next
            ? [
                ...new Map(
                  [...previous, ...result.reports].map((report) => [
                    report.id,
                    report,
                  ]),
                ).values(),
              ]
            : result.reports,
        );
        setCursor(result.next_cursor);
      } catch (reason) {
        if (
          live.current &&
          (generation.current === request ||
            (reason instanceof RequestError &&
              ["UNAUTHENTICATED", "FORBIDDEN"].includes(reason.code)))
        )
          failure(reason);
      } finally {
        if (live.current && generation.current === request) setLoading(false);
      }
    },
    [failure],
  );
  useEffect(() => {
    live.current = true;
    void load(null);
    return () => {
      live.current = false;
      generation.current++;
      targetGeneration.current++;
    };
  }, [load]);
  if (denied)
    return (
      <main id="main" className="moderation-page">
        <h1>{denied}</h1>
        <p>Sign in with an authorized administrator account to continue.</p>
        <a href="/auth/google">Continue with Google</a>
      </main>
    );
  return (
    <main id="main" className="moderation-page">
      <h1>Content reports</h1>
      <p>
        Review reported content. Reports remain in the event history after
        moderation.
      </p>
      <button type="button" className="button" onClick={() => void load(null)}>
        Refresh reports
      </button>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading reports…</p> : null}
      {!loading && !error && reports.length === 0 ? (
        <p>No reports yet.</p>
      ) : null}
      {selected ? (
        <section
          aria-labelledby="moderation-selection"
          className="moderation-selection"
        >
          <h2 id="moderation-selection">Review content</h2>
          <p data-testid="selected-target">
            {selected.kind} {selected.id}
          </p>
          <p>
            {state === null
              ? "Current state: Unavailable"
              : `Current state: ${state ? "Blocked" : "Unblocked"}`}
          </p>
          {notice ? <p role="status">{notice}</p> : null}
          {stateError ? (
            <p role="alert" className="error">
              {stateError}
            </p>
          ) : null}
          {state === null ? (
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => {
                setStateError("");
                void readState(selected, ++targetGeneration.current);
              }}
            >
              Retry content state
            </button>
          ) : null}
          <form onSubmit={moderate}>
            <label htmlFor="moderation-reason">Moderation reason</label>
            <textarea
              id="moderation-reason"
              value={reason}
              maxLength={500}
              required
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
            />
            <p>
              {state === true
                ? "Unblocking restores access only where existing visibility and Link rules permit it."
                : "Blocking makes this content unavailable. Stored media and report history are retained."}
            </p>
            <button
              type="submit"
              className="button"
              disabled={
                saving ||
                state === null ||
                !reason.trim() ||
                reason.trim().length > 500
              }
            >
              {saving ? "Saving…" : state ? "Unblock content" : "Block content"}
            </button>
          </form>
        </section>
      ) : null}
      <ol className="report-list">
        {reports.map((report) => (
          <li
            key={report.id}
            data-testid="report-event"
            className="report-event"
          >
            <h2>{report.category}</h2>
            <p>Report {report.id}</p>
            <time dateTime={report.created_at}>
              {new Date(report.created_at).toLocaleString()}
            </time>
            <p className="report-detail">{report.detail}</p>
            <p>Reported by {report.reporter_id}</p>
            <p>
              Observed Timeline version:{" "}
              {report.observed_timeline_version ?? "Not applicable"}
            </p>
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => select(report.target)}
            >
              Review {report.target.kind} {report.target.id}
            </button>
            {report.subject?.id ? (
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => {
                  if (report.subject) select(report.subject);
                }}
              >
                Review related {report.subject.kind} {report.subject.id}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {cursor ? (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          Load older reports
        </button>
      ) : null}
      <ContentNodeModeration authGeneration={authGeneration} />
      <ContentEdgeReports authGeneration={authGeneration} />
    </main>
  );
}
