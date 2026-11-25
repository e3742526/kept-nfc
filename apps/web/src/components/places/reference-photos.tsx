import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, ImagePlus, MapPin } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import type {
  AttachmentView,
  CreateAttachmentBody,
  FileView,
  PlaceView,
} from '@/api/inventory/types';
import { Notice, Section } from '@/components/page';
import { PhotoImage } from '@/components/photo-image';
import { useUploadErrorText } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';

const PhotoViewer = lazy(() => import('@/components/things/photo-viewer'));

export const isReferencePhoto = (attachment: AttachmentView) =>
  attachment.role === 'photo' &&
  !attachment.locationPhotoTakenAt &&
  !attachment.photoArchivedAt &&
  !!attachment.file?.mime.startsWith('image/');

export function referencePhotos(attachments: AttachmentView[]): AttachmentView[] {
  return attachments
    .filter(isReferencePhoto)
    .sort(
      (first, second) =>
        (second.thumbnailSelectedAt ?? '').localeCompare(first.thumbnailSelectedAt ?? '') ||
        first.sort - second.sort,
    );
}

type PhotoAttempt = {
  file: File;
  key: string;
  previous?: AttachmentView;
  uploadedId?: string;
  stale?: boolean;
};

export type ReferencePhotoActions = {
  upload(file: File, key: string): Promise<FileView>;
  attach(body: CreateAttachmentBody, key: string, version?: number): Promise<AttachmentView>;
  remove?(id: string): Promise<void>;
  cover?(photo: AttachmentView): Promise<AttachmentView>;
  queue?(file: File, previous?: AttachmentView): Promise<void>;
  reload(): Promise<AttachmentView[]>;
};

