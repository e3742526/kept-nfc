/**
 * The capture camera (D34): the back camera, asked for the size the camera setting
 * names (2048 px by default; settings.ts), kept open for the whole session. Every reason it can't open has a name, so
 * the screen can say which ("Kept can't use the camera", D31) and offer the file
 * picker instead, which always works.
 *
 * Needs HTTPS (or localhost): `navigator.mediaDevices` doesn't exist on a plain-HTTP page.
 */

import { TRY } from '@/try/flag';
import { CAMERA_MAX_PX_DEFAULT, cameraMaxPx } from './settings';

/** The back camera, asked for a 16:9 stream whose long edge is `maxPx` (the camera setting). */
export function cameraConstraints(maxPx: number = CAMERA_MAX_PX_DEFAULT): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: 'environment',
      width: { ideal: maxPx },
      height: { ideal: Math.round((maxPx * 9) / 16) },
    },
  };
}

export type CameraProblem =
  /** Plain HTTP: no camera API at all (D31). */
  | 'insecure'
  /** This browser has no `getUserMedia`. */
  | 'unsupported'
  /** The person, or the browser's settings, said no. */
  | 'denied'
  /** No camera on this device. */
  | 'no_camera'
  /** Another app holds the camera. */
  | 'busy'
  | 'failed'
  /** Try SheepKeep on the docs site (D246): no camera is asked for. */
  | 'demo';

export type MediaAccess = Pick<MediaDevices, 'getUserMedia'>;

export type CameraEnv = {
  secure: boolean;
  media: MediaAccess | null;
};

/** The page's own environment. */
export function cameraEnv(): CameraEnv {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  // Undefined on a plain-HTTP page, although the DOM types say it is always there.
  const devices =
    typeof navigator !== 'undefined'
      ? (navigator.mediaDevices as MediaDevices | undefined)
      : undefined;
  const media = typeof devices?.getUserMedia === 'function' ? devices : null;
  return { secure, media };
}

/** A problem known before asking: over HTTP, or no camera API. */
export function problemUpfront(env: CameraEnv): CameraProblem | null {
  if (TRY) return 'demo';
  if (!env.secure) return 'insecure';
  if (!env.media) return 'unsupported';
  return null;
}

/** A `getUserMedia` rejection, by its DOMException name. */
export function classifyCameraError(e: unknown): CameraProblem {
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return 'denied';
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  )
    return 'no_camera';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return 'busy';
  return 'failed';
}

export type OpenCamera =
  | { ok: true; stream: MediaStream; stop: () => void }
  | { ok: false; problem: CameraProblem };

export async function openCamera(env: CameraEnv = cameraEnv()): Promise<OpenCamera> {
  const upfront = problemUpfront(env);
  if (upfront || !env.media) return { ok: false, problem: upfront ?? 'unsupported' };
  try {
    const stream = await env.media.getUserMedia(cameraConstraints(cameraMaxPx()));
    return {
      ok: true,
      stream,
      stop: () => {
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (e) {
    return { ok: false, problem: classifyCameraError(e) };
  }
}
