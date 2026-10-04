import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  jsonBody,
  type ModerationState,
  type ModerationTarget,
  type ReportPage,
  RequestError,
} from "./api";

export function ModerationScreen() {
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
    </main>
  );
}
