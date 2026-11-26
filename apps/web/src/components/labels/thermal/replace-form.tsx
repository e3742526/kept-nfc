import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import type { ReplaceLabelBody, ReplaceLabelResult } from '@/api/capture/types';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

export function ReplaceLabelForm({
  locationId,
  replace,
}: {
  locationId: string;
  replace: (body: ReplaceLabelBody) => Promise<ReplaceLabelResult>;
}) {
  const { t } = useLingui();
  const errors = useErrorText();
  const [previous, setPrevious] = useState('');
  const [replacement, setReplacement] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setStatus('');
    setDone(false);
    try {
      await replace({ locationId, previous, replacement, reason });
      setPrevious('');
      setReplacement('');
      setReason('');
      setDone(true);
    } catch (error) {
      setStatus(errors(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer font-semibold">
        <Trans>Replace a label identity</Trans>
      </summary>
      <div className="mt-3 grid gap-3">
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Use a registered, unclaimed label as the replacement. The old label stays linked to the
            same record and shows as superseded when scanned.
          </Trans>
        </p>
        <TextField
          label={t`Current label code or URL`}
          value={previous}
          onChange={setPrevious}
          inputProps={{ maxLength: 1024 }}
        />
        <TextField
          label={t`Replacement label code or URL`}
          value={replacement}
          onChange={setReplacement}
          inputProps={{ maxLength: 1024 }}
        />
        <TextField
          label={t`Reason for replacement`}
          value={reason}
          onChange={setReason}
          inputProps={{ maxLength: 240 }}
        />
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={!previous.trim() || !replacement.trim() || !reason.trim()}
          className="justify-self-start"
          onPress={() => void submit()}
        >
          <Trans>Replace label</Trans>
        </Button>
        {done && (
          <Notice tone="ok">
            <Trans>Replacement label assigned.</Trans>
          </Notice>
        )}
        {status && <Notice tone="danger">{status}</Notice>}
      </div>
    </details>
  );
}
