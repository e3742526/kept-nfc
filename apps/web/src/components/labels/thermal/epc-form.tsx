import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import type { PrintApi } from './api';

export function EpcForm({
  locationId,
  register,
}: {
  locationId: string;
  register: PrintApi['registerTag'];
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [label, setLabel] = useState('');
  const [epc, setEpc] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    setStatus('');
    try {
      await register({ kind: 'uhf', locationId, label, epc });
      setLabel('');
      setEpc('');
      setSaved(true);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer font-semibold">
        <Trans>Register a UHF RFID tag</Trans>
      </summary>
      <div className="mt-3 grid gap-3">
        <TextField
          label={t`Current label code or URL`}
          value={label}
          onChange={setLabel}
          inputProps={{ maxLength: 1024 }}
        />
        <TextField
          label={t`EPC from your UHF reader`}
          value={epc}
          onChange={(value) => setEpc(value.toUpperCase())}
          inputProps={{ maxLength: 128, autoCapitalize: 'characters' }}
        />
        <Button
          variant="secondary"
          isPending={busy}
          className="justify-self-start"
          isDisabled={!label.trim() || !/^(?:[0-9A-F]{2}){4,64}$/.test(epc.trim())}
          onPress={() => void save()}
        >
          <Trans>Register EPC</Trans>
        </Button>
        {saved && (
          <Notice tone="ok">
            <Trans>UHF RFID tag registered.</Trans>
          </Notice>
        )}
        {status && <Notice tone="danger">{status}</Notice>}
      </div>
    </details>
  );
}
