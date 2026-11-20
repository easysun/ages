import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  bytesLabel,
  errorMessage,
  jsonBody,
  type LibraryAsset,
  type LibraryPage,
  mediaUrl,
  type Profile,
  RequestError,
} from "./api";
import { ContentNodesScreen } from "./content-nodes";
import { AssetDetails } from "./details";
import { type Locale, LocaleProvider, useLocale } from "./i18n";
import { LinksScreen } from "./links";
import { LocalSignIn } from "./local-sign-in";
import { ModerationScreen } from "./moderation";
import { ReporterScreen } from "./reporter";
import { TimelineScreen } from "./timelines";
import { TrackingSettingsScreen } from "./tracking-settings";
import { type UploadJob, uploadFile } from "./upload";
import "./styles.css";

function Brand() {
  const { t } = useLocale();
  return (
    <a href="/" className="brand" aria-label={t("home")}>
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
  const { locale, setLocale, t } = useLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [profileRequest, setProfileRequest] = useState({ path: "/api/me" });
  const authGeneration = useRef(0);
  const [authGenerationRevision, setAuthGenerationRevision] = useState(0);
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
          setError(errorMessage(reason, localeRef.current));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [profileRequest]);
  async function logout() {
    setLogoutError("");
    authGeneration.current++;
    setAuthGenerationRevision(authGeneration.current);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error();
      setProfile(null);
    } catch {
      setLogoutError(t("logoutError"));
    }
  }
  const generation = authGenerationRevision;
  return (
    <>
      <a className="skip-link" href="#main">
        {t("skip")}
      </a>
      <header className="site-header">
        <Brand />
        <span className="header-note">{t("headerNote")}</span>
        {profile ? (
          <div className="account">
            <span>{profile.user.display_name ?? profile.user.email}</span>
            <button type="button" className="text-button" onClick={logout}>
              {t("signOut")}
            </button>
          </div>
        ) : (
          <span className="private-label">{t("privateLabel")}</span>
        )}
        <label className="locale-selector">
          <span className="sr-only">Language / 語言</span>
          <select
            aria-label="Language / 語言"
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="en">English</option>
            <option value="zh-Hant">繁體中文</option>
          </select>
        </label>
      </header>
      {logoutError ? (
        <p className="error logout-notice" role="alert">
          {logoutError}
        </p>
      ) : null}
      {profile ? (
        <nav className="client-nav" aria-label={t("navigation")}>
          <a
            href="/library"
            onClick={collectionLink}
            aria-current={
              path === "/library" || path === "/" ? "page" : undefined
            }
          >
            {t("library")}
          </a>
          <a
            href="/timelines"
            onClick={collectionLink}
            aria-current={path.startsWith("/timelines") ? "page" : undefined}
          >
            {t("timelines")}
          </a>
          <a
            href="/content"
            onClick={collectionLink}
            aria-current={path === "/content" ? "page" : undefined}
          >
            {t("content")}
          </a>
          <a
            href="/links"
            onClick={collectionLink}
            aria-current={path === "/links" ? "page" : undefined}
          >
            {t("links")}
          </a>
          <a
            href="/settings/tracking"
            onClick={collectionLink}
            aria-current={path === "/settings/tracking" ? "page" : undefined}
          >
            {t("tracking")}
          </a>
          <a
            href="/pricing"
            onClick={collectionLink}
            aria-current={path === "/pricing" ? "page" : undefined}
          >
            {t("plans")}
          </a>
          {profile.user.plan === "admin" ? (
            <a
              href="/admin/reports"
              onClick={collectionLink}
              aria-current={path === "/admin/reports" ? "page" : undefined}
            >
              {t("moderation")}
            </a>
          ) : null}
        </nav>
      ) : null}
      {loading ? (
        <main id="main" className="loading-page">
          <p role="status">{t("opening")}</p>
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
            {t("retry")}
          </button>
        </main>
      ) : path === "/pricing" ? (
        <Pricing />
      ) : profile ? (
        path === "/report" ? (
          <ReporterScreen authenticated authGeneration={generation} />
        ) : path === "/admin/reports" ? (
          profile.user.plan === "admin" ? (
            <ModerationScreen authGeneration={generation} />
          ) : (
            <main id="main" className="loading-page">
              <h1>{t("accessDenied")}</h1>
              <p>{t("adminRequired")}</p>
            </main>
          )
        ) : path === "/timelines" || path.startsWith("/timelines/") ? (
          <TimelineScreen
            authGeneration={generation}
            id={
              path === "/timelines"
                ? undefined
                : path.slice("/timelines/".length)
            }
            navigate={navigate}
          />
        ) : path === "/links" ? (
          <LinksScreen authGeneration={generation} />
        ) : path === "/content" ? (
          <ContentNodesScreen authGeneration={generation} />
        ) : path === "/settings/tracking" ? (
          <TrackingSettingsScreen authGeneration={generation} />
        ) : path === "/library" || path === "/" ? (
          <Library
            profile={profile}
            onProfile={(next) => {
              if (generation === authGeneration.current) setProfile(next);
            }}
          />
        ) : (
          <main id="main" className="loading-page">
            <h1>{t("notFound")}</h1>
            <a href="/library" onClick={collectionLink}>
              {t("openLibrary")}
            </a>
          </main>
        )
      ) : path === "/report" ? (
        <ReporterScreen authenticated={false} authGeneration={generation} />
      ) : (
        <Landing />
      )}
    </>
  );
}
function Landing() {
  const { t } = useLocale();
  return (
    <main id="main" className="landing">
      <div className="landing-copy">
        <p className="eyebrow">{t("landingEyebrow")}</p>
        <h1>{t("landingTitle")}</h1>
        <p className="landing-lede">{t("landingIntro")}</p>
        <a href="/auth/google" className="button primary google-link">
          <span aria-hidden="true" className="google-mark">
            G
          </span>
          {t("google")}
          <span aria-hidden="true">↗</span>
        </a>
        <p className="privacy-copy">{t("privateStart")}</p>
        <LocalSignIn />
        <a href="/pricing">{t("explorePlans")}</a>
        <a className="landing-report-link" href="/report">
          {t("reportLink")}
        </a>
      </div>
      <div className="landing-art" aria-hidden="true">
        <div className="paper paper-one">
          <div className="landscape">
            <span className="sun" />
            <span className="ridge ridge-back" />
            <span className="ridge ridge-front" />
          </div>
          <span className="paper-caption">{t("paperOne")}</span>
        </div>
        <div className="paper paper-two">
          <div className="still-life">
            <span />
            <span />
            <span />
          </div>
          <span className="paper-caption">{t("paperTwo")}</span>
        </div>
        <span className="art-note">{t("artNote")}</span>
      </div>
      <div className="landing-footer">
        <span>{t("landingFooter")}</span>
        <span>{t("livingLibrary")}</span>
      </div>
    </main>
  );
}
const proposedPlans = [
  { name: "Free", monthly: 0, supportFee: "20%" },
  { name: "Plus", monthly: 99, supportFee: "10%" },
  { name: "Creator", monthly: 299, supportFee: "5%" },
  { name: "Pro", monthly: 599, supportFee: "2.5%" },
] as const;

