import { useEffect, useRef, useState } from "react";
import {
  api,
  bytesLabel,
  errorMessage,
  jsonBody,
  type LibraryAsset,
  mediaUrl,
  RequestError,
} from "./api";
import { AssetSharing } from "./sharing";

export function AssetDetails({
  asset,
  onClose,
  onSaved,
  onTrashed,
}: {
  asset: LibraryAsset;
  onClose: () => void;
  onSaved: (asset: LibraryAsset) => void;
  onTrashed: (asset: LibraryAsset) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismissed = useRef(false);
  const trashed = useRef(false);
  const active = useRef(true);
  const [current, setCurrent] = useState(asset);
  const [tags, setTags] = useState(asset.tags.join("\n"));
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [trashError, setTrashError] = useState("");
  useEffect(() => {
    active.current = true;
    dialog.current?.showModal();
    let live = true;
    api<{ asset: LibraryAsset }>(`/api/assets/${encodeURIComponent(asset.id)}`)
      .then((result) => {
        if (live) {
          setCurrent(result.asset);
          setTags(result.asset.tags.join("\n"));
        }
      })
      .catch((reason) => {
        if (live) setError(errorMessage(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      active.current = false;
      live = false;
    };
  }, [asset.id]);
  function notifyDismissal() {
    if (dismissed.current || trashed.current) return;
    dismissed.current = true;
    onClose();
  }
  function dismiss() {
    dialog.current?.close();
    notifyDismissal();
  }
  async function saveTags(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = tags.split("\n").filter(Boolean);
    if (
      values.length > 20 ||
      values.some((value) => value.length > 64 || !value.trim())
    ) {
      setError("Use up to 20 tags, with no more than 64 characters each.");
      return;
    }
    if (new Set(values).size !== values.length) {
      setError("Each tag must be unique. Remove duplicate tags before saving.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ asset: LibraryAsset }>(
        `/api/assets/${encodeURIComponent(asset.id)}/tags`,
        { method: "PUT", ...jsonBody({ tags: values }) },
      );
      setCurrent(result.asset);
      setTags(result.asset.tags.join("\n"));
      onSaved(result.asset);
      setNotice("Tags saved");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  async function trash() {
    setSaving(true);
    setTrashError("");
    try {
      const result = await api<{ asset: LibraryAsset }>(
        `/api/assets/${encodeURIComponent(asset.id)}/trash`,
        { method: "POST", ...jsonBody({}) },
      );
      if (!active.current || dismissed.current) return;
      trashed.current = true;
      dialog.current?.close();
      onTrashed(result.asset);
    } catch (reason) {
      setTrashError(
        reason instanceof RequestError && reason.code === "CONFLICT"
          ? "Turn off active share links and remove this moment from timelines before moving this moment to Trash."
          : errorMessage(reason),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="detail-dialog"
      aria-labelledby="detail-title"
      onClose={notifyDismissal}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="detail-header">
        <p className="eyebrow">A moment in your library</p>
        <button
          className="icon-button"
          type="button"
          aria-label="Close details"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      <div className="detail-layout">
        <div className="detail-preview">
          {current.kind === "image" ? (
            <img src={mediaUrl(current)} alt={current.original_name} />
          ) : (
            <video
              src={mediaUrl(current)}
              controls
              aria-label={current.original_name}
            >
              <track kind="captions" />
            </video>
          )}
        </div>
        <div className="detail-content">
          <h2 id="detail-title">{current.original_name}</h2>
          <dl className="metadata">
            <div>
              <dt>Format</dt>
              <dd>
                {current.mime_type
                  .replace("image/", "")
                  .replace("video/", "")
                  .toUpperCase()}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{bytesLabel(current.size_bytes)}</dd>
            </div>
            {current.width && current.height ? (
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {current.width} × {current.height}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Capture time</dt>
              <dd>
                {current.captured_at ? (
                  <time dateTime={current.captured_at}>
                    {current.captured_at}
                  </time>
                ) : (
                  "Unknown"
                )}
              </dd>
            </div>
            <div>
              <dt>Visibility</dt>
              <dd>Private</dd>
            </div>
          </dl>
          <form onSubmit={saveTags}>
            <label htmlFor="asset-tags">Tags</label>
            <p id="tags-help" className="field-help">
              One tag per line. Tags help you find a moment again.
            </p>
            <textarea
              id="asset-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              aria-describedby="tags-help"
              rows={4}
              disabled={loading || saving}
            />
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
            <p role="status" className="notice">
              {loading ? "Loading details…" : notice}
            </p>
            <button
              className="button primary"
              type="submit"
              disabled={loading || saving}
            >
              {saving ? "Saving…" : "Save tags"}
            </button>
          </form>
          {!loading ? <AssetSharing assetId={asset.id} /> : null}
          <section
            className="trash-action"
            aria-label="Move this moment to Trash"
          >
            <p className="field-help">
              Recover this moment from Trash within 30 days. Shared moments must
              be unlinked first.
            </p>
            {trashError ? (
              <p role="alert" className="error">
                {trashError}
              </p>
            ) : null}
            <button
              className="button secondary"
              type="button"
              disabled={loading || saving}
              onClick={() => void trash()}
            >
              Move to Trash
            </button>
          </section>
        </div>
      </div>
    </dialog>
  );
}
