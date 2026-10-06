import { appOrigin } from "../auth/config";
import type { Bindings } from "../bindings";
import { ApiError } from "../http/errors";

export type TrackingWorkerBindings = {
  DB: D1Database;
  APP_ENV?: string;
  APP_ORIGIN?: string;
  TRACKING_ORIGIN?: string;
};

function exactWorkerOrigin(
  value: string | undefined,
  localHosts: readonly string[],
  allowLocalHttp: boolean,
) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  const localHttp =
    allowLocalHttp &&
    url.protocol === "http:" &&
    localHosts.includes(url.hostname);
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new ApiError("SERVICE_UNAVAILABLE");
  return url.origin;
}

export function appTrackingOrigin(
  bindings: Pick<Bindings, "APP_ENV" | "APP_ORIGIN" | "TRACKING_ORIGIN">,
) {
  let url: URL;
  try {
    url = new URL(bindings.TRACKING_ORIGIN ?? "");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  const localHttp =
    bindings.APP_ENV === "local" &&
    url.protocol === "http:" &&
    ["127.0.0.2", "localhost"].includes(url.hostname) &&
    url.hostname !== new URL(appOrigin(bindings)).hostname;
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.origin !== bindings.TRACKING_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin === appOrigin(bindings)
  )
    throw new ApiError("SERVICE_UNAVAILABLE");
  return url.origin;
}

export function trackingPageOrigins(bindings: TrackingWorkerBindings) {
  const allowLocalHttp = bindings.APP_ENV === "local";
  const appOrigin = exactWorkerOrigin(
    bindings.APP_ORIGIN,
    ["127.0.0.1"],
    allowLocalHttp,
  );
  const trackingOrigin = exactWorkerOrigin(
    bindings.TRACKING_ORIGIN,
    ["127.0.0.2", "localhost"],
    allowLocalHttp,
  );
  if (new URL(appOrigin).hostname === new URL(trackingOrigin).hostname)
    throw new ApiError("SERVICE_UNAVAILABLE");
  return {
    appOrigin,
    trackingOrigin,
  };
}

export type TrackingPageOrigins = ReturnType<typeof trackingPageOrigins>;
