import { useEffect, useState } from 'react';
import { ApiError } from '@/api/client';
import type { AttachmentView, PlaceView } from '@/api/inventory/types';
import { referencePhotos } from '@/components/places/reference-photos';
import { type PlatformAdapters, usePlatform } from './adapters';
import type { Connection } from './bridge';

const key = 'placePhotoCache';
const storageLimit = 60_000;
type PlacePhotos = {
  id: string;
  locationId: string;
  photos: AttachmentView[];
  cover?: { fileId: string; jpeg: string };
};
type PlaceScope = (place: Pick<PlacePhotos, 'id' | 'locationId'>) => boolean;
type PlaceRead = { inScope?: PlaceScope };
const placeReads = new Map<string, Map<string, PlaceRead>>();

async function read(connection: Connection, adapters: PlatformAdapters): Promise<PlacePhotos[]> {
  const value = await adapters.outbox.getValue(connection, key);
  return value ? (JSON.parse(value) as PlacePhotos[]) : [];
}

// Prevent intersecting record loads, mutations and inventory refreshes from losing cache updates.
let writes: Promise<void> = Promise.resolve();
function update(
  connection: Connection,
  adapters: PlatformAdapters,
  change: (places: PlacePhotos[]) => PlacePhotos[] | Promise<PlacePhotos[]>,
) {
  const write = writes.then(async () => {
    const current = await read(connection, adapters);
    const next = await change(current);
    if (next === current) return;
    while (next.length && new TextEncoder().encode(JSON.stringify(next)).length > storageLimit)
      next.pop();
    if (next.length) await adapters.outbox.setValue(connection, key, JSON.stringify(next));
    else await adapters.outbox.deleteValue(connection, key);
  });
  writes = write.catch(() => {});
  return write;
}

function rememberPlacePhotos(
  connection: Connection,
  adapters: PlatformAdapters,
  place: Pick<PlaceView, 'id' | 'locationId' | 'attachments'>,
  isCurrent: () => boolean,
) {
  return update(connection, adapters, async (places) => {
    if (!isCurrent()) return places;
    const remaining = places.filter(({ id }) => id !== place.id);
    const photos = referencePhotos(place.attachments).slice(0, 12);
    if (!photos.length) return remaining.length === places.length ? places : remaining;
    const file = photos[0]?.file;
    const previous = places.find(({ id }) => id === place.id)?.cover;
    let cover = previous?.fileId === file?.id ? previous : undefined;
    if (!cover && file?.thumbUrl && adapters.media.readThumbnail) {
      const jpeg = await adapters.media
        .readThumbnail(connection, file.thumbUrl)
        .catch(() => undefined);
      if (jpeg && jpeg.length <= 54_616) cover = { fileId: file.id, jpeg };
    }
    if (!isCurrent()) return places;
    return [
      {
        id: place.id,
        locationId: place.locationId,
        photos: photos.map((photo) => ({
          ...photo,
          url: null,
          file: photo.file && { ...photo.file, thumbUrl: null, displayUrl: null },
        })),
        ...(cover ? { cover } : {}),
      },
      ...remaining.slice(0, 19),
    ];
  });
}

/** Only the current request for a place can repopulate its offline gallery. */
export async function loadPlaceWithPhotoCache(
  connection: Connection,
  adapters: PlatformAdapters,
  id: string,
  request: () => Promise<PlaceView>,
): Promise<PlaceView> {
  const reads = placeReads.get(connection.id) ?? new Map<string, PlaceRead>();
  placeReads.set(connection.id, reads);
  const read: PlaceRead = {};
  reads.set(id, read);
  const isCurrent = () => reads.get(id) === read;
  const release = () => {
    if (isCurrent()) reads.delete(id);
    if (!reads.size && placeReads.get(connection.id) === reads) placeReads.delete(connection.id);
  };
  let save: Promise<void> | undefined;
  try {
    const place = await request();
    if (isCurrent() && place?.id === id && Array.isArray(place.attachments)) {
      save = rememberPlacePhotos(
        connection,
        adapters,
        place,
        () => isCurrent() && read.inScope?.(place) !== false,
      );
    }
    return place;
  } catch (error) {
    if (isCurrent() && error instanceof ApiError && [403, 404].includes(error.status)) {
      void forgetPlacePhotos(connection, adapters, id).catch(() => {});
    }
    throw error;
  } finally {
    if (save) void save.then(release, release);
    else release();
  }
}

export function prunePlacePhotos(
  connection: Connection,
  adapters: PlatformAdapters,
  keep: PlaceScope,
) {
  return update(connection, adapters, (places) => {
    const retained = places.filter(keep);
    return retained.length === places.length ? places : retained;
  });
}

export function forgetPlacePhotos(connection: Connection, adapters: PlatformAdapters, id: string) {
  placeReads.get(connection.id)?.delete(id);
  return prunePlacePhotos(connection, adapters, (place) => place.id !== id);
}

export async function refreshPlacePhotoCache(
  connection: Connection,
  adapters: PlatformAdapters,
  keep: PlaceScope,
  reload: (id: string) => Promise<unknown>,
) {
  // A pending detail response must still belong to the refreshed inventory.
  for (const read of placeReads.get(connection.id)?.values() ?? []) read.inScope = keep;
  await prunePlacePhotos(connection, adapters, keep);
  const cached = await read(connection, adapters);
  await Promise.allSettled(cached.map(({ id }) => reload(id)));
}

export function useOfflinePlacePhotos(connection: Connection, id: string, online: boolean) {
  const adapters = usePlatform();
  const [cached, setCached] = useState<{ context: string; id: string; photos: AttachmentView[] }>();
  useEffect(() => {
    if (online) {
      setCached(undefined);
      return;
    }
    let active = true;
    let url: string | undefined;
    void writes
      .then(() => read(connection, adapters))
      .then((places) => {
        if (!active) return;
        const place = places.find((place) => place.id === id);
        if (!place) {
          setCached(undefined);
          return;
        }
        const { cover } = place;
        if (cover && typeof URL.createObjectURL === 'function') {
          const bytes = Uint8Array.from(atob(cover.jpeg), (byte) => byte.charCodeAt(0));
          url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        }
        const photos = place.photos.map((photo) =>
          photo.file && url && photo.file.id === cover?.fileId
            ? { ...photo, file: { ...photo.file, thumbUrl: url, displayUrl: url } }
            : photo,
        );
        setCached({ context: connection.id, id, photos });
      })
      .catch(() => {
        if (active) setCached(undefined);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [adapters, connection, id, online]);
  return !online && cached?.context === connection.id && cached.id === id
    ? cached.photos
    : undefined;
}
