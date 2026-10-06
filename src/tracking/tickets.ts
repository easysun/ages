import { z } from "zod";
import type { Bindings } from "../bindings";
import type { ClickSource } from "../links/analytics";
import type { Link } from "../links/model";
import { type LinkTracking, linkTrackingSchema } from "../links/tracking";
import type { EnabledProviders } from "./providers";

const tokenPattern = /^[0-9a-f]{64}$/;

const enabledProvidersSchema = z.strictObject({
  ga4: z
    .strictObject({
      id: z.string().regex(/^G-[A-Z0-9]{1,20}$/),
      route: z.enum(["direct", "gtm"]),
    })
    .nullable(),
  meta: z
    .strictObject({
      id: z.string().regex(/^[0-9]{1,30}$/),
      route: z.enum(["direct", "gtm"]),
    })
    .nullable(),
  gtm: z
    .strictObject({ id: z.string().regex(/^GTM-[A-Z0-9]{1,20}$/) })
    .nullable(),
});

const eventSchema = z.strictObject({
  event_name: z.literal("ages_link_click"),
  link_id: z.string().min(1).max(100),
  target_kind: z.enum(["url", "timeline", "asset"]),
  channel: z.string().min(1).max(100),
  utm: linkTrackingSchema.shape.utm,
  custom: linkTrackingSchema.shape.custom,
});

export type TrackingTicketView = {
  providers: EnabledProviders;
  event: {
    event_name: "ages_link_click";
    link_id: string;
    target_kind: Link["target_kind"];
    channel: string;
    utm: LinkTracking["utm"];
    custom: LinkTracking["custom"];
  };
};

type StoredTicket = {
  event_json: string;
  providers_json: string;
};

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(new Uint8Array(digest));
}

function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function isProviderEnabled(providers: EnabledProviders) {
  return (
    providers.ga4 !== null || providers.meta !== null || providers.gtm !== null
  );
}

export async function createTrackingTicket(
  db: Bindings["DB"],
  link: Link,
  tracking: LinkTracking,
  source: ClickSource,
  providers: EnabledProviders,
  now: Date,
): Promise<{ token: string; expiresAt: string }> {
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime) || !isProviderEnabled(providers))
    throw new Error(
      "A tracking ticket requires a valid time and enabled provider.",
    );

  const token = newToken();
  const expiresAt = new Date(currentTime + 300_000).toISOString();
  const event = eventSchema.parse({
    event_name: "ages_link_click",
    link_id: link.id,
    target_kind: link.target_kind,
    channel:
      source.channel.kind === "configured" && source.channel.label
        ? source.channel.label
        : "Other",
    utm: tracking.utm,
    custom: tracking.custom,
  });
  const publicProviders = enabledProvidersSchema.parse(providers);
  await db
    .prepare(`INSERT INTO tracking_tickets (
      token_hash,link_id,target_kind,event_json,providers_json,expires_at
    ) VALUES(?,?,?,?,?,?)`)
    .bind(
      await hashToken(token),
      link.id,
      link.target_kind,
      JSON.stringify(event),
      JSON.stringify(publicProviders),
      expiresAt,
    )
    .run();
  return { token, expiresAt };
}

export async function readTrackingTicket(
  db: Bindings["DB"],
  token: string,
  now: Date,
): Promise<TrackingTicketView | null> {
  if (!tokenPattern.test(token) || !Number.isFinite(now.getTime())) return null;
  const row = await db
    .prepare(`SELECT event_json, providers_json FROM tracking_tickets
      WHERE token_hash = ? AND expires_at > ? AND consumed_at IS NULL`)
    .bind(await hashToken(token), now.toISOString())
    .first<StoredTicket>();
  if (!row) return null;

  try {
    return {
      event: eventSchema.parse(JSON.parse(row.event_json)),
      providers: enabledProvidersSchema.parse(JSON.parse(row.providers_json)),
    };
  } catch {
    return null;
  }
}

export async function consumeTrackingTicket(
  db: Bindings["DB"],
  token: string,
  now: Date,
): Promise<{
  linkId: string;
  targetKind: "url" | "timeline" | "asset";
} | null> {
  if (!tokenPattern.test(token) || !Number.isFinite(now.getTime())) return null;
  const result = await db
    .prepare(`UPDATE tracking_tickets SET consumed_at = ?
      WHERE token_hash = ? AND expires_at > ? AND consumed_at IS NULL
      RETURNING link_id, target_kind`)
    .bind(now.toISOString(), await hashToken(token), now.toISOString())
    .first<{ link_id: string; target_kind: "url" | "timeline" | "asset" }>();
  return result
    ? { linkId: result.link_id, targetKind: result.target_kind }
    : null;
}
