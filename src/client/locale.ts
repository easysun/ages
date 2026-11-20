export type Locale = "en" | "zh-Hant";

export function supportedLocale(
  value: string | null | undefined,
): Locale | null {
  if (value === "zh-TW") return "zh-Hant";
  if (value === "en" || value === "zh-Hant") return value;
  return null;
}
