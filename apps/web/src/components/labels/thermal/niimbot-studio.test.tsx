import 'fake-indexeddb/auto';
import { I18nProvider } from '@lingui/react';
import { createCanvas } from '@napi-rs/canvas';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components/ui/confirm';
import { activateLocale, i18n } from '@/i18n/i18n';
import type { PrintApi } from './api';
import type { NiimbotOutput } from './niimbot';
import { printStore } from './store';
import { ThermalStudio } from './studio';

beforeAll(async () => {
  await activateLocale('en');
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('verifies the selected model, then retries an interrupted offline job with the same labels', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return createCanvas(this.width, this.height).getContext(
      '2d',
    ) as unknown as CanvasRenderingContext2D;
  });
  const device = { id: '075A6BA9-D3C0-4D44-B28D-466C4DB21040', name: 'B1-1234' };
  const identify = vi.fn().mockResolvedValueOnce({ modelId: 4096 }).mockResolvedValue({
    modelId: 4097,
    protocolGeneration: 5,
  });
  const print = vi
    .fn()
    .mockResolvedValueOnce({ state: 'uncertain', completed: 0 })
    .mockResolvedValue({
      state: 'completed',
      completed: 1,
    });
  const bluetooth = {
    discover: vi.fn(async () => [device]),
    identify,
    print,
    cancel: vi.fn(),
  } satisfies NiimbotOutput;
  const api = {
    address: vi.fn(async () => 'https://labels.example.org'),
    preview: vi.fn(),
    create: vi.fn(),
    replace: vi.fn(),
    registerTag: vi.fn(),
    confirm: vi.fn(),
  } satisfies PrintApi;
  const owner = 'niimbot-transport-fixture';
  const source = { kind: 'blank', locationId: '4f12b285-9dcf-4e3c-b6b4-5e545278f26a' } as const;
  render(
    <I18nProvider i18n={i18n}>
      <ConfirmProvider>
        <ThermalStudio owner={owner} source={source} api={api} bluetooth={bluetooth} />
      </ConfirmProvider>
    </I18nProvider>,
  );
  const user = userEvent.setup();
  const quantity = screen.getByRole('spinbutton', { name: 'Quantity' });
  await user.clear(quantity);
  await user.type(quantity, '2');
  const settings = screen.getByRole('button', { name: 'Printer settings' });
  await user.click(settings);
  const setup = await screen.findByRole('dialog', { name: 'Printer settings' });
  await user.click(within(setup).getByRole('button', { name: 'Find nearby printers' }));
  await user.click(await screen.findByRole('button', { name: device.name }));
  expect(
    await screen.findByText('This printer did not identify as a NIIMBOT B1 Pro.'),
  ).toBeVisible();
  expect(await printStore.preferences.get(owner)).not.toMatchObject({
    profileId: `niimbot:${device.id}`,
  });
  await user.click(screen.getByRole('button', { name: device.name }));
  expect(await screen.findByText(/B1 Pro verified at 300 DPI/)).toBeVisible();
  expect(await printStore.preferences.get(owner)).toMatchObject({
    profileId: `niimbot:${device.id}`,
  });

  await user.click(within(setup).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(settings).toHaveFocus());
  expect(quantity).toHaveValue(2);
  await user.clear(quantity);
  await user.type(quantity, '1');
  await user.click(screen.getByRole('button', { name: 'Prepare labels' }));
  const send = await screen.findByRole('button', { name: 'Print on B1 Pro' });
  await user.click(send);
  expect(await screen.findByText(/Print completion is uncertain/)).toBeVisible();
  expect(print).toHaveBeenCalledExactlyOnceWith(
    device.id,
    expect.objectContaining({ width: 567, height: 236, copies: 1, density: 3 }),
  );
  const before = (
    await printStore.jobs.where('[owner+locationId]').equals([owner, source.locationId]).toArray()
  )[0];
  expect(before?.prints.map(({ state }) => state)).toEqual(['connecting', 'uncertain']);
  await user.click(send);
  const dialog = await screen.findByRole('alertdialog', { name: 'Print these labels again?' });
  await user.click(within(dialog).getByRole('button', { name: 'Print' }));
  expect(await screen.findByText(/The printer reports completion/)).toBeVisible();
  expect(print.mock.calls[1]).toEqual(print.mock.calls[0]);
  await waitFor(async () => {
    const after = before && (await printStore.jobs.get(before.id));
    expect(after?.codes).toEqual(before?.codes);
    expect(after?.prints.at(-1)?.state).toBe('printer-completed');
  });
  expect(api.create).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();

  await user.click(settings);
  const reopened = await screen.findByRole('dialog', { name: 'Printer settings' });
  await user.click(within(reopened).getByRole('button', { name: 'Forget printer' }));
  expect(await within(reopened).findByText('No remembered printers.')).toBeVisible();
  await user.click(within(reopened).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('button', { name: 'Print on B1 Pro' })).not.toBeInTheDocument();
  expect(await printStore.jobs.get(before?.id ?? '')).toMatchObject({ codes: before?.codes });
}, 10_000);
