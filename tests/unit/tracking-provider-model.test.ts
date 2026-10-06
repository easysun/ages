import { describe, expect, it } from "vitest";
import { trackingProviderSettingsSchema } from "../../src/tracking/providers";

const emptySettings = {
  ga4_measurement_id: null,
  meta_pixel_id: null,
  gtm_container_id: null,
  ga4_route: "direct",
  meta_route: "direct",
} as const;

describe("tracking provider settings", () => {
  it("accepts provider IDs only in their documented formats", () => {
    expect(
      trackingProviderSettingsSchema.safeParse({
        ...emptySettings,
        ga4_measurement_id: "G-ABC123",
        meta_pixel_id: "1234567890",
        gtm_container_id: "GTM-ABC123",
      }).success,
    ).toBe(true);

    for (const value of [
      { ...emptySettings, ga4_measurement_id: "g-ABC123" },
      { ...emptySettings, ga4_measurement_id: "G-ABC 123" },
      { ...emptySettings, ga4_measurement_id: "G-ABC<script>" },
      { ...emptySettings, meta_pixel_id: "1234567890x" },
      { ...emptySettings, meta_pixel_id: " 1234567890" },
      { ...emptySettings, gtm_container_id: "GTM-ABC\n123" },
      { ...emptySettings, gtm_container_id: "GTM-ABC;alert(1)" },
    ]) {
      expect(trackingProviderSettingsSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("keeps each provider on exactly one direct or GTM route", () => {
    const gtmRouted = {
      ...emptySettings,
      ga4_measurement_id: "G-ABC123",
      meta_pixel_id: "1234567890",
      gtm_container_id: "GTM-ABC123",
      ga4_route: "gtm",
      meta_route: "direct",
    };
    expect(trackingProviderSettingsSchema.safeParse(gtmRouted).success).toBe(
      true,
    );
    expect(
      trackingProviderSettingsSchema.safeParse({
        ...gtmRouted,
        gtm_container_id: null,
      }).success,
    ).toBe(false);
    expect(
      trackingProviderSettingsSchema.safeParse({
        ...emptySettings,
        ga4_route: "both",
      }).success,
    ).toBe(false);
    expect(
      trackingProviderSettingsSchema.safeParse({
        ...emptySettings,
        unexpected: "G-ABC123",
      }).success,
    ).toBe(false);
  });
});
