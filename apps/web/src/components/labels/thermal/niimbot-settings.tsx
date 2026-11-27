import { COMPACT_THERMAL_STOCK, type PrinterProfile } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import {
  type NiimbotDevice,
  type NiimbotIdentity,
  type NiimbotOutput,
  niimbotProfile,
} from './niimbot';
import { type PrintPreferences, printStore } from './store';

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
  owner,
  output,
  stock,
  onChange,
}: {
  owner: string;
  output: NiimbotOutput;
  stock?: string;
  onChange?: (profiles: PrinterProfile[], selected?: PrinterProfile) => void;
}) {
  const { t } = useLingui();
  const errorText = useNiimbotErrorText();
  const [preferences, setPreferences] = useState<PrintPreferences>();
  const [devices, setDevices] = useState<NiimbotDevice[]>();
  const [observation, setObservation] = useState<{ deviceId: string; identity: NiimbotIdentity }>();
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    let active = true;
    void printStore.preferences.get(owner).then(
      (saved) => {
        if (active) {
          setPreferences(
            saved ?? { owner, profiles: [], profileId: '', stock: COMPACT_THERMAL_STOCK },
          );
        }
      },
      () => {
        if (active) setProblem(t`Could not load printer settings.`);
      },
    );
    return () => {
      active = false;
    };
  }, [owner, t]);

  useEffect(
    () => () => {
      if (running.current) void output.cancel().catch(() => {});
    },
    [output],
  );

  async function run(task: () => Promise<void>) {
    if (!preferences || running.current) return;
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

  async function selectPrinter(device: NiimbotDevice, profileId = `niimbot:${device.id}`) {
    try {
      const { next, selected } = await printStore.transaction(
        'rw',
        printStore.preferences,
        async () => {
          const current = (await printStore.preferences.get(owner)) ?? {
            owner,
            stock: COMPACT_THERMAL_STOCK,
            profileId: '',
            profiles: [],
          };
          const saved = current.profiles.find((profile) => profile.id === profileId);
          const selected = saved ?? niimbotProfile(device, stock ?? current.stock);
          const next = {
            ...current,
            stock: selected.stock,
            profileId: selected.id,
            profiles: saved ? current.profiles : [...current.profiles, selected],
          };
          await printStore.preferences.put(next);
          return { next, selected };
        },
      );
      setPreferences(next);
      onChange?.(next.profiles, selected);
      return true;
    } catch {
      setProblem(t`Could not save settings.`);
      return false;
    }
  }

  async function forgetPrinter(deviceId: string) {
    try {
      const next = await printStore.transaction('rw', printStore.preferences, async () => {
        const current = await printStore.preferences.get(owner);
        if (!current) return;
        const profiles = current.profiles.filter((profile) => profile.bluetoothId !== deviceId);
        const next = {
          ...current,
          profiles,
          profileId: profiles.some((profile) => profile.id === current.profileId)
            ? current.profileId
            : '',
        };
        await printStore.preferences.put(next);
        return next;
      });
      if (next) {
        setPreferences(next);
        onChange?.(next.profiles);
      }
      if (observation?.deviceId === deviceId) setObservation(undefined);
    } catch {
      setProblem(t`Could not save settings.`);
    }
  }

  async function identify(device: NiimbotDevice, save: boolean) {
    setObservation(undefined);
    const identity = await output.identify(device.id);
    if (identity.modelId !== 4097) {
      setProblem(errorText({ code: 'niimbot_unsupportedPrinter' }));
      return;
    }
    if (save && !(await selectPrinter(device))) return;
    setObservation({ deviceId: device.id, identity });
    setDevices(undefined);
  }

  if (!preferences) {
    return problem ? (
      <Notice tone="warn">
        <span role="alert">{problem}</span>
      </Notice>
    ) : (
      <p role="status" className="m-0 text-small">
        <Trans>Loading printer settings…</Trans>
      </p>
    );
  }

  const remembered = preferences.profiles.filter(
    (profile) => profile.adapter === 'niimbot-b1-pro' && profile.bluetoothId,
  );
  return (
    <div className="grid min-w-0 gap-3">
      <p className="m-0 text-small text-ink-2">
        <Trans>NIIMBOT B1 Pro Bluetooth</Trans>
      </p>
      {!remembered.length && (
        <p className="m-0">
          <Trans>No remembered printers.</Trans>
        </p>
      )}
      {remembered.map((profile) => {
        if (!profile.bluetoothId) return null;
        const device = { id: profile.bluetoothId, name: profile.name };
        const active = profile.id === preferences.profileId;
        const status = observation?.deviceId === device.id ? observation.identity : undefined;
        return (
          <section
            key={profile.id}
            aria-label={profile.name}
            className="grid min-w-0 gap-2 rounded-lg border border-line p-3"
          >
            <p className="m-0 break-words font-semibold">
              <bdi>{profile.name}</bdi>
            </p>
            {active && (
              <p className="m-0 text-small text-ink-2">
                <Trans>Default printer</Trans>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!active && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await selectPrinter(device, profile.id);
                    })
                  }
                >
                  <Trans>Use for thermal printing</Trans>
                </Button>
              )}
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => void run(() => identify(device, false))}
              >
                <Trans>Check printer status</Trans>
              </Button>
              <Button
                variant="ghost"
                isDisabled={busy}
                onPress={() => void run(() => forgetPrinter(device.id))}
              >
                <Trans>Forget printer</Trans>
              </Button>
            </div>
            {status && (
              <Notice>
                <div role="status" className="grid gap-1">
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
          </section>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={remembered.length ? 'secondary' : 'primary'}
          isDisabled={busy}
          onPress={() => void run(async () => setDevices(await output.discover(false)))}
        >
          <Trans>Find nearby printers</Trans>
        </Button>
        {devices && (
          <Button
            variant="ghost"
            isDisabled={busy}
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
                isDisabled={busy}
                onPress={() => void run(() => identify(device, true))}
              >
                <bdi>{device.name}</bdi>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <Notice tone="warn">
          <span role="alert">{problem}</span>
        </Notice>
      )}
    </div>
  );
}
