import { type RefObject, useEffect, useRef, useState } from "react";
import { errorMessage, type LibraryAsset } from "./api";
import { type UploadJob, uploadFile } from "./upload";

export type AppendAttempt = {
  itemId: string;
  expectedVersion?: number;
  state?: "uncertain" | "consumed";
};

function newAttempt(): AppendAttempt {
  return { itemId: `ti_client_${crypto.randomUUID()}` };
}

type PhotoJob = UploadJob & { asset?: LibraryAsset; attempt: AppendAttempt };

export function MomentComposer({
  empty,
  disabled,
  pickerOpener,
  openLibrary,
  addText,
  addPhoto,
  onUploadError,
}: {
  empty: boolean;
  disabled: boolean;
  pickerOpener: RefObject<HTMLButtonElement | null>;
  openLibrary: () => void;
  addText: (text: string, attempt: AppendAttempt) => Promise<boolean>;
  addPhoto: (asset: LibraryAsset, attempt: AppendAttempt) => Promise<boolean>;
  onUploadError: (reason: unknown) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const [photo, setPhoto] = useState<PhotoJob | null>(null);
  const [photoError, setPhotoError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const textAttempt = useRef<AppendAttempt | null>(null);
  const textButton = useRef<HTMLButtonElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (writing) textInput.current?.focus();
  }, [writing]);

  function closeText() {
    textAttempt.current = null;
    setWriting(false);
    setText("");
    textButton.current?.focus();
  }

  async function saveText(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || operation.current || disabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking(true);
    try {
      const attempt = textAttempt.current ?? newAttempt();
      textAttempt.current = attempt;
      const added = await addText(text, attempt);
      if (added && !controller.signal.aborted) {
        textAttempt.current = null;
        setWriting(false);
        setText("");
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setWorking(false);
      }
    }
  }

  async function savePhoto(job: PhotoJob) {
    if (operation.current || disabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking(true);
    setPhoto(job);
    setPhotoError("");
    try {
      const asset =
        job.asset ??
        (await uploadFile(
          job,
          (change) => {
            if (!controller.signal.aborted)
              setPhoto((current) => current && { ...current, ...change });
          },
          controller.signal,
        ));
      if (controller.signal.aborted) return;
      setPhoto((current) => current && { ...current, asset, phase: "saved" });
      const added = await addPhoto(asset, job.attempt);
      if (controller.signal.aborted) return;
      if (added) setPhoto(null);
      else if (job.attempt.state === "consumed")
        setPhotoError(
          "This photo was already added and the moment has since changed. Review the latest timeline.",
        );
      else
        setPhotoError(
          "Your photo is in your library. You can retry adding it to this timeline.",
        );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setPhotoError(errorMessage(reason));
        onUploadError(reason);
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setWorking(false);
      }
    }
  }

  return (
    <section className="moment-composer" aria-label="Add to timeline">
      <h2>{empty ? "Add your first moment" : "Add a moment"}</h2>
      <div className="composer-actions">
        <button
          className="button primary"
          type="button"
          disabled={working || disabled}
          onClick={() => fileInput.current?.click()}
        >
          Upload photo
        </button>
        <input
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          aria-label="Choose a photo"
          ref={fileInput}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file)
              void savePhoto({
                id: crypto.randomUUID(),
                attempt: newAttempt(),
                file,
                phase: "waiting",
              });
          }}
        />
        <button
          className="button secondary"
          type="button"
          ref={textButton}
          aria-expanded={writing}
          disabled={working || disabled}
          onClick={() => {
            setWriting(true);
            textInput.current?.focus();
          }}
        >
          Write text
        </button>
        <button
          className="text-button"
          type="button"
          ref={pickerOpener}
          aria-describedby="composer-library-hint"
          disabled={working}
          onClick={openLibrary}
        >
          Add moments
        </button>
        <span className="field-help" id="composer-library-hint">
          From your library
        </span>
      </div>
      {writing ? (
        <form className="text-composer" onSubmit={saveText}>
          <label htmlFor="new-moment-text">Moment text</label>
          <textarea
            ref={textInput}
            id="new-moment-text"
            rows={4}
            required
            maxLength={10000}
            readOnly={working || textAttempt.current?.state !== undefined}
            value={text}
            onChange={(event) => {
              textAttempt.current = null;
              setText(event.target.value);
            }}
          />
          {textAttempt.current?.state === "uncertain" && (
            <p role="status">
              The save could not be confirmed. Retry to check this note or
              cancel to review your timeline.
            </p>
          )}
          {textAttempt.current?.state === "consumed" && (
            <p role="status">
              This note was already added and later changed. Your original
              wording is available to copy.
            </p>
          )}
          <div className="moment-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                working ||
                disabled ||
                !text.trim() ||
                textAttempt.current?.state === "consumed"
              }
            >
              Add text moment
            </button>
            <button
              type="button"
              className="text-button"
              disabled={working}
              onClick={closeText}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {working && photo ? (
        <p role="status" className="field-help">
          {photo.asset
            ? "Adding to timeline…"
            : photo.phase === "checking"
              ? "Checking photo…"
              : "Uploading photo…"}
        </p>
      ) : null}
      {photoError && photo ? (
        <div className="composer-error">
          <p role="alert">{photoError}</p>
          <button
            className="text-button"
            type="button"
            disabled={working || disabled || photo.attempt.state === "consumed"}
            onClick={() => void savePhoto(photo)}
          >
            {photo.asset ? "Retry adding photo" : "Retry upload"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={working}
            onClick={() => {
              setPhoto(null);
              setPhotoError("");
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}
