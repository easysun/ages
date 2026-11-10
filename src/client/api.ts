import type { assetPayload } from "../assets/model";
import type { linkPayload } from "../links/model";
import type { LinkTracking } from "../links/tracking";

export type LibraryAsset = ReturnType<typeof assetPayload> & { tags: string[] };
export type LibraryPage = {
  assets: LibraryAsset[];
  next_cursor: string | null;
};
export type OwnerLink = ReturnType<typeof linkPayload>;
export type OwnerLinkPage = {
  links: OwnerLink[];
  next_cursor: string | null;
};
export type LinkTrackingReport = {
  timezone: "Asia/Taipei";
  from: string;
  to: string;
  total: number;
  days: { day: string; clicks: number }[];
  channels: {
    kind: "configured" | "other";
    label: string | null;
    clicks: number;
  }[];
  referrers: {
    kind: "host" | "other" | "direct";
    hostname: string | null;
    clicks: number;
  }[];
};
export type TrackingProviderSettings = {
  ga4_measurement_id: string | null;
  meta_pixel_id: string | null;
  gtm_container_id: string | null;
  ga4_route: "direct" | "gtm";
  meta_route: "direct" | "gtm";
};
export type LinkTrackingProviders = {
  allow_ga4: boolean;
  allow_meta_pixel: boolean;
  allow_gtm: boolean;
};
export type { LinkTracking };
export type Profile = {
  user: {
    id: string;
    display_name: string | null;
    email: string;
    plan: "free" | "creator" | "pro" | "admin";
  };
  quota: {
    storage_limit_bytes: number;
    storage_used_bytes: number;
    storage_reserved_bytes: number;
  };
};
export type ModerationTarget = {
  kind: "asset" | "timeline" | "link";
  id: string;
};
export type ModerationState = {
  moderation: { target: ModerationTarget; blocked: boolean };
};
export type ReportPage = {
  reports: {
    id: string;
    target: ModerationTarget;
    subject?: ModerationTarget;
    category: string;
    detail: string;
    reporter_id: string;
    created_at: string;
    observed_timeline_version: number | null;
  }[];
  next_cursor: string | null;
};
export type ReportTarget =
  | { kind: "timeline"; timeline_id: string }
  | { kind: "link"; slug: string };
export type ReportCategory =
  | "spam"
  | "abuse"
  | "copyright"
  | "illegal"
  | "other";
export type ReportReceipt = {
  report: { id: string; status: "received" };
};
export type ContentEdgeType = "related_to" | "references" | "continuation";
export type ContentEdgeView = {
  id: string;
  type: ContentEdgeType;
  source: { id: string; title: string | null };
  target: { id: string; title: string | null };
  attribution: "added by source owner";
  created_at: string;
};
export type IncomingContentEdgeReview = ContentEdgeView & {
  pending_acceptance: boolean;
  accepted: boolean;
  suppressed: boolean;
  blocked_by_target: boolean;
};
export type ContentEdgePage = {
  edges: ContentEdgeView[];
  next_cursor: string | null;
};
export type ContentEdgeReviewPage = {
  edges: IncomingContentEdgeReview[];
  next_cursor: string | null;
};
export type ContentEdgeOwnerState = {
  id: string;
  accepted_at: string | null;
  suppressed_at: string | null;
  target_owner_blocked_at: string | null;
};
export type ContentEdgeModerationState = {
  moderation: { edge_id: string; blocked: boolean };
};
export type ContentNodeModerationState = {
  moderation: { node_id: string; blocked: boolean };
};
export type ContentEdgeReportPage = {
  reports: {
    id: string;
    edge_id: string;
    category: string;
    detail: string;
    reporter_id: string;
    created_at: string;
    source_id: string;
    target_id: string;
    type: string;
  }[];
  next_cursor: string | null;
};
export type UploadIntent = {
  asset: Omit<LibraryAsset, "tags">;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
};
export class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const requestOptions = {
    ...options,
    credentials: "same-origin" as const,
  };
  const response = await fetch(path, requestOptions);
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Preserve the HTTP status when an error body is empty or malformed.
    }
    const envelope =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { error?: unknown }).error
        : null;
    const error =
      envelope && typeof envelope === "object" && !Array.isArray(envelope)
        ? (envelope as { code?: unknown; message?: unknown })
        : null;
    throw new RequestError(
      typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
      typeof error?.message === "string" ? error.message : "Please try again.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
export function jsonBody(value: unknown) {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
export function mediaUrl(asset: LibraryAsset) {
  return `/api/assets/${encodeURIComponent(asset.id)}/media`;
}
export function bytesLabel(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
export function errorMessage(error: unknown) {
  if (error instanceof RequestError) {
    if (error.code === "UNAUTHENTICATED")
      return "Your session has ended. Sign in again to continue.";
    if (error.code === "QUOTA_EXCEEDED")
      return "There isn’t enough available storage. Pending uploads reserve space until they expire.";
    if (error.code === "ASSET_TOO_LARGE")
      return "This file exceeds the upload limit. Choose a smaller file.";
    if (error.code === "SERVICE_UNAVAILABLE")
      return "Uploads are unavailable right now. Please try again later.";
    if (error.code === "UPLOAD_VALIDATION_FAILED")
      return "This media could not be validated. Choose another file or retry the upload.";
    if (error.code === "UPLOAD_EXPIRED")
      return "The upload window ended. Retry to start a new upload.";
    return error.message;
  }
  return "The connection was interrupted. Check your connection and try again.";
}
