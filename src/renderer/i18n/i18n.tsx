import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EN_MESSAGES, type MessageKey, ZH_MESSAGES } from "./messages";

export type UiLanguage = "zh-CN" | "en";
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const LANGUAGE_STORAGE_KEY = "pi-ecode:language";

interface I18nValue {
  language: UiLanguage;
  locale: string;
  setLanguage: (language: UiLanguage) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function translate(
  language: UiLanguage,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const template = language === "zh-CN" ? ZH_MESSAGES[key] : EN_MESSAGES[key];
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function initialLanguage(): UiLanguage {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "en" || stored === "zh-CN" ? stored : "zh-CN";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<UiLanguage>(initialLanguage);
  const value = useMemo<I18nValue>(() => ({
    language,
    locale: language === "zh-CN" ? "zh-CN" : "en-US",
    setLanguage: (nextLanguage) => {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
      setLanguageState(nextLanguage);
    },
    t: (key, values) => translate(language, key, values),
  }), [language]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
