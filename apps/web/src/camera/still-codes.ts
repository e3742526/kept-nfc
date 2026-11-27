/**
 * Kept labels in still photos (#194): a Room capture's photos are read on the phone before they
 * are sent, so a thing whose label shows is known for certain, without asking AI. Each photo is
 * drawn at most `maxSide` on its long edge (a label across a room is small) and given to the
 * app's one decoder (`appDetect()`, scanner.ts: the native BarcodeDetector or the ZXing wasm);
 * every Kept code found is kept once, in order. A photo the decoder can't read is skipped; a
 * phone with no scanner reads none, and the capture goes on without codes.
 */
import {
  gtinShort,
  gtinValid,
  isProductCode,
  parseScan,
  ROOM_LIMITS,
  upcEToUpcA,
} from '@kept/shared';
import { type Decode, type Drawable, decodeWithBitmap, drawScaled } from './image';
import type { Detect } from './label-recogniser';
import { appDetect, ScannerUnavailable } from './scanner';

/** Long enough for a label in a photo of a whole room, short enough to decode in a moment. */
export const STILL_MAX_SIDE = 2048;

type StillReader = {
  detect?: Detect;
  decode?: Decode;
  draw?: (img: Drawable) => CanvasImageSource;
};

async function* readStillCodes(
  photos: readonly Blob[],
  {
    detect = appDetect(),
    decode = decodeWithBitmap,
    draw = (img) => drawScaled(img, STILL_MAX_SIDE),
  }: StillReader,
) {
  for (const photo of photos) {
    let image: Drawable | undefined;
    try {
      image = await decode(photo);
      const found = await detect(draw(image));
      for (const d of found) {
        yield parseScan(d.rawValue, d.format);
      }
    } catch (e) {
      if (e instanceof ScannerUnavailable) break;
      // One photo the decoder couldn't read: the others still count.
    } finally {
      if (image && 'close' in image.source && typeof image.source.close === 'function')
        image.source.close();
    }
  }
}

export async function keptCodesIn(
  photos: readonly Blob[],
  reader: StillReader = {},
): Promise<string[]> {
  const codes = new Set<string>();
  for await (const scan of readStillCodes(photos, reader)) {
    if (scan.kind === 'kept') codes.add(scan.code);
    if (codes.size >= ROOM_LIMITS.codes) break;
  }
  return [...codes];
}

/** One distinct product code, or the first two so the caller can detect ambiguity. */
export async function productCodesIn(
  photos: readonly Blob[],
  reader: StillReader = {},
): Promise<string[]> {
  const codes = new Set<string>();
  for await (const scan of readStillCodes(photos, reader)) {
    if (scan.kind !== 'barcode' || !isProductCode(scan)) continue;
    const code =
      scan.symbology === 'upc_e' && scan.code.length === 8 ? upcEToUpcA(scan.code) : scan.code;
    if (code && gtinValid(code)) codes.add(gtinShort(code.padStart(14, '0')));
    if (codes.size > 1) break;
  }
  return [...codes];
}
