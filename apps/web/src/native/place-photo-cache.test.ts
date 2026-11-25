import { describe, expect, it, vi } from 'vitest';
import type { AttachmentView, PlaceView } from '@/api/inventory/types';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import { loadPlace } from './inventory';
import { forgetPlacePhotos, prunePlacePhotos, refreshPlacePhotoCache } from './place-photo-cache';

const connection: Connection = {
  id: 'https://kept.example.com|qa|epoch',
  origin: 'https://kept.example.com',
  account: 'qa',
  epoch: 'epoch',
};

function placeWithPhoto(id: string) {
  const attachment = {
    id,
    role: 'photo',
    sort: 0,
    rowVersion: 1,
    file: { id, mime: 'image/jpeg', thumbUrl: `/thumb/${id}` },
  } as AttachmentView;
  return { id: 'shelf', locationId: 'garage', attachments: [attachment] } as PlaceView;
}

function harness() {
  const values = new Map<string, string>();
  const request = vi.fn<() => Promise<PlaceView>>();
  const readThumbnail = vi.fn(async () => 'dGh1bWI=');
  const stored = vi.fn(async (conn: Connection, key: string, value: string) => {
    values.set(`${conn.id}:${key}`, value);
  });
  const adapters: PlatformAdapters = {
    ...capacitorAdapters,
    transport: { ...capacitorAdapters.transport, request: <T>() => request() as Promise<T> },
    outbox: {
      ...capacitorAdapters.outbox,
      async getValue(conn, key) {
        return values.get(`${conn.id}:${key}`);
      },
      setValue: stored,
      async deleteValue(conn, key) {
        values.delete(`${conn.id}:${key}`);
      },
    },
    media: { ...capacitorAdapters.media, readThumbnail },
  };
  return {
    adapters,
    request,
    readThumbnail,
    stored,
    settled: () => prunePlacePhotos(connection, adapters, () => true),
    cached: () => adapters.outbox.getValue(connection, 'placePhotoCache'),
  };
}

describe('offline place photos', () => {
  it('ignores a place detail response that arrives after access was removed by the snapshot', async () => {
    const { adapters, request, settled, cached } = harness();
    const previous = Promise.withResolvers<PlaceView>();
    request.mockReturnValueOnce(previous.promise);
    const read = loadPlace(connection, 'shelf', adapters);
    const reload = vi.fn();
    await refreshPlacePhotoCache(connection, adapters, () => false, reload);
    previous.resolve(placeWithPhoto('previous'));
    await read;
    await settled();
    expect(reload).not.toHaveBeenCalled();
    expect(await cached()).toBeUndefined();
  });

  it('keeps the newer cover when an earlier place detail arrives last', async () => {
    const { adapters, request, settled, cached } = harness();
    const previous = Promise.withResolvers<PlaceView>();
    request.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(placeWithPhoto('new'));
    const earlier = loadPlace(connection, 'shelf', adapters);
    await loadPlace(connection, 'shelf', adapters);
    previous.resolve(placeWithPhoto('previous'));
    await earlier;
    await settled();
    expect(await cached()).toContain('"fileId":"new"');
    expect(await cached()).not.toContain('previous');
  });

  it('caches a pending detail response when the refreshed inventory still includes the place', async () => {
    const { adapters, request, settled, cached } = harness();
    const response = Promise.withResolvers<PlaceView>();
    request.mockReturnValueOnce(response.promise);
    const pending = loadPlace(connection, 'shelf', adapters);
    await refreshPlacePhotoCache(
      connection,
      adapters,
      ({ locationId }) => locationId === 'garage',
      vi.fn(),
    );
    response.resolve(placeWithPhoto('cover'));
    await pending;
    await settled();
    expect(await cached()).toContain('"fileId":"cover"');
  });

  it('discards a thumbnail download already in progress when a photo is invalidated', async () => {
    const { adapters, request, readThumbnail, stored, cached } = harness();
    const download = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    readThumbnail.mockImplementationOnce(() => {
      started.resolve();
      return download.promise;
    });
    request.mockResolvedValueOnce(placeWithPhoto('previous'));
    await loadPlace(connection, 'shelf', adapters);
    await started.promise;
    const forgotten = forgetPlacePhotos(connection, adapters, 'shelf');
    download.resolve('dGh1bWI=');
    await forgotten;
    expect(stored).not.toHaveBeenCalled();
    expect(await cached()).toBeUndefined();
  });
});
