import { afterEach, expect, it, vi } from 'vitest';
import { chosenLocale, initialLocale, LOCALE_KEY, localeToSend } from '@/lib/prefs';
import { i18n, startLocale } from './i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('starts in English and leaves the locale unset for a new device', async () => {
  vi.stubGlobal('navigator', { language: 'de-DE' });
  expect(await startLocale()).toBe('en');
  expect(localStorage.getItem(LOCALE_KEY)).toBeNull();
});

it('starts in English without sending a legacy interface preference to the account', async () => {
  localStorage.setItem(LOCALE_KEY, 'ar');
  expect(initialLocale()).toBe('en');
  expect(await startLocale()).toBe('en');
  expect(i18n.locale).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(document.documentElement.dir).toBe('ltr');
  expect(chosenLocale()).toBeNull();
  expect(localeToSend('en')).toBeNull();
});
