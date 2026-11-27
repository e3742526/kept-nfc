import { I18nProvider } from '@lingui/react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, expect, it, vi } from 'vitest';
import { activateLocale, i18n } from '@/i18n/i18n';
import { DEFAULT_THERMAL_OPTIONS } from './document';
import { TemplateLibrary } from './template-library';

beforeAll(async () => {
  await activateLocale('en');
});
it('shows only compatible layouts and applies a selected layout', async () => {
  const change = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <I18nProvider i18n={i18n}>
      <TemplateLibrary stock="thermal_50x20" options={DEFAULT_THERMAL_OPTIONS} onSelect={change} />
    </I18nProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'View templates' }));
  const dialog = screen.getByRole('dialog', { name: 'Label templates' });
  expect(within(dialog).getByText('Small-parts drawer')).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Use template' }));
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ template: 'drawer' }));
  view.unmount();
  render(
    <I18nProvider i18n={i18n}>
      <TemplateLibrary stock="thermal_40x20" options={DEFAULT_THERMAL_OPTIONS} />
    </I18nProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'View templates' }));
  expect(screen.queryByText('Small-parts drawer')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use template' })).not.toBeInTheDocument();
});
