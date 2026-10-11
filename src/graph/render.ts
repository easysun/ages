import type { PublicEdge } from "./edges";
import type { ContentNode } from "./nodes";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const pageStyles = `<style>
  :root { color-scheme: light; font-family: ui-serif, Georgia, serif; color: #26352f; background: #f7f7f2; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  main { width: min(100%, 680px); padding: clamp(28px, 7vw, 64px); background: #fff; border: 1px solid #e1e5df; border-radius: 24px; box-shadow: 0 18px 60px #26352f12; }
  .brand { display: inline-block; margin-bottom: 48px; color: #344e43; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 1.1rem; font-weight: 700; letter-spacing: .02em; text-decoration: none; }
  .eyebrow { color: #657c6d; font: 700 .75rem/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 12px 0 18px; font-size: clamp(2rem, 7vw, 3.3rem); line-height: 1.08; overflow-wrap: anywhere; }
  .description { max-width: 46ch; color: #52635a; font: 1rem/1.7 ui-sans-serif, system-ui, sans-serif; }
  .target { display: inline-flex; margin-top: 24px; padding: 13px 18px; border-radius: 999px; background: #365847; color: #fff; font: 700 .95rem/1.2 ui-sans-serif, system-ui, sans-serif; text-decoration: none; }
  .target:focus-visible, .brand:focus-visible { outline: 3px solid #b56736; outline-offset: 4px; }
  .backlinks { margin-top: 36px; padding-top: 22px; border-top: 1px solid #e1e5df; font: .95rem/1.6 ui-sans-serif, system-ui, sans-serif; }
  .backlinks h2 { margin: 0 0 12px; font: 700 1.1rem/1.3 ui-serif, Georgia, serif; }
  .backlinks ul { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .backlinks li { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
  .backlinks a { color: #365847; font-weight: 700; }
  .backlinks p { margin: 0; color: #657c6d; font-size: .8rem; }
</style>`;

function documentShell(title: string, content: string, robots: string) {
  const escapedTitle = escapeHtml(title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="${robots}"><title>${escapedTitle} · Ages</title>${pageStyles}</head><body>${content}</body></html>`;
}

export function renderContentNode(
  node: ContentNode,
  visibility: ContentNode["visibility"],
  backlinks: PublicEdge[] = [],
) {
  const title = node.title?.trim() || "A moment to remember";
  const label = escapeHtml(title);
  const robots = visibility === "public" ? "index,follow" : "noindex,nofollow";
  const target =
    node.kind === "external"
      ? `<a class="target" href="${escapeHtml(node.url ?? "")}" rel="noopener noreferrer">Open external page</a>`
      : visibility === "private"
        ? `<a class="target" href="/timelines/${encodeURIComponent(node.timeline_id ?? "")}">Open Timeline editor</a>`
        : `<a class="target" href="/t/${encodeURIComponent(node.timeline_id ?? "")}">View Timeline</a>`;
  const backlinkList =
    visibility === "public" && backlinks.length > 0
      ? `<section class="backlinks" aria-labelledby="backlinks-title"><h2 id="backlinks-title">Related stories</h2><ul>${backlinks
          .map(
            (edge) =>
              `<li><a href="/c/${encodeURIComponent(edge.source.id)}">${escapeHtml(edge.source.title?.trim() || "Untitled reference")}</a><span>${escapeHtml(edge.type)}</span><p>${escapeHtml(edge.attribution)}</p></li>`,
          )
          .join("")}</ul></section>`
      : "";
  return documentShell(
    title,
    `<main aria-labelledby="content-title"><a class="brand" href="/" aria-label="Ages home">ages<span aria-hidden="true">.</span></a><p class="eyebrow">A moment, kept</p><h1 id="content-title">${label}</h1><p class="description">A story shared from Ages.</p>${target}${backlinkList}</main>`,
    robots,
  );
}

export function renderUnavailableContentNode() {
  return documentShell(
    "Content unavailable",
    `<main aria-labelledby="content-title"><a class="brand" href="/" aria-label="Ages home">ages<span aria-hidden="true">.</span></a><h1 id="content-title">This content is unavailable.</h1><p class="description">The reference may have been removed or may not be available to you.</p></main>`,
    "noindex,nofollow",
  );
}
