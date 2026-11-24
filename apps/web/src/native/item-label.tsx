import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, Nfc, QrCode as QrCodeIcon, Share, Tag, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReservedLabel } from '@/api/capture/types';
import { appDetect } from '@/camera/scanner';
import { useErrorText } from '@/components/page';
import type { Read } from '@/components/scan/resolve';
import { ScannerView } from '@/components/scan/scanner-view';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { isolate } from '@/lib/bidi';
import { usePlatform } from './adapters';
import type { Connection, TagReading } from './bridge';
import type { InventoryCache } from './inventory';
import {
  approvedLabel,
  describeTargetFromCache,
  labelBase,
  labelOrigins,
  labelUrl,
  loadLabelAddress,
  type ReadResult,
  reserveLabel,
  resolveLabel,
  shelveReservedCode,
  takeShelvedCode,
} from './labels';
import { useNfcStatusText } from './nfc-status';

// A label for an item while it is being added (a valuable item worth scanning straight to):
// - a blank label already printed or written for this location, scanned by QR or NFC: its code;
// - a new NFC tag: a blank code reserved now (POST /labels/reserve), written to the tag and read
//   back before it counts;
// - a new QR label: a reserved code, shown and shared as a one-label PDF.
// The capture carries the code as `claimCode`, and the server claims it when the capture syncs.
// Scanning works offline from the cached blanks; a new label needs the server.

export type ItemLabel = {
  code: string;
  locationId: string;
  source: 'scanned' | 'nfc' | 'qr';
};

// These native results are only emitted before the write starts. Session invalidation and
// failed readback can occur after the tag already holds the new code.
const NFC_WRITE_NOT_STARTED = new Set([
  'unavailable',
  'unsupported',
  'changed',
  'read_only',
  'too_small',
  'malformed',
]);

