import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import type { Locale } from "./locale";

export type { Locale } from "./locale";

const messages = {
  home: ["Ages home", "Ages 首頁"],
  skip: ["Skip to content", "跳至主要內容"],
  headerNote: ["A home for your moments", "收藏生活時刻的地方"],
  signOut: ["Sign out", "登出"],
  logoutError: [
    "Sign out could not be completed. Please try again.",
    "無法完成登出，請再試一次。",
  ],
  privateLabel: ["Made to keep", "留住珍貴時刻"],
  navigation: ["Primary navigation", "主要導覽"],
  library: ["Library", "素材庫"],
  timelines: ["Timelines", "時間軸"],
  content: ["Content", "內容"],
  links: ["Links", "連結"],
  tracking: ["Tracking settings", "追蹤設定"],
  plans: ["Plans", "方案"],
  moderation: ["Moderation", "內容管理"],
  opening: ["Opening your library…", "正在開啟素材庫…"],
  retry: ["Try again", "再試一次"],
  accessDenied: ["Access denied", "無法存取"],
  adminRequired: [
    "This page requires an administrator account.",
    "此頁面需要管理員帳號。",
  ],
  notFound: ["Page not found", "找不到頁面"],
  openLibrary: ["Open your library", "開啟素材庫"],
  landingEyebrow: [
    "Photos. Stories. A little more life.",
    "照片、故事，與生活的點滴。",
  ],
  landingTitle: ["Keep your moments close.", "珍藏你的每個時刻。"],
  landingIntro: [
    "A place for the photos and videos you want to come back to. Begin with a moment. Keep adding as life unfolds.",
    "收藏想要一再回看的照片與影片。從一個時刻開始，隨著生活繼續記錄。",
  ],
  google: ["Continue with Google", "使用 Google 繼續"],
  privateStart: [
    "Your library starts private. Your memories stay yours.",
    "你的素材庫預設為私人，回憶由你掌握。",
  ],
  explorePlans: ["Explore plans", "查看方案"],
  reportLink: ["Report an Ages Link", "檢舉 Ages 連結"],
  paperOne: ["The places we return to", "我們一再回訪的地方"],
  paperTwo: ["The small things, too", "生活中的小事"],
  artNote: ["Collected, with care.", "用心收藏。"],
  landingFooter: ["ONE MOMENT AT A TIME", "把每個時刻好好收藏"],
  livingLibrary: ["Ages — a living library", "Ages — 持續成長的回憶庫"],
} as const;

type MessageKey = keyof typeof messages;
type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
const key = "ages_locale";

export function supportedLocale(
  value: string | null | undefined,
): Locale | null {
  if (value === "en" || value === "zh-Hant") return value;
  return null;
}

function initialLocale(): Locale {
  try {
    const saved = supportedLocale(window.localStorage.getItem(key));
    if (saved) return saved;
  } catch {
    // Storage can be unavailable in private browsing or embedded clients.
  }
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${key}=`));
    const cookieValue = supportedLocale(cookie?.slice(key.length + 1));
    if (cookieValue) return cookieValue;
  } catch {
    // Fall back to the browser language when cookies are unavailable.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(key, locale);
    } catch {
      // Continue with the current session when storage is blocked.
    }
    try {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${key}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch {
      // Language remains usable in memory when cookies are blocked.
    }
  }, [locale]);
  return (
    <LocaleContext.Provider
      value={{
        locale,
        setLocale,
        t: (name) => messages[name][locale === "en" ? 0 : 1],
      }}
    >
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("LocaleProvider is required");
  return value;
}
