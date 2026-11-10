import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ContentEdgeOwnerState,
  type ContentEdgePage,
  type ContentEdgeReviewPage,
  type ContentEdgeType,
  type ContentEdgeView,
  errorMessage,
  type IncomingContentEdgeReview,
  jsonBody,
  RequestError,
} from "./api";

type EdgeType = ContentEdgeType;
type PublicEdge = ContentEdgeView;
type IncomingReviewEdge = IncomingContentEdgeReview;
type Operation = {
  key: string;
  id: number;
  epoch: number;
  authGeneration: number;
  nodeId: string;
  pairId: string | null;
  pairDirection: "incoming" | "outgoing" | null;
  controller: AbortController;
};

const edgeTypes: { value: EdgeType; label: string }[] = [
  { value: "related_to", label: "Related to" },
  { value: "references", label: "References" },
  { value: "continuation", label: "Continuation" },
];
const reportCategories = ["spam", "abuse", "copyright", "illegal", "other"];

function parseReferenceId(value: string) {
  const input = value.trim();
  if (!input) return null;
  let id = input;
  if (input.startsWith("/") || input.includes("://")) {
    try {
      const target = new URL(input, window.location.origin);
      if (target.origin !== window.location.origin) return null;
      const match = /^\/c\/([^/]+)$/.exec(target.pathname);
      if (!match || target.search || target.hash) return null;
      id = decodeURIComponent(match[1] ?? "");
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

function requestPath(
  nodeId: string,
  direction: "incoming" | "outgoing",
  knownNodeId: string | null,
  cursor: string | null = null,
) {
  const params = new URLSearchParams({ direction, limit: "30" });
  if (knownNodeId) params.set("known_node", knownNodeId);
  if (cursor) params.set("cursor", cursor);
  return `/api/content-nodes/${encodeURIComponent(nodeId)}/edges?${params}`;
}

function isAuthorizationFailure(reason: unknown): reason is RequestError {
  return (
    reason instanceof RequestError &&
    (reason.status === 401 || reason.status === 403)
  );
}

export function ContentEdgesPanel({
  nodeId,
  authGeneration,
}: {
  nodeId: string;
  authGeneration: number;
}): React.JSX.Element {
  const authGenerationRef = useRef(authGeneration);
  authGenerationRef.current = authGeneration;
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;
  const mountedRef = useRef(false);
  const sequenceRef = useRef(0);
  const epochRef = useRef(0);
  const requestGenerationsRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const knownNodeIdRef = useRef<string | null>(null);
  const pairDirectionRef = useRef<"incoming" | "outgoing">("outgoing");
  const busyOperationRef = useRef<number | null>(null);
  const [outgoing, setOutgoing] = useState<PublicEdge[]>([]);
  const [incoming, setIncoming] = useState<PublicEdge[]>([]);
  const [review, setReview] = useState<IncomingReviewEdge[]>([]);
  const [outgoingCursor, setOutgoingCursor] = useState<string | null>(null);
  const [incomingCursor, setIncomingCursor] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const [pairEdges, setPairEdges] = useState<PublicEdge[]>([]);
  const [pairDirection, setPairDirection] = useState<"incoming" | "outgoing">(
    "outgoing",
  );
  const [knownNodeId, setKnownNodeId] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [edgeType, setEdgeType] = useState<EdgeType>("related_to");
  const [reportingEdgeId, setReportingEdgeId] = useState<string | null>(null);
  const [reportCategory, setReportCategory] = useState("abuse");
  const [reportDetail, setReportDetail] = useState("");
  const [busyEdgeId, setBusyEdgeId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [accessBlocked, setAccessBlocked] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const beginOperation = useCallback(
    (
      key: string,
      pairId: string | null = null,
      pairDirection: "incoming" | "outgoing" | null = null,
    ): Operation => {
      controllersRef.current.get(key)?.abort();
      const controller = new AbortController();
      const id = ++sequenceRef.current;
      requestGenerationsRef.current.set(key, id);
      controllersRef.current.set(key, controller);
      return {
        key,
        id,
        epoch: epochRef.current,
        authGeneration,
        nodeId,
        pairId,
        pairDirection,
        controller,
      };
    },
    [authGeneration, nodeId],
  );

  const owns = useCallback((operation: Operation) => {
    return (
      mountedRef.current &&
      authGenerationRef.current === operation.authGeneration &&
      nodeIdRef.current === operation.nodeId &&
      epochRef.current === operation.epoch &&
      requestGenerationsRef.current.get(operation.key) === operation.id &&
      (operation.pairId === null ||
        (knownNodeIdRef.current === operation.pairId &&
          pairDirectionRef.current === operation.pairDirection)) &&
      !operation.controller.signal.aborted
    );
  }, []);

  const releaseBusy = useCallback((operation: Operation) => {
    if (busyOperationRef.current !== operation.id) return;
    busyOperationRef.current = null;
    setBusyEdgeId(null);
  }, []);

  const invalidateOperation = useCallback((key: string) => {
    controllersRef.current.get(key)?.abort();
    controllersRef.current.delete(key);
    requestGenerationsRef.current.set(key, ++sequenceRef.current);
  }, []);

  const abortAll = useCallback(() => {
    epochRef.current += 1;
    for (const controller of controllersRef.current.values())
      controller.abort();
    controllersRef.current.clear();
    requestGenerationsRef.current.clear();
  }, []);

  const authorizationFailure = useCallback(
    (reason: RequestError) => {
      abortAll();
      setOutgoing([]);
      setIncoming([]);
      setReview([]);
      setPairEdges([]);
      knownNodeIdRef.current = null;
      pairDirectionRef.current = "outgoing";
      setKnownNodeId("");
      setReportingEdgeId(null);
      setReportDetail("");
      busyOperationRef.current = null;
      setBusyEdgeId(null);
      setLoading(false);
      setLoadingMore({});
      setOutgoingCursor(null);
      setIncomingCursor(null);
      setReviewCursor(null);
      setAccessBlocked(true);
      setError(
        reason.status === 401
          ? "Your session has ended. Refresh relationship access to continue."
          : "Access to these relationships is no longer available. Refresh access to continue.",
      );
      setStatus("");
    },
    [abortAll],
  );

  const readOutgoing = useCallback(
    async (
      knownId: string | null = null,
      cursor: string | null = null,
      append = false,
    ): Promise<boolean> => {
      const key = knownId ? `outgoing-pair:${knownId}` : "outgoing";
      const operation = beginOperation(
        key,
        knownId,
        knownId ? "outgoing" : null,
      );
      if (!knownId && append)
        setLoadingMore((current) => ({ ...current, outgoing: true }));
      try {
        const result = await api<ContentEdgePage>(
          requestPath(nodeId, "outgoing", knownId, cursor),
          { signal: operation.controller.signal },
        );
        if (!owns(operation)) return false;
        if (knownId) setPairEdges(result.edges);
        else {
          setOutgoing((current) =>
            append
              ? [
                  ...new Map(
                    [...current, ...result.edges].map((edge) => [
                      edge.id,
                      edge,
                    ]),
                  ).values(),
                ]
              : result.edges,
          );
          setOutgoingCursor(result.next_cursor);
        }
        return true;
      } catch (reason) {
        if (!owns(operation)) return false;
        if (isAuthorizationFailure(reason)) {
          authorizationFailure(reason);
          return false;
        }
        setError(errorMessage(reason));
        return false;
      } finally {
        if (owns(operation) && !knownId && append)
          setLoadingMore((current) => ({ ...current, outgoing: false }));
      }
    },
    [beginOperation, nodeId, owns, authorizationFailure],
  );

  const readIncoming = useCallback(
    async (
      knownId: string | null = null,
      cursor: string | null = null,
      append = false,
    ): Promise<boolean> => {
      const key = knownId ? `incoming-pair:${knownId}` : "incoming";
      const operation = beginOperation(
        key,
        knownId,
        knownId ? "incoming" : null,
      );
      if (!knownId && append)
        setLoadingMore((current) => ({ ...current, incoming: true }));
      try {
        const result = await api<ContentEdgePage>(
          requestPath(nodeId, "incoming", knownId, cursor),
          { signal: operation.controller.signal },
        );
        if (!owns(operation)) return false;
        if (knownId) setPairEdges(result.edges);
        else {
          setIncoming((current) =>
            append
              ? [
                  ...new Map(
                    [...current, ...result.edges].map((edge) => [
                      edge.id,
                      edge,
                    ]),
                  ).values(),
                ]
              : result.edges,
          );
          setIncomingCursor(result.next_cursor);
        }
        return true;
      } catch (reason) {
        if (!owns(operation)) return false;
        if (isAuthorizationFailure(reason)) {
          authorizationFailure(reason);
          return false;
        }
        setError(errorMessage(reason));
        return false;
      } finally {
        if (owns(operation) && !knownId && append)
          setLoadingMore((current) => ({ ...current, incoming: false }));
      }
    },
    [beginOperation, nodeId, owns, authorizationFailure],
  );

  const readReview = useCallback(
    async (cursor: string | null = null, append = false): Promise<boolean> => {
      const key = "incoming-review";
      const operation = beginOperation(key);
      if (append) setLoadingMore((current) => ({ ...current, review: true }));
      const params = new URLSearchParams({ limit: "30" });
      if (cursor) params.set("cursor", cursor);
      try {
        const result = await api<ContentEdgeReviewPage>(
          `/api/content-nodes/${encodeURIComponent(nodeId)}/incoming-review?${params}`,
          { signal: operation.controller.signal },
        );
        if (!owns(operation)) return false;
        setReview((current) =>
          append
            ? [
                ...new Map(
                  [...current, ...result.edges].map((edge) => [edge.id, edge]),
                ).values(),
              ]
            : result.edges,
        );
        setReviewCursor(result.next_cursor);
        return true;
      } catch (reason) {
        if (!owns(operation)) return false;
        if (isAuthorizationFailure(reason)) {
          authorizationFailure(reason);
          return false;
        }
        setError(errorMessage(reason));
        return false;
      } finally {
        if (owns(operation) && append)
          setLoadingMore((current) => ({ ...current, review: false }));
      }
    },
    [beginOperation, nodeId, owns, authorizationFailure],
  );

  const refresh = useCallback(async () => {
    if (busyOperationRef.current !== null) return;
    abortAll();
    setLoading(true);
    setLoadingMore({});
    setOutgoing([]);
    setIncoming([]);
    setReview([]);
    setOutgoingCursor(null);
    setIncomingCursor(null);
    setReviewCursor(null);
    setPairEdges([]);
    setError("");
    setStatus("");
    const refreshEpoch = epochRef.current;
    const refreshAuthGeneration = authGeneration;
    const refreshNodeId = nodeId;
    const knownId = knownNodeIdRef.current;
    const pairRead = knownId
      ? pairDirectionRef.current === "incoming"
        ? readIncoming(knownId)
        : readOutgoing(knownId)
      : Promise.resolve(true);
    const reads = await Promise.all([
      readOutgoing(),
      readIncoming(),
      readReview(),
      pairRead,
    ]);
    if (
      mountedRef.current &&
      authGenerationRef.current === refreshAuthGeneration &&
      nodeIdRef.current === refreshNodeId &&
      epochRef.current === refreshEpoch
    ) {
      if (reads.every(Boolean)) {
        setAccessBlocked(false);
        setError("");
      }
      setLoading(false);
    }
  }, [
    abortAll,
    authGeneration,
    nodeId,
    readIncoming,
    readOutgoing,
    readReview,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    setOutgoing([]);
    setIncoming([]);
    setReview([]);
    setPairEdges([]);
    setKnownNodeId("");
    knownNodeIdRef.current = null;
    pairDirectionRef.current = "outgoing";
    busyOperationRef.current = null;
    setReportingEdgeId(null);
    setReportDetail("");
    setBusyEdgeId(null);
    setLoadingMore({});
    setError("");
    setStatus("");
    setAccessBlocked(true);
    void refresh();
    return () => {
      mountedRef.current = false;
      abortAll();
    };
  }, [refresh, abortAll]);

  async function createRelationship(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessBlocked || busyEdgeId) return;
    const targetId = parseReferenceId(targetInput);
    if (!targetId) {
      setError("Enter a known Ages reference URL or reference ID.");
      setStatus("");
      return;
    }
    const operation = beginOperation(`create:${targetId}`);
    busyOperationRef.current = operation.id;
    setBusyEdgeId("create");
    setError("");
    setStatus("");
    try {
      await api<{ edge: ContentEdgeOwnerState }>("/api/content-edges", {
        method: "POST",
        ...jsonBody({ source_id: nodeId, target_id: targetId, type: edgeType }),
        signal: operation.controller.signal,
      });
      if (!owns(operation)) return;
      invalidateOperation("outgoing");
      setTargetInput("");
      knownNodeIdRef.current = targetId;
      setKnownNodeId(targetId);
      pairDirectionRef.current = "outgoing";
      setPairDirection("outgoing");
      setStatus("Relationship added.");
      void readOutgoing(targetId);
      void readOutgoing();
    } catch (reason) {
      if (!owns(operation)) return;
      if (isAuthorizationFailure(reason)) {
        authorizationFailure(reason);
        return;
      }
      setError(errorMessage(reason));
    } finally {
      if (owns(operation)) releaseBusy(operation);
    }
  }

  async function changeIncoming(edge: IncomingReviewEdge, action: string) {
    if (accessBlocked || busyEdgeId) return;
    invalidateOperation("incoming");
    invalidateOperation("incoming-review");
    setLoadingMore((current) => ({
      ...current,
      incoming: false,
      review: false,
    }));
    const operation = beginOperation(`edge-action:${edge.id}`);
    busyOperationRef.current = operation.id;
    setBusyEdgeId(edge.id);
    setError("");
    setStatus("");
    try {
      const result = await api<{ edge: ContentEdgeOwnerState }>(
        `/api/content-edges/${encodeURIComponent(edge.id)}`,
        {
          method: "PATCH",
          ...jsonBody({ action }),
          signal: operation.controller.signal,
        },
      );
      if (!owns(operation)) return;
      const updated = result.edge;
      setReview((current) =>
        current.map((item) =>
          item.id === edge.id
            ? {
                ...item,
                accepted: updated.accepted_at !== null,
                pending_acceptance:
                  action === "accept" ? false : item.pending_acceptance,
                suppressed: updated.suppressed_at !== null,
                blocked_by_target: updated.target_owner_blocked_at !== null,
              }
            : item,
        ),
      );
      setStatus(
        action === "accept"
          ? "Relationship accepted."
          : action === "suppress"
            ? "Relationship suppressed."
            : action === "unsuppress"
              ? "Relationship restored."
              : action === "block"
                ? "Relationship blocked."
                : "Relationship unblocked.",
      );
      if (
        action === "accept" ||
        action === "unsuppress" ||
        action === "unblock"
      ) {
        knownNodeIdRef.current = edge.source.id;
        pairDirectionRef.current = "incoming";
        setKnownNodeId(edge.source.id);
        setPairDirection("incoming");
        void readIncoming(edge.source.id);
      } else if (action === "suppress" || action === "block") {
        invalidateOperation(`incoming-pair:${edge.source.id}`);
        setPairEdges((current) =>
          current.filter((item) => item.id !== edge.id),
        );
        setIncoming((current) => current.filter((item) => item.id !== edge.id));
      }
    } catch (reason) {
      if (!owns(operation)) return;
      if (isAuthorizationFailure(reason)) {
        authorizationFailure(reason);
        return;
      }
      setError(errorMessage(reason));
    } finally {
      if (owns(operation)) releaseBusy(operation);
    }
  }

  async function submitReport(
    event: React.FormEvent<HTMLFormElement>,
    edge: IncomingReviewEdge,
  ) {
    event.preventDefault();
    if (accessBlocked || busyEdgeId) return;
    const operation = beginOperation(`edge-report:${edge.id}`);
    busyOperationRef.current = operation.id;
    setBusyEdgeId(edge.id);
    setError("");
    setStatus("");
    try {
      await api(`/api/content-edges/${encodeURIComponent(edge.id)}/reports`, {
        method: "POST",
        ...jsonBody({ category: reportCategory, detail: reportDetail.trim() }),
        signal: operation.controller.signal,
      });
      if (!owns(operation)) return;
      setReportDetail("");
      setReportingEdgeId(null);
      setStatus(
        "Report received. The relationship remains a source-owner assertion.",
      );
    } catch (reason) {
      if (!owns(operation)) return;
      if (isAuthorizationFailure(reason)) {
        authorizationFailure(reason);
        return;
      }
      setError(errorMessage(reason));
    } finally {
      if (owns(operation)) releaseBusy(operation);
    }
  }

  function openKnownTarget() {
    if (accessBlocked || busyEdgeId) return;
    const targetId = parseReferenceId(targetInput);
    if (!targetId) {
      setError("Enter a known Ages reference URL or reference ID.");
      setStatus("");
      return;
    }
    knownNodeIdRef.current = targetId;
    pairDirectionRef.current = "outgoing";
    setKnownNodeId(targetId);
    setPairDirection("outgoing");
    setPairEdges([]);
    setError("");
    setStatus("");
    void readOutgoing(targetId);
  }

  async function removeOutgoing(edge: PublicEdge) {
    if (accessBlocked || busyEdgeId) return;
    invalidateOperation("outgoing");
    invalidateOperation(`outgoing-pair:${edge.target.id}`);
    setLoadingMore((current) => ({ ...current, outgoing: false }));
    const operation = beginOperation(`edge-remove:${edge.id}`);
    busyOperationRef.current = operation.id;
    setBusyEdgeId(edge.id);
    setError("");
    setStatus("");
    try {
      await api<{ removed: boolean }>(
        `/api/content-edges/${encodeURIComponent(edge.id)}`,
        { method: "DELETE", signal: operation.controller.signal },
      );
      if (!owns(operation)) return;
      setOutgoing((current) => current.filter((item) => item.id !== edge.id));
      setPairEdges((current) => current.filter((item) => item.id !== edge.id));
      setStatus("Relationship removed.");
    } catch (reason) {
      if (!owns(operation)) return;
      if (isAuthorizationFailure(reason)) {
        authorizationFailure(reason);
        return;
      }
      setError(errorMessage(reason));
    } finally {
      if (owns(operation)) releaseBusy(operation);
    }
  }

  function openKnownPair(edge: IncomingReviewEdge) {
    if (accessBlocked || loading || busyEdgeId !== null) return;
    abortAll();
    setLoadingMore({});
    knownNodeIdRef.current = edge.source.id;
    pairDirectionRef.current = "incoming";
    setKnownNodeId(edge.source.id);
    setPairDirection("incoming");
    setPairEdges([]);
    void readIncoming(edge.source.id);
  }

  const knownTargetId = knownNodeId;
  const parsedTargetInput = parseReferenceId(targetInput);
  const listedIncoming = new Map(incoming.map((edge) => [edge.id, edge]));
  const mergedOutgoing = [
    ...new Map(
      [
        ...outgoing,
        ...pairEdges.filter((edge) => edge.source.id === nodeId),
      ].map((edge) => [edge.id, edge]),
    ).values(),
  ];

  return (
    <section className="content-edges-panel" aria-label="Content relationships">
      <div className="content-edges-heading">
        <div>
          <h3>Content relationships</h3>
          <p>
            A relationship is added by its source owner and does not mean the
            target owner endorses it.
          </p>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={refresh}
          disabled={loading || busyEdgeId !== null}
        >
          Refresh relationships
        </button>
      </div>
      {status ? <p role="status">{status}</p> : null}
      {error ? (
        <div className="content-edges-error">
          <p role="alert" className="error">
            {error}
          </p>
          {accessBlocked ? (
            <button
              type="button"
              className="button"
              onClick={refresh}
              disabled={loading || busyEdgeId !== null}
            >
              Refresh relationship access
            </button>
          ) : (
            <button type="button" className="button" onClick={refresh}>
              Try again
            </button>
          )}
        </div>
      ) : null}
      <form className="content-edges-form" onSubmit={createRelationship}>
        <label htmlFor={`content-edge-target-${nodeId}`}>
          Target reference URL or ID
        </label>
        <input
          id={`content-edge-target-${nodeId}`}
          value={targetInput}
          onChange={(event) => {
            setTargetInput(event.target.value);
          }}
          maxLength={4096}
          placeholder="Paste a known /c/ reference URL or ID"
          disabled={accessBlocked || busyEdgeId !== null}
        />
        <button
          type="button"
          className="button"
          disabled={accessBlocked || busyEdgeId !== null || !parsedTargetInput}
          onClick={openKnownTarget}
        >
          Open known target pair
        </button>
        <label htmlFor={`content-edge-type-${nodeId}`}>Relationship type</label>
        <select
          id={`content-edge-type-${nodeId}`}
          value={edgeType}
          onChange={(event) => setEdgeType(event.target.value as EdgeType)}
          disabled={accessBlocked || busyEdgeId !== null}
        >
          {edgeTypes.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="button primary"
          disabled={accessBlocked || busyEdgeId !== null || !targetInput.trim()}
        >
          Add relationship
        </button>
      </form>

      <section
        aria-label="Outgoing relationships"
        className="content-edge-group"
      >
        <h4>Outgoing relationships</h4>
        {loading && mergedOutgoing.length === 0 ? (
          <p role="status">Loading outgoing relationships…</p>
        ) : mergedOutgoing.length === 0 ? (
          <p>No outgoing relationships yet.</p>
        ) : (
          <ul className="content-edge-list">
            {mergedOutgoing.map((edge) => (
              <li key={edge.id}>
                <span className="content-edge-type">{edge.type}</span>
                {edge.target.title ? (
                  <strong>{edge.target.title}</strong>
                ) : null}
                <a href={`/c/${encodeURIComponent(edge.target.id)}`}>
                  Open known target
                </a>
                <button
                  type="button"
                  className="button"
                  disabled={accessBlocked || busyEdgeId !== null}
                  onClick={() => void removeOutgoing(edge)}
                >
                  Remove relationship
                </button>
              </li>
            ))}
          </ul>
        )}
        {outgoingCursor ? (
          <button
            type="button"
            className="button"
            disabled={
              accessBlocked ||
              busyEdgeId !== null ||
              Boolean(loadingMore.outgoing)
            }
            onClick={() => void readOutgoing(null, outgoingCursor, true)}
          >
            {loadingMore.outgoing
              ? "Loading older outgoing relationships…"
              : "Load older outgoing relationships"}
          </button>
        ) : null}
      </section>

      <section
        aria-label="Incoming relationships"
        className="content-edge-group"
      >
        <h4>Incoming relationships</h4>
        {incoming.length > 0 ? (
          <div>
            <h5>Visible incoming references</h5>
            <ul className="content-edge-list">
              {incoming.map((edge) => (
                <li key={edge.id}>
                  <span className="content-edge-type">{edge.type}</span>
                  <strong>{edge.source.title || "Untitled reference"}</strong>
                  <a href={`/c/${encodeURIComponent(edge.source.id)}`}>
                    Open source reference
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {incomingCursor ? (
          <button
            type="button"
            className="button"
            disabled={
              accessBlocked ||
              busyEdgeId !== null ||
              Boolean(loadingMore.incoming)
            }
            onClick={() => void readIncoming(null, incomingCursor, true)}
          >
            {loadingMore.incoming
              ? "Loading older incoming relationships…"
              : "Load older incoming relationships"}
          </button>
        ) : null}
        {reviewCursor ? (
          <button
            type="button"
            className="button"
            disabled={
              accessBlocked ||
              busyEdgeId !== null ||
              Boolean(loadingMore.review)
            }
            onClick={() => void readReview(reviewCursor, true)}
          >
            {loadingMore.review
              ? "Loading older incoming review…"
              : "Load older incoming review"}
          </button>
        ) : null}
        {review.length === 0 && incoming.length === 0 && !loading ? (
          <p>No incoming relationships.</p>
        ) : (
          <ul className="content-edge-list">
            {review.map((edge) => {
              const publicEdge = listedIncoming.get(edge.id);
              const pairKnown = knownNodeId === edge.source.id;
              const canReveal =
                edge.pending_acceptance ||
                publicEdge !== undefined ||
                pairKnown;
              const sourceTitle = canReveal
                ? edge.source.title || "Untitled reference"
                : "Accepted incoming relationship";
              return (
                <li key={edge.id}>
                  <span className="content-edge-type">{edge.type}</span>
                  <strong>{sourceTitle}</strong>
                  <span>{edge.attribution}</span>
                  {edge.pending_acceptance ? (
                    <span className="content-edge-state">
                      Awaiting your acceptance
                    </span>
                  ) : edge.accepted ? (
                    <span className="content-edge-state">Accepted</span>
                  ) : null}
                  {edge.suppressed ? (
                    <span className="content-edge-state">Suppressed</span>
                  ) : null}
                  {edge.blocked_by_target ? (
                    <span className="content-edge-state">Blocked by you</span>
                  ) : null}
                  {!canReveal ? (
                    <button
                      type="button"
                      className="button"
                      disabled={accessBlocked || loading || busyEdgeId !== null}
                      onClick={() => openKnownPair(edge)}
                    >
                      Open known pair
                    </button>
                  ) : edge.pending_acceptance ? (
                    <button
                      type="button"
                      className="button"
                      disabled={accessBlocked || busyEdgeId !== null}
                      onClick={() => void changeIncoming(edge, "accept")}
                    >
                      Accept
                    </button>
                  ) : null}
                  {canReveal ? (
                    <a href={`/c/${encodeURIComponent(edge.source.id)}`}>
                      Open source reference
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    disabled={accessBlocked || busyEdgeId !== null}
                    onClick={() =>
                      void changeIncoming(
                        edge,
                        edge.suppressed ? "unsuppress" : "suppress",
                      )
                    }
                  >
                    {edge.suppressed
                      ? "Restore relationship"
                      : "Suppress relationship"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={accessBlocked || busyEdgeId !== null}
                    onClick={() =>
                      void changeIncoming(
                        edge,
                        edge.blocked_by_target ? "unblock" : "block",
                      )
                    }
                  >
                    {edge.blocked_by_target
                      ? "Unblock relationship"
                      : "Block relationship"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={accessBlocked || busyEdgeId !== null}
                    onClick={() => {
                      setReportingEdgeId((current) =>
                        current === edge.id ? null : edge.id,
                      );
                      setReportDetail("");
                      setError("");
                    }}
                  >
                    Report relationship
                  </button>
                  {reportingEdgeId === edge.id ? (
                    <form
                      className="content-edge-report-form"
                      onSubmit={(event) => void submitReport(event, edge)}
                    >
                      <label
                        htmlFor={`content-edge-report-category-${edge.id}`}
                      >
                        Report category
                      </label>
                      <select
                        id={`content-edge-report-category-${edge.id}`}
                        value={reportCategory}
                        onChange={(event) =>
                          setReportCategory(event.target.value)
                        }
                        disabled={accessBlocked || busyEdgeId !== null}
                      >
                        {reportCategories.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={`content-edge-report-detail-${edge.id}`}>
                        Report detail
                      </label>
                      <textarea
                        id={`content-edge-report-detail-${edge.id}`}
                        value={reportDetail}
                        onChange={(event) =>
                          setReportDetail(event.target.value)
                        }
                        maxLength={1000}
                        required
                        disabled={accessBlocked || busyEdgeId !== null}
                      />
                      <button
                        type="submit"
                        className="button"
                        disabled={
                          accessBlocked ||
                          busyEdgeId !== null ||
                          !reportDetail.trim()
                        }
                      >
                        Send report
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {knownTargetId ? (
        <section
          aria-label="Known pair relationship"
          className="content-edge-group"
        >
          <h4>Known pair relationship</h4>
          <p>Reference ID: {knownTargetId}</p>
          {pairEdges.length ? (
            <ul className="content-edge-list">
              {pairEdges.map((edge) => (
                <li key={edge.id}>
                  <span className="content-edge-type">{edge.type}</span>
                  <strong>
                    {pairDirection === "incoming"
                      ? edge.source.title || "Untitled reference"
                      : edge.target.title || "Untitled reference"}
                  </strong>
                  <span>{edge.attribution}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No active relationship is visible for this known pair.</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
