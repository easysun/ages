import {
  api,
  jsonBody,
  type LibraryAsset,
  RequestError,
  type UploadIntent,
} from "./api";

export type UploadJob = {
  id: string;
  file: File;
  phase: "waiting" | "uploading" | "checking" | "saved" | "error";
  intent?: UploadIntent;
  message?: string;
};
const supported = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
]);
export async function uploadFile(
  job: UploadJob,
  update: (change: Partial<UploadJob>) => void,
) {
  const file = job.file;
  if (!supported.has(file.type))
    throw new RequestError(
      "INVALID_REQUEST",
      "Choose a JPEG, PNG, WebP, GIF, MP4, or WebM file.",
    );
  const limit = (file.type.startsWith("image/") ? 25 : 250) * 1024 ** 2;
  if (!file.size || file.size > limit)
    throw new RequestError(
      "ASSET_TOO_LARGE",
      "This file exceeds the upload limit.",
    );
  let intent = job.intent;
  if (intent) {
    update({ phase: "checking" });
    try {
      return (
        await api<{ asset: LibraryAsset }>(
          `/api/assets/${intent.asset.id}/complete`,
          { method: "POST", ...jsonBody({}) },
        )
      ).asset;
    } catch (error) {
      if (
        !(error instanceof RequestError) ||
        !["UPLOAD_VALIDATION_FAILED", "UPLOAD_EXPIRED"].includes(error.code)
      )
        throw error;
    }
    const current = await api<{ asset: LibraryAsset }>(
      `/api/assets/${intent.asset.id}`,
    );
    if (
      current.asset.status !== "pending" ||
      Date.parse(intent.upload.expires_at) <= Date.now()
    )
      intent = undefined;
  }
  if (!intent) {
    intent = await api<UploadIntent>("/api/assets/upload-intent", {
      method: "POST",
      ...jsonBody({
        filename: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      }),
    });
    update({ intent });
  }
  update({ phase: "uploading" });
  let response: Response;
  try {
    response = await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: file,
    });
  } catch {
    throw new RequestError(
      "UPLOAD_INTERRUPTED",
      "Upload interrupted. Retry checks for a saved upload before sending the file again.",
    );
  }
  if (!response.ok)
    throw new RequestError(
      "UPLOAD_INTERRUPTED",
      "Upload interrupted. Retry checks for a saved upload before sending the file again.",
    );
  update({ phase: "checking" });
  return (
    await api<{ asset: LibraryAsset }>(
      `/api/assets/${intent.asset.id}/complete`,
      { method: "POST", ...jsonBody({}) },
    )
  ).asset;
}
