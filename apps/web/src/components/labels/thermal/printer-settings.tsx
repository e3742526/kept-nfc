import {
  COMPACT_THERMAL_STOCK,
  defaultPrinterProfile,
  type PrinterProfile,
  printerOnStock,
  savePrinterStock,
  ThermalBatchSpecSchema,
  type ThermalLayout,
} from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useErrorText } from '@/components/page';
import { DEFAULT_THERMAL_OPTIONS } from './document';
import { printSpec } from './jobs';
import type { NiimbotOutput } from './niimbot';
import { NiimbotSettings } from './niimbot-settings';
import { ThermalSettings } from './settings';
import { printStore } from './store';

/** Printer settings share the same account-scoped profiles as the label editor. */
export function PrinterSettingsPanel({ owner, output }: { owner: string; output?: NiimbotOutput }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;
  const [profile, setProfile] = useState(defaultPrinterProfile);
  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [stock, setStock] = useState(COMPACT_THERMAL_STOCK);
  const [layout, setLayout] = useState<ThermalLayout>('single');
  const [options, setOptions] = useState(DEFAULT_THERMAL_OPTIONS);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const choose = useCallback((next: PrinterProfile, nextStock = next.stock) => {
    const applied = printerOnStock(next, nextStock);
    setProfile(applied);
    setStock(nextStock);
    setLayout(nextStock === 'thermal_4x6in' ? applied.layout : 'single');
  }, []);
  useEffect(() => {
    let active = true;
    void printStore.preferences
      .get(owner)
      .then((saved) => {
        if (!active) return;
        if (saved) {
          setProfiles(saved.profiles);
          const selected = saved.profiles.find((item) => item.id === saved.profileId);
          choose(selected ?? defaultPrinterProfile(), saved.stock);
        }
        setReady(true);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(errorTextRef.current(err));
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [owner, choose]);
  async function save() {
    try {
      setError('');
      ThermalBatchSpecSchema.parse(printSpec(stock, layout, profile, options, '', ''));
      const saved = savePrinterStock(
        { ...profile, id: profile.id || crypto.randomUUID(), name: profile.name.trim() },
        stock,
        layout,
      );
      const next = await printStore.transaction('rw', printStore.preferences, async () => {
        const prior = await printStore.preferences.get(owner);
        const next = {
          ...prior,
          owner,
          stock,
          profileId: saved.id,
          profiles: [...(prior?.profiles ?? []).filter((item) => item.id !== saved.id), saved],
        };
        await printStore.preferences.put(next);
        return next;
      });
      setProfiles(next.profiles);
      setProfile(saved);
    } catch (err) {
      setError(errorText(err));
    }
  }
  if (!ready) return <p role="status">{t`Loading printer settings…`}</p>;
  return (
    <div className="grid gap-4">
      {output && (
        <NiimbotSettings
          owner={owner}
          output={output}
          stock={stock}
          onChange={(next, selected) => {
            setProfiles(next);
            if (selected) choose(selected);
            else if (!next.some((item) => item.id === profile.id)) choose(defaultPrinterProfile());
          }}
        />
      )}
      <ThermalSettings
        mode="printer"
        stock={stock}
        setStock={(value) => choose(profile, value)}
        layout={layout}
        setLayout={setLayout}
        profile={profile}
        setProfile={setProfile}
        profiles={profiles}
        selectProfile={(id) =>
          choose(profiles.find((item) => item.id === id) ?? defaultPrinterProfile())
        }
        saveProfile={() => void save()}
        options={options}
        setOptions={setOptions}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
