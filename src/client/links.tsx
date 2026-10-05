import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { googleCustomParameterName } from "../tracking/google-parameters";
import {
  api,
  errorMessage,
  jsonBody,
  type LinkTracking,
  type LinkTrackingProviders,
  type LinkTrackingReport,
  type OwnerLink,
  type OwnerLinkPage,
  RequestError,
} from "./api";

type TrackingDraftParameter = LinkTracking["custom"][number] & { id: string };
type TrackingDraft = {
  tags: string;
  channels: string;
  utm: LinkTracking["utm"];
  custom: TrackingDraftParameter[];
};
type ReportRange = { from: string; to: string };
type UtmKey = keyof LinkTracking["utm"];

const UTM_FIELDS: { key: UtmKey; label: string; id: string }[] = [
  { key: "utm_source", label: "UTM source", id: "link-utm-source" },
  { key: "utm_medium", label: "UTM medium", id: "link-utm-medium" },
  { key: "utm_campaign", label: "UTM campaign", id: "link-utm-campaign" },
  { key: "utm_term", label: "UTM term", id: "link-utm-term" },
  { key: "utm_content", label: "UTM content", id: "link-utm-content" },
];

const emptyDraft: TrackingDraft = {
  tags: "",
  channels: "",
  utm: {},
  custom: [],
};

function trackingDraft(tracking: LinkTracking): TrackingDraft {
  return {
    tags: tracking.tags.join("\n"),
    channels: tracking.channels.join("\n"),
    utm: tracking.utm,
    custom: tracking.custom.map(({ key, value }) => ({
      id: crypto.randomUUID(),
      key,
      value,
    })),
  };
}

function draftTracking(draft: TrackingDraft): LinkTracking {
  return {
    tags: draft.tags === "" ? [] : draft.tags.split("\n"),
    channels: draft.channels === "" ? [] : draft.channels.split("\n"),
    utm: draft.utm,
    custom: draft.custom.map(({ key, value }) => ({ key, value })),
  };
}

function linkState(link: OwnerLink) {
  if (!link.active) return "Inactive";
  if (link.expires_at && Date.parse(link.expires_at) <= Date.now())
    return "Expired";
  return "Active";
}

function listPath(tag: string) {
  const query = new URLSearchParams({ limit: "30" });
  if (tag !== "") query.set("tag", tag);
  return `/api/links?${query.toString()}`;
}

function reportPath(linkId: string, range: ReportRange) {
  const query = new URLSearchParams();
  if (range.from !== "") query.set("from", range.from);
  if (range.to !== "") query.set("to", range.to);
  const suffix = query.toString();
  return `/api/links/${encodeURIComponent(linkId)}/analytics${suffix ? `?${suffix}` : ""}`;
}

function isAuthorizationFailure(reason: unknown): reason is RequestError {
  return (
    reason instanceof RequestError &&
    (reason.status === 401 || reason.status === 403)
  );
}

const enabledLinkProviders: LinkTrackingProviders = {
  allow_ga4: true,
  allow_meta_pixel: true,
  allow_gtm: true,
};

