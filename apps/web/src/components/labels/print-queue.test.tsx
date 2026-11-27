import { I18nProvider } from '@lingui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, expect, it, vi } from 'vitest';
import { activateLocale, i18n } from '@/i18n/i18n';
import { PrintQueue, type PrintQueueRequest } from './print-queue';

beforeAll(async () => {
  await activateLocale('en');
});

it('routes a queued batch to the chosen printer stock', async () => {
  const items = [
    {
      locationId: 'location',
      kind: 'thing' as const,
      recordId: 'item',
      batchId: null,
      name: 'Drill',
      available: true,
    },
  ];
  const request = vi.fn<PrintQueueRequest>(async (action) =>
    action?.action === 'prepare' ? { items, batchId: 'batch' } : { items },
  );
  const openBatch = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nProvider i18n={i18n}>
      <PrintQueue
        request={request}
        locationName={() => 'Home'}
        openBatch={openBatch}
        confirmPrinted={async () => {}}
        printerSettings={<p>Choose a Bluetooth printer</p>}
      />
    </I18nProvider>,
  );
  await screen.findByText('Drill');
  await user.click(screen.getByRole('button', { name: /Printer/ }));
  await user.click(screen.getByRole('option', { name: 'NIIMBOT B1 Pro' }));
  expect(screen.getByText('Choose a Bluetooth printer')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Prepare labels' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      action: 'prepare',
      locationId: 'location',
      kind: 'thing',
      stock: 'thermal_50x20',
    }),
  );
  expect(openBatch).toHaveBeenCalledWith('batch');
});
