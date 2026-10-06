import { z } from "zod";
import type { Bindings } from "../bindings";

export const trackingProviderSettingsSchema = z
  .strictObject({
    ga4_measurement_id: z
      .string()
      .regex(/^G-[A-Z0-9]{1,20}$/)
      .nullable(),
    meta_pixel_id: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .nullable(),
    gtm_container_id: z
      .string()
      .regex(/^GTM-[A-Z0-9]{1,20}$/)
      .nullable(),
    ga4_route: z.enum(["direct", "gtm"]).default("direct"),
    meta_route: z.enum(["direct", "gtm"]).default("direct"),
  })
  .refine(
    (settings) =>
      (settings.ga4_route === "direct" || settings.gtm_container_id !== null) &&
      (settings.meta_route === "direct" || settings.gtm_container_id !== null),
  );

export type TrackingProviderSettings = z.infer<
  typeof trackingProviderSettingsSchema
>;

export type EnabledProviders = {
  ga4: { id: string; route: "direct" | "gtm" } | null;
  meta: { id: string; route: "direct" | "gtm" } | null;
  gtm: { id: string } | null;
};

const emptySettings: TrackingProviderSettings = {
  ga4_measurement_id: null,
  meta_pixel_id: null,
  gtm_container_id: null,
  ga4_route: "direct",
  meta_route: "direct",
};

const disabledProviders: EnabledProviders = {
  ga4: null,
  meta: null,
  gtm: null,
};

type ProviderSettingsRow = TrackingProviderSettings;

export async function getTrackingProviders(
  db: Bindings["DB"],
  ownerId: string,
): Promise<TrackingProviderSettings> {
  const row = await db
    .prepare(`SELECT ga4_measurement_id, meta_pixel_id, gtm_container_id,
      ga4_route, meta_route FROM tracking_provider_settings WHERE user_id = ?`)
    .bind(ownerId)
    .first<ProviderSettingsRow>();
  return row ? trackingProviderSettingsSchema.parse(row) : { ...emptySettings };
}

type LinkProviderRow = {
  user_id: string | null;
  ga4_measurement_id: string | null;
  meta_pixel_id: string | null;
  gtm_container_id: string | null;
  ga4_route: "direct" | "gtm" | null;
  meta_route: "direct" | "gtm" | null;
  allow_ga4: number;
  allow_meta_pixel: number;
  allow_gtm: number;
};

export async function resolveLinkProviders(
  db: Bindings["DB"],
  linkId: string,
  ownerId: string,
): Promise<EnabledProviders> {
  const row = await db
    .prepare(`SELECT p.user_id, p.ga4_measurement_id, p.meta_pixel_id,
      p.gtm_container_id, p.ga4_route, p.meta_route,
      l.allow_ga4, l.allow_meta_pixel, l.allow_gtm
      FROM distribution_links l
      LEFT JOIN tracking_provider_settings p ON p.user_id = l.owner_id
      WHERE l.id = ? AND l.owner_id = ?`)
    .bind(linkId, ownerId)
    .first<LinkProviderRow>();
  if (!row) return { ...disabledProviders };

  const settings =
    row.user_id === null
      ? emptySettings
      : trackingProviderSettingsSchema.parse({
          ga4_measurement_id: row.ga4_measurement_id,
          meta_pixel_id: row.meta_pixel_id,
          gtm_container_id: row.gtm_container_id,
          ga4_route: row.ga4_route,
          meta_route: row.meta_route,
        });
  const gtmAllowed = row.allow_gtm === 1;
  const ga4Enabled =
    row.allow_ga4 === 1 &&
    settings.ga4_measurement_id !== null &&
    (settings.ga4_route === "direct" || gtmAllowed);
  const metaEnabled =
    row.allow_meta_pixel === 1 &&
    settings.meta_pixel_id !== null &&
    (settings.meta_route === "direct" || gtmAllowed);

  return {
    ga4: ga4Enabled
      ? {
          id: settings.ga4_measurement_id as string,
          route: settings.ga4_route,
        }
      : null,
    meta: metaEnabled
      ? { id: settings.meta_pixel_id as string, route: settings.meta_route }
      : null,
    gtm:
      gtmAllowed && settings.gtm_container_id !== null
        ? { id: settings.gtm_container_id }
        : null,
  };
}
