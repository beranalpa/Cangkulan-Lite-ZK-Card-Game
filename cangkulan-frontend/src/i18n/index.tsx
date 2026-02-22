/**
 * Internationalization (i18n) Provider & Hook
 *
 * Uses react-intl with lazy-loaded locale data.
 * Supports English (en) and Indonesian (id).
 *
 * Usage:
 *   // In main.tsx or App.tsx:
 *   <I18nProvider><App /></I18nProvider>
 *
 *   // In any component:
 *   const { formatMessage } = useAppIntl();
 *   formatMessage({ id: 'nav.home' }) // → "Home" or "Beranda"
 *
 *   // Or with the FormattedMessage component:
 *   <FormattedMessage id="playing.yourTurn" />
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { IntlProvider } from 'react-intl';
import { useIntl } from 'react-intl';

// Re-export for convenience
export { FormattedMessage } from 'react-intl';

// ── Supported Locales ──────────────────────────────────────────────────────

export type SupportedLocale = 'en' | 'id';

export const SUPPORTED_LOCALES: { code: SupportedLocale; name: string; flag: string }[] = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'id', name: 'Bahasa Indonesia', flag: '🇮🇩' },
];

const STORAGE_KEY = 'cangkulan-locale';

// ── Message Loading ────────────────────────────────────────────────────────

// Import statically for reliability (small JSON files, ~4KB each)
import enMessages from './en.json';
import idMessages from './id.json';

const messages: Record<SupportedLocale, Record<string, string>> = {
  en: enMessages,
  id: idMessages,
};

// ── Detect Browser Locale ──────────────────────────────────────────────────

function detectLocale(): SupportedLocale {
  // Check saved preference
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'id') return saved;
  } catch { /* ignore */ }

  // Check browser language
  const browserLang = navigator.language?.toLowerCase() ?? '';
  if (browserLang.startsWith('id')) return 'id';

  return 'en';
}

// ── Context & Provider ─────────────────────────────────────────────────────

interface I18nContextType {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'en',
  setLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(detectLocale);

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch { /* ignore */ }
    // Update HTML lang attribute
    document.documentElement.lang = newLocale;
  }, []);

  // Set initial HTML lang
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale }}>
      <IntlProvider
        locale={locale}
        messages={messages[locale]}
        defaultLocale="en"
        onError={(err) => {
          // Suppress missing translation warnings in dev
          if (err.code === 'MISSING_TRANSLATION') return;
          console.error('[i18n]', err);
        }}
      >
        {children}
      </IntlProvider>
    </I18nContext.Provider>
  );
}

// ── Hooks ──────────────────────────────────────────────────────────────────

/** Access locale switching functionality */
export function useLocale() {
  return useContext(I18nContext);
}

/** Convenience wrapper around useIntl with locale switching */
export function useAppIntl() {
  const intl = useIntl();
  const { locale, setLocale } = useLocale();
  return { ...intl, locale, setLocale };
}
