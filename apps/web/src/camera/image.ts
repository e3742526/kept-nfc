/**
 * What the phone does with a photo before it queues (D34, D36, D117; @kept/shared
 * `PHOTO_POLICY`):
 *
 * - **THING:** the photo is shrunk to 2048 px on the long edge, JPEG q0.85, and that JPEG is the
 *   only upload (the `original`). The full-size photo is never kept.
 * - **RECEIPT, LABEL, READING:** the photo is evidence. A camera frame is encoded at the track's
 *   resolution (within the camera setting), JPEG q0.92, and becomes the `original`; a file (the
 *   system camera, the gallery, a share) is kept **byte for byte** unless it is over 4096 px. Both get a 2048 px `display` JPEG made here, because the
 *   server can't decode HEIC and the phone can.
 * - **When the phone can't decode a file** (a HEIC on a browser without it, a PDF): the file
 *   goes as it is, with no display, and the server shows "preview unavailable" (D36). Never
 *   rejected.
 *
 * - **The camera setting** (settings.ts, 2048 px by default and at most) bounds a camera frame's
 *   long edge, evidence originals included.
 * - **Any image bigger than UPLOAD_MAX_PX** (4096) on its long edge, from a file or an upload, is
 *   re-encoded at that size before it is queued or sent; one at or under it goes as it is.
 *
 * Only canvas and `createImageBitmap`, so it works in every browser Kept supports; a decoder is
 * injectable for tests.
 */
import { type CaptureMode, newId, PHOTO_POLICY } from '@kept/shared';
import { sha256Hex } from '@/lib/sha256';
import type { LocalBlob } from '@/offline/store';
import { cameraMaxPx } from './settings';

/** The longest edge, in pixels, of any image sent to the server; larger ones are shrunk to it. */
export const UPLOAD_MAX_PX = 4096;

export const JPEG_QUALITY = { thing: 0.85, evidence: 0.92, display: 0.85 } as const;

/** A photo ready to queue: the upload, and the phone-made display for evidence modes. */
export type CapturedImage = {
  original: Blob;
  display: Blob | null;
  /** The phone couldn't decode it, so there is no display (D36 "preview unavailable"). */
  previewUnavailable: boolean;
};

/** A picture the canvas can draw, with its size. */
export type Drawable = { source: CanvasImageSource; width: number; height: number };

/** Decodes a file into something drawable; `createImageBitmap` by default. */
export type Decode = (blob: Blob) => Promise<Drawable>;

export const decodeWithBitmap: Decode = async (blob) => {
  if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
};

/** The size that fits `max` on the long edge, never enlarged. */
export function fitWithin(width: number, height: number, max: number) {
  const long = Math.max(width, height);
  if (long <= max || long === 0) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Draws `img` onto a new canvas, shrunk to `max` on the long edge when given. */
export function drawScaled(img: Drawable, max?: number): HTMLCanvasElement {
  const size = max ? fitWithin(img.width, img.height, max) : img;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(img.source, 0, 0, size.width, size.height);
  return canvas;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the canvas made no JPEG'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Re-encodes `img` at `max` on the long edge, as a PNG when `type` is one, else a JPEG. */
function shrunk(img: Drawable, max: number, type: string): Promise<Blob> {
  const canvas = drawScaled(img, max);
  if (type !== 'image/png') return canvasToJpeg(canvas, JPEG_QUALITY.evidence);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas made no PNG'))), type);
  });
}

/** Whether `img` is bigger than an upload may be. */
export const overUploadMax = (img: Drawable) => Math.max(img.width, img.height) > UPLOAD_MAX_PX;

/**
 * `file` as it may be uploaded: an image over UPLOAD_MAX_PX on its long edge, shrunk to it
 * (JPEG, or PNG for a PNG); anything else, or an image the phone can't decode, as it is.
 */