export function ItemLabelPicker({
  connection,
  cache,
  locationId,
  itemName,
  online,
  value,
  onChange,
  disabled = false,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  /** The destination's location: a label is claimed only in the location it was made for. */
  locationId: string;
  itemName: string;
  online: boolean;
  value: ItemLabel | undefined;
  onChange: (label: ItemLabel | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const nfcStatus = useNfcStatusText();
  const [open, setOpen] = useState(!!value);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [inspection, setInspection] = useState<{ reading: TagReading; url: string }>();
  const [existingOwner, setExistingOwner] = useState<string | null>(null);
  // The code reserved for a new label, kept so a cancelled or repeated attempt doesn't make
  // another blank. The form remounts this picker after each save, which starts afresh.
  const reserved = useRef<ReservedLabel | undefined>(undefined);
  // The Idempotency-Key of a reservation not yet answered: a retry after a lost answer gets the
  // same code rather than another blank. Per location, as the key's request names one.
  const reserving = useRef<{ key: string; locationId: string } | undefined>(undefined);
  const live = useRef(true);
  const inFlight = useRef(false);
  // Codes the form holds (written, or chosen for the item) and codes put in front of a person
  // (a QR label shared): neither may be offered to another item.
  const inUse = useRef(new Set<string>());
  const shared = useRef(new Set<string>());
  const adaptersRef = useRef(adapters);
  adaptersRef.current = adapters;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const https = connection.origin.startsWith('https://');
  const messages = {
    scan: t`Hold the top of your iPhone near one NFC tag.`,
    multiple: t`Move other tags away and scan one tag.`,
    written: t`SheepKeep tag verified.`,
    retry: t`Hold steady against the tag and try again.`,
  };

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void adapters.nfc.cancelTag().catch(() => {});
      // A code reserved but never written, shown or chosen goes back on the shelf, so a
      // cancelled attempt does not leave an unclaimed blank behind for good.
      const held = reserved.current;
      if (held && !inUse.current.has(held.code) && !shared.current.has(held.code)) {
        void shelveReservedCode(
          connectionRef.current,
          held.locationId,
          held.code,
          adaptersRef.current,
        );
      }
    };
  }, [adapters]);

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setStatus('');
    try {
      await operation();
    } catch (error) {
      if (live.current) setStatus(errorText(error));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function reserve(): Promise<ReservedLabel | undefined> {
    const held = reserved.current;
    if (held && held.locationId === locationId) return held;
    let next = await takeShelvedCode(connection, cache, locationId, adapters);
    if (!next) {
      if (!live.current) return;
      if (reserving.current?.locationId !== locationId) {
        reserving.current = { key: newId(), locationId };
      }
      const out = await reserveLabel(connection, locationId, reserving.current.key, adapters);
      reserving.current = undefined;
      // The label address (else the server's own origin): what the NFC check, the system camera
      // and a printed label of the same code all carry.
      next = { ...out, url: labelUrl(await loadLabelAddress(connection, adapters), out.code) };
    }
    if (!live.current) {
      await shelveReservedCode(connection, next.locationId, next.code, adapters);
      return;
    }
    reserved.current = next;
    return next;
  }

  /** Use a label the reader found, when it is a blank of this location. */
  function take(result: ReadResult): boolean {
    if (result.status === 'unassigned' && result.claim) {
      if (result.claim.locationId !== locationId) {
        setStatus(
          t`This label belongs to another location. Choose a destination there, or use another label.`,
        );
        return false;
      }
      pick({ code: result.claim.code, locationId, source: 'scanned' });
      setStatus('');
      return true;
    }
    switch (result.status) {
      case 'resolved': {
        const other = describeTargetFromCache(cache, result.target);
        setStatus(
          other
            ? t`This label is already on ${isolate(other)}. Use a blank label.`
            : t`This label is already in use. Use a blank label.`,
        );
        break;
      }
      case 'ambiguous':
        setStatus(t`This label is already in use. Use a blank label.`);
        break;
      case 'foreign':
        setStatus(t`This tag belongs to a different SheepKeep server.`);
        break;
      case 'malformed':
        setStatus(t`This tag does not contain a SheepKeep label URL.`);
        break;
      case 'not_kept':
        setStatus(t`Not a SheepKeep label.`);
        break;
      case 'unresolved':
      case 'unassigned':
        setStatus(t`This label could not be checked offline.`);
        break;
      default:
        setStatus(t`This label is unavailable in your SheepKeep.`);
    }
    return false;
  }

  const readCamera = (readout: Read) => {
    if (inFlight.current) return;
    void run(async () => {
      const result = await resolveLabel(
        connection,
        cache,
        readout.text,
        'qr',
        readout.format,
        false,
        adapters,
      );
      if (!live.current) return;
      if (take(result)) setCamera(false);
    });
  };

  function scanNfc() {
    // Release the camera before asking iOS to start its NFC reader.
    flushSync(() => setCamera(false));
    setInspection(undefined);
    return run(async () => {
      const reading = await adapters.nfc.scanTag(connection, { mode: 'read', messages });
      if (!live.current) return;
      if (reading.status !== 'read' || !reading.url) {
        setStatus(
          reading.status === 'blank'
            ? t`This NFC tag is blank. Choose Write new NFC tag to give it a label.`
            : nfcStatus(reading),
        );
        return;
      }
      take(await resolveLabel(connection, cache, reading.url, 'nfc', undefined, false, adapters));
    });
  }

  function inspectNewTag() {
    flushSync(() => setCamera(false));
    setInspection(undefined);
    setExistingOwner(null);
    return run(async () => {
      const label = await reserve();
      if (!label || !live.current) return;
      const { url } = label;
      const reading = await adapters.nfc.scanTag(connection, { mode: 'inspect', url, messages });
      if (!live.current) return;
      if (reading.status !== 'inspected') {
        setStatus(nfcStatus(reading));
        return;
      }
      if (reading.url === url) {
        pick({ code: codeOf(url), locationId, source: 'nfc' });
        setStatus(t`SheepKeep tag verified.`);
        return;
      }
      // A tag that already holds a blank label of this location is that label: no write.
      if (
        reading.url &&
        approvedLabel(reading.url, labelOrigins(connection)).status === 'approved'
      ) {
        const result = await resolveLabel(
          connection,
          cache,
          reading.url,
          'nfc',
          undefined,
          false,
          adapters,
        );
        if (!live.current) return;
        if (result.status === 'unassigned' && result.claim?.locationId === locationId) {
          take(result);
          return;
        }
        if (result.status === 'resolved') {
          setExistingOwner(describeTargetFromCache(cache, result.target));
        }
      }
      if (!reading.writable) {
        setStatus(nfcStatus({ status: 'read_only' }));
        return;
      }
      if ((reading.required ?? 1) > (reading.capacity ?? 0)) {
        setStatus(nfcStatus({ status: 'too_small' }));
        return;
      }
      setInspection({ reading, url });
    });
  }

  function writeNewTag() {
    const pending = inspection;
    if (!pending?.reading.fingerprint) return;
    return run(async () => {
      const held = reserved.current;
      // Keep potentially written codes out of both the shelf and a retry on a different tag.
      reserved.current = undefined;
      setInspection(undefined);
      setExistingOwner(null);
      const result = await adapters.nfc.scanTag(connection, {
        mode: 'write',
        url: pending.url,
        fingerprint: pending.reading.fingerprint,
        messages,
      });
      if (held && NFC_WRITE_NOT_STARTED.has(result.status)) {
        if (live.current) reserved.current = held;
        else if (!inUse.current.has(held.code) && !shared.current.has(held.code)) {
          await shelveReservedCode(connection, held.locationId, held.code, adapters);
        }
      }
      if (!live.current) return;
      if (result.status === 'written') {
        pick({ code: codeOf(pending.url), locationId, source: 'nfc' });
        setStatus(t`SheepKeep tag verified.`);
      } else {
        setStatus(nfcStatus(result));
      }
    });
  }

  function newQrLabel() {
    setCamera(false);
    setInspection(undefined);
    return run(async () => {
      const label = await reserve();
      if (!label || !live.current) return;
      pick({ code: label.code, locationId, source: 'qr' });
    });
  }

  function pick(label: ItemLabel) {
    inUse.current.add(label.code);
    onChange(label);
  }

  function remove() {
    if (value?.source === 'qr' && !shared.current.has(value.code)) inUse.current.delete(value.code);
    // A written tag keeps its code (scanning it gives it back); a QR label not yet stuck on
    // anything can be offered again.
    if (value?.source === 'nfc' && reserved.current?.code === value.code) {
      reserved.current = undefined;
    }
    onChange(undefined);
    setStatus('');
  }

  const valueUrl = value ? labelUrl(labelBase(connection), value.code) : null;
  const locked = disabled || busy;

  return (
    <details
      className="kept-details"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (!next) setCamera(false);
      }}
    >
      <summary>
        <span className="inline-flex flex-wrap items-center gap-2">
          <Trans>QR or NFC label</Trans>
          {value && (
            <span className="kept-chip">
              <QrCodeIcon size={13} aria-hidden />
              <bdi className="ltr">{value.code}</bdi>
            </span>
          )}
        </span>
      </summary>
      <div className="grid gap-3 pt-3">
        {value ? (
          <>
            <p className="text-small text-ink-2">
              {value.source === 'nfc' ? (
                <Trans>NFC tag written and verified. It opens this item once the item syncs.</Trans>
              ) : value.source === 'qr' ? (
                <Trans>
                  New QR label. Share it to print, stick it on the item, and it opens this item once
                  the item syncs.
                </Trans>
              ) : (
                <Trans>Scanned label. It opens this item once the item syncs.</Trans>
              )}
            </p>
            {value.source === 'qr' && valueUrl && (
              <div className="grid justify-items-center gap-3">
                <QrCode value={valueUrl} label={t`SheepKeep QR label`} />
                {https && (
                  <Button
                    variant="secondary"
                    isDisabled={locked}
                    onPress={() => {
                      shared.current.add(value.code);
                      void run(() =>
                        adapters.media.shareLabelPdf(connection, {
                          url: valueUrl,
                          name: itemName.trim() || t`New item`,
                        }),
                      );
                    }}
                  >
                    <Share size={16} aria-hidden />
                    <Trans>Share QR label PDF</Trans>
                  </Button>
                )}
              </div>
            )}
            <Button
              variant="secondary"
              size="small"
              className="justify-self-start"
              isDisabled={locked}
              onPress={remove}
            >
              <X size={15} aria-hidden />
              <Trans>Remove label</Trans>
            </Button>
          </>
        ) : (
          <>
            <p className="text-small text-ink-2">
              <Trans>
                Give a valuable item its own label, then scan the label to open the item.
              </Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                isDisabled={locked}
                onPress={() => {
                  setInspection(undefined);
                  setStatus('');
                  setCamera((open) => !open);
                }}
              >
                <Camera size={15} aria-hidden />
                {camera ? <Trans>Close camera</Trans> : <Trans>Scan QR label</Trans>}
              </Button>
              <Button
                variant="secondary"
                size="small"
                isDisabled={locked}
                onPress={() => void scanNfc()}
              >
                <Nfc size={15} aria-hidden />
                <Trans>Scan NFC tag</Trans>
              </Button>
              {online && https && (
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={locked}
                  onPress={() => void inspectNewTag()}
                >
                  <Tag size={15} aria-hidden />
                  <Trans>Write new NFC tag</Trans>
                </Button>
              )}
              {online && (
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={locked}
                  onPress={() => void newQrLabel()}
                >
                  <QrCodeIcon size={15} aria-hidden />
                  <Trans>New QR label</Trans>
                </Button>
              )}
            </div>
            {!online && (
              <p className="text-small text-ink-2">
                <Trans>Connect to make a new label. You can still scan a blank label.</Trans>
              </p>
            )}
            {camera && (
              <div className="relative min-h-52 overflow-hidden rounded-xl bg-charcoal">
                <ScannerView detect={appDetect()} paused={busy} onRead={readCamera} />
              </div>
            )}
            {inspection && (
              <div className="grid gap-3 rounded-xl border border-line bg-sunken p-4">
                {inspection.reading.occupied ? (
                  <p>
                    <Trans>
                      This tag already holds information. Writing will replace its contents.
                    </Trans>
                  </p>
                ) : (
                  <p>
                    <Trans>This tag is blank and ready to write.</Trans>
                  </p>
                )}
                {existingOwner && (
                  <p className="font-semibold">
                    {t`Currently linked to: ${isolate(existingOwner)}`}
                  </p>
                )}
                <Button isPending={busy} isDisabled={disabled} onPress={() => void writeNewTag()}>
                  <Nfc size={16} aria-hidden />
                  {inspection.reading.occupied ? (
                    <Trans>Overwrite NFC tag</Trans>
                  ) : (
                    <Trans>Write and verify</Trans>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
        {status && (
          <p role="status" className="rounded-xl bg-sunken p-3 text-small text-ink-2">
            {status}
          </p>
        )}
      </div>
    </details>
  );
}

function codeOf(url: string): string {
  return decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
}
