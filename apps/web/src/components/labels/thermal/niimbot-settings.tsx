import type { PrinterProfile } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import type { NiimbotDevice, NiimbotIdentity, NiimbotOutput } from './niimbot';

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

export function isNiimbotError(error: unknown) {
  const code = errorCode(error);
  return typeof code === 'string' && code.startsWith('niimbot_');
}

export function useNiimbotErrorText() {
  const { t } = useLingui();
  return (error: unknown) => {
    switch (errorCode(error)) {
      case 'niimbot_bluetoothOff':
        return t`Turn on Bluetooth to use the label printer.`;
      case 'niimbot_bluetoothDenied':
        return t`Allow Bluetooth for SheepKeep in iPhone Settings.`;
      case 'niimbot_unsupportedPrinter':
        return t`This printer did not identify as a NIIMBOT B1 Pro.`;
      case 'niimbot_busy':
        return t`A Bluetooth printer operation is already in progress.`;
      case 'niimbot_cancelled':
        return t`Printer connection cancelled.`;
      case 'niimbot_invalidImage':
        return t`Prepare the labels with a supported B1 Pro stock and page range.`;
      default:
        return t`Could not communicate with the printer. Check that it is on and nearby.`;
    }
  };
}

export function NiimbotSettings({
  output,
  profile,
  selectPrinter,
  forget,
  disabled,
}: {
  output: NiimbotOutput;
  profile: PrinterProfile;
  selectPrinter: (device: NiimbotDevice) => Promise<void>;
  forget: (id: string) => Promise<void>;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const errorText = useNiimbotErrorText();
  const [devices, setDevices] = useState<NiimbotDevice[]>();
  const [observation, setObservation] = useState<{ deviceId: string; identity: NiimbotIdentity }>();
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const remembered = profile.adapter === 'niimbot-b1-pro' && profile.bluetoothId;
  const status = observation?.deviceId === remembered ? observation?.identity : undefined;
  useEffect(
    () => () => {
      if (running.current) void output.cancel().catch(() => {});
    },
    [output],
  );

  async function run(task: () => Promise<void>) {
    if (disabled || running.current) return;
    running.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function identify(device: NiimbotDevice, save: boolean) {
    setObservation(undefined);
    const identity = await output.identify(device.id);
    if (identity.modelId !== 4097) {
      setProblem(errorText({ code: 'niimbot_unsupportedPrinter' }));
      return;
    }
    if (save) await selectPrinter(device);
    setObservation({ deviceId: device.id, identity });
    setDevices(undefined);
  }

  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer font-semibold">
        <Trans>NIIMBOT B1 Pro Bluetooth</Trans>
      </summary>
      <div className="mt-3 grid gap-3">
        {remembered && (
          <div className="grid gap-2">
            <p className="m-0 text-small">
              <Trans>Remembered printer</Trans> · <bdi>{profile.name}</bdi>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                isDisabled={disabled || busy}
                onPress={() =>
                  void run(() => identify({ id: remembered, name: profile.name }, false))
                }
              >
                <Trans>Check printer status</Trans>
              </Button>
              <Button
                variant="ghost"
                isDisabled={disabled || busy}
                onPress={() => void run(() => forget(profile.id))}
              >
                <Trans>Forget printer</Trans>
              </Button>
            </div>
          </div>
        )}
        {status && (
          <Notice>
            <div className="grid gap-1">
              <Trans>B1 Pro verified at 300 DPI. It reconnects when you print.</Trans>
              {status.firmware && <span>{t`Firmware: ${status.firmware}`}</span>}
              {status.protocolGeneration !== undefined && (
                <span>{t`Protocol generation: ${status.protocolGeneration}`}</span>
              )}
              {status.batteryPercent !== undefined && (
                <span>{t`Battery: ${status.batteryPercent}%`}</span>
              )}
              {status.lidOpen && <Trans>The printer lid is open.</Trans>}
              {status.paperOut && <Trans>The printer is out of labels.</Trans>}
              {status.rollRecognized === true && (
                <Trans>The printer recognized the label roll.</Trans>
              )}
              {status.rollRecognized === false && (
                <Trans>The printer did not report a recognized roll.</Trans>
              )}
            </div>
          </Notice>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            isDisabled={disabled || busy}
            onPress={() => void run(async () => setDevices(await output.discover(false)))}
          >
            <Trans>Find nearby printers</Trans>
          </Button>
          {devices && (
            <Button
              variant="ghost"
              isDisabled={disabled || busy}
              onPress={() => void run(async () => setDevices(await output.discover(true)))}
            >
              <Trans>Show other Bluetooth devices</Trans>
            </Button>
          )}
          {busy && (
            <Button variant="ghost" onPress={() => void output.cancel().catch(() => {})}>
              <Trans>Cancel</Trans>
            </Button>
          )}
        </div>
        {busy && (
          <p role="status" className="m-0 text-small">
            <Trans>Checking Bluetooth…</Trans>
          </p>
        )}
        {devices && devices.length === 0 && (
          <Notice>
            <Trans>No nearby printers found.</Trans>
          </Notice>
        )}
        {devices && devices.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0">
            {devices.map((device) => (
              <li key={device.id}>
                <Button
                  variant="secondary"
                  isDisabled={disabled || busy}
                  onPress={() => void run(() => identify(device, true))}
                >
                  <bdi>{device.name}</bdi>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {problem && <Notice tone="warn">{problem}</Notice>}
      </div>
    </details>
  );
}
