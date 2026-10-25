import { html } from "hono/html";
import type { Asset } from "../assets/model";
import type { Timeline } from "./model";
import type { EventAt } from "./validation";

export type ViewerItem = {
  id: string;
  caption: string;
  event_at: string | null;
  asset_id: string;
  kind: Asset["kind"];
  width: number | null;
  height: number | null;
};

function validImageDimensions(
  dimensions:
    | { width: number | null; height: number | null }
    | null
    | undefined,
) {
  if (
    !dimensions ||
    typeof dimensions.width !== "number" ||
    !Number.isFinite(dimensions.width) ||
    !Number.isInteger(dimensions.width) ||
    dimensions.width <= 0 ||
    typeof dimensions.height !== "number" ||
    !Number.isFinite(dimensions.height) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.height <= 0
  )
    return null;
  return dimensions;
}

function eventLabel(value: string | null) {
  if (value === null) return null;
  const event = JSON.parse(value) as EventAt;
  if (event.kind === "date")
    return html`<p class="date"><time datetime="${event.date}">${event.date}</time> <span>${event.time_zone}</span></p>`;
  const label = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: event.time_zone,
  }).format(new Date(event.instant));
  return html`<p class="date"><time datetime="${event.instant}">${label}</time> <span>${event.time_zone}</span></p>`;
}

export function renderTimeline(
  timeline: Timeline,
  items: ViewerItem[],
  cover: Asset | null,
  origin: string,
) {
  const path = `/t/${encodeURIComponent(timeline.id)}`;
  const canonical = `${origin}${path}`;
  const reportQuery = new URLSearchParams({
    kind: "timeline",
    timeline_id: timeline.id,
  });
  const reportPath = `/report?${reportQuery.toString()}`;
  const mediaUrl = (id: string) => `${path}/media/${encodeURIComponent(id)}`;
  const robots =
    timeline.visibility === "unlisted" ? "noindex, nofollow" : "index, follow";
  const description =
    items.find((item) => item.caption.trim())?.caption.slice(0, 200) ??
    `${items.length} ${items.length === 1 ? "moment" : "moments"} in a living timeline.`;
  const image =
    cover?.kind === "image"
      ? cover.id
      : items.find((item) => item.kind === "image")?.asset_id;
  const displayMedia = (
    id: string,
    kind: Asset["kind"],
    caption: string,
    dimensions?: { width: number | null; height: number | null },
  ) => {
    const alt = caption.trim().slice(0, 200) || "Timeline photo";
    if (kind === "image") {
      const size = validImageDimensions(dimensions);
      if (size)
        return html`<img src="${mediaUrl(id)}" alt="${alt}" width="${size.width}" height="${size.height}" loading="lazy" decoding="async">`;
      return html`<img src="${mediaUrl(id)}" alt="${alt}" loading="lazy" decoding="async">`;
    }
    if (kind === "video")
      return html`<video controls preload="metadata" aria-label="${caption.trim().slice(0, 200) || "Timeline video"}" src="${mediaUrl(id)}"></video>`;
    if (kind === "audio")
      return html`<audio controls preload="metadata" aria-label="${caption.trim().slice(0, 200) || "Timeline audio"}" src="${mediaUrl(id)}"></audio>`;
    return html`<a href="${mediaUrl(id)}">Open attachment</a>`;
  };
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${timeline.title} — Ages</title>
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${robots}">
<meta name="description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Ages">
<meta property="og:title" content="${timeline.title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
${image ? html`<meta property="og:image" content="${origin}${mediaUrl(image)}">` : null}
<style>
:root{color-scheme:light; font-family:system-ui,sans-serif; color:#24312d; background:#f6f4ee; line-height:1.6}
*{box-sizing:border-box}body{margin:0}a{color:#315b49}header,main,footer{width:min(100% - 2rem,48rem); margin-inline:auto}
header{padding-block:3rem 2rem}header p{letter-spacing:.12em; text-transform:uppercase; font-size:.8rem; color:#5b6e61}
h1{font-size:clamp(2rem,6vw,3.5rem); line-height:1.15; overflow-wrap:anywhere; margin:.5rem 0 1rem}
.cover{border-radius:1rem; overflow:hidden; margin-top:2rem}.cover img,.cover video{width:100%; max-height:34rem; object-fit:contain; display:block; background:#e8ebe5}
.cover img{height:auto}
ol{list-style:none; padding:0; margin:0}li{margin-bottom:2rem}figure{margin:0; border:1px solid #e0e4da; border-radius:1rem; overflow:hidden; background:#fff}
figure img,figure video{display:block; width:100%; height:auto; max-height:70vh; object-fit:contain; background:#edf0e9}
figure audio{width:100%; display:block}figcaption{padding:1.25rem; overflow-wrap:anywhere}.caption{white-space:pre-wrap; margin:0}
.date{color:#647269; font-size:.85rem; margin:0 0 .75rem}.date span{display:inline-block; margin-left:.5rem}footer{padding-block:1rem 3rem; color:#647269; font-size:.85rem}
@media(max-width:30rem){header{padding-top:2rem}figcaption{padding:1rem}}
</style>
</head>
<body>
<header><p>Ages · Living timeline</p><h1>${timeline.title}</h1><span>${items.length} ${items.length === 1 ? "moment" : "moments"}</span>
${cover ? html`<div class="cover">${displayMedia(cover.id, cover.kind, timeline.title, cover)}</div>` : null}</header>
<main aria-label="Timeline moments">
${items.length ? html`<ol>${items.map((item) => html`<li><figure>${displayMedia(item.asset_id, item.kind, item.caption, item)}<figcaption>${eventLabel(item.event_at)}${item.caption ? html`<p class="caption">${item.caption}</p>` : null}</figcaption></figure></li>`)}</ol>` : html`<p>This story is waiting for its first moment.</p>`}
</main><footer><p>A story to keep adding to.</p><nav aria-label="Reporting"><a href="${reportPath}">Report this Timeline</a> <a href="/report">Report an Ages Link</a></nav></footer>
</body>
</html>`;
}
