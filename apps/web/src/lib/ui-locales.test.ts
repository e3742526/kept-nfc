import { afterEach, describe, expect, it, vi } from 'vitest';

// The interface languages a build offers (prefs.ts UI_LOCALES). The test run turns every language
// on (vitest.config.ts); a build without VITE_UI_LOCALES offers English only.
async function prefsWith(offered: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_UI_LOCALES', offered ?? '');
  return import('./prefs');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('UI_LOCALES', () => {
  it('is English only when the build names none; a stored or browser language shows English', async () => {
    const prefs = await prefsWith(undefined);
    expect(prefs.UI_LOCALES).toEqual(['en']);
    // Every language keeps its catalogue and stays a language SheepKeep knows.
    expect(prefs.LOCALES).toHaveLength(8);
    expect(prefs.isLocale('de')).toBe(true);
    expect(prefs.isUiLocale('de')).toBe(false);
    localStorage.setItem(prefs.LOCALE_KEY, 'de');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');
    expect(prefs.initialLocale()).toBe('en');
    localStorage.removeItem(prefs.LOCALE_KEY);
    expect(prefs.initialLocale()).toBe('en');
  });

  it('offers the languages the build names, and ignores ones SheepKeep has no catalogue for', async () => {
    const prefs = await prefsWith('en, de,xx');
    expect(prefs.UI_LOCALES).toEqual(['en', 'de']);
    localStorage.setItem(prefs.LOCALE_KEY, 'de');
    expect(prefs.initialLocale()).toBe('de');
    localStorage.setItem(prefs.LOCALE_KEY, 'fr');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-AT');
    expect(prefs.initialLocale()).toBe('de');
  });
});