export function ReferencePhotos({
  place,
  editable,
  camera,
  actions,
  onChange,
  imageUrl = (url) => url,
  onError,
}: {
  place: Pick<PlaceView, 'id' | 'locationId' | 'attachments'>;
  editable: boolean;
  camera?: boolean;
  actions: ReferencePhotoActions;
  onChange: (id: string | undefined, photo?: AttachmentView) => void;
  imageUrl?: (url: string | null) => string | null;
  onError?: (error: unknown) => boolean;
}) {
  const { t } = useLingui();
  const errorText = useUploadErrorText();
  const confirm = useConfirm();
  const library = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<AttachmentView>(undefined);
  const [viewId, setViewId] = useState<string>();
  const [attempt, setAttempt] = useState<PhotoAttempt>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [queued, setQueued] = useState(false);
  const photos = referencePhotos(place.attachments).map((photo) => ({
    ...photo,
    file: photo.file && {
      ...photo.file,
      thumbUrl: imageUrl(photo.file.thumbUrl),
      displayUrl: imageUrl(photo.file.displayUrl),
    },
  }));
  const index = photos.findIndex((photo) => photo.id === viewId);

  async function save(selection: PhotoAttempt) {
    if (busy || !editable) return;
    setBusy(true);
    setMessage('');
    setQueued(false);
    let work = selection;
    try {
      if (actions.queue) {
        await actions.queue(work.file, work.previous);
        setAttempt(undefined);
        setQueued(true);
        return;
      }
      if (!work.uploadedId) {
        const file = await actions.upload(work.file, work.key);
        work = { ...work, uploadedId: file.id };
        setAttempt(work);
      }
      const previousId = work.previous?.id;
      const photo = await actions.attach(
        {
          id: work.key,
          fileId: work.uploadedId,
          locationId: place.locationId,
          subject: { placeId: place.id },
          role: 'photo',
          ...(previousId ? { replacesAttachmentId: previousId } : {}),
        },
        work.key,
        work.previous?.rowVersion,
      );
      onChange(previousId, { ...photo, canManage: true });
      setAttempt(undefined);
    } catch (error) {
      if (onError?.(error)) return;
      if (work.previous && error instanceof ApiError && [404, 412].includes(error.status)) {
        setAttempt({ ...work, stale: true });
        try {
          const latest = await actions.reload();
          if (!referencePhotos(latest).some((photo) => photo.id === work.previous?.id)) {
            setAttempt(undefined);
            setMessage(t`This reference photo is gone. Choose another photo to replace.`);
          } else {
            setMessage(t`This reference photo changed. Review it before replacing it.`);
          }
        } catch (reloadError) {
          if (!onError?.(reloadError)) setMessage(errorText(reloadError));
        }
      } else {
        setMessage(errorText(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function pick(input: HTMLInputElement, previous?: AttachmentView) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const work = { file, key: newId(), ...(previous ? { previous } : {}) };
    setAttempt(work);
    void save(work);
  }

  async function retry(work: PhotoAttempt) {
    if (!work.stale) return save(work);
    try {
      const previous = referencePhotos(await actions.reload()).find(
        (photo) => photo.id === work.previous?.id,
      );
      if (!previous) {
        setAttempt(undefined);
        setMessage(t`This reference photo is gone. Choose another photo to replace.`);
        return;
      }
      if (
        !(await confirm({
          title: t`Replace photo?`,
          body: previous.name ?? t`Replace the current reference photo with your selection.`,
          confirmLabel: t`Replace photo`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      const next = { ...work, previous, key: newId(), stale: false };
      setAttempt(next);
      await save(next);
    } catch (error) {
      if (!onError?.(error)) setMessage(errorText(error));
    }
  }

  async function remove(photo: AttachmentView) {
    if (
      !actions.remove ||
      busy ||
      !(await confirm({
        title: t`Remove photo?`,
        confirmLabel: t`Remove`,
        cancelLabel: t`Cancel`,
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setMessage('');
    try {
      await actions.remove(photo.id);
      onChange(photo.id);
    } catch (error) {
      if (!onError?.(error)) setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function cover(photo: AttachmentView) {
    if (!actions.cover || busy) return;
    setBusy(true);
    setMessage('');
    try {
      onChange(photo.id, await actions.cover(photo));
    } catch (error) {
      if (!onError?.(error)) setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (!editable && photos.length === 0) return null;
  return (
    <Section title={<Trans>Reference photos</Trans>}>
      {editable && (
        <div className="flex flex-wrap gap-2">
          <input
            ref={library}
            type="file"
            accept="image/*"
            hidden
            aria-label={t`Choose reference photo`}
            onChange={(event) => pick(event.currentTarget, replacing.current)}
          />
          {camera && (
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              aria-label={t`Take reference photo`}
              onChange={(event) => pick(event.currentTarget)}
            />
          )}
          <Button
            variant="secondary"
            isDisabled={busy || !!attempt}
            onPress={() => {
              replacing.current = undefined;
              library.current?.click();
            }}
          >
            <ImagePlus size={16} aria-hidden />
            <Trans>Add photo</Trans>
          </Button>
          {camera && (
            <Button
              variant="secondary"
              isDisabled={busy || !!attempt}
              onPress={() => cameraInput.current?.click()}
            >
              <Camera size={16} aria-hidden />
              <Trans>Take photo</Trans>
            </Button>
          )}
        </div>
      )}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.id} className="grid content-start gap-1">
              <Button
                variant="secondary"
                className="grid min-w-0 justify-items-center p-2"
                onPress={() => setViewId(photo.id)}
              >
                {photo.file?.thumbUrl ? (
                  <PhotoImage
                    src={photo.file.thumbUrl}
                    rotation={photo.photoRotation}
                    className="aspect-square w-full rounded-lg"
                  />
                ) : (
                  <MapPin className="m-4" size={24} aria-hidden />
                )}
                <bdi className="min-w-0 wrap-anywhere">{photo.name ?? t`Photograph`}</bdi>
              </Button>
              {editable && photo.canManage && (
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="small"
                    variant="ghost"
                    isDisabled={busy || !!attempt}
                    onPress={() => {
                      replacing.current = photo;
                      library.current?.click();
                    }}
                  >
                    <Trans>Replace photo</Trans>
                  </Button>
                  {actions.cover && photos[0]?.id !== photo.id && (
                    <Button
                      size="small"
                      variant="ghost"
                      isDisabled={busy || !!attempt}
                      onPress={() => void cover(photo)}
                    >
                      <Trans>Set as cover</Trans>
                    </Button>
                  )}
                  {actions.remove && (
                    <Button
                      size="small"
                      variant="ghost"
                      isDisabled={busy || !!attempt}
                      onPress={() => void remove(photo)}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <Notice tone="danger">{message}</Notice>}
      {queued && (
        <p role="status">
          <Trans>Saved on device</Trans>
        </p>
      )}
      {busy && (
        <p role="status">
          <Trans>Saving…</Trans>
        </p>
      )}
      {attempt && !busy && (
        <div className="flex flex-wrap gap-2">
          <Button onPress={() => void retry(attempt)}>
            {attempt.stale ? <Trans>Review replacement</Trans> : <Trans>Try again</Trans>}
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              setAttempt(undefined);
              setMessage('');
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
      {index >= 0 && (
        <Suspense fallback={null}>
          <PhotoViewer
            photos={photos}
            index={index}
            go={(delta) => setViewId(photos[index + delta]?.id ?? viewId)}
            rtl={document.documentElement.dir === 'rtl'}
            onClose={() => setViewId(undefined)}
          />
        </Suspense>
      )}
    </Section>
  );
}

export function changedReferences(rows: AttachmentView[], id?: string, photo?: AttachmentView) {
  if (id && photo) return rows.map((row) => (row.id === id ? photo : row));
  if (id) return rows.filter((row) => row.id !== id);
  return photo ? [...rows, photo] : rows;
}