function LinkProviderSettings({
  linkId,
  linkSlug,
  authGeneration,
  onAuthorizationFailure,
}: {
  linkId: string;
  linkSlug: string;
  authGeneration: number;
  onAuthorizationFailure: (reason: unknown) => boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(enabledLinkProviders);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const authGenerationRef = useRef(authGeneration);
  const requestGeneration = useRef(0);
  const activeRequests = useRef(new Set<AbortController>());

  const newController = useCallback(() => {
    const controller = new AbortController();
    activeRequests.current.add(controller);
    return controller;
  }, []);

  const finishController = useCallback((controller: AbortController) => {
    activeRequests.current.delete(controller);
  }, []);

  const clearDraft = useCallback(() => {
    requestGeneration.current++;
    for (const controller of activeRequests.current) controller.abort();
    activeRequests.current.clear();
    setDraft({ ...enabledLinkProviders });
    setLoading(false);
    setSaving(false);
    setLoadError("");
    setSaveError("");
    setNotice("");
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current++;
      for (const controller of activeRequests.current) controller.abort();
      activeRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (authGenerationRef.current !== authGeneration) {
      authGenerationRef.current = authGeneration;
      clearDraft();
    }
  }, [authGeneration, clearDraft]);

  // Retry state intentionally triggers a fresh provider settings read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally triggers a fresh provider read.
  useEffect(() => {
    const currentRequest = ++requestGeneration.current;
    const controller = newController();
    setLoading(true);
    setLoadError("");
    api<{ providers: LinkTrackingProviders }>(
      `/api/links/${encodeURIComponent(linkId)}/tracking/providers`,
      { signal: controller.signal },
    )
      .then(({ providers }) => {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          setDraft(providers);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (
          controller.signal.aborted ||
          !mounted.current ||
          currentRequest !== requestGeneration.current ||
          authGenerationRef.current !== authGeneration
        )
          return;
        if (onAuthorizationFailure(reason)) {
          clearDraft();
          return;
        }
        setLoadError(errorMessage(reason));
        setLoading(false);
      })
      .finally(() => finishController(controller));
  }, [
    linkId,
    authGeneration,
    retry,
    newController,
    finishController,
    clearDraft,
    onAuthorizationFailure,
  ]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || saving || loadError) return;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result = await api<{ providers: LinkTrackingProviders }>(
        `/api/links/${encodeURIComponent(linkId)}/tracking/providers`,
        {
          method: "PUT",
          ...jsonBody(draft),
          signal: controller.signal,
        },
      );
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      ) {
        setDraft(result.providers);
        setNotice(`Provider choices saved for ${linkSlug}.`);
      }
    } catch (reason) {
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentRequest !== requestGeneration.current ||
        authGenerationRef.current !== authGeneration
      )
        return;
      if (onAuthorizationFailure(reason)) {
        clearDraft();
        return;
      }
      setSaveError(
        `Provider choices could not be saved. ${errorMessage(reason)}`,
      );
    } finally {
      finishController(controller);
      if (
        mounted.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      )
        setSaving(false);
    }
  }

  return (
    <section
      className="tracking-settings-card link-provider-settings-card"
      aria-label="Link tracking providers"
    >
      <div className="tracking-settings-heading">
        <div>
          <p className="eyebrow">Privacy choices</p>
          <h2>Tracking providers</h2>
        </div>
      </div>
      <p className="field-help">
        Choose which account providers may run for this Link. Turning off Google
        Tag Manager also disables its container and any GTM-routed GA4 or Meta
        delivery. When allowed, the container loads only after consent and
        receives ages_link_click, including when no GA4 or Meta ID is
        configured. Ages-managed tags should also require their matching
        eligibility flag; container-owned tags may use ages_link_click alone.
      </p>
      <p className="field-help">
        In GA4, turn off Enhanced Measurement so it does not send extra events.
        Review and publish your GTM container; these Link settings cannot change
        its rules.
      </p>
      <p className="field-help">
        GA4 uses the custom parameter names shown beside each Link field.
        Register those names as event-scoped custom dimensions to report their
        literal values.
      </p>
      {loading ? <p role="status">Loading provider choices…</p> : null}
      {loadError ? (
        <div className="error" role="alert">
          Provider choices could not be loaded. {loadError}
          <button
            className="text-button"
            type="button"
            onClick={() => setRetry((current) => current + 1)}
          >
            Retry provider choices
          </button>
        </div>
      ) : null}
      {saveError ? (
        <p className="error" role="alert">
          {saveError}
        </p>
      ) : null}
      {notice ? (
        <p className="link-notice" role="status">
          {notice}
        </p>
      ) : null}
      <form className="link-provider-form" onSubmit={save}>
        <label>
          <input
            type="checkbox"
            checked={draft.allow_ga4}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                allow_ga4: event.target.checked,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          Allow Google Analytics 4
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.allow_meta_pixel}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                allow_meta_pixel: event.target.checked,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          Allow Meta Pixel
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.allow_gtm}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                allow_gtm: event.target.checked,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          Allow Google Tag Manager
        </label>
        <button
          className="button secondary"
          type="submit"
          disabled={loading || saving || Boolean(loadError)}
        >
          {saving ? "Saving provider choices…" : "Save provider choices"}
        </button>
      </form>
    </section>
  );
}

