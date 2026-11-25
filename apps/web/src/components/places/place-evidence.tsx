import type { PlaceEvidence } from '@kept/shared';
import { PhotoImage } from '@/components/photo-image';

export function PlaceEvidenceDetails({
  evidence,
  resolveThumbnail = (url) => url,
}: {
  evidence?: PlaceEvidence | undefined;
  resolveThumbnail?: (url: string) => string | undefined;
}) {
  const description = evidence?.description;
  const photo = evidence?.referencePhoto;
  const url = photo && resolveThumbnail(photo.thumbUrl);
  if (!description && !url) return null;
  return (
    <span className="flex min-w-0 items-start gap-2 font-normal text-small text-ink-2">
      {photo && url && (
        <PhotoImage
          src={url}
          alt={photo.placeName}
          rotation={photo.rotation}
          className="size-10 rounded-md border border-line"
        />
      )}
      {description && (
        <span className="grid min-w-0 [overflow-wrap:anywhere]">
          <bdi className="font-medium">{description.placeName}</bdi>
          <bdi>{description.text}</bdi>
        </span>
      )}
    </span>
  );
}
