import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../bindings";

const errors = {
  INVALID_REQUEST: { status: 400, message: "Invalid request." },
  UNAUTHENTICATED: { status: 401, message: "Authentication required." },
  FORBIDDEN: { status: 403, message: "Access denied." },
  NOT_FOUND: { status: 404, message: "Resource not found." },
  CONFLICT: {
    status: 409,
    message: "The request conflicts with current state.",
  },
  PAYLOAD_TOO_LARGE: { status: 413, message: "Request body is too large." },
  ASSET_TOO_LARGE: { status: 413, message: "Asset exceeds the size limit." },
  QUOTA_EXCEEDED: { status: 403, message: "Storage quota exceeded." },
  UPLOAD_EXPIRED: { status: 409, message: "Upload intent has expired." },
  UPLOAD_VALIDATION_FAILED: {
    status: 422,
    message: "Upload validation failed.",
  },
  RATE_LIMITED: { status: 429, message: "Too many requests." },
  INTERNAL_ERROR: { status: 500, message: "An unexpected error occurred." },
  SERVICE_UNAVAILABLE: { status: 503, message: "Service is not ready." },
} as const satisfies Record<
  string,
  { status: ContentfulStatusCode; message: string }
>;

export type ErrorCode = keyof typeof errors;

export class ApiError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(errors[code].message);
    this.name = "ApiError";
  }
}

export function errorResponse(context: Context<AppContext>, code: ErrorCode) {
  const { status, message } = errors[code];
  return context.json(
    { error: { code, message, request_id: context.get("requestId") } },
    status,
  );
}
