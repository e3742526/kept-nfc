/**
 * Points the PWA shell at the signed-in person's offline store once T24's provider has opened it
 * (offline/provider.tsx): the update prompt then gates on active sync work (D148). Rendered
 * once inside the provider; on sign-out the shell goes back to an empty in-memory store.
 */
import { useEffect } from 'react';
import { useOffline } from '@/offline/provider';
import { MemoryStore } from '@/offline/store';
import { defaultLock } from '@/offline/sync-engine';
import { setPageStore } from './page-store';

export function PwaStoreBridge() {
  const offline = useOffline();
  const store = offline?.store;
  const engine = offline?.engine;
  useEffect(() => {
    if (!store || !engine) return;
    setPageStore(
      store,
      async () => !engine.isRunning() && (await defaultLock(async () => true)) === true,
    );
    return () => setPageStore(new MemoryStore());
  }, [store, engine]);
  return null;
}
