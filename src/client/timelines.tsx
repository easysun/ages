import { useCallback, useEffect, useRef, useState } from "react";
import type { timelinePayload } from "../timeline/model";
import type { EventAt } from "../timeline/validation";
import {
  api,
  errorMessage,
  jsonBody,
  type LibraryAsset,
  type LibraryPage,
  mediaUrl,
  RequestError,
} from "./api";
import { StoryViewport } from "./story-viewport";

type Summary = Omit<ReturnType<typeof timelinePayload>, "items">;
type Item = NonNullable<ReturnType<typeof timelinePayload>["items"]>[number];
type Story = Summary & { items: Item[] };
type Page = { timelines: Summary[]; next_cursor: string | null };
type Navigate = (path: string) => void;

export function TimelineScreen({
  id,
  navigate,
}: {
  id?: string;
  navigate: Navigate;
}) {
  return id ? (
    <TimelineEditor key={id} id={id} />
  ) : (
    <TimelineList navigate={navigate} />
  );
}
function TimelineList({ navigate }: { navigate: Navigate }) {
  const [stories, setStories] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [request, setRequest] = useState({ path: "/api/timelines?limit=30" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Page>(request.path, { signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted) {
          setStories(page.timelines);
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
  }, [request]);
  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const result = await api<{ timeline: Story }>("/api/timelines", {
        method: "POST",
        ...jsonBody({ title }),
      });
      if (live.current)
        navigate(`/timelines/${encodeURIComponent(result.timeline.id)}`);
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      if (live.current) setCreating(false);
    }
  }
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await api<Page>(
        `/api/timelines?limit=30&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!live.current) return;
      setStories((current) => [
        ...current,
        ...page.timelines.filter(
          (row) => !current.some((item) => item.id === row.id),
        ),
      ]);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (live.current) setError(errorMessage(reason));
    } finally {
      if (live.current) setLoading(false);
    }
  }
  return (
    <main id="main" className="timeline-page">
      <div className="timeline-intro">
        <p className="eyebrow">A story that keeps growing</p>
        <h1>Your timelines</h1>
        <p>Bring moments together. Describe them. Keep adding.</p>
      </div>
      <form className="timeline-create" onSubmit={create}>
        <label htmlFor="new-timeline-title">New timeline title</label>
        <input
          id="new-timeline-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
          placeholder="A summer, a place, a life…"
        />
        <button className="button primary" disabled={creating} type="submit">
          {creating ? "Creating…" : "Create timeline"}
        </button>
        <p className="field-help">
          New timelines are private. Your original media stays in your library.
        </p>
      </form>
      {error ? (
        <div className="error" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setRequest({ path: "/api/timelines?limit=30" })}
          >
            Retry timelines
          </button>
        </div>
      ) : null}
      <div className="timeline-list">
        {stories.map((story) => (
          <a
            key={story.id}
            className="timeline-tile"
            href={`/timelines/${encodeURIComponent(story.id)}`}
            onClick={(event) => {
              if (
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigate(event.currentTarget.pathname);
            }}
          >
            <h2>{story.title}</h2>
            <span>
              {story.visibility === "private"
                ? "Private"
                : story.visibility === "unlisted"
                  ? "Anyone with the link"
                  : "Public"}
            </span>
          </a>
        ))}
      </div>
      {loading ? (
        <p role="status">Opening timelines…</p>
      ) : cursor ? (
        <button
          type="button"
          className="button secondary"
          onClick={() => void more()}
        >
          More timelines
        </button>
      ) : stories.length === 0 && !error ? (
        <p className="empty-state">Your first story starts with a moment.</p>
      ) : null}
    </main>
  );
}

function TimelineEditor({ id }: { id: string }) {
  const [story, setStory] = useState<Story | null>(null);
  const [assets, setAssets] = useState<Record<string, LibraryAsset>>({});
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [assetError, setAssetError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [request, setRequest] = useState({ id });
  const live = useRef(true);
  const writing = useRef(false);
  const current = useRef<Story | null>(null);
  const pickerOpener = useRef<HTMLButtonElement>(null);
  const receive = useCallback((next: Story) => {
    if (current.current && next.version < current.current.version) return;
    current.current = next;
    setStory(next);
  }, []);
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    setError("");
    api<{ timeline: Story }>(
      `/api/timelines/${encodeURIComponent(request.id)}`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) receive(result.timeline);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [request, receive]);
  useEffect(() => {
    const controller = new AbortController();
    setLibraryLoading(true);
    api<LibraryPage>("/api/assets?limit=100", { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setLibrary(page.assets);
        setCursor(page.next_cursor);
        setAssets(
          Object.fromEntries(page.assets.map((asset) => [asset.id, asset])),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setLibraryError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLibraryLoading(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const missing = [
      ...new Set([
        ...(story?.items.map((item) => item.asset_id) ?? []),
        ...(story?.cover_asset_id ? [story.cover_asset_id] : []),
      ]),
    ].filter((assetId) => !assets[assetId]);
    if (!missing.length) {
      setAssetError("");
      return;
    }
    setAssetError("");
    const controller = new AbortController();
    Promise.allSettled(
      missing.map((assetId) =>
        api<{ asset: LibraryAsset }>(
          `/api/assets/${encodeURIComponent(assetId)}`,
          { signal: controller.signal },
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      if (results.some((result) => result.status === "rejected"))
        setAssetError(
          "Some media details could not be loaded. Your story is still saved.",
        );
      const found = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.asset] : [],
      );
      if (found.length)
        setAssets((existing) => ({
          ...existing,
          ...Object.fromEntries(found.map((asset) => [asset.id, asset])),
        }));
    });
    return () => controller.abort();
  }, [story, assets]);
  async function libraryPage(next?: string) {
    if (libraryLoading) return;
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const page = await api<LibraryPage>(
        `/api/assets?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      if (!live.current) return;
      setLibrary((existing) =>
        next
          ? [
              ...existing,
              ...page.assets.filter(
                (row) => !existing.some((item) => item.id === row.id),
              ),
            ]
          : page.assets,
      );
      setCursor(page.next_cursor);
      setAssets((existing) => ({
        ...existing,
        ...Object.fromEntries(page.assets.map((asset) => [asset.id, asset])),
      }));
    } catch (reason) {
      if (live.current) setLibraryError(errorMessage(reason));
    } finally {
      if (live.current) setLibraryLoading(false);
    }
  }
  async function mutation(
    path: string,
    method: string,
    change: Record<string, unknown>,
  ) {
    if (writing.current || !current.current) return false;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ timeline: Story }>(
        `/api/timelines/${encodeURIComponent(id)}${path}`,
        {
          method,
          ...jsonBody({ expected_version: current.current.version, ...change }),
        },
      );
      if (!live.current) return false;
      receive(result.timeline);
      return true;
    } catch (reason) {
      if (!live.current) return false;
      if (reason instanceof RequestError && reason.code === "CONFLICT") {
        try {
          const result = await api<{ timeline: Story }>(
            `/api/timelines/${encodeURIComponent(id)}`,
          );
          if (!live.current) return false;
          receive(result.timeline);
          setError(
            "This timeline changed elsewhere. The latest story is loaded and your unsaved drafts are kept. Review them and try again.",
          );
        } catch (refreshError) {
          if (live.current)
            setError(
              `The timeline changed elsewhere. ${errorMessage(refreshError)} Retry loading before saving again.`,
            );
        }
      } else setError(errorMessage(reason));
      return false;
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function append(ids: string[]) {
    const added: string[] = [];
    for (const assetId of ids) {
      if (
        !live.current ||
        !(await mutation("/items", "POST", { asset_id: assetId }))
      )
        return added;
      added.push(assetId);
    }
    if (live.current) {
      setNotice(
        `${added.length} ${added.length === 1 ? "moment" : "moments"} added`,
      );
    }
    return added;
  }
  async function move(index: number, direction: number) {
    const next = current.current?.items.map((item) => item.id);
    if (!next?.[index] || !next[index + direction]) return;
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + direction, 0, item);
    if (await mutation("/order", "PUT", { item_ids: next }))
      setNotice("Story order saved");
  }
  if (!story)
    return (
      <main id="main" className="timeline-page">
        {error ? (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={() => setRequest({ id })}
            >
              Retry timeline
            </button>
          </>
        ) : (
          <p role="status">Opening your story…</p>
        )}
      </main>
    );
  return (
    <main id="main" className="timeline-page">
      <div className="timeline-intro editor-intro">
        <div>
          <p className="eyebrow">
            Living timeline ·{" "}
            {story.visibility === "private"
              ? "Private"
              : story.visibility === "unlisted"
                ? "Anyone with the link"
                : "Public"}
          </p>
          <h1>{story.title}</h1>
          <p>{story.items.length} moments, with more to come.</p>
        </div>
        <button
          className="button primary"
          type="button"
          ref={pickerOpener}
          onClick={() => setPicker(true)}
        >
          Add moments
        </button>
      </div>
      {error ? (
        <div className="error editor-notice" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setRequest({ id })}
          >
            Reload timeline
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="editor-notice">
          {notice}
        </p>
      ) : null}
      {assetError ? (
        <div role="alert" className="error editor-notice">
          {assetError}
          <button
            type="button"
            className="text-button"
            onClick={() => setAssets((existing) => ({ ...existing }))}
          >
            Retry media details
          </button>
        </div>
      ) : null}
      <StoryViewport positions={story.items.map((item) => item.position)} />
      <div className="editor-layout">
        <div className="story-items">
          {story.items.length ? (
            <ol>
              {story.items.map((item, index) => (
                <li key={item.id}>
                  <Moment
                    item={item}
                    index={index}
                    asset={assets[item.asset_id]}
                    busy={busy}
                    last={index === story.items.length - 1}
                    save={(change) =>
                      mutation(
                        `/items/${encodeURIComponent(item.id)}`,
                        "PATCH",
                        change,
                      )
                    }
                    move={(direction) => move(index, direction)}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-state">
              <h2>A first moment, then another.</h2>
              <p>Choose photos or videos from your private library to begin.</p>
            </div>
          )}
        </div>
        <aside className="story-settings">
          <Settings
            story={story}
            assets={Object.values(assets)}
            busy={busy}
            save={(change) => mutation("", "PATCH", change)}
          />
          <ShareLink id={id} visibility={story.visibility} />
        </aside>
      </div>
      {picker ? (
        <LibraryPicker
          assets={library}
          loading={libraryLoading}
          error={libraryError}
          writeError={error}
          busy={busy}
          cursor={cursor}
          more={() => void libraryPage(cursor ?? undefined)}
          retry={() => void libraryPage()}
          append={append}
          close={() => {
            setPicker(false);
            if (pickerOpener.current?.isConnected) pickerOpener.current.focus();
          }}
        />
      ) : null}
    </main>
  );
}

function Moment({
  item,
  index,
  asset,
  busy,
  last,
  save,
  move,
}: {
  item: Item;
  index: number;
  asset?: LibraryAsset;
  busy: boolean;
  last: boolean;
  save: (change: Record<string, unknown>) => Promise<boolean>;
  move: (direction: number) => Promise<void>;
}) {
  const [caption, setCaption] = useState(item.caption);
  const [captionDirty, setCaptionDirty] = useState(false);
  const [dateDirty, setDateDirty] = useState(false);
  const [kind, setKind] = useState<"none" | "date" | "instant">(
    item.event_at?.kind ?? "none",
  );
  const [date, setDate] = useState(
    item.event_at?.kind === "date" ? item.event_at.date : "",
  );
  const [instant, setInstant] = useState(
    item.event_at?.kind === "instant" ? item.event_at.instant : "",
  );
  const [zone, setZone] = useState(
    item.event_at?.time_zone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!captionDirty) setCaption(item.caption);
  }, [item.caption, captionDirty]);
  useEffect(() => {
    if (dateDirty) return;
    setKind(item.event_at?.kind ?? "none");
    setDate(item.event_at?.kind === "date" ? item.event_at.date : "");
    setInstant(item.event_at?.kind === "instant" ? item.event_at.instant : "");
    setZone(
      item.event_at?.time_zone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }, [item.event_at, dateDirty]);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const eventAt: EventAt | null =
      kind === "date"
        ? { kind, date, time_zone: zone, calendar: "iso8601" }
        : kind === "instant"
          ? { kind, instant, time_zone: zone }
          : null;
    if (await save({ caption, event_at: eventAt })) {
      setCaptionDirty(false);
      setDateDirty(false);
      setNotice("Moment saved");
    }
  }
  const field = `item-${item.id}`;
  return (
    <fieldset className="moment" aria-label={`Moment ${index + 1}`}>
      <legend>Moment {index + 1}</legend>
      <div className="moment-media">
        {asset?.kind === "image" ? (
          <img src={mediaUrl(asset)} alt={asset.original_name} loading="lazy" />
        ) : asset?.kind === "video" ? (
          <video
            src={mediaUrl(asset)}
            controls
            preload="none"
            aria-label={asset.original_name}
          >
            <track kind="captions" />
          </video>
        ) : (
          <p>Loading this moment’s media…</p>
        )}
      </div>
      <div className="moment-content">
        <h2>{asset?.original_name ?? "Library moment"}</h2>
        <p className="field-help">
          This caption and date belong to this story. The original media stays
          unchanged.
        </p>
        <form onSubmit={submit}>
          <label htmlFor={`${field}-caption`}>Caption</label>
          <textarea
            id={`${field}-caption`}
            value={caption}
            maxLength={10000}
            rows={3}
            onChange={(event) => {
              setCaption(event.target.value);
              setCaptionDirty(true);
              setNotice("");
            }}
          />
          <div className="event-fields">
            <div>
              <label htmlFor={`${field}-kind`}>Date type</label>
              <select
                id={`${field}-kind`}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                  setDateDirty(true);
                  setNotice("");
                }}
              >
                <option value="none">No event date</option>
                <option value="date">Calendar date</option>
                <option value="instant">Exact time</option>
              </select>
            </div>
            {kind === "date" ? (
              <div>
                <label htmlFor={`${field}-date`}>Event date</label>
                <input
                  id={`${field}-date`}
                  type="date"
                  value={date}
                  required
                  onChange={(event) => {
                    setDate(event.target.value);
                    setDateDirty(true);
                  }}
                />
              </div>
            ) : kind === "instant" ? (
              <div>
                <label htmlFor={`${field}-instant`}>Event instant</label>
                <input
                  id={`${field}-instant`}
                  value={instant}
                  required
                  placeholder="2026-10-04T10:30:00+08:00"
                  onChange={(event) => {
                    setInstant(event.target.value);
                    setDateDirty(true);
                  }}
                />
              </div>
            ) : null}
            {kind !== "none" ? (
              <div>
                <label htmlFor={`${field}-zone`}>Time zone</label>
                <input
                  id={`${field}-zone`}
                  value={zone}
                  required
                  maxLength={100}
                  placeholder="Asia/Taipei"
                  onChange={(event) => {
                    setZone(event.target.value);
                    setDateDirty(true);
                  }}
                />
              </div>
            ) : null}
          </div>
          {kind === "instant" ? (
            <p className="field-help">
              Use an ISO timestamp with an explicit offset. The named time zone
              controls presentation.
            </p>
          ) : null}
          <div className="moment-actions">
            <button className="button secondary" type="submit" disabled={busy}>
              Save moment
            </button>
            {notice ? <p role="status">{notice}</p> : null}
          </div>
        </form>
        <div className="order-actions">
          <button
            className="text-button"
            type="button"
            disabled={busy || index === 0}
            onClick={() => void move(-1)}
          >
            Move earlier
          </button>
          <button
            className="text-button"
            type="button"
            disabled={busy || last}
            onClick={() => void move(1)}
          >
            Move later
          </button>
        </div>
      </div>
    </fieldset>
  );
}

