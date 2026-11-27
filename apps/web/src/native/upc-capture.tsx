import { parseScan, productCodeForms } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { BarcodeLookup, ScanOutcome } from '@/api/capture/types';
import { appDetect } from '@/camera/scanner';
import { productName } from '@/components/scan/barcode-sheet';
import type { Read } from '@/components/scan/resolve';
import { ScannerView } from '@/components/scan/scanner-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';

type Candidate = { id: string; locationId: string; name: string | null };

export function UpcCapture({
  connection,
  cache,
  online,
  onNew,
  onOpen,
  onClose,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  online: boolean;
  onNew: (code: string, name?: string) => void;
  onOpen: (target: Target) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { transport, outbox } = usePlatform();
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(true);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [matchPreference, setMatchPreference] = useState('');

  function open(candidate: Candidate) {
    onOpen({ kind: 'thing', id: candidate.id, locationId: candidate.locationId });
  }

  async function chooseMatch(code: string, candidates: Candidate[]) {
    const key = `preferredUpc:${productCodeForms(code).find((form) => form.length === 12) ?? code}`;
    const preferred = await outbox.getValue(connection, key).catch(() => undefined);
    const match = candidates.find((candidate) => candidate.id === preferred);
    if (match) open(match);
    else {
      setMatchPreference(key);
      setMatches(candidates);
    }
  }

  async function read({ text, format }: Read) {
    if (working.current) return;
    const parsed = parseScan(text, format);
    if (parsed.kind !== 'barcode' || !['upc_a', 'upc_e'].includes(parsed.symbology)) {
      setNotice(t`Scan a product UPC or enter the digits printed under it.`);
      setCamera(false);
      return;
    }
    working.current = true;
    setBusy(true);
    setCamera(false);
    setNotice('');
    setMatches([]);
    try {
      let lookupEnabled = false;
      if (online) {
        const response = await transport.request<ScanOutcome>(
          connection,
          capturePaths.scanResolve,
          {
            method: 'POST',
            body: { text: parsed.code, format: parsed.symbology },
          },
        );
        if (response.outcome === 'open' && response.target.kind === 'thing') {
          onOpen(response.target);
          return;
        }
        if (response.outcome === 'legacy_ambiguous') {
          const candidates = response.candidates.filter(({ kind }) => kind === 'thing');
          if (candidates.length) {
            await chooseMatch(parsed.code, candidates);
            return;
          }
        }
        lookupEnabled = response.outcome === 'barcode' && response.barcode.lookupEnabled;
      } else {
        const forms = productCodeForms(parsed.code, parsed.symbology);
        const candidates =
          cache?.things.filter(({ barcode }) => barcode && forms.includes(barcode)) ?? [];
        const first = candidates[0];
        if (candidates.length === 1 && first) {
          open(first);
          return;
        }
        if (candidates.length > 1) {
          await chooseMatch(parsed.code, candidates);
          return;
        }
      }
      const result = lookupEnabled
        ? await transport
            .request<BarcodeLookup>(connection, capturePaths.barcode(parsed.code))
            .catch(() => undefined)
        : undefined;
      onNew(
        parsed.code,
        result?.enabled && result.found && result.product ? productName(result.product) : undefined,
      );
    } catch {
      setNotice(t`Could not check this UPC. Try again.`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {camera && (
        <div className="relative min-h-52 overflow-hidden rounded-xl bg-charcoal">
          <ScannerView detect={appDetect()} paused={busy} onRead={read} />
        </div>
      )}
      {matches.length > 0 && (
        <p>
          <Trans>Several existing items have this UPC. Choose the one to open.</Trans>
        </p>
      )}
      {matches.map((candidate) => (
        <Button
          key={candidate.id}
          variant="secondary"
          onPress={() => {
            void outbox.setValue(connection, matchPreference, candidate.id).catch(() => {});
            open(candidate);
          }}
        >
          {candidate.name ?? t`Unnamed item`}
        </Button>
      ))}
      <TextField
        label={t`UPC digits`}
        value={text}
        onChange={setText}
        inputProps={{ inputMode: 'numeric', maxLength: 13 }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={!text.trim()}
          onPress={() => void read({ text })}
        >
          <Trans>Check UPC</Trans>
        </Button>
        {!camera && (
          <Button variant="secondary" isDisabled={busy} onPress={() => setCamera(true)}>
            <Trans>Scan again</Trans>
          </Button>
        )}
        <Button variant="ghost" isDisabled={busy} onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
