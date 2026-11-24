import type { Part } from '@kept/shared';
import sharp from 'sharp';
import type { ImageInput } from '../ai/call.js';
import { invalid } from '../http/errors.js';
import { InvalidVisualImage, prepareVisualImage } from '../visual-search/image.js';

export type StoredPhoto = Extract<Part, { type: 'photo' }> & {
  jpeg: string;
  width: number;
  height: number;
};

export async function prepareAssistantPhoto(base64: string): Promise<StoredPhoto> {
  try {
    const jpeg = await prepareVisualImage(Buffer.from(base64, 'base64'), 'image/jpeg');
    const { width, height } = await sharp(jpeg).metadata();
    if (!width || !height) throw new InvalidVisualImage();
    return { type: 'photo', jpeg: jpeg.toString('base64'), width, height };
  } catch (error) {
    if (error instanceof InvalidVisualImage) throw invalid('Choose a readable JPEG photo.');
    throw error;
  }
}

export function photoInput(part: StoredPhoto): ImageInput {
  return {
    bytes: Buffer.from(part.jpeg, 'base64'),
    mediaType: 'image/jpeg',
    width: part.width,
    height: part.height,
  };
}
