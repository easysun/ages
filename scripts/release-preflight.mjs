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
  const target = validateReleaseTarget(parsed.config, environment);
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
    `Preflight passed for ${environment}: isolated bindings, secret names and migration ledger verified.`,
  );
  if (action !== "--deploy") return;
  try {
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
