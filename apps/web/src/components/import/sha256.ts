/**
 * An archive's SHA-256, read in chunks, in a worker (sha256.worker.ts) so the page stays
 * responsive. The function itself is lib/sha256.ts, shared with every other upload.
 */
import { hashBlob } from '@/lib/sha256';

export { HASH_CHUNK, hashBlob, Sha256 } from '@/lib/sha256';

export type HashMessage =
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; sha256: string }
  | { kind: 'error' };

/**
 * The file's SHA-256, in a worker where there is one (sha256.worker.ts), else here. Rejects when
 * the file can't be read (it was moved or deleted after it was chosen).
 */
export async function hashFile(
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined') return hashBlob(file, onProgress, signal);
  const worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = (e: MessageEvent<HashMessage>) => {
        if (e.data.kind === 'progress') onProgress(e.data.fraction);
        else if (e.data.kind === 'done') resolve(e.data.sha256);
        else reject(new Error('unreadable'));
      };
      worker.onerror = () => reject(new Error('unreadable'));
      worker.onmessageerror = () => reject(new Error('unreadable'));
      worker.postMessage(file);
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}
