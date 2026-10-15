import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const persistence = resolve(
  root,
  process.env.AGES_DEMO_PERSIST_TO ?? ".wrangler/demo",
);
const fixtures = resolve(root, ".wrangler/demo-fixtures");

export const demoAssets = [
  {
    id: "as_demo_coast",
    name: "Coastal light.png",
    width: 600,
    height: 400,
    tone: 0,
    tags: ["Coast", "Travel"],
  },
  {
    id: "as_demo_mountains",
    name: "Mountain air.png",
    width: 600,
    height: 400,
    tone: 1,
    tags: ["Nature", "Travel"],
  },
  {
    id: "as_demo_afternoon",
    name: "A quiet afternoon.png",
    width: 400,
    height: 600,
    tone: 2,
    tags: ["Everyday", "Favorites"],
  },
  {
    id: "as_demo_sunset",
    name: "Golden evening.png",
    width: 600,
    height: 400,
    tone: 3,
    tags: ["Coast", "Favorites"],
  },
];

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}

export function samplePng(width, height, tone) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const mountain =
        y > height * (0.53 + 0.15 * Math.sin((x / width) * 7 + tone));
      const palette = mountain
        ? [70 + tone * 15, 85 + tone * 12, 69]
        : [203 + tone * 5, 192 - tone * 7, 165 - tone * 5];
      for (let channel = 0; channel < 3; channel++)
        raw[offset + channel] = Math.max(
          0,
          Math.min(255, (palette[channel] ?? 0) + (y / height) * 20),
        );
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sqlValue(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
function values(...items) {
  return items.map(sqlValue).join(",");
}

export function seedSql(media, now = new Date().toISOString()) {
  const owner = "us_local_test";
  const statements = [
    "INSERT OR IGNORE INTO users (id,email,display_name,created_at,updated_at) VALUES (" +
      values(
        owner,
        "local-test@ages.example.test",
        "Local test account",
        now,
        now,
      ) +
      ");",
    "INSERT OR IGNORE INTO usage_quotas (user_id,storage_limit_bytes,max_asset_bytes,timeline_limit,link_limit,updated_at) VALUES (" +
      values(owner, 1024 ** 3, 250 * 1024 ** 2, 10, 100, now) +
      ");",
  ];
  for (const { id, name, width, height, tags, size, etag } of media) {
    const key = `originals/${owner}/${id}/fixture`;
    statements.push(
      "INSERT OR IGNORE INTO assets (id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,width,height,upload_expires_at,created_at,updated_at) VALUES (" +
        values(
          id,
          owner,
          "image",
          name,
          "image/png",
          size,
          key,
          width,
          height,
          now,
          now,
          now,
        ) +
        ");",
      "UPDATE assets SET status='ready',etag=" +
        sqlValue(etag) +
        ",updated_at=" +
        sqlValue(now) +
        " WHERE id=" +
        sqlValue(id) +
        " AND status='pending';",
    );
    for (const tag of tags)
      statements.push(
        "INSERT OR IGNORE INTO asset_tags (asset_id,owner_id,tag) VALUES (" +
          values(id, owner, tag) +
          ");",
      );
  }
  const timelines = [
    {
      id: "tl_demo_weekend",
      title: "A weekend by the sea",
      visibility: "unlisted",
      cover: media[0].id,
      items: [
        [
          "ti_demo_coast",
          media[0].id,
          0,
          "Morning light along the coast",
          "2024-05-10",
        ],
        [
          "ti_demo_mountains",
          media[1].id,
          1,
          "The mountain trail",
          "2024-05-11",
        ],
        ["ti_demo_sunset", media[3].id, 2, "The last evening", "2024-05-12"],
      ],
    },
    {
      id: "tl_demo_everyday",
      title: "Small everyday moments",
      visibility: "private",
      cover: media[2].id,
      items: [
        [
          "ti_demo_afternoon",
          media[2].id,
          0,
          "An ordinary afternoon",
          "2024-06-18",
        ],
        [
          "ti_demo_shared",
          media[3].id,
          1,
          "A familiar sunset, a different story",
          "2024-06-20",
        ],
      ],
    },
  ];
  for (const timeline of timelines) {
    statements.push(
      "INSERT OR IGNORE INTO timelines (id,owner_id,title,visibility,cover_asset_id,created_at,updated_at) VALUES (" +
        values(
          timeline.id,
          owner,
          timeline.title,
          timeline.visibility,
          timeline.cover,
          now,
          now,
        ) +
        ");",
    );
    for (const [id, asset, position, caption, date] of timeline.items) {
      const event = JSON.stringify({
        kind: "date",
        date,
        time_zone: "Asia/Taipei",
        calendar: "iso8601",
      });
      statements.push(
        "INSERT OR IGNORE INTO timeline_items (id,timeline_id,owner_id,asset_id,position,caption,event_at,created_at,updated_at) VALUES (" +
          values(
            id,
            timeline.id,
            owner,
            asset,
            position,
            caption,
            event,
            now,
            now,
          ) +
          ");",
      );
    }
  }
  statements.push(
    "INSERT INTO distribution_links (id,owner_id,slug,target_kind,timeline_id,created_at,updated_at) " +
      "SELECT " +
      values(
        "ln_demo_story",
        owner,
        "demo-story",
        "timeline",
        "tl_demo_weekend",
        now,
        now,
      ) +
      " WHERE NOT EXISTS (SELECT 1 FROM distribution_links WHERE id='ln_demo_story');",
  );
  return `${statements.join("\n")}\n`;
}

async function main() {
  const seedOnly =
    process.argv.length === 3 && process.argv[2] === "--seed-only";
  if (process.argv.length !== 2 && !seedOnly)
    throw new Error("Usage: node scripts/dev-demo.mjs [--seed-only]");
  const port = Number(process.env.AGES_DEMO_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AGES_DEMO_PORT must be a valid TCP port.");

  mkdirSync(persistence, { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  // Never forward CI or production Cloudflare credentials into local Wrangler.
  const localEnv = { ...process.env };
  delete localEnv.CLOUDFLARE_API_TOKEN;
  delete localEnv.CLOUDFLARE_ACCOUNT_ID;
  const localArgs = ["--local", "--env", "", "--persist-to", persistence];
  function wrangler(args) {
    execFileSync(process.execPath, [cli, ...args, ...localArgs], {
      cwd: root,
      env: localEnv,
      stdio: "inherit",
    });
  }

  wrangler(["d1", "migrations", "apply", "DB"]);
  const media = [];
  for (const asset of demoAssets) {
    const bytes = samplePng(asset.width, asset.height, asset.tone);
    const file = resolve(fixtures, `${asset.id}.png`);
    const key = `originals/us_local_test/${asset.id}/fixture`;
    writeFileSync(file, bytes);
    wrangler([
      "r2",
      "object",
      "put",
      `ages-media-local/${key}`,
      "--file",
      file,
      "--content-type",
      "image/png",
    ]);
    media.push({
      ...asset,
      size: bytes.length,
      etag: createHash("md5").update(bytes).digest("hex"),
    });
  }
  const sqlFile = resolve(fixtures, "seed.sql");
  writeFileSync(sqlFile, seedSql(media));
  wrangler(["d1", "execute", "DB", "--file", sqlFile]);
  console.log(
    "Local-only demo seeded: 4 photos, 2 timelines, 1 short link. No cloud resources were accessed.",
  );
  if (seedOnly) return;

  const origin = `http://127.0.0.1:${port}`;
  console.log(`Open ${origin}/ and choose 'Use local test account'.`);
  const worker = spawn(
    process.execPath,
    [
      cli,
      "dev",
      "--env",
      "",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistence,
      "--var",
      `APP_ORIGIN:${origin}`,
      "--var",
      "LOCAL_LOGIN_ENABLED:true",
    ],
    { cwd: root, env: localEnv, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => worker.kill(signal));
  worker.on("error", (error) => {
    console.error("Demo Worker could not start:", error.message);
    process.exitCode = 1;
  });
  worker.on("close", (code) => {
    if (process.exitCode !== 1) process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error("Demo startup failed:", error.message);
    process.exitCode = 1;
  });
}
