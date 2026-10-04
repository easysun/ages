import qrcode from "qrcode-generator";
import { useEffect, useRef, useState } from "react";
import type { linkPayload } from "../links/model";
import { api, errorMessage, jsonBody, RequestError } from "./api";

type ShareLink = ReturnType<typeof linkPayload>;
type LinkPage = { links: ShareLink[]; next_cursor: string | null };

function localExpiry(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function expiryInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw new Error("Choose an expiry in the future, or leave it blank.");
  return date.toISOString();
}

export function AssetSharing({ assetId }: { assetId: string }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState("");
  const [expiry, setExpiry] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [qr, setQr] = useState<{ id: string; src: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    api<LinkPage>("/api/links?limit=100", { signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted) {
          setLinks(page.links);
          setCursor(page.next_cursor);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, []);
  async function more() {
    if (!cursor) return;
    setBusy(true);
    setError("");
    try {
      const page = await api<LinkPage>(
        `/api/links?limit=100&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!live.current) return;
      setLinks((current) => [
        ...current,
        ...page.links.filter(
          (link) => !current.some((row) => row.id === link.id),
        ),
      ]);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (slug && !/^[a-z0-9-]{3,64}$/.test(slug)) {
      setError(
        "Use 3–64 lowercase letters, numbers, or hyphens for the link name.",
      );
      return;
    }
    let expires_at: string | null;
    try {
      expires_at = expiryInput(expiry);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ link: ShareLink }>("/api/links", {
        method: "POST",
        ...jsonBody({
          target: { kind: "asset", asset_id: assetId },
          ...(slug ? { slug } : {}),
          expires_at,
        }),
      });
      if (!live.current) return;
      setLinks((current) => [result.link, ...current]);
      setSlug("");
      setExpiry("");
      setNotice("Share link created");
    } catch (reason) {
      if (live.current)
        setError(
          reason instanceof RequestError && reason.code === "CONFLICT"
            ? "That link name is unavailable, or this moment can no longer be shared. Choose another name or refresh."
            : errorMessage(reason),
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function update(
    link: ShareLink,
    change: { active?: boolean; expires_at?: string | null },
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ link: ShareLink }>(
        `/api/links/${encodeURIComponent(link.id)}`,
        { method: "PATCH", ...jsonBody(change) },
      );
      if (!live.current) return;
      setLinks((current) =>
        current.map((row) => (row.id === link.id ? result.link : row)),
      );
      setDrafts((current) => ({
        ...current,
        [link.id]: localExpiry(result.link.expires_at),
      }));
      if (change.active === false)
        setQr((current) => (current?.id === link.id ? null : current));
      setNotice(
        change.active === undefined
          ? "Expiry saved"
          : change.active
            ? "Share link activated"
            : "Share link deactivated",
      );
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function copy(link: ShareLink) {
    try {
      await navigator.clipboard.writeText(link.short_url);
      if (live.current) setNotice("Link copied");
    } catch {
      if (live.current)
        setError(
          "Select the short URL to copy it. Clipboard access is unavailable.",
        );
    }
  }
  function showQr(link: ShareLink) {
    try {
      const code = qrcode(0, "M");
      code.addData(link.short_url);
      code.make();
      setQr({ id: link.id, src: code.createDataURL(4, 16) });
    } catch {
      setError(
        "The QR code could not be generated. You can still copy the link.",
      );
    }
  }
  const matching = links.filter(
    (link) => link.target.kind === "asset" && link.target.asset_id === assetId,
  );
  return (
    <section className="sharing-panel" aria-label="Share this moment">
      <h3>Share this moment</h3>
      <p className="field-help">
        Anyone with an active link can open this moment. Your library stays
        private.
      </p>
      <form onSubmit={create}>
        <label htmlFor="share-slug">Link name (optional)</label>
        <input
          id="share-slug"
          value={slug}
          maxLength={64}
          onChange={(event) => setSlug(event.target.value)}
          disabled={busy || loading}
          autoCapitalize="none"
          spellCheck={false}
        />
        <label htmlFor="share-expiry">Link expiry (your local time)</label>
        <input
          id="share-expiry"
          type="datetime-local"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          disabled={busy || loading}
        />
        <p className="field-help">
          Leave the expiry blank to keep the link available.
        </p>
        <button
          className="button secondary"
          type="submit"
          disabled={busy || loading}
        >
          Create share link
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <p role="status" className="notice">
        {loading ? "Loading share links…" : notice}
      </p>
      {matching.map((link) => {
        const expired =
          link.expires_at !== null && Date.parse(link.expires_at) <= Date.now();
        return (
          <article
            className="share-link"
            key={link.id}
            aria-label={`Share link ${link.slug}`}
          >
            <h4>
              {link.slug}{" "}
              <span>
                {!link.active ? "Inactive" : expired ? "Expired" : "Active"}
              </span>
            </h4>
            <label htmlFor={`short-${link.id}`}>
              Short URL for {link.slug}
            </label>
            <input
              id={`short-${link.id}`}
              value={link.short_url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <div className="sharing-actions">
              <button
                className="button secondary"
                type="button"
                aria-label={`Copy ${link.slug}`}
                onClick={() => void copy(link)}
              >
                Copy link
              </button>
              <button
                className="button secondary"
                type="button"
                aria-label={`Show QR for ${link.slug}`}
                onClick={() => showQr(link)}
              >
                Show QR
              </button>
              <button
                className="button secondary"
                type="button"
                aria-label={`${link.active ? "Deactivate" : "Activate"} ${link.slug}`}
                disabled={busy}
                onClick={() => void update(link, { active: !link.active })}
              >
                {link.active ? "Deactivate" : "Activate"}
              </button>
            </div>
            {qr?.id === link.id ? (
              <img
                className="share-qr"
                src={qr.src}
                alt={`QR code for ${link.slug}`}
              />
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  void update(link, {
                    expires_at: expiryInput(
                      drafts[link.id] ?? localExpiry(link.expires_at),
                    ),
                  });
                } catch (reason) {
                  setError((reason as Error).message);
                }
              }}
            >
              <label htmlFor={`expiry-${link.id}`}>
                Expiry for {link.slug} (your local time)
              </label>
              <input
                id={`expiry-${link.id}`}
                type="datetime-local"
                value={drafts[link.id] ?? localExpiry(link.expires_at)}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [link.id]: event.target.value,
                  }))
                }
                disabled={busy}
              />
              <button
                className="button secondary"
                type="submit"
                aria-label={`Save expiry for ${link.slug}`}
                disabled={busy}
              >
                Save expiry
              </button>
            </form>
          </article>
        );
      })}
      {cursor ? (
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => void more()}
        >
          Load more share links
        </button>
      ) : null}
    </section>
  );
}
