import { z } from "zod";
import { tagsSchema } from "../assets/library";
import { linkUrlSchema } from "./model";

const parameterValueSchema = z
  .string()
  .max(100)
  .refine((value) => noParameterControls(value));
const parameterKeySchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => {
    if (!noParameterControls(value)) return false;
    const normalized = value.toLowerCase();
    return (
      !normalized.startsWith("utm_") &&
      !["ages_channel", "__proto__", "prototype", "constructor"].includes(
        normalized,
      )
    );
  });
const customParameterSchema = z.strictObject({
  key: parameterKeySchema,
  value: parameterValueSchema,
});

function noParameterControls(value: string) {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

export const linkTrackingSchema = z.strictObject({
  // Share the Asset tag contract so Link tags and channel labels retain the
  // same exact Unicode, whitespace, and control-character behavior.
  tags: tagsSchema.shape.tags,
  channels: tagsSchema.shape.tags,
  utm: z.strictObject({
    utm_source: parameterValueSchema.optional(),
    utm_medium: parameterValueSchema.optional(),
    utm_campaign: parameterValueSchema.optional(),
    utm_term: parameterValueSchema.optional(),
    utm_content: parameterValueSchema.optional(),
  }),
  custom: z
    .array(customParameterSchema)
    .max(10)
    .refine(
      (parameters) =>
        new Set(parameters.map((parameter) => parameter.key)).size ===
        parameters.length,
    ),
});

export type LinkTracking = z.infer<typeof linkTrackingSchema>;

type TrackingSettingsRow = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  custom_json: string;
};

export async function getLinkTracking(
  db: D1Database,
  linkId: string,
): Promise<LinkTracking> {
  const [settings, tags, channels] = await Promise.all([
    db
      .prepare(
        `SELECT utm_source, utm_medium, utm_campaign, utm_term, utm_content, custom_json
        FROM link_tracking_settings WHERE link_id = ?`,
      )
      .bind(linkId)
      .first<TrackingSettingsRow>(),
    db
      .prepare("SELECT tag FROM link_tags WHERE link_id = ? ORDER BY position")
      .bind(linkId)
      .all<{ tag: string }>(),
    db
      .prepare(
        "SELECT channel FROM link_channels WHERE link_id = ? ORDER BY position",
      )
      .bind(linkId)
      .all<{ channel: string }>(),
  ]);
  const utm: LinkTracking["utm"] = {};
  if (settings) {
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
    ] as const) {
      const value = settings[key];
      if (value !== null) utm[key] = value;
    }
  }
  return linkTrackingSchema.parse({
    tags: tags.results.map((row) => row.tag),
    channels: channels.results.map((row) => row.channel),
    utm,
    custom: settings ? JSON.parse(settings.custom_json) : [],
  });
}

export function applyLinkParameters(
  destination: string,
  settings: LinkTracking,
  applicationOrigin: string,
): string {
  const normalizedDestination = linkUrlSchema.parse(destination);
  const tracking = linkTrackingSchema.parse(settings);
  const destinationUrl = new URL(normalizedDestination);
  const originUrl = new URL(applicationOrigin);
  if (destinationUrl.origin === originUrl.origin) return destination;

  for (const [key, value] of Object.entries(tracking.utm)) {
    if (value !== undefined) destinationUrl.searchParams.set(key, value);
  }
  for (const parameter of tracking.custom)
    destinationUrl.searchParams.set(parameter.key, parameter.value);
  return destinationUrl.href;
}
