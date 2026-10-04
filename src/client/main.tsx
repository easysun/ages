import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  bytesLabel,
  errorMessage,
  type LibraryAsset,
  type LibraryPage,
  mediaUrl,
  type Profile,
  RequestError,
} from "./api";
import { AssetDetails } from "./details";
import { TimelineScreen } from "./timelines";
import { type UploadJob, uploadFile } from "./upload";
import "./styles.css";

function Brand() {
  return (
    <a href="/" className="brand" aria-label="Ages home">
      <span className="brand-mark" aria-hidden="true">
        a
      </span>
      <span>
        ages<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profileRequest, setProfileRequest] = useState({ path: "/api/me" });
  const authGeneration = useRef(0);
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const popped = () => setPath(window.location.pathname);
    window.addEventListener("popstate", popped);
    return () => window.removeEventListener("popstate", popped);
  }, []);
  function navigate(next: string) {
    window.history.pushState(null, "", next);
    setPath(next);
    window.scrollTo(0, 0);
  }
  function collectionLink(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(event.currentTarget.pathname);
  }
  useEffect(() => {
    let live = true;
    const generation = authGeneration.current;
    setLoading(true);
    setError("");
    api<Profile>(profileRequest.path)
      .then((result) => {
        if (live && generation === authGeneration.current) setProfile(result);
      })
      .catch((reason) => {
        if (
          live &&
          !(reason instanceof RequestError && reason.code === "UNAUTHENTICATED")
        )
          setError(errorMessage(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [profileRequest]);
  async function logout() {
    authGeneration.current++;
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error();
      setProfile(null);
    } catch {
      setError("Sign out could not be completed. Please try again.");
    }
  }
  const generation = authGeneration.current;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Brand />
        <span className="header-note">A home for your moments</span>
        {profile ? (
          <div className="account">
            <span>{profile.user.display_name ?? profile.user.email}</span>
            <button type="button" className="text-button" onClick={logout}>
              Sign out
            </button>
          </div>
        ) : (
          <span className="private-label">Made to keep</span>
        )}
      </header>
      {profile ? (
        <nav className="client-nav" aria-label="Your collections">
          <a
            href="/library"
            onClick={collectionLink}
            aria-current={
              path === "/library" || path === "/" ? "page" : undefined
            }
          >
            Library
          </a>
          <a
            href="/timelines"
            onClick={collectionLink}
            aria-current={path.startsWith("/timelines") ? "page" : undefined}
          >
            Timelines
          </a>
        </nav>
      ) : null}
      {loading ? (
        <main id="main" className="loading-page">
          <p role="status">Opening your library…</p>
        </main>
      ) : error ? (
        <main id="main" className="loading-page">
          <p role="alert" className="error">
            {error}
          </p>
          <button
            type="button"
            className="button"
            onClick={() => setProfileRequest({ path: "/api/me" })}
          >
            Try again
          </button>
        </main>
      ) : profile ? (
        path === "/timelines" || path.startsWith("/timelines/") ? (
          <TimelineScreen
            id={
              path === "/timelines"
                ? undefined
                : path.slice("/timelines/".length)
            }
            navigate={navigate}
          />
        ) : path === "/library" || path === "/" ? (
          <Library
            profile={profile}
            onProfile={(next) => {
              if (generation === authGeneration.current) setProfile(next);
            }}
          />
        ) : (
          <main id="main" className="loading-page">
            <h1>Page not found</h1>
            <a href="/library" onClick={collectionLink}>
              Open your library
            </a>
          </main>
        )
      ) : (
        <Landing />
      )}
    </>
  );
}
function Landing() {
  return (
    <main id="main" className="landing">
      <div className="landing-copy">
        <p className="eyebrow">Photos. Stories. A little more life.</p>
        <h1>Keep your moments close.</h1>
        <p className="landing-lede">
          A place for the photos and videos you want to come back to. Begin with
          a moment. Keep adding as life unfolds.
        </p>
        <a href="/auth/google" className="button primary google-link">
          <span aria-hidden="true" className="google-mark">
            G
          </span>
          Continue with Google<span aria-hidden="true">↗</span>
        </a>
        <p className="privacy-copy">
          Your library starts private. Your memories stay yours.
        </p>
      </div>
      <div className="landing-art" aria-hidden="true">
        <div className="paper paper-one">
          <div className="landscape">
            <span className="sun" />
            <span className="ridge ridge-back" />
            <span className="ridge ridge-front" />
          </div>
          <span className="paper-caption">The places we return to</span>
        </div>
        <div className="paper paper-two">
          <div className="still-life">
            <span />
            <span />
            <span />
          </div>
          <span className="paper-caption">The small things, too</span>
        </div>
        <span className="art-note">Collected, with care.</span>
      </div>
      <div className="landing-footer">
        <span>ONE MOMENT AT A TIME</span>
        <span>Ages — a living library</span>
      </div>
    </main>
  );
}
function query(filter: string, next?: string) {
  const params = new URLSearchParams({ limit: "30" });
  if (filter) params.set("tag", filter);
  if (next) params.set("cursor", next);
  return `/api/assets?${params}`;
}

function Library({
  profile,
  onProfile,
}: {
  profile: Profile;
  onProfile: (profile: Profile) => void;
}) {
  const initialTag =
    new URLSearchParams(window.location.search).get("tag") ?? "";
  const [libraryRequest, setLibraryRequest] = useState({ tag: initialTag });
  const tag = libraryRequest.tag;
  const [filterInput, setFilterInput] = useState(initialTag);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<LibraryAsset | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [quotaNotice, setQuotaNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoading(true);
    setError("");
    setSelected(new Set());
    api<LibraryPage>(query(libraryRequest.tag), { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setAssets(page.assets);
        setCursor(page.next_cursor);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Fetching starts from the first page when the exact tag or refresh changes.
  }, [libraryRequest]);
  async function more() {
    const controller = pageRequest.current;
    if (!cursor || !controller || controller.signal.aborted) return;
    setLoading(true);
    setError("");
    try {
      const page = await api<LibraryPage>(query(tag, cursor), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setAssets((current) => [
        ...current,
        ...page.assets.filter(
          (asset) => !current.some((row) => row.id === asset.id),
        ),
      ]);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  function applyFilter(value: string) {
    const next = value;
    setAssets([]);
    setCursor(null);
    setLibraryRequest({ tag: next });
    setFilterInput(next);
    const url = new URL(window.location.href);
    url.pathname = "/library";
    if (next) url.searchParams.set("tag", next);
    else url.searchParams.delete("tag");
    window.history.replaceState(null, "", url);
  }
  async function run(job: UploadJob) {
    const update = (change: Partial<UploadJob>) => {
      if (!mounted.current) return;
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id ? { ...item, ...change } : item,
        ),
      );
    };
    update({ phase: "uploading", message: "" });
    try {
      await uploadFile(job, update);
    } catch (reason) {
      update({ phase: "error", message: errorMessage(reason) });
      return;
    }
    if (!mounted.current) return;
    update({ phase: "saved", message: "Saved to your library" });
    setLibraryRequest((current) => ({ tag: current.tag }));
    try {
      const next = await api<Profile>("/api/me");
      if (!mounted.current) return;
      onProfile(next);
      setQuotaNotice("");
    } catch {
      if (!mounted.current) return;
      setQuotaNotice(
        "Storage display may be out of date. Refresh the page to update it.",
      );
    }
  }
  async function filesChosen(files: FileList | null) {
    if (!files?.length) return;
    const added = Array.from(files).map(
      (file): UploadJob => ({
        id: crypto.randomUUID(),
        file,
        phase: "waiting",
      }),
    );
    setJobs((current) => [
      ...current.filter((job) => job.phase !== "saved"),
      ...added,
    ]);
    setUploading(true);
    for (const job of added) {
      if (!mounted.current) return;
      await run(job);
    }
    if (!mounted.current) return;
    setUploading(false);
    if (input.current) input.current.value = "";
  }
  async function retry(job: UploadJob) {
    setUploading(true);
    await run(job);
    if (mounted.current) setUploading(false);
  }
  function saved(asset: LibraryAsset) {
    if (!mounted.current) return;
    setAssets((current) =>
      current.map((row) => (row.id === asset.id ? asset : row)),
    );
    setLibraryRequest((current) => ({ tag: current.tag }));
  }
  const quota = profile.quota;
  const progress = Math.min(
    100,
    ((quota.storage_used_bytes + quota.storage_reserved_bytes) /
      Math.max(1, quota.storage_limit_bytes)) *
      100,
  );
  return (
    <main id="main" className="library-page">
      <section className="library-intro">
        <div>
          <p className="eyebrow">Collected over time</p>
          <h1>Your library</h1>
          <p className="intro-copy">
            The big days. The ordinary ones. All worth keeping.
          </p>
        </div>
        <div className="upload-control">
          <label
            className={`button primary upload-label ${uploading ? "disabled" : ""}`}
            htmlFor="choose-files"
          >
            <span aria-hidden="true">＋</span>Add moments
          </label>
          <input
            ref={input}
            className="file-input"
            id="choose-files"
            type="file"
            aria-label="Choose photos or videos"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
            multiple
            disabled={uploading}
            onChange={(event) => void filesChosen(event.target.files)}
          />
          <span className="upload-help">
            Photos up to 25 MB · videos up to 250 MB
          </span>
        </div>
      </section>
      <div className="library-layout">
        <aside className="library-sidebar">
          <div className="sidebar-current">
            <span aria-hidden="true">▧</span>All moments
            <span className="sidebar-dot" aria-hidden="true" />
          </div>
          <form
            className="filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilter(filterInput);
            }}
          >
            <label htmlFor="tag-filter">Filter by tag</label>
            <input
              ref={filter}
              id="tag-filter"
              type="text"
              value={filterInput}
              maxLength={64}
              placeholder="Find a familiar thread"
              onChange={(event) => setFilterInput(event.target.value)}
            />
            <button className="button secondary" type="submit">
              Apply filter
            </button>
            {tag ? (
              <button
                className="text-button"
                type="button"
                onClick={() => applyFilter("")}
              >
                Clear filter
              </button>
            ) : null}
            <p className="field-help">
              Tags match exactly, including spaces and capitals.
            </p>
          </form>
          <div className="storage-card">
            <span className="eyebrow">Your space</span>
            <p>
              {bytesLabel(quota.storage_used_bytes)}{" "}
              <span>of {bytesLabel(quota.storage_limit_bytes)}</span>
            </p>
            <progress
              value={progress}
              max={100}
              aria-label="Storage used including pending uploads"
            />
            {quota.storage_reserved_bytes > 0 ? (
              <p className="field-help">
                {bytesLabel(quota.storage_reserved_bytes)} reserved for pending
                uploads
              </p>
            ) : (
              <p className="field-help">A little room for what comes next.</p>
            )}
            {quotaNotice ? (
              <p role="status" className="field-help">
                {quotaNotice}
              </p>
            ) : null}
          </div>
          <p className="sidebar-note">
            Each moment is private.
            <br />
            Keep adding, at your own pace.
          </p>
        </aside>
        <section className="collection" aria-label="Library moments">
          <div className="collection-heading">
            <h2>{tag ? `Tagged “${tag}”` : "All moments"}</h2>
            <span>
              {assets.length} {assets.length === 1 ? "moment" : "moments"}
              {cursor ? " shown" : ""}
            </span>
          </div>
          {jobs.length ? (
            <section className="upload-list" aria-label="Uploads">
              {jobs.map((job) => (
                <div className="upload-row" key={job.id}>
                  <div>
                    <strong>{job.file.name}</strong>
                    <p
                      role={job.phase === "error" ? "alert" : "status"}
                      className={job.phase === "error" ? "error" : "field-help"}
                    >
                      {job.message ||
                        {
                          waiting: "Waiting…",
                          uploading: "Uploading directly to storage…",
                          checking: "Checking your upload…",
                          saved: "Saved",
                          error: "Upload interrupted",
                        }[job.phase]}
                    </p>
                  </div>
                  {job.phase === "error" ? (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={uploading}
                      onClick={() => void retry(job)}
                      aria-label={`Retry ${job.file.name}`}
                    >
                      Retry
                    </button>
                  ) : job.phase === "saved" ? (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Dismiss ${job.file.name}`}
                      onClick={() =>
                        setJobs((current) =>
                          current.filter((item) => item.id !== job.id),
                        )
                      }
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
          {selected.size > 0 ? (
            <div className="selection-bar">
              <p role="status">{selected.size} selected</p>
              <button
                type="button"
                className="text-button"
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="collection-error">
              <p role="alert" className="error">
                {error}
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={() => setLibraryRequest({ tag })}
              >
                Retry library
              </button>
            </div>
          ) : null}
          {!loading && !error && assets.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">＋</span>
              <h3>
                {tag
                  ? "No moments with this tag yet"
                  : "A beginning, waiting for you"}
              </h3>
              <p>
                {tag
                  ? "Try another tag or clear the filter to see your library."
                  : "Add a photo or a video. It doesn’t have to be a special occasion."}
              </p>
              {tag ? (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => applyFilter("")}
                >
                  Show all moments
                </button>
              ) : (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => input.current?.click()}
                >
                  Choose a first moment
                </button>
              )}
            </div>
          ) : null}
          <div className="asset-grid">
            {assets.map((asset) => (
              <article
                className={`asset-card ${selected.has(asset.id) ? "selected" : ""}`}
                key={asset.id}
              >
                <div className="card-media">
                  <button
                    className="open-asset"
                    type="button"
                    aria-label={`Open ${asset.original_name}`}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setDetails(asset);
                    }}
                  >
                    {asset.kind === "image" ? (
                      <img
                        src={mediaUrl(asset)}
                        alt={asset.original_name}
                        loading="lazy"
                      />
                    ) : (
                      <>
                        <video
                          src={mediaUrl(asset)}
                          preload="metadata"
                          aria-label={asset.original_name}
                        >
                          <track kind="captions" />
                        </video>
                        <span className="video-label">Video</span>
                      </>
                    )}
                  </button>
                  <label className="select-asset">
                    <input
                      type="checkbox"
                      aria-label={`Select ${asset.original_name}`}
                      checked={selected.has(asset.id)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(asset.id);
                          else next.delete(asset.id);
                          return next;
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="card-caption">
                  <h3>{asset.original_name}</h3>
                  <span>{bytesLabel(asset.size_bytes)}</span>
                </div>
                {asset.tags.length ? (
                  <div className="card-tags">
                    {asset.tags.map((value) => (
                      <button
                        type="button"
                        key={value}
                        onClick={() => applyFilter(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="card-private">
                    Private · {asset.kind === "image" ? "Photo" : "Video"}
                  </p>
                )}
              </article>
            ))}
          </div>
          {loading ? (
            <p role="status" className="collection-loading">
              Loading moments…
            </p>
          ) : cursor ? (
            <button
              className="button secondary load-more"
              type="button"
              onClick={() => void more()}
            >
              Load more moments
            </button>
          ) : assets.length > 0 ? (
            <p className="collection-end">A little piece of life, kept.</p>
          ) : null}
        </section>
      </div>
      {details ? (
        <AssetDetails
          key={details.id}
          asset={details}
          onSaved={saved}
          onClose={() => {
            setDetails(null);
            if (opener.current?.isConnected) opener.current.focus();
            else filter.current?.focus();
          }}
        />
      ) : null}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