export async function capForUpload<T extends Blob>(
  file: T,
  decode: Decode = decodeWithBitmap,
): Promise<T | Blob> {
  if (!file.type.startsWith('image/')) return file;
  let img: Drawable | null = null;
  try {
    img = await decode(file);
    if (!overUploadMax(img)) return file;
    const blob = await shrunk(img, UPLOAD_MAX_PX, file.type);
    const name = 'name' in file && typeof file.name === 'string' ? file.name : null;
    return name !== null && typeof File === 'function'
      ? new File([blob], name, { type: blob.type, lastModified: Date.now() })
      : blob;
  } catch {
    return file;
  } finally {
    if (img && typeof ImageBitmap !== 'undefined' && img.source instanceof ImageBitmap)
      img.source.close();
  }
}

const evidence = (mode: CaptureMode) => PHOTO_POLICY[mode].keepOriginal;
const shrinkTo = (mode: CaptureMode) => {
  const policy = PHOTO_POLICY[mode];
  return policy.keepOriginal ? policy.displayTo : policy.shrinkTo;
};
/** A camera frame's long edge: what the mode shrinks to, and never more than the camera setting. */
const frameMax = (mode: CaptureMode, setting: number) => Math.min(shrinkTo(mode), setting);

/** A camera frame (already drawn at full resolution) → the blobs its mode keeps. */
export async function fromFrame(
  frame: Drawable,
  mode: CaptureMode,
  maxPx: number = cameraMaxPx(),
): Promise<CapturedImage> {
  if (!evidence(mode)) {
    const original = await canvasToJpeg(
      drawScaled(frame, frameMax(mode, maxPx)),
      JPEG_QUALITY.thing,
    );
    return { original, display: null, previewUnavailable: false };
  }
  const original = await canvasToJpeg(drawScaled(frame, maxPx), JPEG_QUALITY.evidence);
  const display = await canvasToJpeg(
    drawScaled(frame, frameMax(mode, maxPx)),
    JPEG_QUALITY.display,
  );
  return { original, display, previewUnavailable: false };
}

/**
 * A picked or shared file → the blobs its mode keeps. Evidence originals are the file itself;
 * a THING photo is re-encoded small, or kept as it is when it can't be decoded.
 */
export async function fromFile(
  file: Blob,
  mode: CaptureMode,
  decode: Decode = decodeWithBitmap,
): Promise<CapturedImage> {
  let img: Drawable | null = null;
  if (file.type.startsWith('image/') || file.type === '') {
    try {
      img = await decode(file);
    } catch {
      img = null;
    }
  }
  if (!img) return { original: file, display: null, previewUnavailable: true };
  try {
    const small = await canvasToJpeg(
      drawScaled(img, shrinkTo(mode)),
      evidence(mode) ? JPEG_QUALITY.display : JPEG_QUALITY.thing,
    );
    // An evidence file is kept byte for byte, unless it is bigger than an upload may be.
    const kept = overUploadMax(img) ? await shrunk(img, UPLOAD_MAX_PX, file.type) : file;
    return evidence(mode)
      ? { original: kept, display: small, previewUnavailable: false }
      : { original: small, display: null, previewUnavailable: false };
  } catch {
    return { original: file, display: null, previewUnavailable: true };
  } finally {
    if (typeof ImageBitmap !== 'undefined' && img.source instanceof ImageBitmap) img.source.close();
  }
}

/**
 * The queue's blobs for one image, each with the upload id chosen now, so a retry replays the
 * same file (T24's uploader pairs the display with its original through `displayFileId`).
 */
export async function toLocalBlobs(
  img: CapturedImage,
  ids: () => string = newId,
): Promise<{ original: LocalBlob; display: LocalBlob | null }> {
  const original: LocalBlob = {
    id: ids(),
    kind: 'original',
    blob: img.original,
    sha256: await sha256Hex(img.original),
  };
  const display: LocalBlob | null = img.display
    ? { id: ids(), kind: 'display', blob: img.display, sha256: await sha256Hex(img.display) }
    : null;
  return { original, display };
}
