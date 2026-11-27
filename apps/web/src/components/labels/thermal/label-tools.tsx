import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { TextField } from '@/components/ui/text-field';
import type { PrintApi } from './api';
import { EpcForm } from './epc-form';
import { ReplaceLabelForm } from './replace-form';

export function LabelTools({
  locationId,
  currentLabel,
  api,
}: {
  locationId: string;
  currentLabel?: string | undefined;
  api: Pick<PrintApi, 'replace' | 'registerTag'>;
}) {
  const { t } = useLingui();
  const [label, setLabel] = useState(currentLabel ?? '');

  return (
    <details className="rounded-lg border border-line p-3 print:hidden">
      <summary className="cursor-pointer font-semibold">
        <Trans>Advanced label tools</Trans>
      </summary>
      <div className="mt-3 grid gap-3">
        <TextField
          label={t`Current label code or URL`}
          value={label}
          onChange={setLabel}
          inputProps={{ maxLength: 1024 }}
        />
        <ReplaceLabelForm
          locationId={locationId}
          previous={label}
          replace={async (body) => {
            const result = await api.replace(body);
            setLabel((value) => (value === body.previous ? body.replacement.trim() : value));
            return result;
          }}
        />
        <EpcForm locationId={locationId} label={label} register={api.registerTag} />
      </div>
    </details>
  );
}
