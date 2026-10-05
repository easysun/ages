import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  jsonBody,
  RequestError,
  type TrackingProviderSettings,
} from "./api";

const emptySettings: TrackingProviderSettings = {
  ga4_measurement_id: null,
  meta_pixel_id: null,
  gtm_container_id: null,
  ga4_route: "direct",
  meta_route: "direct",
};

function authorizationMessage(reason: RequestError) {
  return reason.status === 401
    ? "Your session has ended. Sign in again to continue."
    : "Access to tracking settings is no longer available for this account.";
}

function isAuthorizationFailure(reason: unknown): reason is RequestError {
  return (
    reason instanceof RequestError &&
    (reason.status === 401 || reason.status === 403)
  );
}

export function TrackingSettingsScreen({
  authGeneration,
}: {
  authGeneration: number;
}): React.JSX.Element {
  const [draft, setDraft] = useState(emptySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [accessError, setAccessError] = useState("");
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

  const clearSensitiveState = useCallback((message: string) => {
    requestGeneration.current++;
    for (const controller of activeRequests.current) controller.abort();
    activeRequests.current.clear();
    setDraft({ ...emptySettings });
    setLoading(false);
    setSaving(false);
    setLoadError("");
    setSaveError("");
    setNotice("");
    setAccessError(message);
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
      clearSensitiveState(
        "Your sign-in changed. Reload tracking settings to continue.",
      );
    }
  }, [authGeneration, clearSensitiveState]);

  // Retry state intentionally triggers a fresh provider settings read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally triggers a fresh provider read.
  useEffect(() => {
    if (accessError) return;
    const currentRequest = ++requestGeneration.current;
    const controller = newController();
    setLoading(true);
    setLoadError("");
    api<{ providers: TrackingProviderSettings }>("/api/me/tracking/providers", {
      signal: controller.signal,
    })
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
        if (isAuthorizationFailure(reason)) {
          clearSensitiveState(authorizationMessage(reason));
          return;
        }
        setLoadError(errorMessage(reason));
        setLoading(false);
      })
      .finally(() => finishController(controller));
  }, [
    accessError,
    authGeneration,
    retry,
    newController,
    finishController,
    clearSensitiveState,
  ]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || saving || accessError || loadError) return;
    const currentRequest = requestGeneration.current;
    const controller = newController();
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result = await api<{ providers: TrackingProviderSettings }>(
        "/api/me/tracking/providers",
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
        setNotice("Tracking providers saved.");
      }
    } catch (reason) {
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentRequest !== requestGeneration.current ||
        authGenerationRef.current !== authGeneration
      )
        return;
      if (isAuthorizationFailure(reason)) {
        clearSensitiveState(authorizationMessage(reason));
        return;
      }
      setSaveError(
        `Provider settings could not be saved. ${errorMessage(reason)}`,
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

  function retrySettings() {
    setAccessError("");
    setLoadError("");
    setRetry((current) => current + 1);
  }

  if (accessError) {
    return (
      <main id="main" className="tracking-provider-page">
        <p className="eyebrow">Account tracking</p>
        <h1>Tracking settings</h1>
        <p role="alert" className="error">
          {accessError}
        </p>
        <button
          className="button secondary"
          type="button"
          onClick={retrySettings}
        >
          Retry tracking settings
        </button>
      </main>
    );
  }

  return (
    <main id="main" className="tracking-provider-page">
      <header className="tracking-provider-intro">
        <p className="eyebrow">Account tracking</p>
        <h1>Tracking settings</h1>
        <p>
          Add the public IDs for the analytics providers you use. Each provider
          follows one delivery route, and each Link can opt out independently.
        </p>
      </header>
      <section
        className="tracking-provider-card"
        aria-label="Account tracking providers"
      >
        <h2>Account providers</h2>
        <p className="field-help">
          New provider IDs apply to your existing and future Links. Turn a
          provider off for an individual Link from its Links settings.
        </p>
        {loading ? <p role="status">Loading tracking settings…</p> : null}
        {loadError ? (
          <div className="error" role="alert">
            Tracking settings could not be loaded. {loadError}
            <button
              className="text-button"
              type="button"
              onClick={retrySettings}
            >
              Retry tracking settings
            </button>
          </div>
        ) : null}
        {saveError ? (
          <p className="error" role="alert">
            {saveError}
          </p>
        ) : null}
        {notice ? (
          <p className="saved-settings-notice" role="status">
            {notice}
          </p>
        ) : null}
        <form className="tracking-provider-form" onSubmit={save}>
          <label htmlFor="tracking-ga4-measurement-id">
            Google Analytics 4 measurement ID
          </label>
          <input
            id="tracking-ga4-measurement-id"
            value={draft.ga4_measurement_id ?? ""}
            maxLength={22}
            pattern="G-[A-Z0-9]{1,20}"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                ga4_measurement_id: event.target.value || null,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          <label htmlFor="tracking-meta-pixel-id">Meta Pixel ID</label>
          <input
            id="tracking-meta-pixel-id"
            value={draft.meta_pixel_id ?? ""}
            maxLength={30}
            pattern="[0-9]{1,30}"
            inputMode="numeric"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                meta_pixel_id: event.target.value || null,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          <label htmlFor="tracking-gtm-container-id">
            Google Tag Manager container ID
          </label>
          <input
            id="tracking-gtm-container-id"
            value={draft.gtm_container_id ?? ""}
            maxLength={24}
            pattern="GTM-[A-Z0-9]{1,20}"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                gtm_container_id: event.target.value || null,
              }))
            }
            disabled={loading || saving || Boolean(loadError)}
          />
          <fieldset className="tracking-provider-routes">
            <legend>Delivery route</legend>
            <label htmlFor="tracking-ga4-route">GA4 delivery</label>
            <select
              id="tracking-ga4-route"
              value={draft.ga4_route}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ga4_route: event.target.value as "direct" | "gtm",
                }))
              }
              disabled={loading || saving || Boolean(loadError)}
            >
              <option value="direct">Direct</option>
              <option value="gtm">Google Tag Manager</option>
            </select>
            <label htmlFor="tracking-meta-route">Meta Pixel delivery</label>
            <select
              id="tracking-meta-route"
              value={draft.meta_route}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  meta_route: event.target.value as "direct" | "gtm",
                }))
              }
              disabled={loading || saving || Boolean(loadError)}
            >
              <option value="direct">Direct</option>
              <option value="gtm">Google Tag Manager</option>
            </select>
            <p className="field-help">
              A GTM route requires a configured container ID. A provider is
              delivered directly or through GTM, never both.
            </p>
          </fieldset>
          <button
            className="button primary"
            type="submit"
            disabled={loading || saving || Boolean(loadError)}
          >
            {saving ? "Saving providers…" : "Save account providers"}
          </button>
        </form>
      </section>
    </main>
  );
}
