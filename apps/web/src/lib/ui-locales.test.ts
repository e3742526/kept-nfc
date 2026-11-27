import { afterEach, expect, it, vi } from 'vitest';
import { chosenLocale, initialLocale, isLocale, isUiLocale, LOCALE_KEY, UI_LOCALES } from './prefs';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('offers English and ignores old interface choices and the browser language', () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');
  localStorage.setItem(LOCALE_KEY, 'de');
  expect(UI_LOCALES).toEqual(['en']);
  expect(isLocale('de')).toBe(true);
  expect(isUiLocale('de')).toBe(false);
  expect(chosenLocale()).toBeNull();
  expect(initialLocale()).toBe('en');
});
