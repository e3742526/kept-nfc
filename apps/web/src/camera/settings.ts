/**
 * Camera settings, kept on this device (localStorage, like geo.ts's "suggest where"): the longest
 * edge, in pixels, a photo taken with the in-app camera is kept at. The camera is asked for about
 * that size, and a frame bigger than it is drawn down to it, for the THING and the evidence modes
 * alike. 2048 is the default and the most the setting offers; a smaller size trades detail for
 * less to upload.
 *
 * Files that don't come from the camera (the gallery, the system camera, a share) aren't affected;
 * image.ts's UPLOAD_MAX_PX bounds those.
 */
export const CAMERA_MAX_PX_KEY = 'kept.camera.maxPx';
export const CAMERA_SIZES = [1024, 1536, 2048] as const;
export type CameraSize = (typeof CAMERA_SIZES)[number];
export const CAMERA_MAX_PX_DEFAULT: CameraSize = 2048;

export function isCameraSize(n: number): n is CameraSize {
  return (CAMERA_SIZES as readonly number[]).includes(n);
}

/** The stored size, or the default when there is none or it isn't one of the choices. */
export function cameraMaxPx(): CameraSize {
  try {
    const n = Number(localStorage.getItem(CAMERA_MAX_PX_KEY));
    return isCameraSize(n) ? n : CAMERA_MAX_PX_DEFAULT;
  } catch {
    return CAMERA_MAX_PX_DEFAULT;
  }
}

export function setCameraMaxPx(size: CameraSize): void {
  try {
    if (size === CAMERA_MAX_PX_DEFAULT) localStorage.removeItem(CAMERA_MAX_PX_KEY);
    else localStorage.setItem(CAMERA_MAX_PX_KEY, String(size));
  } catch {
    // No storage: the camera keeps its default size.
  }
}
