/**
 * The shutter keeps what the viewfinder showed (grab.ts): the video fills its box with
 * `object-cover`, so a frame of another shape is cut to the box's shape, around its middle.
 */
import { describe, expect, it } from 'vitest';
import { coverCrop, currentFrame } from './grab';

const video = (
  videoWidth: number,
  videoHeight: number,
  clientWidth: number,
  clientHeight: number,
) => ({ videoWidth, videoHeight, clientWidth, clientHeight }) as HTMLVideoElement;

describe('what the shutter keeps', () => {
  it('a tall portrait frame in a squarer box keeps the middle band, top and bottom cut', () => {
    // A phone's 1080 × 1920 frame in a 600 × 500 viewfinder.
    expect(coverCrop(1080, 1920, 600, 500)).toEqual({ x: 0, y: 510, width: 1080, height: 900 });
  });

  it('a landscape frame in a portrait box keeps the middle column', () => {
    expect(coverCrop(1920, 1080, 500, 1000)).toEqual({ x: 690, y: 0, width: 540, height: 1080 });
  });

  it('the whole frame when the box has its shape, or no size', () => {
    expect(coverCrop(1200, 900, 400, 300)).toEqual({ x: 0, y: 0, width: 1200, height: 900 });
    expect(coverCrop(1080, 1920, 0, 0)).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('the frame it hands on is the crop, at the camera’s own resolution', () => {
    const v = video(1080, 1920, 600, 500);
    expect(currentFrame(v)).toEqual({
      source: v,
      width: 1080,
      height: 900,
      crop: { x: 0, y: 510, width: 1080, height: 900 },
    });
    const square = video(1000, 1000, 300, 300);
    expect(currentFrame(square)).toEqual({ source: square, width: 1000, height: 1000 });
    expect(currentFrame(video(0, 0, 300, 300))).toBeNull();
  });
});
