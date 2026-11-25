/**
 * Offline, a catalogue never loaded online isn't cached (sw.ts), so the language asked for can fail
 * to load. The page then shows English and says so: `lang` and direction follow the language that
 * loaded, and the person's own choice stays stored for the next start.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { LOCALE_KEY, setLocale } from '@/lib/prefs';
import { i18n, startLocale } from './i18n';

vi.mock('../locales/ar/messages.po', () => {
  throw new Error('offline: the catalogue was never cached');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('shows English, marked as English, when the chosen catalogue cannot load', async () => {
  vi.stubGlobal('navigator', { language: 'en-GB' });
  setLocale('ar');
  expect(await startLocale()).toBe('en');
  expect(i18n.locale).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(document.documentElement.dir).not.toBe('rtl');
  expect(localStorage.getItem(LOCALE_KEY)).toBe('ar');
});
