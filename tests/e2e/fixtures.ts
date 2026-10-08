import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { BrowserContext } from "@playwright/test";

export const e2eOrigin = `http://127.0.0.1:${process.env.AGES_E2E_PORT ?? "8797"}`;
export const e2eTrackingOrigin = `http://localhost:${process.env.AGES_E2E_TRACKING_PORT ?? "8798"}`;

const cli = resolve("node_modules/wrangler/bin/wrangler.js");
const persistence = resolve(".wrangler/e2e");
const artifacts = resolve(".wrangler/e2e-fixtures");
mkdirSync(artifacts, { recursive: true });
const local = ["--local", "--env", "", "--persist-to", persistence];
function command(args: string[]) {
  return execFileSync(process.execPath, [cli, ...args, ...local], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function executeFixtureSql(sql: string) {
  command(["d1", "execute", "DB", "--command", sql]);
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
export function photo(width: number, height: number, tone = 0) {
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
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function putFixture(key: string, bytes: Buffer) {
  const path = resolve(artifacts, `${randomUUID()}.png`);
  writeFileSync(path, bytes);
  command([
    "r2",
    "object",
    "put",
    `ages-media-local/${key}`,
    "--file",
    path,
    "--content-type",
    "image/png",
  ]);
}
export async function seedLibrary(context: BrowserContext) {
  const suffix = randomUUID();
  const owner = `us_browser_${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const rows = [
    { name: "Coastal light.png", width: 600, height: 400, tone: 0 },
    { name: "A quiet afternoon.png", width: 400, height: 600, tone: 1 },
    { name: "Mountain air.png", width: 600, height: 400, tone: 2 },
  ];
  const sql = [
    `INSERT INTO users (id,email,display_name,created_at,updated_at) VALUES ('${owner}','${suffix}@example.test','Alex','${now}','${now}');`,
    `INSERT INTO usage_quotas (user_id,storage_limit_bytes,max_asset_bytes,timeline_limit,link_limit,updated_at) VALUES ('${owner}',1073741824,262144000,10,100,'${now}');`,
    `INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES ('${hash}','${owner}','${expiry}','${now}');`,
  ];
  const ids: string[] = [];
  for (const [index, row] of rows.entries()) {
    const id = `as_${suffix}_${index}`;
    const key = `originals/${owner}/${id}/fixture`;
    const bytes = photo(row.width, row.height, row.tone);
    putFixture(key, bytes);
    ids.push(id);
    sql.push(
      `INSERT INTO assets (id,owner_id,kind,original_name,mime_type,size_bytes,r2_key,width,height,upload_expires_at,created_at,updated_at) VALUES ('${id}','${owner}','image','${row.name}','image/png',${bytes.length},'${key}',${row.width},${row.height},'${expiry}','${now}','${now}');`,
      `UPDATE assets SET status='ready', etag='${createHash("md5").update(bytes).digest("hex")}' WHERE id='${id}';`,
    );
  }
  const foreign = `foreign_${suffix}`;
  sql.push(
    `INSERT INTO users (id,email,created_at,updated_at) VALUES ('${foreign}','foreign_${suffix}@example.test','${now}','${now}');`,
    `INSERT INTO assets (id,owner_id,kind,status,original_name,mime_type,size_bytes,r2_key,upload_expires_at,created_at,updated_at) VALUES ('as_${foreign}','${foreign}','image','ready','Foreign secret.png','image/png',10,'foreign/${suffix}','${expiry}','${now}','${now}');`,
  );
  const path = resolve(artifacts, `${suffix}.sql`);
  writeFileSync(path, sql.join("\n"));
  command(["d1", "execute", "DB", "--file", path]);
  await context.addCookies([
    {
      name: "ages_session",
      value: token,
      url: e2eOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { owner, ids };
}

export type ProviderFixtureOptions = {
  ga4?: boolean;
  meta?: boolean;
  gtm?: boolean;
  ga4Route?: "direct" | "gtm";
  metaRoute?: "direct" | "gtm";
  allowGa4?: boolean;
  allowMeta?: boolean;
  allowGtm?: boolean;
};

export function seedProviderLink(
  owner: string,
  route: "direct" | "gtm" = "direct",
  target = `${e2eOrigin}/synthetic-destination?destination_secret=private#story`,
  options: ProviderFixtureOptions = {},
) {
  const id = `ln_${randomUUID()}`;
  const slug = `provider-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const custom = [
    { key: "note", value: "</script><img src=x onerror=alert(1)>" },
    { key: "send_to", value: "G-ATTACKER1" },
    {
      key: "page_location",
      value: "https://attacker.example.test/ticket-secret",
    },
    { key: "transport_url", value: "https://attacker.example.test/collect" },
    { key: "event_callback", value: "continueNow" },
    { key: "event", value: "attacker_route" },
    { key: "field_1", value: "a".repeat(100) },
    { key: "field_2", value: "b".repeat(100) },
    { key: "field_3", value: "c".repeat(100) },
    { key: "field_4", value: "d".repeat(100) },
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const sqlValue = (value: string | null) =>
    value === null ? "NULL" : quote(value);
  const ga4Id = options.ga4 === false ? null : "G-ABC123";
  const metaId = options.meta === false ? null : "1234567890";
  const gtmId = options.gtm === false ? null : "GTM-ABC123";
  const ga4Route = options.ga4Route ?? route;
  const metaRoute = options.metaRoute ?? route;
  const sql = [
    `INSERT INTO distribution_links (id,owner_id,slug,target_kind,target_url,allow_ga4,allow_meta_pixel,allow_gtm,created_at,updated_at) VALUES (${quote(id)},${quote(owner)},${quote(slug)},'url',${quote(target)},${options.allowGa4 === false ? 0 : 1},${options.allowMeta === false ? 0 : 1},${options.allowGtm === false ? 0 : 1},${quote(now)},${quote(now)});`,
    `INSERT INTO tracking_provider_settings (user_id,ga4_measurement_id,meta_pixel_id,gtm_container_id,ga4_route,meta_route) VALUES (${quote(owner)},${sqlValue(ga4Id)},${sqlValue(metaId)},${sqlValue(gtmId)},${quote(ga4Route)},${quote(metaRoute)}) ON CONFLICT(user_id) DO UPDATE SET ga4_measurement_id=excluded.ga4_measurement_id,meta_pixel_id=excluded.meta_pixel_id,gtm_container_id=excluded.gtm_container_id,ga4_route=excluded.ga4_route,meta_route=excluded.meta_route;`,
    `INSERT INTO link_tracking_settings (link_id,owner_id,utm_source,utm_medium,utm_campaign,utm_term,utm_content,custom_json) VALUES (${quote(id)},${quote(owner)},'ages',${quote("m".repeat(100))},${quote("c".repeat(100))},${quote("t".repeat(100))},${quote("v".repeat(100))},${quote(JSON.stringify(custom))});`,
    `INSERT INTO link_channels (link_id,owner_id,channel,position) VALUES (${quote(id)},${quote(owner)},'newsletter',0);`,
  ];
  executeFixtureSql(sql.join("\n"));
  return { id, slug, target, custom };
}

export function seedTimeline(
  owner: string,
  assets: string[],
  count = 3,
  title = "A living story",
) {
  const id = `tl_${randomUUID()}`;
  const now = new Date().toISOString();
  const itemIds = Array.from({ length: count }, () => `ti_${randomUUID()}`);
  const sql = [
    `INSERT INTO timelines (id,owner_id,title,created_at,updated_at) VALUES ('${id}','${owner}','${title.replaceAll("'", "''")}','${now}','${now}');`,
    ...itemIds.map(
      (itemId, index) =>
        `INSERT INTO timeline_items (id,timeline_id,owner_id,asset_id,position,caption,created_at,updated_at) VALUES ('${itemId}','${id}','${owner}','${assets[index % assets.length]}',${index},'Moment ${index + 1}','${now}','${now}');`,
    ),
  ];
  const path = resolve(artifacts, `${id}.sql`);
  writeFileSync(path, sql.join("\n"));
  command(["d1", "execute", "DB", "--file", path]);
  return { id, itemIds };
}

export function seedTaggedLinks(
  owner: string,
  tag: string,
  prefix: string,
  count: number,
) {
  const createdAt = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `ln_${randomUUID()}`,
    slug: `${prefix}-${index}`,
  }));
  const escapedTag = tag.replaceAll("'", "''");
  const sql = rows.flatMap(({ id, slug }) => [
    `INSERT INTO distribution_links (id,owner_id,slug,target_kind,target_url,active,moderation_blocked,created_at,updated_at) VALUES ('${id}','${owner}','${slug}','url','https://example.org/${slug}',1,0,'${createdAt}','${createdAt}');`,
    `INSERT INTO link_tags (link_id,owner_id,tag,position) VALUES ('${id}','${owner}','${escapedTag}',0);`,
  ]);
  executeFixtureSql(sql.join("\n"));
  return rows;
}
