/**
 * Numbered label series (`PPP-XXXX-NNNN`): printed aliases of short IDs, separate from the
 * Crockford short IDs themselves. `PPP` is the purpose the series was printed for (it never limits
 * what a label is later claimed for), `XXXX` a random base36 series ID the server reserves, and
 * `NNNN` the label's place in the series. A series is registered on the server before it prints
 * (labels/series.ts): each alias stands for one blank short ID, so claiming, moving, retiring and
 * reprinting a numbered label is what they are for any other label.
 */
export const DEVICE_LABEL_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DEVICE_LABEL_CODE = /^[A-Z]{3}-[0-9A-Z]{4}-[0-9]{4}$/;
/** The same pattern as a SQL-safe source, for CHECKs and route params. */
export const DEVICE_LABEL_PREFIX = /^[A-Z]{3}$/;

/**
 * Purposes offered when a series is made. Any three letters are accepted; these are the house
 * ones. `TMP` is for write-in labels.
 */
export const DEVICE_LABEL_PREFIXES = ['BIN', 'ITM', 'LOC', 'SHF', 'TMP', 'GEN'] as const;

/**
 * What a person typed or a reader gave, folded onto the alias form: trimmed, upper case, spaces
 * and Unicode hyphens (a printed U+2011 included) as `-`. Unlike a short ID nothing else is folded:
 * base36 keeps O, I and L. Not validated; check with `parseDeviceLabel`.
 */
export function normaliseDeviceLabel(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s\u2010-\u2015-]+/g, '-');
}

export function isDeviceLabel(input: string): boolean {
  return parseDeviceLabel(input) !== null;
}

export function parseDeviceLabel(input: string) {
  const code = normaliseDeviceLabel(input);
  if (!DEVICE_LABEL_CODE.test(code)) return null;
  const prefix = code.slice(0, 3);
  const batchId = code.slice(4, 8);
  const sequence = Number(code.slice(9));
  if (sequence === 0) return null;
  return { code, prefix, batchId, sequence };
}

/** Rejection sampling avoids modulo bias; I, L, O and U remain distinct. */
export function randomDeviceBatchId(): string {
  let code = '';
  while (code.length < 4) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      if (byte < 252) code += DEVICE_LABEL_ALPHABET.charAt(byte % 36);
      if (code.length === 4) break;
    }
  }
  return code;
}

export function deviceLabelCode(prefix: string, batchId: string, sequence: number): string {
  if (!/^[A-Z]{3}$/.test(prefix) || !/^[0-9A-Z]{4}$/.test(batchId)) {
    throw new RangeError('Invalid label prefix or batch ID');
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new RangeError('Label sequence must be 1–9999');
  }
  return `${prefix}-${batchId}-${String(sequence).padStart(4, '0')}`;
}

/** A local manifest, for tests and offline previews only: a series that prints is reserved by
 * the server (`POST /api/v1/labels/batches` with `series`), which owns uniqueness. Its QR payload
 * is the bare alias; a printed label carries the alias's HTTPS link instead.
 */
export function createDeviceLabelBatch(
  prefix: string,
  count: number,
  isReserved: (prefix: string, batchId: string) => boolean,
) {
  if (!/^[A-Z]{3}$/.test(prefix) || !Number.isInteger(count) || count < 1 || count > 9999) {
    throw new RangeError('Invalid prefix or label count');
  }
  for (let attempt = 0; attempt < 128; attempt++) {
    const batchId = randomDeviceBatchId();
    if (isReserved(prefix, batchId)) continue;
    return {
      id: crypto.randomUUID(),
      prefix,
      batchId,
      labels: Array.from({ length: count }, (_, i) => {
        const code = deviceLabelCode(prefix, batchId, i + 1);
        return { id: crypto.randomUUID(), code, qrPayload: code };
      }),
    };
  }
  throw new Error('Unable to allocate an unused label batch ID');
}
