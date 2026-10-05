import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  validateReleaseTarget,
  verifyReleaseResources,
} from "../src/operations/preflight.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main() {
  const [environment, action, ...extra] = process.argv.slice(2);
  if (
    !environment ||
    (action !== undefined && action !== "--deploy") ||
    extra.length
  )
    throw new Error(
      "Usage: npm run preflight -- <development|preview|production> [--deploy]",
    );
  const parsed = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(resolve(root, "wrangler.jsonc"), "utf8"),
  );
  if (parsed.error) throw new Error("Invalid Wrangler JSONC configuration.");
  const trackingParsed = ts.parseConfigFileTextToJson(
    "wrangler.tracking.jsonc",
    readFileSync(resolve(root, "wrangler.tracking.jsonc"), "utf8"),
  );
  if (trackingParsed.error)
    throw new Error("Invalid tracking Worker Wrangler JSONC configuration.");
  const target = validateReleaseTarget(
    parsed.config,
    environment,
    trackingParsed.config,
  );
  if (
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_ACCOUNT_ID !== target.accountId
  )
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID differs from the configured account.",
    );
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const migrations = readdirSync(resolve(root, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (action === "--deploy") {
    try {
      execFileSync("npm", ["run", "check"], { cwd: root, stdio: "inherit" });
    } catch {
      throw new Error(
        "Local verification failed; deployment was not attempted.",
      );
    }
  }
  if (!existsSync(resolve(root, "dist/client/index.html")))
    throw new Error("Build the client before checking release resources.");
  await verifyReleaseResources(target, token, migrations);
  console.log(
    `Preflight passed for ${environment}: application resources and isolated tracking Worker configuration verified.`,
  );
  console.log(
    "Manual release gates remain: verify both declared registrable domains against the Public Suffix List, provision and verify DNS/TLS, test origin/cookie isolation in browsers, and observe expected provider events after consent. See docs/provider-release-gates.md.",
  );
  if (action !== "--deploy") return;
  try {
    execFileSync(
      process.execPath,
      [
        resolve(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        "wrangler.tracking.jsonc",
        "--env",
        environment,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: target.accountId,
          CLOUDFLARE_ENV: environment,
        },
      },
    );
    execFileSync(
      process.execPath,
      [
        resolve(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--env",
        environment,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: target.accountId,
          CLOUDFLARE_ENV: environment,
        },
      },
    );
  } catch {
    throw new Error(
      "Deployment failed; inspect the named environment before retrying.",
    );
  }
}
main().catch((error) => {
  console.error(`Release preflight failed: ${error.message}`);
  process.exitCode = 1;
});
