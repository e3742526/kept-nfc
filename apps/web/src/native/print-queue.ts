import { useCallback } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { PrintQueueRequest } from '@/components/labels/print-queue';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';

export function useNativePrintQueue(connection: Connection): PrintQueueRequest {
  const { transport } = usePlatform();
  return useCallback<PrintQueueRequest>(
    (action) =>
      transport.request(
        connection,
        capturePaths.labelQueue,
        action ? { method: 'POST', body: action } : undefined,
      ),
    [connection, transport],
  );
}
