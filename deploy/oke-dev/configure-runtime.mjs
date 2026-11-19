import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const [directory, port = "8787"] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
delete config.env;
delete config.$schema;
config.main = resolve(root, config.main);
config.assets.directory = resolve(root, config.assets.directory);
for (const database of config.d1_databases)
  database.migrations_dir = resolve(root, database.migrations_dir);

const bucket = config.r2_buckets.find(({ binding }) => binding === "MEDIA");
const accessKeyId = randomBytes(16).toString("hex");
const secretAccessKey = randomBytes(32).toString("hex");
bucket.local_dev = {
  experimental_s3_credentials: { accessKeyId, secretAccessKey },
};
writeFileSync(join(directory, "wrangler.json"), JSON.stringify(config), {
  mode: 0o600,
});

const variables = {
  APP_ORIGIN: `http://127.0.0.1:${port}`,
  TRACKING_ORIGIN: "http://localhost:8798",
  ROBOTS_NOINDEX: "true",
  LOCAL_R2_UPLOADS_ENABLED: "true",
  R2_BUCKET_NAME: bucket.bucket_name,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
};
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  if (process.env[name]) variables[name] = process.env[name];
}
writeFileSync(
  join(directory, ".dev.vars"),
  `${Object.entries(variables)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`,
  { mode: 0o600 },
);
