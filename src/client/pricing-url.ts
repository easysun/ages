import type { Locale } from "./locale";

export function officialPricingUrl(locale: Locale): string {
  return locale === "en"
    ? "https://ages.tw/pricing-en"
    : "https://ages.tw/pricing";
}
