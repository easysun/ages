import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  jsonBody,
  type ReportCategory,
  type ReportReceipt,
  type ReportTarget,
  RequestError,
} from "./api";

const categories: { value: ReportCategory; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "abuse", label: "Abuse" },
  { value: "copyright", label: "Copyright" },
  { value: "illegal", label: "Illegal content" },
  { value: "other", label: "Other" },
];
const linkSlugPattern = /^[a-z0-9-]{3,64}$/;
const invalidTargetMessage =
  "This reporting link is not valid. Enter an Ages Link to continue.";

function targetKey(target: ReportTarget | null) {
  if (!target) return "";
  return target.kind === "timeline"
    ? `timeline:${target.timeline_id}`
    : `link:${target.slug}`;
}

function parseReportTarget(search: string) {
  if (/%(?![\da-f]{2})/i.test(search)) return { target: null, invalid: true };
  try {
    decodeURIComponent(search.replaceAll("+", "%20"));
  } catch {
    return { target: null, invalid: true };
  }
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (!keys.length) return { target: null, invalid: false };
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    params.getAll("kind").length !== 1
  )
    return { target: null, invalid: true };

  const kind = params.get("kind");
  if (
    kind === "timeline" &&
    params.getAll("timeline_id").length === 1 &&
    !params.has("slug")
  ) {
    const timelineId = params.get("timeline_id");
    if (timelineId && timelineId.length <= 100)
      return {
        target: { kind: "timeline", timeline_id: timelineId } as ReportTarget,
        invalid: false,
      };
  }
  if (
    kind === "link" &&
    params.getAll("slug").length === 1 &&
    !params.has("timeline_id")
  ) {
    const slug = params.get("slug");
    if (slug && linkSlugPattern.test(slug))
      return { target: { kind: "link", slug } as ReportTarget, invalid: false };
  }
  return { target: null, invalid: true };
}

function parseLinkInput(value: string): ReportTarget | null {
  const input = value.trim();
  if (linkSlugPattern.test(input)) return { kind: "link", slug: input };
  if (input.startsWith("//")) return null;
  if (!input.startsWith("/") && !/^[a-z][a-z\d+.-]*:/i.test(input)) return null;
  try {
    const url = new URL(input, window.location.origin);
    const match = /^\/s\/([a-z0-9-]{3,64})$/.exec(url.pathname);
    if (
      url.origin !== window.location.origin ||
      url.username !== "" ||
      url.password !== "" ||
      !match
    )
      return null;
    return { kind: "link", slug: match[1] as string };
  } catch {
    return null;
  }
}

function reportPath(target: ReportTarget) {
  const params = new URLSearchParams({ kind: target.kind });
  params.set(
    target.kind === "timeline" ? "timeline_id" : "slug",
    target.kind === "timeline" ? target.timeline_id : target.slug,
  );
  return `/report?${params.toString()}`;
}

function signInPath(target: ReportTarget) {
  const params = new URLSearchParams({
    report_kind: target.kind,
    report_value: target.kind === "timeline" ? target.timeline_id : target.slug,
  });
  return `/auth/google?${params.toString()}`;
}

