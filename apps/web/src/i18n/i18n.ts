/**
 * Lingui (D96): ICU messages, PO catalogues in src/locales/<locale>/messages.po, compiled on
 * import by @lingui/vite-plugin. `pnpm --filter @kept/web i18n:extract` refreshes the catalogues.
 */
import { i18n } from '@lingui/core';
import { localiseSeparators } from '@/lib/format';
import {
  type Digits,
  formatLocale,
  type Locale,
  settleStoredLocale,
  showLocale,
  storedDigits,
} from '@/lib/prefs';

/**
 * `locales` carries the digit choice (D143) into Lingui's own number, date and plural `#`
 * formatting, so `plural(n, …)` in Arabic shows ٣ or 3 as the person chose.
 */
export async function activateLocale(locale: Locale, digits: Digits = 'eastern'): Promise<void> {
  const { messages } = await import('../locales/en/messages.po');
  i18n.loadAndActivate({
    locale,
    locales: [formatLocale(locale, digits)],
    messages: localiseSeparators(messages, locale),
  });
}

/** English is the interface language, including when an older device stored another choice. */
export async function startLocale(): Promise<Locale> {
  settleStoredLocale();
  await activateLocale('en', storedDigits()).catch(() =>
    i18n.loadAndActivate({ locale: 'en', messages: {} }),
  );
  showLocale('en');
  return 'en';
}

export { i18n };
