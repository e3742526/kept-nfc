/**
 * "Type the code" (WCAG 1.1/2.1: an alternative to the camera, always reachable). The 6
 * characters of a legacy short ID use Crockford folding. Numbered aliases keep every Base36
 * character and may carry a batch guard. The field stays left to right in Arabic.
 */
import { isShortCode, normaliseInputCode, parseDeviceLabelReference } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { IdChip } from '@/components/id-chip';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

export function ManualCode({
  onCode,
  onCancel,
}: {
  onCode: (code: string) => void;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const [raw, setRaw] = useState('');
  const [tried, setTried] = useState(false);
  const numbered = parseDeviceLabelReference(raw);
  const code = numbered
    ? numbered.guard
      ? `${numbered.code}-${numbered.guard}`
      : numbered.code
    : normaliseInputCode(raw);
  const valid = !!numbered || isShortCode(code);
  const error =
    tried && !valid
      ? t`Enter a short ID like 7KQ‑4MZ or a numbered ID like TMP-A09Z-0001.`
      : undefined;
  return (
    <Form
      aria-label={t`Type the code`}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (valid) onCode(code);
      }}
    >
      <TextField
        label={t`Code on the label`}
        value={raw}
        onChange={(v) => {
          setRaw(v);
          setTried(false);
        }}
        isInvalid={!!error}
        errorMessage={error}
        placeholder="7KQ‑4MZ"
        autoFocus
        inputProps={{
          dir: 'ltr',
          autoCapitalize: 'characters',
          autoComplete: 'off',
          autoCorrect: 'off',
          spellCheck: false,
          maxLength: 32,
        }}
      />
      <div className="flex min-h-9 items-center gap-2" aria-live="polite">
        {valid ? (
          <>
            <IdChip code={numbered?.code ?? code} />
            <span className="text-small text-ink-3">
              <Trans>Ready to look up</Trans>
            </span>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="secondary" onPress={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
        <Button type="submit">
          <Trans>Find</Trans>
        </Button>
      </div>
    </Form>
  );
}
