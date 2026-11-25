import { inventoryPaths } from '@/api/inventory/paths';
import type { AttachmentView, PlaceView } from '@/api/inventory/types';
import { capForUpload } from '@/camera/image';
import { ReferencePhotos } from '@/components/places/reference-photos';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import { previewUrl } from './inventory';
import { isAuthRefusal, isRestoreEpochMismatch, saveOnPhone, stageOriginal } from './outbox';

export function NativePlacePhotos({
  connection,
  place,
  editable,
  online,
  pendingPlace,
  onQueued,
  onChange,
  reload,
  onAuthError,
}: {
  connection: Connection;
  place: Pick<PlaceView, 'id' | 'locationId' | 'attachments' | 'name'>;
  editable: boolean;
  online: boolean;
  pendingPlace?: boolean | undefined;
  onQueued: () => void;
  onChange: (id: string | undefined, photo?: AttachmentView) => void;
  reload: () => Promise<AttachmentView[]>;
  onAuthError?: ((reason: 'expired' | 'restored') => void) | undefined;
}) {
  const adapters = usePlatform();
  const { transport } = adapters;
  const connected = online && !pendingPlace;
  return (
    <ReferencePhotos
      place={place}
      editable={editable}
      camera
      imageUrl={(url) =>
        url?.startsWith('blob:') ? url : (previewUrl(url, connection.origin) ?? null)
      }
      actions={{
        ...(!connected
          ? {
              queue: async (file: File, previous?: AttachmentView) => {
                await saveOnPhone(
                  connection,
                  {
                    locationId: place.locationId,
                    placeId: place.id,
                    name: file.name || place.name,
                    placePhoto: previous
                      ? { replaces: { id: previous.id, rowVersion: previous.rowVersion } }
                      : {},
                    ...(pendingPlace ? { dependsOnPlace: place.id } : {}),
                  },
                  [{ file, role: 'photo' }],
                  adapters,
                );
                onQueued();
              },
            }
          : {
              remove: (id: string) =>
                transport.request<void>(connection, inventoryPaths.attachment(id), {
                  method: 'DELETE',
                }),
              cover: async (photo: AttachmentView) => ({
                ...(await transport.request<AttachmentView>(
                  connection,
                  inventoryPaths.attachment(photo.id),
                  {
                    method: 'PATCH',
                    ifMatch: photo.rowVersion,
                    body: { selectThumbnail: true },
                  },
                )),
                canManage: photo.canManage === true,
              }),
            }),
        upload: async (file, key) => {
          const capped = await capForUpload(file);
          try {
            await stageOriginal(connection, adapters, key, key, capped);
            return await transport.uploadOriginal(connection, {
              id: key,
              file: key,
              location: place.locationId,
              stagedPhotoMime: capped.type,
            });
          } finally {
            await adapters.outbox.abort(connection, key).catch(() => {});
          }
        },
        attach: (body, idempotencyKey, ifMatch) =>
          transport.request(connection, inventoryPaths.attachments, {
            method: 'POST',
            body,
            idempotencyKey,
            ifMatch,
          }),
        reload,
      }}
      onChange={onChange}
      onError={(error) => {
        if (isAuthRefusal(error)) {
          onAuthError?.('expired');
          return true;
        }
        if (isRestoreEpochMismatch(error)) {
          onAuthError?.('restored');
          return true;
        }
        return false;
      }}
    />
  );
}