function Settings({
  story,
  assets,
  busy,
  save,
}: {
  story: Story;
  assets: LibraryAsset[];
  busy: boolean;
  save: (change: Record<string, unknown>) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(story.title);
  const [visibility, setVisibility] = useState(story.visibility);
  const [cover, setCover] = useState(story.cover_asset_id ?? "");
  const [dirty, setDirty] = useState({
    title: false,
    visibility: false,
    cover: false,
  });
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!dirty.title) setTitle(story.title);
    if (!dirty.visibility) setVisibility(story.visibility);
    if (!dirty.cover) setCover(story.cover_asset_id ?? "");
  }, [story.title, story.visibility, story.cover_asset_id, dirty]);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const change = {
      ...(dirty.title ? { title } : {}),
      ...(dirty.visibility ? { visibility } : {}),
      ...(dirty.cover ? { cover_asset_id: cover || null } : {}),
    };
    if (!Object.keys(change).length) {
      setNotice("Timeline is up to date");
      return;
    }
    if (await save(change)) {
      setDirty({ title: false, visibility: false, cover: false });
      setNotice("Timeline saved");
    }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <h2>About this story</h2>
      <label htmlFor="story-title">Timeline title</label>
      <input
        id="story-title"
        value={title}
        maxLength={200}
        required
        onChange={(event) => {
          setTitle(event.target.value);
          setDirty((value) => ({ ...value, title: true }));
        }}
      />
      <label htmlFor="story-cover">Cover</label>
      <select
        id="story-cover"
        value={cover}
        onChange={(event) => {
          setCover(event.target.value);
          setDirty((value) => ({ ...value, cover: true }));
        }}
      >
        <option value="">No cover</option>
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.original_name}
          </option>
        ))}
      </select>
      <label htmlFor="story-visibility">Visibility</label>
      <select
        id="story-visibility"
        value={visibility}
        onChange={(event) => {
          setVisibility(event.target.value as typeof visibility);
          setDirty((value) => ({ ...value, visibility: true }));
        }}
      >
        <option value="private">Private</option>
        <option value="unlisted">Anyone with the link</option>
        <option value="public">Public</option>
      </select>
      <p className="field-help">
        Private is only for you. Anyone with the link can view an unlisted
        story; it asks search engines not to index it. Public stories permit
        indexing.
      </p>
      <button type="submit" className="button secondary" disabled={busy}>
        Save timeline
      </button>
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  );
}