export function LinksScreen({
  authGeneration,
}: {
  authGeneration: number;
}): React.JSX.Element {
  const [links, setLinks] = useState<OwnerLink[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterDraft, setFilterDraft] = useState("");
  const [listQuery, setListQuery] = useState({ tag: "", revision: 0 });
  const appliedTag = listQuery.tag;
  const [listLoading, setListLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [accessError, setAccessError] = useState("");
  const [savedNotice, setSavedNotice] = useState("");

  const [report, setReport] = useState<LinkTrackingReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [rangeDraft, setRangeDraft] = useState<ReportRange>({
    from: "",
    to: "",
  });
  const [appliedRange, setAppliedRange] = useState<ReportRange>({
    from: "",
    to: "",
  });
  const [reportRetry, setReportRetry] = useState(0);

  const [draft, setDraft] = useState<TrackingDraft>(emptyDraft);
  const [googleParameterNames, setGoogleParameterNames] = useState<{
    keys: string[];
    names: string[];
  }>({ keys: [], names: [] });
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState("");
  const [trackingRetry, setTrackingRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  const mounted = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const linksRef = useRef(links);
  linksRef.current = links;
  const selectedFilterMatch = useRef<{
    linkId: string;
    tag: string;
    matches: boolean;
  } | null>(null);
  const authGenerationRef = useRef(authGeneration);
  const requestGeneration = useRef(0);
  const listGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const reportGeneration = useRef(0);
  const trackingGeneration = useRef(0);
  const activeRequests = useRef(new Set<AbortController>());
  const serializedCustomKeys = JSON.stringify(
    draft.custom.map(({ key }) => key),
  );

  useEffect(() => {
    let current = true;
    const keys = JSON.parse(serializedCustomKeys) as string[];
    void Promise.all(
      keys.map((key) =>
        key === "" ? Promise.resolve("") : googleCustomParameterName(key),
      ),
    ).then((names) => {
      if (current) setGoogleParameterNames({ keys, names });
    });
    return () => {
      current = false;
    };
  }, [serializedCustomKeys]);

  const newController = useCallback(() => {
    const controller = new AbortController();
    activeRequests.current.add(controller);
    return controller;
  }, []);

  const finishController = useCallback((controller: AbortController) => {
    activeRequests.current.delete(controller);
  }, []);

  const clearSensitiveState = useCallback((message: string) => {
    requestGeneration.current++;
    listGeneration.current++;
    selectionGeneration.current++;
    reportGeneration.current++;
    trackingGeneration.current++;
    for (const controller of activeRequests.current) controller.abort();
    activeRequests.current.clear();
    setLinks([]);
    linksRef.current = [];
    setNextCursor(null);
    setSelectedId(null);
    selectedIdRef.current = null;
    selectedFilterMatch.current = null;
    setReport(null);
    setReportLoading(false);
    setReportError("");
    setDraft(emptyDraft);
    setTrackingLoading(false);
    setTrackingError("");
    setSaving(false);
    setSaveError("");
    setNotice("");
    setSavedNotice("");
    setListLoading(false);
    setMoreLoading(false);
    setListError("");
    setAccessError(message);
    setFilterDraft("");
    setListQuery((current) => ({
      tag: "",
      revision: current.revision + 1,
    }));
    setRangeDraft({ from: "", to: "" });
    setAppliedRange({ from: "", to: "" });
  }, []);

  const clearForAuthorizationFailure = useCallback(
    (reason: unknown) => {
      if (!isAuthorizationFailure(reason)) return false;
      if (mounted.current) {
        clearSensitiveState(
          reason.status === 401
            ? "Your session has ended. Sign in again to view these links."
            : "This Links view is no longer available for this account.",
        );
      }
      return true;
    },
    [clearSensitiveState],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current++;
      for (const controller of activeRequests.current) controller.abort();
      activeRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (authGenerationRef.current !== authGeneration) {
      authGenerationRef.current = authGeneration;
      clearSensitiveState("Your sign-in changed. Reload Links to continue.");
    }
  }, [authGeneration, clearSensitiveState]);

  useEffect(() => {
    if (accessError) return;
    const currentGeneration = ++listGeneration.current;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setListLoading(true);
    setListError("");
    api<OwnerLinkPage>(listPath(listQuery.tag), { signal: controller.signal })
      .then((page) => {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentGeneration === listGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          const selected = selectedIdRef.current;
          const selectedMembership = selectedFilterMatch.current;
          const selectedStillMatches =
            selected !== null &&
            (listQuery.tag === "" ||
              (selectedMembership?.linkId === selected &&
                selectedMembership.tag === listQuery.tag &&
                selectedMembership.matches));
          const selectedRow =
            selectedStillMatches && selected
              ? linksRef.current.find((link) => link.id === selected)
              : undefined;
          const nextLinks =
            selectedRow &&
            !page.links.some((link) => link.id === selectedRow.id)
              ? [...page.links, selectedRow]
              : page.links;
          linksRef.current = nextLinks;
          setLinks(nextLinks);
          setNextCursor(page.next_cursor);
          const nextSelected =
            selected && nextLinks.some((link) => link.id === selected)
              ? selected
              : (page.links[0]?.id ?? null);
          if (selected !== nextSelected) {
            selectionGeneration.current++;
            reportGeneration.current++;
            trackingGeneration.current++;
            selectedIdRef.current = nextSelected;
            setReport(null);
            setDraft(emptyDraft);
            setNotice("");
            setSaving(false);
            selectedFilterMatch.current = nextSelected
              ? { linkId: nextSelected, tag: listQuery.tag, matches: true }
              : null;
          }
          setSelectedId(nextSelected);
          setListLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (clearForAuthorizationFailure(reason)) return;
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentGeneration === listGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          setListError(errorMessage(reason));
          setListLoading(false);
        }
      })
      .finally(() => finishController(controller));
  }, [
    listQuery,
    authGeneration,
    accessError,
    newController,
    finishController,
    clearForAuthorizationFailure,
  ]);

  const selectedLink = links.find((link) => link.id === selectedId) ?? null;

  // Retry state is intentionally a trigger; the current report query is unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reportRetry intentionally triggers a fresh report read.
  useEffect(() => {
    if (accessError || !selectedId) {
      setReport(null);
      setReportLoading(false);
      setReportError("");
      return;
    }

    const currentSelection = selectionGeneration.current;
    const currentReport = ++reportGeneration.current;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setReport(null);
    setReportError("");
    setReportLoading(true);
    api<LinkTrackingReport>(reportPath(selectedId, appliedRange), {
      signal: controller.signal,
    })
      .then((result) => {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentSelection === selectionGeneration.current &&
          currentReport === reportGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          setReport(result);
          setReportLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (clearForAuthorizationFailure(reason)) return;
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentSelection === selectionGeneration.current &&
          currentReport === reportGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          setReport(null);
          setReportError(
            `The click report could not be refreshed. ${errorMessage(reason)}`,
          );
          setReportLoading(false);
        }
      })
      .finally(() => finishController(controller));
  }, [
    selectedId,
    appliedRange,
    reportRetry,
    authGeneration,
    accessError,
    newController,
    finishController,
    clearForAuthorizationFailure,
  ]);

  // Retry state is intentionally a trigger; the selected Link is unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trackingRetry intentionally triggers a fresh settings read.
  useEffect(() => {
    if (accessError || !selectedId) {
      setDraft(emptyDraft);
      setTrackingLoading(false);
      return;
    }

    const currentSelection = selectionGeneration.current;
    const currentTracking = ++trackingGeneration.current;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setTrackingLoading(true);
    setTrackingError("");
    setSaveError("");
    api<{ tracking: LinkTracking }>(
      `/api/links/${encodeURIComponent(selectedId)}/tracking`,
      { signal: controller.signal },
    )
      .then(({ tracking }) => {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentSelection === selectionGeneration.current &&
          currentTracking === trackingGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          selectedFilterMatch.current = {
            linkId: selectedId,
            tag: appliedTag,
            matches: appliedTag === "" || tracking.tags.includes(appliedTag),
          };
          setDraft(trackingDraft(tracking));
          setTrackingLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (clearForAuthorizationFailure(reason)) return;
        if (
          !controller.signal.aborted &&
          mounted.current &&
          currentSelection === selectionGeneration.current &&
          currentTracking === trackingGeneration.current &&
          currentRequest === requestGeneration.current &&
          authGenerationRef.current === authGeneration
        ) {
          setTrackingError(errorMessage(reason));
          setTrackingLoading(false);
        }
      })
      .finally(() => finishController(controller));
  }, [
    selectedId,
    appliedTag,
    trackingRetry,
    authGeneration,
    accessError,
    newController,
    finishController,
    clearForAuthorizationFailure,
  ]);

  function changeSelection(linkId: string) {
    if (linkId === selectedId) return;
    selectionGeneration.current++;
    selectedIdRef.current = linkId;
    selectedFilterMatch.current = {
      linkId,
      tag: appliedTag,
      matches: true,
    };
    setSelectedId(linkId);
    setReport(null);
    setReportLoading(true);
    setReportError("");
    setDraft(emptyDraft);
    setTrackingLoading(true);
    setTrackingError("");
    setSaveError("");
    setNotice("");
    setSaving(false);
  }

  function applyTagFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    listGeneration.current++;
    selectionGeneration.current++;
    reportGeneration.current++;
    trackingGeneration.current++;
    setLinks([]);
    linksRef.current = [];
    setNextCursor(null);
    setSelectedId(null);
    selectedIdRef.current = null;
    selectedFilterMatch.current = null;
    setReport(null);
    setReportError("");
    setDraft(emptyDraft);
    setTrackingLoading(false);
    setListError("");
    setListLoading(true);
    setMoreLoading(false);
    setSaving(false);
    setListQuery((current) => ({
      tag: filterDraft,
      revision: current.revision + 1,
    }));
  }

  async function loadMore() {
    if (!nextCursor || moreLoading || accessError) return;
    const currentGeneration = listGeneration.current;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setMoreLoading(true);
    setListError("");
    const query = new URLSearchParams({ limit: "30", cursor: nextCursor });
    if (appliedTag !== "") query.set("tag", appliedTag);
    try {
      const page = await api<OwnerLinkPage>(`/api/links?${query}`, {
        signal: controller.signal,
      });
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentGeneration === listGeneration.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      ) {
        setLinks((current) => [
          ...current,
          ...page.links.filter(
            (link) => !current.some((existing) => existing.id === link.id),
          ),
        ]);
        setNextCursor(page.next_cursor);
        setMoreLoading(false);
      }
    } catch (reason) {
      if (clearForAuthorizationFailure(reason)) return;
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentGeneration === listGeneration.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      ) {
        setListError(errorMessage(reason));
        setMoreLoading(false);
      }
    } finally {
      finishController(controller);
    }
  }

  function applyReportRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reportGeneration.current++;
    setReport(null);
    setReportLoading(true);
    setReportError("");
    setAppliedRange({ ...rangeDraft });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedLink || trackingLoading || saving || accessError) return;
    const linkId = selectedLink.id;
    const currentSelection = selectionGeneration.current;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setSaving(true);
    setSaveError("");
    setNotice("");
    setSavedNotice("");
    try {
      const result = await api<{ tracking: LinkTracking }>(
        `/api/links/${encodeURIComponent(linkId)}/tracking`,
        {
          method: "PUT",
          ...jsonBody(draftTracking(draft)),
          signal: controller.signal,
        },
      );
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      ) {
        setSavedNotice(`Tracking settings saved for ${selectedLink.slug}.`);
        setListQuery((current) => ({
          ...current,
          revision: current.revision + 1,
        }));
        if (
          selectedId === linkId &&
          currentSelection === selectionGeneration.current
        ) {
          selectedFilterMatch.current = {
            linkId,
            tag: appliedTag,
            matches:
              appliedTag === "" || result.tracking.tags.includes(appliedTag),
          };
          setDraft(trackingDraft(result.tracking));
          setReport(null);
          setReportLoading(true);
          setReportError("");
          setReportRetry((current) => current + 1);
        }
      }
    } catch (reason) {
      if (clearForAuthorizationFailure(reason)) return;
      if (
        !controller.signal.aborted &&
        mounted.current &&
        selectedId === linkId &&
        currentSelection === selectionGeneration.current &&
        currentRequest === requestGeneration.current &&
        authGenerationRef.current === authGeneration
      ) {
        setSaveError(
          `Tracking settings could not be saved. ${errorMessage(reason)}`,
        );
      }
    } finally {
      finishController(controller);
      if (
        mounted.current &&
        selectedId === linkId &&
        currentSelection === selectionGeneration.current &&
        currentRequest === requestGeneration.current
      )
        setSaving(false);
    }
  }

  async function copyLink(link: OwnerLink) {
    try {
      await navigator.clipboard.writeText(link.short_url);
      if (mounted.current) setNotice("Link copied.");
    } catch {
      if (mounted.current)
        setSaveError(
          "Select the short URL to copy it. Clipboard access is unavailable.",
        );
    }
  }

  if (accessError) {
    return (
      <main id="main" className="link-analytics-page">
        <p className="eyebrow">Your links</p>
        <h1>Your links</h1>
        <p role="alert" className="error">
          {accessError}
        </p>
      </main>
    );
  }

  return (
    <main id="main" className="link-analytics-page">
      <header className="link-analytics-intro">
        <p className="eyebrow">Keep sharing, keep the story</p>
        <h1>Your links</h1>
        <p>
          See how your shared moments travel, then tune the details for the next
          person who opens them.
        </p>
      </header>
      {savedNotice ? (
        <p className="saved-settings-notice" role="status">
          {savedNotice}
        </p>
      ) : null}

      <div className="link-analytics-layout">
        <aside className="link-list-panel" aria-label="Your saved links">
          <form className="link-filter-form" onSubmit={applyTagFilter}>
            <label htmlFor="link-tag-filter">Filter links by exact tag</label>
            <input
              id="link-tag-filter"
              value={filterDraft}
              onChange={(event) => setFilterDraft(event.target.value)}
              maxLength={64}
              autoCapitalize="none"
              spellCheck={false}
            />
            <p className="field-help">
              Matching preserves case, Unicode, and any spaces you enter.
            </p>
            <div className="link-filter-actions">
              <button className="button secondary" type="submit">
                Apply tag filter
              </button>
              {appliedTag !== "" || filterDraft !== "" ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setFilterDraft("");
                    if (appliedTag !== "" || links.length === 0) {
                      listGeneration.current++;
                      selectionGeneration.current++;
                      reportGeneration.current++;
                      trackingGeneration.current++;
                      setLinks([]);
                      linksRef.current = [];
                      setNextCursor(null);
                      setMoreLoading(false);
                      setSelectedId(null);
                      selectedIdRef.current = null;
                      selectedFilterMatch.current = null;
                      setReport(null);
                      setDraft(emptyDraft);
                      setNotice("");
                      setSaving(false);
                      setListQuery((current) => ({
                        tag: "",
                        revision: current.revision + 1,
                      }));
                      setListLoading(true);
                    }
                  }}
                >
                  Show all links
                </button>
              ) : null}
            </div>
          </form>

          {appliedTag !== "" ? (
            <p className="link-filter-summary">
              Exact tag: <strong>{appliedTag}</strong>
            </p>
          ) : null}
          {listError ? (
            <div className="error" role="alert">
              {listError}
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setListQuery((current) => ({
                    ...current,
                    revision: current.revision + 1,
                  }))
                }
              >
                Retry links
              </button>
            </div>
          ) : null}
          {listLoading ? <p role="status">Loading your links…</p> : null}
          <div className="link-summary-list">
            {links.map((link) => (
              <article className="link-summary-card" key={link.id}>
                <button
                  type="button"
                  className="link-summary-select"
                  aria-label={`Select ${link.slug}`}
                  aria-pressed={link.id === selectedId}
                  onClick={() => changeSelection(link.id)}
                >
                  <span className="link-summary-slug">{link.slug}</span>
                  <span className="link-summary-state">{linkState(link)}</span>
                </button>
                <span className="link-summary-kind">
                  {link.target.kind === "url"
                    ? "External URL"
                    : link.target.kind === "timeline"
                      ? "Timeline"
                      : "Asset"}
                </span>
              </article>
            ))}
          </div>
          {nextCursor ? (
            <button
              className="button secondary"
              type="button"
              disabled={moreLoading || listLoading}
              onClick={() => void loadMore()}
            >
              {moreLoading ? "Loading more links…" : "Load more links"}
            </button>
          ) : null}
          {!listLoading && links.length === 0 && !listError ? (
            <p className="empty-state">
              {appliedTag
                ? "No links have this exact tag yet."
                : "Your shared links will appear here."}
            </p>
          ) : null}
        </aside>

        {selectedLink ? (
          <div className="link-workspace">
            <section
              className="selected-link-card"
              aria-label="Selected link details"
            >
              <div className="selected-link-heading">
                <div>
                  <p className="eyebrow">Shared link</p>
                  <h2>{selectedLink.slug}</h2>
                </div>
                <span
                  className={`link-state-pill ${linkState(selectedLink).toLowerCase()}`}
                >
                  {linkState(selectedLink)}
                </span>
              </div>
              <p className="selected-link-target-label">Destination</p>
              {selectedLink.target.kind === "url" ? (
                <a
                  className="selected-link-target"
                  href={selectedLink.target.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedLink.target.url}
                </a>
              ) : selectedLink.target.kind === "timeline" ? (
                <p className="selected-link-target">
                  Timeline · {selectedLink.target.timeline_id}
                </p>
              ) : (
                <p className="selected-link-target">
                  Asset · {selectedLink.target.asset_id}
                </p>
              )}
              <label
                className="short-url-label"
                htmlFor={`short-url-${selectedLink.id}`}
              >
                Short URL for {selectedLink.slug}
              </label>
              <input
                id={`short-url-${selectedLink.id}`}
                className="short-url-input"
                value={selectedLink.short_url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <div className="link-detail-actions">
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`Copy ${selectedLink.slug}`}
                  onClick={() => void copyLink(selectedLink)}
                >
                  Copy link
                </button>
                <span className="link-expiry">
                  {selectedLink.expires_at
                    ? `Expires ${selectedLink.expires_at}`
                    : "No expiry"}
                </span>
              </div>
              {notice ? (
                <p className="link-notice" role="status">
                  {notice}
                </p>
              ) : null}
            </section>

            <LinkProviderSettings
              key={selectedLink.id}
              linkId={selectedLink.id}
              linkSlug={selectedLink.slug}
              authGeneration={authGeneration}
              onAuthorizationFailure={clearForAuthorizationFailure}
            />

            <section
              className="click-report-card"
              aria-label="Click source report"
            >
              <div className="click-report-heading">
                <div>
                  <p className="eyebrow">First-party report</p>
                  <h2>Clicks</h2>
                </div>
                <output className="click-total" aria-label="Clicks">
                  {report ? report.total : "—"}
                </output>
              </div>
              <p className="field-help">
                {report
                  ? `Showing ${report.from} through ${report.to}. Time zone: ${report.timezone}.`
                  : "Daily totals use Asia/Taipei."}
              </p>
              <form className="report-range-form" onSubmit={applyReportRange}>
                <div>
                  <label htmlFor="report-from">From</label>
                  <input
                    id="report-from"
                    type="date"
                    value={rangeDraft.from}
                    onChange={(event) =>
                      setRangeDraft((current) => ({
                        ...current,
                        from: event.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <label htmlFor="report-through">Through</label>
                  <input
                    id="report-through"
                    type="date"
                    value={rangeDraft.to}
                    onChange={(event) =>
                      setRangeDraft((current) => ({
                        ...current,
                        to: event.target.value,
                      }))
                    }
                  />
                </div>
                <button
                  className="button secondary"
                  type="submit"
                  disabled={reportLoading}
                >
                  Apply date range
                </button>
              </form>
              <p className="report-timezone">
                Reporting time zone: <strong>Asia/Taipei</strong>
              </p>
              {reportLoading ? (
                <p role="status">Loading click report…</p>
              ) : null}
              {reportError ? (
                <div className="error" role="alert">
                  {reportError}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setReportRetry((current) => current + 1)}
                  >
                    Retry report
                  </button>
                </div>
              ) : null}
              {report ? (
                <>
                  {report.channels.length === 0 &&
                  report.referrers.length === 0 ? (
                    <p className="source-empty">
                      No source data recorded in this range yet.
                    </p>
                  ) : null}
                  <div className="link-source-columns">
                    <section aria-label="Channel source totals">
                      <h3>Sharing channels</h3>
                      {report.channels.length > 0 ? (
                        <ul className="source-list">
                          {report.channels.map((row) => (
                            <li key={`${row.kind}:${row.label ?? "other"}`}>
                              <span>
                                {row.kind === "configured"
                                  ? row.label
                                  : "Other"}
                              </span>
                              <strong>{row.clicks}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="field-help">
                          No channel labels in this range.
                        </p>
                      )}
                    </section>
                    <section aria-label="Referrer source totals">
                      <h3>Referrers</h3>
                      {report.referrers.length > 0 ? (
                        <ul className="source-list">
                          {report.referrers.map((row) => (
                            <li key={`${row.kind}:${row.hostname ?? "none"}`}>
                              <span>
                                {row.kind === "host"
                                  ? row.hostname
                                  : row.kind === "direct"
                                    ? "Direct/unknown"
                                    : "Other"}
                              </span>
                              <strong>{row.clicks}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="field-help">
                          No referrers in this range.
                        </p>
                      )}
                    </section>
                  </div>
                  <p className="field-help source-limit-note">
                    Other includes source-bucket overflow, such as additional
                    hosts or historical channel labels beyond the daily limit.
                  </p>
                  <div className="daily-clicks-wrap">
                    <table className="daily-clicks-table">
                      <caption>Daily clicks</caption>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Clicks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.days.map((row) => (
                          <tr key={row.day}>
                            <th scope="row">{row.day}</th>
                            <td>{row.clicks}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              <p className="report-limitation">
                A click is a successful Link resolution. Bots and link previews
                may count; these totals do not identify people or estimate
                unique visitors. Channel labels are self-reported and recipients
                can edit the URL.
              </p>
            </section>

            <section
              className="tracking-settings-card"
              aria-label="Tracking settings"
            >
              <div className="tracking-settings-heading">
                <div>
                  <p className="eyebrow">Personalize this share</p>
                  <h2>Tags and tracking settings</h2>
                </div>
                <span className="tracking-default">Click counts are on</span>
              </div>
              <p className="field-help">
                Enter one exact tag or channel per line. Values keep their case,
                Unicode, and intentional spaces. Tracking parameters apply only
                to external URL destinations.
              </p>
              {trackingLoading ? (
                <p role="status">Loading tracking settings…</p>
              ) : null}
              {trackingError ? (
                <div className="error" role="alert">
                  Tracking settings could not be loaded. {trackingError}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setTrackingRetry((current) => current + 1)}
                  >
                    Retry settings
                  </button>
                </div>
              ) : null}
              {saveError ? (
                <p className="error" role="alert">
                  {saveError}
                </p>
              ) : null}
              <form className="tracking-settings-form" onSubmit={saveSettings}>
                <label htmlFor="link-tags">Link tags</label>
                <textarea
                  id="link-tags"
                  rows={3}
                  value={draft.tags}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      tags: event.target.value,
                    }))
                  }
                  aria-describedby="link-tags-help"
                  disabled={trackingLoading || saving}
                />
                <p className="field-help" id="link-tags-help">
                  Up to 20 tags, each 1–64 characters. Blank lines are sent as
                  entered and will be rejected by the server.
                </p>

                <label htmlFor="link-channels">Sharing channels</label>
                <textarea
                  id="link-channels"
                  rows={3}
                  value={draft.channels}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      channels: event.target.value,
                    }))
                  }
                  aria-describedby="link-channels-help"
                  disabled={trackingLoading || saving}
                />
                <p className="field-help" id="link-channels-help">
                  Up to 20 exact labels. A channel is self-reported and can be
                  edited by the person who opens the link.
                </p>

                <fieldset className="utm-fields">
                  <legend>UTM parameters</legend>
                  {UTM_FIELDS.map(({ key, label, id }) => (
                    <div className="utm-field-row" key={key}>
                      <label htmlFor={id}>{label}</label>
                      <input
                        id={id}
                        value={draft.utm[key] ?? ""}
                        maxLength={100}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            utm: {
                              ...current.utm,
                              [key]: event.target.value,
                            },
                          }))
                        }
                        disabled={trackingLoading || saving}
                      />
                      <label className="utm-include-label">
                        <input
                          type="checkbox"
                          checked={draft.utm[key] !== undefined}
                          aria-label={`Include ${label}`}
                          onChange={(event) =>
                            setDraft((current) => {
                              const utm = { ...current.utm };
                              if (event.target.checked) utm[key] ??= "";
                              else delete utm[key];
                              return { ...current, utm };
                            })
                          }
                          disabled={trackingLoading || saving}
                        />
                        Include
                      </label>
                    </div>
                  ))}
                  <p className="field-help">
                    Values are literal strings. Leave a field unchecked to omit
                    it, or include it with an empty value.
                  </p>
                </fieldset>

                <fieldset className="custom-parameter-fields">
                  <legend>Custom query parameters</legend>
                  {draft.custom.map((parameter, index) => (
                    <div className="custom-parameter-row" key={parameter.id}>
                      <div>
                        <label htmlFor={`link-custom-key-${index}`}>
                          Custom parameter {index + 1} key
                        </label>
                        <input
                          id={`link-custom-key-${index}`}
                          value={parameter.key}
                          maxLength={40}
                          autoCapitalize="none"
                          spellCheck={false}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              custom: current.custom.map((item, position) =>
                                position === index
                                  ? { ...item, key: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                          disabled={trackingLoading || saving}
                        />
                        {parameter.key !== "" &&
                        googleParameterNames.keys[index] === parameter.key ? (
                          <p className="field-help">
                            GA4 parameter: {googleParameterNames.names[index]}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <label htmlFor={`link-custom-value-${index}`}>
                          Custom parameter {index + 1} value
                        </label>
                        <input
                          id={`link-custom-value-${index}`}
                          value={parameter.value}
                          maxLength={100}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              custom: current.custom.map((item, position) =>
                                position === index
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                          disabled={trackingLoading || saving}
                        />
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Remove custom parameter ${index + 1}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            custom: current.custom.filter(
                              (_, position) => position !== index,
                            ),
                          }))
                        }
                        disabled={trackingLoading || saving}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="custom-parameter-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        const id = crypto.randomUUID();
                        setDraft((current) =>
                          current.custom.length >= 10
                            ? current
                            : {
                                ...current,
                                custom: [
                                  ...current.custom,
                                  { id, key: "", value: "" },
                                ],
                              },
                        );
                      }}
                      disabled={
                        trackingLoading || saving || draft.custom.length >= 10
                      }
                    >
                      Add custom parameter
                    </button>
                    <p className="field-help">
                      Up to 10 parameters. Keys and values stay literal,
                      including equals signs and spaces.
                    </p>
                  </div>
                </fieldset>
                <button
                  className="button primary"
                  type="submit"
                  disabled={trackingLoading || saving || Boolean(trackingError)}
                >
                  {saving ? "Saving settings…" : "Save tracking settings"}
                </button>
              </form>
            </section>
          </div>
        ) : !listLoading && !listError ? (
          <section className="link-empty-workspace" aria-label="Link details">
            <h2>Choose a link to see its story</h2>
            <p>
              Each link keeps its own click history, tags, and sharing details.
            </p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
