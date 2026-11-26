import {
  COMPACT_THERMAL_STOCK,
  MICRO_THERMAL_STOCK,
  type PrinterProfile,
  type StockCalibration,
  stockCalibration,
  supportsDrawerTemplate,
  THERMAL_LABEL_STOCKS,
  type ThermalLayout,
  WORKSHOP_ICON_CODES,
  type WorkshopIcon,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Checkbox } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { useStockText } from '../stock-picker';
import type { ThermalOptions } from './document';
import { useWorkshopIconNames, WorkshopPhoto } from './workshop-photo';

export function Choices<T extends string>({
  label,
  value,
  items,
  change,
}: {
  label: string;
  value: T;
  items: { id: T; name: string }[];
  change: (value: T) => void;
}) {
  return (
    <Select
      label={label}
      selectedKey={value}
      items={items}
      onSelectionChange={(key) => {
        const choice = items.find((item) => item.id === key);
        if (choice) change(choice.id);
      }}
    >
      {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
    </Select>
  );
}

export function PrintNumber({
  label,
  value,
  change,
  min,
  max,
}: {
  label: string;
  value: number | undefined;
  change: (value: number | undefined) => void;
  min: number;
  max: number;
}) {
  return (
    <TextField
      label={label}
      value={value === undefined || Number.isNaN(value) ? '' : String(value)}
      onChange={(value) => change(value === '' ? undefined : Number(value))}
      inputProps={{ type: 'number', inputMode: 'decimal', min, max, step: 'any' }}
    />
  );
}

export function ThermalSettings({
  stock,
  setStock,
  layout,
  setLayout,
  profile,
  setProfile,
  profiles,
  selectProfile,
  saveProfile,
  options,
  setOptions,
  suggestIcon,
}: {
  stock: string;
  setStock: (stock: string) => void;
  layout: ThermalLayout;
  setLayout: (layout: ThermalLayout) => void;
  profile: PrinterProfile;
  setProfile: (profile: PrinterProfile) => void;
  profiles: PrinterProfile[];
  selectProfile: (id: string) => void;
  saveProfile: () => void;
  options: ThermalOptions;
  setOptions: (options: ThermalOptions) => void;
  suggestIcon?: ((photo: File) => Promise<WorkshopIcon | undefined>) | undefined;
}) {
  const { t } = useLingui();
  const stockText = useStockText();
  const iconNames = useWorkshopIconNames();
  const compact = stock === COMPACT_THERMAL_STOCK;
  const micro = stock === MICRO_THERMAL_STOCK;
  const supportsDrawer = supportsDrawerTemplate(stock);
  const drawer = supportsDrawer && options.template === 'drawer';
  const maxLines = micro ? 1 : compact ? 2 : 6;
  const defaults = stockCalibration(stock);
  const calibration = profile.calibration[stock] ?? defaults;
  const setCalibration = (key: keyof StockCalibration, value: number | undefined) =>
    setProfile({
      ...profile,
      calibration: {
        ...profile.calibration,
        [stock]: {
          ...calibration,
          [key]: value ?? defaults[key],
        },
      },
    });
  const layoutItems = [
    { id: 'single', name: t`One label per sticker` },
    { id: 'cut_4x3', name: t`Two 4 × 3 in labels · cut apart` },
    { id: 'cut_2x2', name: t`Six 2 × 2 in labels · cut apart` },
    { id: 'cut_2x1', name: t`Twelve 2 × 1 in labels · cut apart` },
  ] satisfies { id: ThermalLayout; name: string }[];
  const measurements = [
    ['offsetX', t`Horizontal offset (mm)`],
    ['offsetY', t`Vertical offset (mm)`],
    ['top', t`Top margin (mm)`],
    ['right', t`Right margin (mm)`],
    ['bottom', t`Bottom margin (mm)`],
    ['left', t`Left margin (mm)`],
  ] as const;
  const visibility = [
    ['showName', t`Show item or category name`],
    ['showLocation', t`Show location when it fits`],
    ['showContents', t`Show contents when they fit`],
    ['showNfc', t`Mark labels paired with an NFC tag`],
    ['showBarcode', t`Print the product barcode on large labels`],
  ] as const;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Choices
          label={t`Printer profile`}
          value={profile.id || 'system'}
          items={[
            { id: 'system', name: t`System print dialog` },
            ...profiles.map((item) => ({ id: item.id, name: item.name })),
          ]}
          change={selectProfile}
        />
        <Choices
          label={t`Physical stock`}
          value={stock}
          items={THERMAL_LABEL_STOCKS.map((item) => ({
            id: item.key,
            name:
              item.key === COMPACT_THERMAL_STOCK
                ? t`Compact Thermal — 50 × 20 mm`
                : item.key === MICRO_THERMAL_STOCK
                  ? t`Micro Thermal 1.2 × 0.8 in`
                  : stockText(item).title,
          }))}
          change={setStock}
        />
        <Choices
          label={t`Label layout`}
          value={layout}
          items={stock === 'thermal_4x6in' ? layoutItems : layoutItems.slice(0, 1)}
          change={setLayout}
        />
        <PrintNumber
          label={t`Handwriting lines`}
          value={Math.min(maxLines, options.handwriting)}
          min={0}
          max={maxLines}
          change={(handwriting) =>
            setOptions({ ...options, handwriting: Math.min(maxLines, handwriting ?? 0) })
          }
        />
      </div>
      {supportsDrawer && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Choices
            label={t`Label template`}
            value={options.template ?? 'standard'}
            items={[
              { id: 'standard', name: t`Standard inventory label` },
              { id: 'drawer', name: t`Small-parts drawer` },
            ]}
            change={(template) =>
              setOptions({ ...options, template: template === 'drawer' ? template : undefined })
            }
          />
          {drawer && (
            <>
              <Choices<WorkshopIcon | 'auto' | 'none'>
                label={t`Category icon`}
                value={options.workshopIcon ?? 'auto'}
                items={[
                  { id: 'auto', name: t`Automatic from category and contents` },
                  { id: 'none', name: t`No icon` },
                  ...WORKSHOP_ICON_CODES.map((id) => ({ id, name: iconNames[id] })),
                ]}
                change={(icon) =>
                  setOptions({ ...options, workshopIcon: icon === 'auto' ? undefined : icon })
                }
              />
              {options.workshopIcon !== 'none' && (
                <Choices
                  label={t`Icon placement`}
                  value={options.iconPlacement ?? 'beside'}
                  items={[
                    { id: 'beside', name: t`Beside the QR` },
                    { id: 'embedded', name: t`Inside the QR (experimental)` },
                  ]}
                  change={(iconPlacement) => setOptions({ ...options, iconPlacement })}
                />
              )}
              {suggestIcon && (
                <WorkshopPhoto
                  suggest={suggestIcon}
                  apply={(workshopIcon) => setOptions({ ...options, workshopIcon })}
                />
              )}
            </>
          )}
        </div>
      )}
      {(compact || micro || drawer) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {!drawer && (
            <Choices
              label={compact ? t`Compact label content` : t`Micro label content`}
              value={options.variant ?? 'standard'}
              items={[
                { id: 'standard', name: t`Item name and tag indicators` },
                { id: 'identity', name: t`Identification only` },
              ]}
              change={(variant) => setOptions({ ...options, variant })}
            />
          )}
          <Choices
            label={t`QR destination`}
            value={options.payload ?? 'url'}
            items={[
              { id: 'url', name: t`HTTPS link for phone cameras` },
              { id: 'app', name: t`Compact code for the SheepKeep scanner` },
            ]}
            change={(payload) => setOptions({ ...options, payload })}
          />
        </div>
      )}
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer font-semibold">
          <Trans>Layout and printer calibration</Trans>
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {!compact && !drawer && (
            <Choices
              label={t`QR side on compact labels`}
              value={options.qrSide}
              items={[
                { id: 'left', name: t`Left` },
                { id: 'right', name: t`Right` },
              ]}
              change={(qrSide) => setOptions({ ...options, qrSide })}
            />
          )}
          <PrintNumber
            label={t`Preferred QR width (mm)`}
            value={profile.qrMm ?? (compact ? (drawer ? 17 : 16) : undefined)}
            min={5}
            max={125}
            change={(qrMm) => {
              const { qrMm: _previous, ...other } = profile;
              setProfile(qrMm === undefined ? other : { ...other, qrMm });
            }}
          />
          <PrintNumber
            label={t`Preferred identifier size (pt)`}
            value={options.identifierPt || undefined}
            min={6}
            max={72}
            change={(size) => setOptions({ ...options, identifierPt: size ?? 0 })}
          />
          <PrintNumber
            label={t`Resolution (DPI)`}
            value={profile.dpi}
            min={150}
            max={1200}
            change={(dpi) => setProfile({ ...profile, dpi: dpi ?? 203 })}
          />
          <Choices
            label={t`Orientation`}
            value={profile.orientation}
            items={[
              { id: 'portrait', name: t`Portrait` },
              { id: 'landscape', name: t`Landscape` },
            ]}
            change={(orientation) => setProfile({ ...profile, orientation })}
          />
          <PrintNumber
            label={t`Content scale (%)`}
            value={profile.scale}
            min={60}
            max={100}
            change={(scale) => setProfile({ ...profile, scale: scale ?? 100 })}
          />
          {(
            [
              ['printableWidth', t`Printable width (mm)`],
              ['printableHeight', t`Printable height (mm)`],
              ['minMediaWidth', t`Minimum media width (mm)`],
              ['maxMediaWidth', t`Maximum media width (mm)`],
              ['minFeedLength', t`Minimum feed length (mm)`],
            ] as const
          ).map(([key, label]) => (
            <PrintNumber
              key={key}
              label={label}
              value={profile[key]}
              min={1}
              max={1000}
              change={(value) => {
                const { [key]: _previous, ...other } = profile;
                setProfile(value === undefined ? other : { ...other, [key]: value });
              }}
            />
          ))}
          {measurements.map(([key, label]) => (
            <PrintNumber
              key={key}
              label={label}
              min={key.startsWith('offset') ? -25 : 0}
              max={25}
              value={calibration[key]}
              change={(value) => setCalibration(key, value)}
            />
          ))}
          {visibility
            .filter(
              ([key]) =>
                !(micro || compact) ||
                (key !== 'showNfc' && key !== 'showBarcode' && key !== 'showLocation'),
            )
            .map(([key, label]) => (
              <Checkbox
                key={key}
                className="flex items-center gap-2"
                isSelected={options[key] ?? false}
                onChange={(checked) => setOptions({ ...options, [key]: checked })}
              >
                {({ isSelected }) => (
                  <>
                    <span
                      aria-hidden
                      className="grid size-5 place-items-center rounded border border-line"
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                    {label}
                  </>
                )}
              </Checkbox>
            ))}
        </div>
      </details>
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer font-semibold">
          <Trans>Save printer profile</Trans>
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField
            label={t`Printer name`}
            value={profile.name}
            onChange={(name) => setProfile({ ...profile, name })}
            inputProps={{ maxLength: 100 }}
          />
          <TextField
            label={t`System printer or queue name`}
            value={profile.queue ?? ''}
            onChange={(queue) => setProfile({ ...profile, queue })}
            inputProps={{ maxLength: 200 }}
          />
          <Choices
            label={t`Media tracking`}
            value={profile.media}
            items={[
              { id: 'gap', name: t`Gap` },
              { id: 'mark', name: t`Black mark` },
              { id: 'continuous', name: t`Continuous` },
            ]}
            change={(media) => setProfile({ ...profile, media })}
          />
          {(
            [
              ['gapOrMark', t`Gap or mark height (mm)`, 30],
              ['speed', t`Driver speed setting`, 100],
              ['darkness', t`Driver darkness setting`, 100],
            ] as const
          ).map(([key, label, max]) => (
            <PrintNumber
              key={key}
              label={label}
              value={profile[key]}
              min={0}
              max={max}
              change={(value) => {
                const { [key]: _previous, ...other } = profile;
                setProfile(value === undefined ? other : { ...other, [key]: value });
              }}
            />
          ))}
        </div>
        <p className="text-small text-ink-2">
          <Trans>
            Use the system print dialog to select the queue and apply media, speed, and darkness
            settings.
          </Trans>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" isDisabled={!profile.name.trim()} onPress={saveProfile}>
            <Trans>Save profile and stock calibration</Trans>
          </Button>
          {profile.id && (
            <Button
              variant="secondary"
              onPress={() => setProfile({ ...profile, id: '', name: '' })}
            >
              <Trans>Copy to a new profile</Trans>
            </Button>
          )}
        </div>
      </details>
    </div>
  );
}
