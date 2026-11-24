import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import type { TagReading } from './bridge';

/** The words for an NFC reader result that did not read or write a SheepKeep label. */
export function useNfcStatusText() {
  const { t } = useLingui();
  return useCallback(
    (result: Pick<TagReading, 'status'>) => {
      switch (result.status) {
        case 'unavailable':
          return t`NFC is unavailable on this device.`;
        case 'busy':
          return t`Finish the current NFC scan and try again.`;
        case 'blank':
          return t`This NFC tag is blank.`;
        case 'malformed':
          return t`This tag does not contain a SheepKeep label URL.`;
        case 'cancelled':
          return t`Scan cancelled.`;
        case 'timeout':
          return t`The scan timed out. Try again.`;
        case 'unsupported':
          return t`This tag does not support NDEF.`;
        case 'read_only':
          return t`This NFC tag is read-only. Try another tag.`;
        case 'too_small':
          return t`This NFC tag is too small for the label URL.`;
        case 'changed':
          return t`This tag has changed. Inspect it again before writing.`;
        case 'write_unverified':
          return t`Writing was interrupted. Inspect the tag again to verify what it holds.`;
        default:
          return t`The NFC scan was interrupted. Try again.`;
      }
    },
    [t],
  );
}