export function ReporterScreen({
  authenticated,
  authGeneration,
}: {
  authenticated: boolean;
  authGeneration: number;
}) {
  const initial = parseReportTarget(window.location.search);
  const [target, setTarget] = useState<ReportTarget | null>(initial.target);
  const [targetError, setTargetError] = useState(
    initial.invalid ? invalidTargetMessage : "",
  );
  const [linkInput, setLinkInput] = useState("");
  const [category, setCategory] = useState<ReportCategory | "">("");
  const [detail, setDetail] = useState("");
  const [feedback, setFeedback] = useState("");
  const [receipt, setReceipt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requiresSignIn, setRequiresSignIn] = useState(false);
  const mounted = useRef(true);
  const operationGeneration = useRef(0);
  const lastTargetKey = useRef(targetKey(initial.target));
  const lastAuth = useRef({ authenticated, authGeneration });
  const pendingRequest = useRef<number | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const draft = useRef({ category: "" as ReportCategory | "", detail: "" });

  const clearDraft = useCallback(() => {
    draft.current = { category: "", detail: "" };
    if (!mounted.current) return;
    setCategory("");
    setDetail("");
    setReceipt("");
  }, []);

  const invalidateCurrentOperation = useCallback(() => {
    operationGeneration.current++;
    clearDraft();
    setFeedback("");
    setSubmitting(pendingRequest.current !== null);
  }, [clearDraft]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current++;
      draft.current = { category: "", detail: "" };
      activeController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const key = targetKey(target);
    if (lastTargetKey.current === key) return;
    lastTargetKey.current = key;
    invalidateCurrentOperation();
    setTargetError("");
  }, [target, invalidateCurrentOperation]);

  useEffect(() => {
    const previous = lastAuth.current;
    if (
      previous.authenticated === authenticated &&
      previous.authGeneration === authGeneration
    )
      return;
    lastAuth.current = { authenticated, authGeneration };
    invalidateCurrentOperation();
  }, [authenticated, authGeneration, invalidateCurrentOperation]);

  useEffect(() => {
    const onPopState = () => {
      const parsed = parseReportTarget(window.location.search);
      operationGeneration.current++;
      draft.current = { category: "", detail: "" };
      setTarget(parsed.target);
      setTargetError(parsed.invalid ? invalidTargetMessage : "");
      setLinkInput("");
      setCategory("");
      setDetail("");
      setReceipt("");
      setFeedback("");
      setSubmitting(pendingRequest.current !== null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function chooseTarget(next: ReportTarget) {
    invalidateCurrentOperation();
    setTargetError("");
    setLinkInput("");
    setTarget(next);
    window.history.replaceState(null, "", reportPath(next));
  }

  function useLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = parseLinkInput(linkInput);
    if (!next) {
      setTargetError(invalidTargetMessage);
      return;
    }
    chooseTarget(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !target ||
      !category ||
      !authenticated ||
      requiresSignIn ||
      pendingRequest.current !== null
    )
      return;
    const requestGeneration = operationGeneration.current;
    const requestId = requestGeneration + 1;
    operationGeneration.current = requestId;
    pendingRequest.current = requestId;
    const controller = new AbortController();
    activeController.current = controller;
    const submittedTarget = target;
    const submittedCategory = category;
    const submittedDetail = detail;
    draft.current = { category: submittedCategory, detail: submittedDetail };
    setSubmitting(true);
    setFeedback("");
    setReceipt("");

    try {
      await api<ReportReceipt>("/api/reports", {
        method: "POST",
        ...jsonBody({
          target: submittedTarget,
          category: submittedCategory,
          detail: submittedDetail,
        }),
        signal: controller.signal,
      });
      if (!mounted.current || operationGeneration.current !== requestId) return;
      setReceipt("Thank you. Your report has been received.");
    } catch (error) {
      if (error instanceof RequestError && [401, 403].includes(error.status)) {
        draft.current = { category: "", detail: "" };
        if (mounted.current) {
          setCategory("");
          setDetail("");
          setReceipt("");
          setRequiresSignIn(true);
          setFeedback("Your session ended. Sign in again to send this report.");
        }
        return;
      }
      if (!mounted.current || operationGeneration.current !== requestId) return;
      if (error instanceof RequestError && error.status === 404)
        setFeedback("This share is unavailable.");
      else
        setFeedback(
          "We couldn’t send your report. Your draft is still here; try again when you’re ready.",
        );
    } finally {
      if (pendingRequest.current === requestId) {
        pendingRequest.current = null;
        if (mounted.current) setSubmitting(false);
      }
      if (activeController.current === controller)
        activeController.current = null;
    }
  }

  const canSubmit = Boolean(
    target && category && authenticated && !requiresSignIn && !submitting,
  );
  return (
    <main id="main" className="reporter-page">
      <div className="reporter-intro">
        <p className="eyebrow">Help keep Ages safe</p>
        <h1>Report a share</h1>
        <p>Tell us about an Ages Timeline or Link that may need review.</p>
      </div>

      <form className="reporter-link-form" onSubmit={useLink}>
        <label htmlFor="report-link">Ages Link URL or slug</label>
        <div className="reporter-link-row">
          <input
            id="report-link"
            autoComplete="url"
            value={linkInput}
            onChange={(event) => setLinkInput(event.currentTarget.value)}
          />
          <button className="button secondary" type="submit">
            Use this Link
          </button>
        </div>
        <p className="reporter-help">
          Paste a same-origin Ages short Link or enter its slug. We won’t open
          the Link.
        </p>
      </form>

      {targetError ? (
        <p className="reporter-message error" role="alert">
          {targetError}
        </p>
      ) : null}
      {target ? (
        <section
          className="reporter-target"
          aria-labelledby="report-target-heading"
        >
          <h2 id="report-target-heading">Selected share</h2>
          <p>
            {target.kind === "timeline" ? "Timeline" : "Ages Link"}:{" "}
            {target.kind === "timeline" ? target.timeline_id : target.slug}
          </p>
        </section>
      ) : null}

      {target && (!authenticated || requiresSignIn) ? (
        <section
          className="reporter-auth"
          aria-labelledby="report-auth-heading"
        >
          <h2 id="report-auth-heading">Sign in to send your report</h2>
          <p>Sign in securely to send a report about this selected share.</p>
          {feedback ? (
            <p className="reporter-message error" role="alert">
              {feedback}
            </p>
          ) : null}
          <a className="button primary" href={signInPath(target)}>
            Continue with Google
          </a>
        </section>
      ) : null}

      {target && authenticated && !requiresSignIn ? (
        <form className="reporter-form" onSubmit={submit}>
          <label htmlFor="report-category">Category</label>
          <select
            id="report-category"
            required
            value={category}
            onChange={(event) => {
              const value = event.currentTarget.value as ReportCategory | "";
              draft.current.category = value;
              setCategory(value);
            }}
          >
            <option value="">Choose a category</option>
            {categories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <label htmlFor="report-detail">
            Report details <span>(optional)</span>
          </label>
          <textarea
            id="report-detail"
            maxLength={1000}
            rows={6}
            value={detail}
            aria-describedby="report-detail-count"
            onChange={(event) => {
              const value = event.currentTarget.value;
              draft.current.detail = value;
              setDetail(value);
            }}
          />
          <p
            id="report-detail-count"
            className="reporter-help"
            aria-live="polite"
          >
            {detail.length} / 1000 characters
          </p>
          {feedback ? (
            <p className="reporter-message error" role="alert">
              {feedback}
            </p>
          ) : null}
          {receipt ? (
            <p className="reporter-message" role="status">
              {receipt}
            </p>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={!canSubmit}
          >
            {submitting ? "Sending report…" : "Submit report"}
          </button>
        </form>
      ) : null}
    </main>
  );
}
