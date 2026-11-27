import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ownerScenario, signedOutScenario } from '@/api/mock/fixtures';
import { paths } from '@/api/paths';
import { startLocale } from '@/i18n/i18n';
import { LOCALE_KEY } from '@/lib/prefs';
import { findHeading, renderApp } from '@/test/app';

it('shows English settings and leaves a legacy account language alone', async () => {
  const state = ownerScenario();
  state.me.profile.locale = 'es';
  localStorage.setItem(LOCALE_KEY, 'ar');
  await startLocale();
  const { mock } = await renderApp('/settings', { state });
  await findHeading('Settings');
  expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
  expect(mock.state.me.profile.locale).toBe('es');
  expect(mock.calls.some((call) => call.method === 'PATCH' && call.path === paths.me)).toBe(false);
});

it('shows the English sign-in page without a language picker', async () => {
  await renderApp('/signin', { state: signedOutScenario() });
  await findHeading('Sign in');
  expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
});
