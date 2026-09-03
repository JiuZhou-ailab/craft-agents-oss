// input: Locale messages, date-fns locales, and lightweight language metadata
// output: Complete synchronous locale registry for non-critical consumers
// pos: Compatibility registry; startup-sensitive renderers use lazy locale loading

/**
 * Canonical locale registry — single source of truth for all supported locales.
 *
 * To add a new locale:
 * 1. Create the locale JSON file in ./locales/
 * 2. Import the messages and date-fns locale below
 * 3. Add one entry to LOCALE_REGISTRY
 *
 * Everything else (SUPPORTED_LANGUAGE_CODES, LANGUAGES, i18n resources,
 * date locale lookup) is derived automatically. No other file needs to change.
 */

import type { Locale } from "date-fns";
import { LANGUAGES } from "./languages";

// ─── Translation resources ───────────────────────────────────────────────────
import enMessages from "./locales/en.json";
import esMessages from "./locales/es.json";
import zhHansMessages from "./locales/zh-Hans.json";
import jaMessages from "./locales/ja.json";
import huMessages from "./locales/hu.json";
import deMessages from "./locales/de.json";
import plMessages from "./locales/pl.json";

// ─── date-fns locales ────────────────────────────────────────────────────────
import { enUS } from "date-fns/locale/en-US";
import { es as esDateLocale } from "date-fns/locale/es";
import { zhCN } from "date-fns/locale/zh-CN";
import { ja as jaDateLocale } from "date-fns/locale/ja";
import { hu as huDateLocale } from "date-fns/locale/hu";
import { de as deDateLocale } from "date-fns/locale/de";
import { pl as plDateLocale } from "date-fns/locale/pl";

// ─── Registry ────────────────────────────────────────────────────────────────

interface LocaleEntry {
  nativeName: string;
  messages: Record<string, string>;
  dateLocale: Locale;
}

export const LOCALE_REGISTRY = {
  en: { ...LANGUAGES.en, messages: enMessages, dateLocale: enUS },
  es: { ...LANGUAGES.es, messages: esMessages, dateLocale: esDateLocale },
  "zh-Hans": {
    ...LANGUAGES["zh-Hans"],
    messages: zhHansMessages,
    dateLocale: zhCN,
  },
  ja: { ...LANGUAGES.ja, messages: jaMessages, dateLocale: jaDateLocale },
  hu: { ...LANGUAGES.hu, messages: huMessages, dateLocale: huDateLocale },
  de: {
    ...LANGUAGES.de,
    messages: deMessages,
    dateLocale: deDateLocale,
  },
  pl: { ...LANGUAGES.pl, messages: plMessages, dateLocale: plDateLocale },
} satisfies Record<string, LocaleEntry>;

export type { LanguageCode } from "./languages";
