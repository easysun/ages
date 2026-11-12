/**
 * Read-only, bounded public smoke checks. Never send credentials, payloads, or
 * attacker strings to a live site. Keep the target list fixed and reviewed.
 */
import { pathToFileURL } from "node:url";

export const targets = Object.freeze([
  { url: "https://app.ages.tw/health", status: 200, jsonStatus: "ok" },
  {
    url: "https://app.ages.tw/api/me",
    status: 401,
    errorCode: "UNAUTHENTICATED",
  },
  { url: "https://ages-brand.pages.dev/", status: 200, noindex: true },
  { url: "https://brand.ball-in.club/", status: 200, noindex: true },
]);

export async function checkTargets(fetchImpl = fetch) {
  for (const target of targets) {
    const response = await fetchImpl(target.url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== target.status) {
      throw new Error(
        `${target.url}: HTTP ${response.status}, expected ${target.status}`,
      );
    }
    if (
      target.noindex &&
      !/\bnoindex\b/i.test(response.headers.get("x-robots-tag") ?? "")
    ) {
      throw new Error(`${target.url}: missing noindex response header`);
    }
    if (target.jsonStatus || target.errorCode) {
      if (response.headers.get("cache-control") !== "no-store") {
        throw new Error(`${target.url}: API must not be cached`);
      }
      if (
        !/^req_[a-f0-9-]{36}$/.test(response.headers.get("x-request-id") ?? "")
      ) {
        throw new Error(`${target.url}: missing server-generated request ID`);
      }
      const json = await response.json();
      if (target.jsonStatus && json.status !== target.jsonStatus) {
        throw new Error(`${target.url}: unexpected health response`);
      }
      if (target.errorCode && json.error?.code !== target.errorCode) {
        throw new Error(
          `${target.url}: unauthenticated access contract changed`,
        );
      }
    }
    console.log(`PASS ${target.url} HTTP ${target.status}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkTargets().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
