import type { TrackingPageOrigins } from "./config";
import { googleCustomParameterName } from "./google-parameters";
import type { TrackingTicketView } from "./tickets";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const utmKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

async function googleEventParameters(view: TrackingTicketView) {
  const { event } = view;
  const customParameters = await Promise.all(
    event.custom.map(
      async ({ key, value }) =>
        [await googleCustomParameterName(key), value] as const,
    ),
  );
  const parameters: Record<string, string> = {
    link_id: event.link_id,
    target_kind: event.target_kind,
    channel: event.channel,
  };
  for (const key of utmKeys) {
    const value = event.utm[key];
    if (value !== undefined) parameters[key] = value;
  }
  for (const [key, value] of customParameters) {
    if (Object.hasOwn(parameters, key))
      throw new Error("Tracking event parameter names collided.");
    parameters[key] = value;
  }
  if (Object.keys(parameters).length > 25)
    throw new Error(
      "Tracking event exceeds the Google Analytics parameter limit.",
    );
  return parameters;
}

export async function renderTrackingInterstitial(
  token: string,
  view: TrackingTicketView,
  origins: TrackingPageOrigins,
) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const action = new URL("/s/continue", origins.appOrigin).href;
  const googleEvent = await googleEventParameters(view);
  const usesGtm = view.providers.gtm !== null;
  const providerNames = [
    ...(view.providers.ga4 === null ? [] : ["Google Analytics 4"]),
    ...(view.providers.meta === null ? [] : ["Meta Pixel"]),
    ...(usesGtm ? ["Google Tag Manager"] : []),
  ];
  const providerList = providerNames.map((name) => `<li>${name}</li>`).join("");
  const bootstrapView = safeJson({
    ...view,
    googleEvent,
  });
  const script = `(() => {
  history.replaceState(null, "", location.origin + "/consent");
  const fallback = document.getElementById("fallback");
  const input = fallback && fallback.querySelector('input[name="token"]');
  const token = input && input.value;
  const action = fallback && fallback.action;
  fallback && fallback.remove();
  const allow = document.getElementById("allow");
  const skip = document.getElementById("skip");
  allow.hidden = false;
  skip.hidden = false;
  const view = ${bootstrapView};
  const pageLocation = location.origin + "/consent";
  let submitted = false;
  const continueNow = () => {
    if (submitted || !token || !action) return;
    submitted = true;
    const form = document.createElement("form");
    form.method = "post";
    form.action = action;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "token";
    field.value = token;
    form.append(field);
    document.body.append(form);
    form.submit();
  };
  skip.addEventListener("click", continueNow);
  const eventData = () => {
    const data = {
      link_id: view.event.link_id,
      target_kind: view.event.target_kind,
      channel: view.event.channel,
      page_location: pageLocation,
      page_referrer: "",
      ages_custom: view.event.custom
    };
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      if (Object.prototype.hasOwnProperty.call(view.event.utm, key)) data[key] = view.event.utm[key];
    }
    return data;
  };
  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    script.referrerPolicy = "no-referrer";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  const beginConsent = () => {
    allow.disabled = true;
    const loads = [];
    if (view.providers.ga4 && view.providers.ga4.route === "direct") {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
      window.gtag("config", view.providers.ga4.id, {
        send_page_view: false,
        page_location: pageLocation,
        page_referrer: ""
      });
      window.gtag("event", view.event.event_name, view.googleEvent);
      loads.push(loadScript("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(view.providers.ga4.id)));
    }
    if (view.providers.meta && view.providers.meta.route === "direct") {
      window.fbq = function fbq() { window.fbq.queue.push(Array.from(arguments)); };
      window.fbq.queue = [];
      window.fbq("init", view.providers.meta.id);
      window.fbq("trackCustom", view.event.event_name, eventData());
      loads.push(loadScript("https://connect.facebook.net/en_US/fbevents.js"));
    }
    if (view.providers.gtm) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: "ages_provider_eligibility",
        ages_ga4_eligible: view.providers.ga4 !== null && view.providers.ga4.route === "gtm",
        ages_meta_pixel_eligible: view.providers.meta !== null && view.providers.meta.route === "gtm"
      });
      window.dataLayer.push({
        event: view.event.event_name,
        link_id: view.event.link_id,
        target_kind: view.event.target_kind,
        channel: view.event.channel,
        page_location: pageLocation,
        page_referrer: "",
        utm_source: view.event.utm.utm_source,
        utm_medium: view.event.utm.utm_medium,
        utm_campaign: view.event.utm.utm_campaign,
        utm_term: view.event.utm.utm_term,
        utm_content: view.event.utm.utm_content,
        ages_custom: view.event.custom
      });
      loads.push(loadScript("https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(view.providers.gtm.id)));
    }
    window.setTimeout(continueNow, 2000);
    Promise.all(loads).then(continueNow, continueNow);
  };
  allow.addEventListener("click", beginConsent);
  window.setTimeout(continueNow, 10000);
})();`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Before you continue</title>
<style nonce="${nonce}">
  body { font: 1rem/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; color: #1d2925; background: #f5f4ef; }
  main { max-width: 34rem; margin: 8vh auto; padding: 2rem; background: white; border: 1px solid #d6ddd8; border-radius: 1rem; }
  h1 { margin-top: 0; font-size: clamp(1.6rem, 7vw, 2rem); }
  p { color: #40534b; }
  ul { margin: .5rem 0 1rem; padding-left: 1.25rem; color: #40534b; }
  button { min-height: 2.75rem; margin: .5rem .5rem .5rem 0; padding: .65rem 1rem; border: 0; border-radius: .5rem; font: inherit; cursor: pointer; }
  #allow { color: white; background: #245c46; }
  #skip, #fallback button { color: #1d2925; background: #e8eee9; }
</style>
</head>
<body>
<main>
  <h1>Before you continue</h1>
  <p>This Link can send one visit event to these providers if you allow it:</p>
  <ul aria-label="Configured analytics providers">${providerList}</ul>
  <p>You can continue without optional analytics.</p>
  <button id="allow" type="button" hidden>Allow optional analytics</button>
  <button id="skip" type="button" hidden>Continue without analytics</button>
  <form id="fallback" action="${escapeHtml(action)}" method="post">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">Continue without analytics</button>
  </form>
</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://www.googletagmanager.com https://connect.facebook.net`,
    "connect-src https://www.googletagmanager.com https://connect.facebook.net https://www.google-analytics.com https://region1.google-analytics.com https://www.facebook.com",
    "img-src https://www.googletagmanager.com https://connect.facebook.net https://www.google-analytics.com https://region1.google-analytics.com https://www.facebook.com",
    `style-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `form-action ${origins.appOrigin}`,
  ].join("; ");
  return { html, contentSecurityPolicy };
}