function Pricing() {
  const { locale } = useLocale();
  const zh = locale === "zh-Hant";
  return (
    <main id="main" className="loading-page pricing-page">
      <p className="eyebrow">{zh ? "Ages 測試版" : "Ages beta"}</p>
      <h1>{zh ? "為回憶選擇適合的方案" : "Plans for your memories"}</h1>
      <p>
        {zh
          ? "方案價格與創作者贊助費率仍在規劃中，付費訂閱與贊助功能尚未開放。"
          : "Plan prices and creator-support fees are proposals. Paid subscriptions and creator-support payments are not available yet."}
      </p>
      <section className="pricing-section" aria-labelledby="monthly-plans">
        <h2 id="monthly-plans">{zh ? "月繳方案" : "Monthly plans"}</h2>
        <p>
          {zh
            ? "月費為會員本人 Ages 方案的價格，金額以新臺幣顯示。"
            : "The monthly price is what a member would pay for their own Ages plan. Prices are shown in New Taiwan dollars."}
        </p>
        <table className="pricing-table">
          <caption>{zh ? "規劃中的月費" : "Proposed monthly prices"}</caption>
          <thead>
            <tr>
              <th className="pricing-table-header" scope="col">
                {zh ? "方案" : "Plan"}
              </th>
              <th className="pricing-table-header" scope="col">
                {zh ? "月費" : "Monthly price"}
              </th>
            </tr>
          </thead>
          <tbody>
            {proposedPlans.map(({ name, monthly }) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>
                  NT${monthly} {zh ? "/ 月" : "/ month"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {zh
            ? "方案功能、儲存空間上限及年費尚未定案。"
            : "Plan features, storage limits, and annual pricing have not been finalized."}
        </p>
      </section>
      <section className="pricing-section" aria-labelledby="support-fees">
        <h2 id="support-fees">
          {zh ? "創作者贊助費率" : "Creator-support fees"}
        </h2>
        <p>
          {zh
            ? "創作者贊助是粉絲支付給創作者的獨立款項，每筆贊助將依創作者的方案費率計收平台費。"
            : "Creator support is a separate payment from a fan to a creator. The platform fee would apply to each support payment at the rate for the creator’s plan."}
        </p>
        <table className="pricing-table">
          <caption>
            {zh
              ? "規劃中的創作者贊助平台費率"
              : "Proposed platform fees on creator support"}
          </caption>
          <thead>
            <tr>
              <th className="pricing-table-header" scope="col">
                {zh ? "創作者方案" : "Creator’s plan"}
              </th>
              <th className="pricing-table-header" scope="col">
                {zh ? "Ages 平台費率" : "Ages platform fee"}
              </th>
            </tr>
          </thead>
          <tbody>
            {proposedPlans.map(({ name, supportFee }) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{supportFee}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <a href="/library">{zh ? "返回 Ages" : "Return to Ages"}</a>
    </main>
  );
}
function query(filter: string, next?: string, trash = false) {
  const params = new URLSearchParams({ limit: "30" });
  if (filter && !trash) params.set("tag", filter);
  if (next) params.set("cursor", next);
  return `/api/assets${trash ? "/trash" : ""}?${params}`;
}

function Library({
  profile,
  onProfile,
}: {
  profile: Profile;
  onProfile: (profile: Profile) => void;
}) {
  const { locale } = useLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const zh = locale === "zh-Hant";
  const initialTag =
    new URLSearchParams(window.location.search).get("tag") ?? "";
  const initialTrash =
    new URLSearchParams(window.location.search).get("view") === "trash";
  const [libraryRequest, setLibraryRequest] = useState({
    tag: initialTag,
    trash: initialTrash,
  });
  const trash = libraryRequest.trash;
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
  const [notice, setNotice] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const trashTab = useRef<HTMLButtonElement>(null);
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
    api<LibraryPage>(
      query(libraryRequest.tag, undefined, libraryRequest.trash),
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setAssets(page.assets);
        setCursor(page.next_cursor);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(errorMessage(reason, localeRef.current));
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
      const page = await api<LibraryPage>(query(tag, cursor, trash), {
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
      if (!controller.signal.aborted)
        setError(errorMessage(reason, localeRef.current));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  function applyFilter(value: string) {
    const next = value;
    setAssets([]);
    setCursor(null);
    setLibraryRequest({ tag: next, trash: false });
    setFilterInput(next);
    const url = new URL(window.location.href);
    url.pathname = "/library";
    url.searchParams.delete("view");
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
      update({ phase: "error", message: errorMessage(reason, locale) });
      return;
    }
    if (!mounted.current) return;
    update({
      phase: "saved",
      message: zh ? "已儲存至素材庫" : "Saved to your library",
    });
    setLibraryRequest((current) => ({ ...current }));
    try {
      const next = await api<Profile>("/api/me");
      if (!mounted.current) return;
      onProfile(next);
      setQuotaNotice("");
    } catch {
      if (!mounted.current) return;
      setQuotaNotice(
        zh
          ? "儲存空間資訊可能不是最新狀態，請重新整理頁面。"
          : "Storage display may be out of date. Refresh the page to update it.",
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
    setLibraryRequest((current) => ({ ...current }));
  }
  function switchCollection(toTrash: boolean) {
    setAssets([]);
    setCursor(null);
    setError("");
    setNotice("");
    setLibraryRequest({ tag: "", trash: toTrash });
    setFilterInput("");
    const url = new URL(window.location.href);
    url.pathname = "/library";
    url.searchParams.delete("tag");
    if (toTrash) url.searchParams.set("view", "trash");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  }
  async function restore(asset: LibraryAsset) {
    const controller = pageRequest.current;
    setRestoring(asset.id);
    setError("");
    try {
      await api(`/api/assets/${encodeURIComponent(asset.id)}/restore`, {
        method: "POST",
        ...jsonBody({}),
      });
      if (!mounted.current || controller?.signal.aborted) return;
      setAssets((current) => current.filter((row) => row.id !== asset.id));
      setNotice(zh ? "時刻已還原至素材庫" : "Moment restored to your library");
      trashTab.current?.focus();
      setLibraryRequest((current) => ({ ...current }));
    } catch (reason) {
      if (mounted.current && !controller?.signal.aborted)
        setError(
          reason instanceof RequestError && reason.code === "CONFLICT"
            ? zh
              ? "無法還原此時刻，可能已超過還原期限或媒體無法使用。"
              : "This moment could not be restored. Its recovery window may have ended, or its media is unavailable."
            : errorMessage(reason, locale),
        );
    } finally {
      if (mounted.current) setRestoring(null);
    }
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
          <p className="eyebrow">
            {zh ? "日積月累的收藏" : "Collected over time"}
          </p>
          <h1>{zh ? "你的素材庫" : "Your library"}</h1>
          <p className="intro-copy">
            {zh
              ? "重要的日子、平凡的日常，都值得珍藏。"
              : "The big days. The ordinary ones. All worth keeping."}
          </p>
        </div>
        <div className="upload-control">
          <label
            className={`button primary upload-label ${uploading ? "disabled" : ""}`}
            htmlFor="choose-files"
          >
            <span aria-hidden="true">＋</span>
            {zh ? "新增時刻" : "Add moments"}
          </label>
          <input
            ref={input}
            className="file-input"
            id="choose-files"
            type="file"
            aria-label={zh ? "選擇照片或影片" : "Choose photos or videos"}
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
            multiple
            disabled={uploading}
            onChange={(event) => void filesChosen(event.target.files)}
          />
          <span className="upload-help">
            {zh
              ? "照片上限 25 MB · 影片上限 250 MB"
              : "Photos up to 25 MB · videos up to 250 MB"}
          </span>
        </div>
      </section>
      <div className="library-layout">
        <aside className="library-sidebar">
          <nav
            className="collection-switcher"
            aria-label={zh ? "素材庫分類" : "Library collections"}
          >
            <button
              type="button"
              className="button secondary"
              aria-pressed={!trash}
              onClick={() => switchCollection(false)}
            >
              {zh ? "所有時刻" : "All moments"}
            </button>
            <button
              ref={trashTab}
              type="button"
              className="button secondary"
              aria-pressed={trash}
              onClick={() => switchCollection(true)}
            >
              {zh ? "垃圾桶" : "Trash"}
            </button>
          </nav>
          {!trash ? (
            <form
              className="filter-form"
              onSubmit={(event) => {
                event.preventDefault();
                applyFilter(filterInput);
              }}
            >
              <label htmlFor="tag-filter">
                {zh ? "依標籤篩選" : "Filter by tag"}
              </label>
              <input
                ref={filter}
                id="tag-filter"
                type="text"
                value={filterInput}
                maxLength={64}
                placeholder={zh ? "尋找標籤" : "Find a familiar thread"}
                onChange={(event) => setFilterInput(event.target.value)}
              />
              <button className="button secondary" type="submit">
                {zh ? "套用篩選" : "Apply filter"}
              </button>
              {tag ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => applyFilter("")}
                >
                  {zh ? "清除篩選" : "Clear filter"}
                </button>
              ) : null}
              <p className="field-help">
                {zh
                  ? "標籤需完全相符，包含空格與大小寫。"
                  : "Tags match exactly, including spaces and capitals."}
              </p>
            </form>
          ) : (
            <p className="field-help">
              {zh
                ? "移至垃圾桶的時刻可在 30 天內還原，期間仍佔用儲存空間。"
                : "Moments can be restored for 30 days. Storage remains in use while they are in Trash."}
            </p>
          )}
          <div className="storage-card">
            <span className="eyebrow">{zh ? "你的空間" : "Your space"}</span>
            <p>
              {bytesLabel(quota.storage_used_bytes)}{" "}
              <span>
                {zh ? "共" : "of"} {bytesLabel(quota.storage_limit_bytes)}
              </span>
            </p>
            <progress
              value={progress}
              max={100}
              aria-label={
                zh
                  ? "已使用空間，包含待完成的上傳"
                  : "Storage used including pending uploads"
              }
            />
            {quota.storage_reserved_bytes > 0 ? (
              <p className="field-help">
                {bytesLabel(quota.storage_reserved_bytes)}{" "}
                {zh ? "保留給待完成的上傳" : "reserved for pending uploads"}
              </p>
            ) : (
              <p className="field-help">
                {zh
                  ? "為未來的回憶留點空間。"
                  : "A little room for what comes next."}
              </p>
            )}
            {quotaNotice ? (
              <p role="status" className="field-help">
                {quotaNotice}
              </p>
            ) : null}
          </div>
          <p className="sidebar-note">
            {zh ? "每個時刻預設為私人。" : "Each moment is private."}
            <br />
            {zh ? "照自己的步調繼續記錄。" : "Keep adding, at your own pace."}
          </p>
        </aside>
        <section
          className="collection"
          aria-label={zh ? "素材庫時刻" : "Library moments"}
        >
          <div className="collection-heading">
            <h2>
              {trash
                ? zh
                  ? "垃圾桶"
                  : "Trash"
                : tag
                  ? zh
                    ? `標籤「${tag}」`
                    : `Tagged “${tag}”`
                  : zh
                    ? "所有時刻"
                    : "All moments"}
            </h2>
            <span>
              {zh
                ? `已顯示 ${assets.length} 個時刻`
                : `${assets.length} ${assets.length === 1 ? "moment" : "moments"}${cursor ? " shown" : ""}`}
            </span>
          </div>
          {notice ? (
            <p role="status" className="notice">
              {notice}
            </p>
          ) : null}
          {jobs.length ? (
            <section
              className="upload-list"
              aria-label={zh ? "上傳項目" : "Uploads"}
            >
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
                          waiting: zh ? "等待中…" : "Waiting…",
                          uploading: zh
                            ? "正在上傳…"
                            : "Uploading directly to storage…",
                          checking: zh
                            ? "正在檢查上傳…"
                            : "Checking your upload…",
                          saved: zh ? "已儲存" : "Saved",
                          error: zh ? "上傳中斷" : "Upload interrupted",
                        }[job.phase]}
                    </p>
                  </div>
                  {job.phase === "error" ? (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={uploading}
                      onClick={() => void retry(job)}
                      aria-label={
                        zh
                          ? `重試上傳 ${job.file.name}`
                          : `Retry ${job.file.name}`
                      }
                    >
                      {zh ? "重試" : "Retry"}
                    </button>
                  ) : job.phase === "saved" ? (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={
                        zh
                          ? `關閉 ${job.file.name}`
                          : `Dismiss ${job.file.name}`
                      }
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
              <p role="status">
                {zh
                  ? `已選取 ${selected.size} 個項目`
                  : `${selected.size} selected`}
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => setSelected(new Set())}
              >
                {zh ? "清除選取" : "Clear selection"}
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
                onClick={() => setLibraryRequest((current) => ({ ...current }))}
              >
                {zh ? "重新載入素材庫" : "Retry library"}
              </button>
            </div>
          ) : null}
          {!loading && !error && assets.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">＋</span>
              <h3>
                {trash
                  ? zh
                    ? "垃圾桶是空的"
                    : "Trash is empty"
                  : tag
                    ? zh
                      ? "目前沒有這個標籤的時刻"
                      : "No moments with this tag yet"
                    : zh
                      ? "從這裡開始"
                      : "A beginning, waiting for you"}
              </h3>
              <p>
                {trash
                  ? zh
                    ? "移至垃圾桶的時刻會顯示在這裡。"
                    : "Moments you move to Trash will appear here."
                  : tag
                    ? zh
                      ? "試試其他標籤，或清除篩選以查看素材庫。"
                      : "Try another tag or clear the filter to see your library."
                    : zh
                      ? "新增照片或影片，平凡的日常也值得記錄。"
                      : "Add a photo or a video. It doesn’t have to be a special occasion."}
              </p>
              {trash ? null : tag ? (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => applyFilter("")}
                >
                  {zh ? "顯示所有時刻" : "Show all moments"}
                </button>
              ) : (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => input.current?.click()}
                >
                  {zh ? "選擇第一個時刻" : "Choose a first moment"}
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
                  {trash ? (
                    <div className="trash-placeholder" aria-hidden="true">
                      ↺
                    </div>
                  ) : (
                    <>
                      <button
                        className="open-asset"
                        type="button"
                        aria-label={
                          zh
                            ? `開啟 ${asset.original_name}`
                            : `Open ${asset.original_name}`
                        }
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
                            <span className="video-label">
                              {zh ? "影片" : "Video"}
                            </span>
                          </>
                        )}
                      </button>
                      <label className="select-asset">
                        <input
                          type="checkbox"
                          aria-label={
                            zh
                              ? `選取 ${asset.original_name}`
                              : `Select ${asset.original_name}`
                          }
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
                    </>
                  )}
                </div>
                <div className="card-caption">
                  <h3>{asset.original_name}</h3>
                  <span>{bytesLabel(asset.size_bytes)}</span>
                </div>
                {trash ? (
                  <div className="trash-card-actions">
                    <p className="field-help">
                      {zh ? "已移至垃圾桶" : "Moved to Trash"}{" "}
                      {asset.deleted_at
                        ? new Date(asset.deleted_at).toLocaleDateString(locale)
                        : ""}
                    </p>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={restoring !== null}
                      aria-label={
                        zh
                          ? `還原 ${asset.original_name}`
                          : `Restore ${asset.original_name}`
                      }
                      onClick={() => void restore(asset)}
                    >
                      {restoring === asset.id
                        ? zh
                          ? "還原中…"
                          : "Restoring…"
                        : zh
                          ? "還原"
                          : "Restore"}
                    </button>
                  </div>
                ) : asset.tags.length ? (
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
                    {zh ? "私人" : "Private"} ·{" "}
                    {asset.kind === "image"
                      ? zh
                        ? "照片"
                        : "Photo"
                      : zh
                        ? "影片"
                        : "Video"}
                  </p>
                )}
              </article>
            ))}
          </div>
          {loading ? (
            <p role="status" className="collection-loading">
              {zh ? "正在載入時刻…" : "Loading moments…"}
            </p>
          ) : cursor ? (
            <button
              className="button secondary load-more"
              type="button"
              onClick={() => void more()}
            >
              {zh ? "載入更多時刻" : "Load more moments"}
            </button>
          ) : assets.length > 0 ? (
            <p className="collection-end">
              {zh ? "珍藏生活的點點滴滴。" : "A little piece of life, kept."}
            </p>
          ) : null}
        </section>
      </div>
      {details ? (
        <AssetDetails
          key={details.id}
          asset={details}
          onSaved={saved}
          onTrashed={(asset) => {
            if (!mounted.current) return;
            setDetails(null);
            setAssets((current) =>
              current.filter((row) => row.id !== asset.id),
            );
            setLibraryRequest((current) => ({ ...current }));
            setNotice(zh ? "已移至垃圾桶" : "Moved to Trash");
            filter.current?.focus();
          }}
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
if (root)
  createRoot(root).render(
    <LocaleProvider>
      <App />
    </LocaleProvider>,
  );
