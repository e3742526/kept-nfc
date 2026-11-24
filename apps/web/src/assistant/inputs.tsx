import { ASSISTANT_PHOTO_MAX_BASE64, type AssistantModel } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { canvasToJpeg, decodeWithBitmap, drawScaled } from '@/camera/image';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';

const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_JPEG_BYTES = Math.floor(ASSISTANT_PHOTO_MAX_BASE64 / 4) * 3;
const AUTOMATIC = 'automatic';
export class AssistantPhotoError extends Error {}

export async function assistantPhotoBase64(file: File): Promise<string> {
  return encodePhoto(file).catch(() => {
    throw new AssistantPhotoError();
  });
}

async function encodePhoto(file: File): Promise<string> {
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Invalid photo size');
  let jpeg: Blob = file;
  if (file.type !== 'image/jpeg' || file.size > MAX_JPEG_BYTES) {
    const bitmap = await decodeWithBitmap(file).catch(async () => {
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { source: image, width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    try {
      jpeg = await canvasToJpeg(drawScaled(bitmap, 1024), 0.85);
    } finally {
      if (typeof ImageBitmap !== 'undefined' && bitmap.source instanceof ImageBitmap) {
        bitmap.source.close();
      }
    }
  }
  if (!jpeg.size || jpeg.size > MAX_JPEG_BYTES) throw new Error('Invalid JPEG size');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : '';
      const separator = data.indexOf(',');
      if (separator < 0) reject(new Error('Could not read photo'));
      else resolve(data.slice(separator + 1));
    };
    reader.readAsDataURL(jpeg);
  });
}

export function useAssistantInputs(models: AssistantModel[]) {
  const [selected, setModel] = useState<string>();
  const [photo, setPhoto] = useState<File>();
  const choices = photo ? models.filter((model) => model.vision) : models;
  return {
    choices,
    supportsPhotos: models.some((model) => model.vision),
    model: choices.find((model) => model.id === selected)?.id,
    photo,
    setModel,
    setPhoto,
  };
}

export function AssistantInputs({
  value,
  disabled,
}: {
  value: ReturnType<typeof useAssistantInputs>;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const { choices, model, photo, setModel, setPhoto, supportsPhotos } = value;
  if (!choices.length && !photo) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {choices.length > 0 && (
        <Select
          className="min-w-0 flex-1"
          label={t`Model`}
          items={[
            { id: AUTOMATIC, label: t`Automatic` },
            ...choices.map((option) => ({ id: `model:${option.id}`, label: option.id })),
          ]}
          selectedKey={model ? `model:${model}` : AUTOMATIC}
          isDisabled={disabled}
          onSelectionChange={(key) =>
            setModel(typeof key === 'string' && key.startsWith('model:') ? key.slice(6) : undefined)
          }
        >
          {(option) => (
            <SelectItem id={option.id} textValue={option.label}>
              <bdi>{option.label}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      {supportsPhotos && !photo && (
        <FileTrigger acceptedFileTypes={['image/*']} onSelect={(files) => setPhoto(files?.[0])}>
          <Button size="small" variant="secondary" isDisabled={disabled}>
            <Trans>Attach photo</Trans>
          </Button>
        </FileTrigger>
      )}
      {photo && (
        <div className="flex max-w-full items-center gap-2">
          <bdi className="min-w-0 break-all text-small">{photo.name}</bdi>
          <Button
            size="small"
            variant="secondary"
            isDisabled={disabled}
            onPress={() => setPhoto(undefined)}
          >
            <Trans>Remove photo</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