function ShareLink({
  id,
  visibility,
}: {
  id: string;
  visibility: Story["visibility"];
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [request, setRequest] = useState({
    path: `/t/${encodeURIComponent(id)}`,
  });
  useEffect(() => {
    setUrl("");
    setError("");
    if (visibility === "private") return;
    const controller = new AbortController();
    const path = request.path;
    fetch(path, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer unavailable");
        const html = await response.text();
        const value = new DOMParser()
          .parseFromString(html, "text/html")
          .querySelector('link[rel="canonical"]')
          ?.getAttribute("href");
        if (!value) throw new Error("Canonical link unavailable");
        const canonical = new URL(value);
        if (
          !["http:", "https:"].includes(canonical.protocol) ||
          canonical.pathname !== path ||
          canonical.search ||
          canonical.hash ||
          canonical.username ||
          canonical.password
        )
          throw new Error("Invalid canonical link");
        if (!controller.signal.aborted) setUrl(canonical.href);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The share link could not be loaded. Please retry.");
      });
    return () => controller.abort();
  }, [visibility, request]);
  return (
    <section className="share-panel" aria-label="Share timeline">
      <h2>Keep the story going</h2>
      {visibility === "private" ? (
        <p>This story is private. Choose “Anyone with the link” to share it.</p>
      ) : error ? (
        <>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            className="button secondary"
            type="button"
            onClick={() => setRequest({ path: `/t/${encodeURIComponent(id)}` })}
          >
            Retry share link
          </button>
        </>
      ) : url ? (
        <>
          <label htmlFor="canonical-share-link">Share URL</label>
          <input
            id="canonical-share-link"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <a className="text-button" href={url}>
            Open shared timeline
          </a>
          <p className="field-help">
            This link stays the same when you add more moments.
          </p>
        </>
      ) : (
        <p role="status">Loading share link…</p>
      )}
    </section>
  );
}

