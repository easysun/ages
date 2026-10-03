export type Asset = {
  id: string;
  owner_id: string;
  kind: "image" | "video" | "audio" | "file";
  status: "pending" | "ready" | "failed" | "deleted" | "purged";
  original_name: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  etag: string | null;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  visibility: "private" | "unlisted" | "public";
  upload_expires_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  trash_generation: string | null;
  purge_claim: string | null;
};

export function assetPayload(asset: Asset) {
  const {
    r2_key: _key,
    owner_id: _owner,
    etag: _etag,
    trash_generation: _generation,
    purge_claim: _claim,
    upload_expires_at: _expiry,
    ...payload
  } = asset;
  return payload;
}
