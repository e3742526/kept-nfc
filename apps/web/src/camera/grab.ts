/**
 * The shutter (D34): the video's current frame, drawn at the track's full
 * resolution, then kept the way the mode says (image.ts). The session stays open, so the next
 * shot is instant.
 *
 * The photo is what the viewfinder showed. The video fills its box (`object-cover`), so a phone's
 * camera frame, taller or wider than the box, shows only its middle; the shutter keeps that
 * middle, not the whole frame, or the saved photo would hold what the person framed out.
 */
import type { CaptureMode } from '@kept/shared';
import { type CapturedImage, type Crop, type Drawable, fromFrame } from './image';

/**
 * The part of a `frameW` × `frameH` frame that `object-cover` shows in a `boxW` × `boxH` box:
 * the frame scaled to cover the box, centred, and cut at the box's edges. The whole frame when
 * the box has no size (hidden) or the same shape.
 */
export function coverCrop(frameW: number, frameH: number, boxW: number, boxH: number): Crop {
  const whole = { x: 0, y: 0, width: frameW, height: frameH };
  if (!(boxW > 0 && boxH > 0 && frameW > 0 && frameH > 0)) return whole;
  const scale = Math.max(boxW / frameW, boxH / frameH);
  const width = Math.min(frameW, Math.round(boxW / scale));
  const height = Math.min(frameH, Math.round(boxH / scale));
  if (width === frameW && height === frameH) return whole;
  return {
    x: Math.round((frameW - width) / 2),
    y: Math.round((frameH - height) / 2),
    width,
    height,
  };
}

/** The frame on screen now, at the video's own resolution, cut to what the viewfinder shows;
 * null before the first frame. */
export function currentFrame(video: HTMLVideoElement): Drawable | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const crop = coverCrop(videoWidth, videoHeight, video.clientWidth, video.clientHeight);
  if (crop.width === videoWidth && crop.height === videoHeight)
    return { source: video, width: videoWidth, height: videoHeight };
  return { source: video, width: crop.width, height: crop.height, crop };
}

/** Whether the video shows a frame yet: the shutter waits for it (the stream alone isn't one). */
export function hasFrame(video: HTMLVideoElement): boolean {
  return currentFrame(video) !== null;
}

export async function grabFrame(
  video: HTMLVideoElement,
  mode: CaptureMode,
): Promise<CapturedImage | null> {
  const frame = currentFrame(video);
  return frame ? fromFrame(frame, mode) : null;
}