function LibraryPicker({
  assets,
  loading,
  error,
  writeError,
  busy,
  cursor,
  more,
  retry,
  append,
  close,
}: {
  assets: LibraryAsset[];
  loading: boolean;
  error: string;
  writeError: string;
  busy: boolean;
  cursor: string | null;
  more: () => void;
  retry: () => void;
  append: (ids: string[]) => Promise<string[]>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismissed = useRef(false);
  const mounted = useRef(true);
  const [selected, setSelected] = useState(new Set<string>());
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  function notifyDismissal() {
    if (dismissed.current || !mounted.current) return;
    dismissed.current = true;
    close();
  }
  function dismiss() {
    dialog.current?.close();
    notifyDismissal();
  }
  async function add() {
    setAdding(true);
    const ids = [...selected];
    const added = await append(ids);
    if (!mounted.current) return;
    setSelected(
      (current) => new Set([...current].filter((id) => !added.includes(id))),
    );
    setAdding(false);
    if (added.length === ids.length && added.length > 0) dismiss();
  }
  return (
    <dialog
      ref={dialog}
      className="detail-dialog moment-picker"
      aria-labelledby="picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!adding) dismiss();
      }}
      onClose={notifyDismissal}
    >
      <div className="detail-header">
        <h2 id="picker-title">Add moments</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close moment picker"
          disabled={adding}
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      <p>
        Your private library. Reuse media without copying it; each story has its
        own captions and dates.
      </p>
      {error ? (
        <div role="alert" className="error">
          {error}
          <button type="button" className="text-button" onClick={retry}>
            Retry library
          </button>
        </div>
      ) : null}
      {writeError ? (
        <div role="alert" className="error">
          {writeError}
          <button type="button" className="text-button" onClick={retry}>
            Refresh library
          </button>
        </div>
      ) : null}
      <div className="picker-grid">
        {assets.map((asset) => (
          <label key={asset.id} className="picker-card">
            <input
              type="checkbox"
              aria-label={`Select ${asset.original_name}`}
              checked={selected.has(asset.id)}
              disabled={adding}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(asset.id);
                  else next.delete(asset.id);
                  return next;
                })
              }
            />
            {asset.kind === "image" ? (
              <img
                src={mediaUrl(asset)}
                alt={asset.original_name}
                loading="lazy"
              />
            ) : (
              <span className="picker-video">Video</span>
            )}
            <span>{asset.original_name}</span>
          </label>
        ))}
      </div>
      {loading ? (
        <p role="status">Loading library…</p>
      ) : cursor ? (
        <button type="button" className="button secondary" onClick={more}>
          More library moments
        </button>
      ) : !assets.length && !error ? (
        <p>Your library is empty. Add photos or videos in Library first.</p>
      ) : null}
      <div className="picker-actions">
        <p>{selected.size} selected</p>
        {selected.size > 0 ? (
          <button
            type="button"
            className="text-button"
            disabled={adding}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        ) : null}
        <button
          type="button"
          className="button primary"
          disabled={!selected.size || adding || busy}
          onClick={() => void add()}
        >
          {adding ? "Adding moments…" : "Add selected moments"}
        </button>
      </div>
    </dialog>
  );
}
