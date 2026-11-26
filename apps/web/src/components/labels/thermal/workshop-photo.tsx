import type { WorkshopIcon } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';

export function useWorkshopIconNames(): Record<WorkshopIcon, string> {
  const { t } = useLingui();
  return {
    BIT: t`Driver bits`,
    HEX: t`Hex bits`,
    BLT: t`Nuts and bolts`,
    TOL: t`Tools`,
    CAB: t`Cables`,
    ELE: t`Electrical`,
    MEA: t`Measuring`,
    ROT: t`Rotary discs`,
    ADH: t`Adhesives`,
    WSH: t`Washers`,
    DRL: t`Drill bits`,
    MSC: t`Miscellaneous`,
  };
}

export function WorkshopPhoto({
  suggest,
  apply,
}: {
  suggest: (photo: File) => Promise<WorkshopIcon | undefined>;
  apply: (icon: WorkshopIcon) => void;
}) {
  const { t } = useLingui();
  const names = useWorkshopIconNames();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<WorkshopIcon>();
  const [message, setMessage] = useState('');

  async function read(photo: File) {
    setSuggestion(undefined);
    setMessage('');
    setBusy(true);
    try {
      const icon = await suggest(photo);
      if (icon) setSuggestion(icon);
      else setMessage(t`No category icon was suggested.`);
    } catch {
      setMessage(t`Could not suggest a category icon. Check that server AI is available.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid content-start gap-2">
      <Button variant="secondary" isPending={busy} onPress={() => input.current?.click()}>
        <Trans>Suggest icon from photo</Trans>
      </Button>
      <p className="m-0 text-small text-ink-2">
        <Trans>Sends the photo to your configured server AI.</Trans>
      </p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void read(file);
        }}
      />
      {message && <Notice>{message}</Notice>}
      {suggestion && (
        <Button
          variant="secondary"
          onPress={() => {
            apply(suggestion);
            setSuggestion(undefined);
          }}
        >
          <Trans>Use suggested icon: {names[suggestion]}</Trans>
        </Button>
      )}
    </div>
  );
}
