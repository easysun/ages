export type Locale = "en" | "zh-Hant";

export function supportedLocale(
  value: string | null | undefined,
): Locale | null {
  if (value === "zh-TW") return "zh-Hant";
  if (value === "en" || value === "zh-Hant") return value;
  return null;
}

export function browserLocale(
  languages: readonly string[] | undefined,
  language: string,
): Locale {
  const preferences = languages?.length ? languages : [language];
  for (const preference of preferences) {
    const normalized = preference.toLowerCase();
    if (/^zh(-|$)/.test(normalized)) return "zh-Hant";
    if (/^en(-|$)/.test(normalized)) return "en";
  }
  return "en";
}
