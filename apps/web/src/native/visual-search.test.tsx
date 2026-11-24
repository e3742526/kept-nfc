import type { VisualSearchCoverage, VisualSearchInputResponse } from '@kept/shared';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { activateLocale, i18n } from '@/i18n/i18n';
import { capacitorAdapters, NativePlatformProvider } from './adapters';
import type { Connection } from './bridge';
import { VisualSearchScreen } from './visual-search';
import { VisualSearchProtocolError } from './visual-search-api';

beforeAll(async () => {
  await activateLocale('en');
});

const connection: Connection = {
  id: 'native-1',
  origin: 'https://sheepkeep.example',
  epoch: 'generation-1',
  account: 'account-1',
};
const locationId = '11111111-1111-7111-8111-111111111111';
const coverage: VisualSearchCoverage = {
  generation: 'whole-image-1',
  ready: 2,
  pending: 1,
  failed: 0,
  paused: 0,
};
const uploaded = {
  inputId: '22222222-2222-7222-8222-222222222222',
  expiresAt: '2026-11-24T17:00:00Z',
};

function setup(initial: 'text' | 'photo', online = true) {
  const adapter = {
    status: vi.fn().mockResolvedValue(coverage),
    upload: vi.fn().mockResolvedValue(uploaded),
    search: vi.fn().mockResolvedValue({ outcome: 'no_close_match', coverage, matches: [] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    thumbnail: vi.fn(),
  };
  const media = { ...capacitorAdapters.media, openRemote: vi.fn().mockResolvedValue(undefined) };
  const onOpen = vi.fn();
  const view = (enabled = true) => (
    <I18nProvider i18n={i18n}>
      <NativePlatformProvider adapters={{ ...capacitorAdapters, visualSearch: adapter, media }}>
        <VisualSearchScreen
          connection={connection}
          visible={enabled}
          online={online}
          intent={{ mode: initial, text: 'red electrical connector', locationId }}
          onBack={vi.fn()}
          onOpen={onOpen}
          onAuthError={vi.fn()}
        />
      </NativePlatformProvider>
    </I18nProvider>
  );
  const ui = render(view());
  return { adapter, media, onOpen, ...ui, show: (enabled: boolean) => ui.rerender(view(enabled)) };
}

describe('native photo search', () => {
  it('runs the Search words in the selected location and separates incomplete coverage from no match', async () => {
    const { adapter } = setup('text');
    expect(await screen.findByText(/No close photo match/)).toBeInTheDocument();
    expect(screen.getByText('Photo indexing is incomplete.')).toBeInTheDocument();
    expect(adapter.status).toHaveBeenCalledWith(connection, locationId);
    expect(adapter.search).toHaveBeenCalledWith(connection, {
      text: 'red electrical connector',
      locationIds: [locationId],
      limit: 8,
    });
  });

  it('does not contact the encoder offline', () => {
    const { adapter } = setup('photo', false);
    expect(screen.getByText('Photo search needs a connection.')).toBeInTheDocument();
    expect(adapter.status).not.toHaveBeenCalled();
    expect(adapter.upload).not.toHaveBeenCalled();
  });

  it('distinguishes an incompatible response from an empty index', async () => {
    const { adapter } = setup('photo');
    adapter.search.mockRejectedValue(new VisualSearchProtocolError());
    const input = await screen.findByRole('textbox', { name: 'Describe what you are looking for' });
    await userEvent.clear(input);
    await userEvent.type(input, 'blue cable');
    await userEvent.click(screen.getByRole('button', { name: 'Find in photos' }));
    expect(
      await screen.findByText('Update your SheepKeep server to search photos.'),
    ).toBeInTheDocument();
  });

  it('releases an input whose upload finishes after cancellation', async () => {
    const { adapter, container } = setup('photo');
    let completeUpload: (value: VisualSearchInputResponse) => void = () => {};
    adapter.upload.mockImplementation(
      () =>
        new Promise<VisualSearchInputResponse>((resolve) => {
          completeUpload = resolve;
        }),
    );
    await screen.findByRole('button', { name: 'Choose a photo' });
    const picker = container.querySelector('input[type="file"]:not([capture])');
    if (!picker) throw new Error('Photo picker was missing');
    const image = new File(['fixture'], 'independent.heic', { type: 'image/heic' });
    fireEvent.change(picker, { target: { files: [image] } });
    await screen.findByRole('button', { name: 'Cancel' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => completeUpload(uploaded));
    expect(adapter.upload).toHaveBeenCalledWith(connection, image, locationId);
    expect(adapter.search).not.toHaveBeenCalled();
    expect(adapter.cancel).toHaveBeenCalledWith(connection, uploaded.inputId);
  });

  it('releases the input when search fails and explains unavailable inference', async () => {
    const { adapter, container } = setup('photo');
    adapter.search.mockRejectedValue(new ApiError(503, 'internal', 'Encoder unavailable'));
    await screen.findByRole('button', { name: 'Take a photo' });
    const picker = container.querySelector('input[type="file"][capture]');
    if (!picker) throw new Error('Camera picker was missing');
    fireEvent.change(picker, {
      target: { files: [new File(['fixture'], 'camera.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByText('Photo search is temporarily unavailable.')).toBeInTheDocument();
    await waitFor(() => expect(adapter.cancel).toHaveBeenCalledWith(connection, uploaded.inputId));
  });
});
