import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronRight,
  Keyboard,
  Nfc,
  Package,
  QrCode as QrCodeIcon,
  Radar,
  Share,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { appDetect } from '@/camera/scanner';
import { useErrorText } from '@/components/page';
import type { Read } from '@/components/scan/resolve';
import { ScannerView } from '@/components/scan/scanner-view';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { TextField } from '@/components/ui/text-field';
import { isolate } from '@/lib/bidi';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection, FindTagEvent, TagReading } from './bridge';
import { ClaimBinLabel } from './claim-bin-label';
import type { InventoryCache } from './inventory';
import {
  describeTargetFromCache,
  inspectTagOwner,
  isTarget,
  labelUrl,
  type ReadResult,
  resolveLabel,
  type ScanCandidate,
  type Target,
} from './labels';
import { useNfcStatusText } from './nfc-status';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export type LabelBox = {
  id: string;
  name: string;
  locationId: string;
  shortCode: string | null;
  /** False for an item that is not a box (its label opens the item; there is no Find). */
  isContainer?: boolean;
};

export const FIND_TARGET_KEY = 'findTarget';

type ScanMode = 'qr' | 'qr-result' | 'nfc';

export function LabelPanel({
  connection,
  cache,
  action,
  box,
  canEnroll = false,
  onOpen,
  onClose,
  onProgram,
  onClearFindTarget,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  action: 'identify' | 'find' | 'enroll';
  box?: LabelBox;
  canEnroll?: boolean;
  onOpen: (target: Target) => void;
  onClose: () => void;
  onProgram?: () => void;
  onClearFindTarget?: () => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findPausedState, setFindPausedState] = useState<'timeout' | 'interrupted' | null>(null);
  const [scanMode, setScanMode] = useState<ScanMode>(action === 'identify' ? 'qr' : 'nfc');
  const [claim, setClaim] = useState<{ code: string; locationId: string }>();
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState('');
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [inspection, setInspection] = useState<TagReading>();
  const [existingOwner, setExistingOwner] = useState<string | null>(null);
  const [unverifiedWrite, setUnverifiedWrite] = useState(false);
  const [matched, setMatched] = useState(false);
  const inFlight = useRef(false);
  const alreadyAlerted = useRef(false);
  const live = useRef(true);
  const identifyRead = useRef<AbortController | null>(null);
  const findSessionId = useRef<string | null>(null);
  const findGeneration = useRef(0);
  const invalidateFindSession = useCallback(() => {
    findGeneration.current += 1;
    findSessionId.current = null;
  }, []);
  const isCurrentFindSession = useCallback(
    (sessionId: string) => live.current && findSessionId.current === sessionId,
    [],
  );
  const url = box?.shortCode ? labelUrl(connection.origin, box.shortCode) : null;
  const messages = {
    scan: t`Hold the top of your iPhone near one NFC tag.`,
    multiple: t`Move other tags away and scan one tag.`,
    written: t`SheepKeep tag verified.`,
    matched: box ? t`Found ${isolate(box.name)}.` : t`Found box.`,
    retry: t`Hold steady against the tag and try again.`,
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const sessionId = findSessionId.current ?? undefined;
      invalidateFindSession();
      void adapters.nfc.cancelTag(sessionId).catch(() => {});
    };
  }, [adapters, invalidateFindSession]);

  // Backgrounding ends the native reader; drop the React generation so a late
  // resolution or native event from that run cannot act on a later session.
  useEffect(() => {
    let remove: (() => Promise<void> | void) | undefined;
    let cancelled = false;
    void adapters.lifecycle
      .onAppStateChange(({ active }) => {
        if (active || !findSessionId.current) return;
        const sessionId = findSessionId.current;
        invalidateFindSession();
        setFinding(false);
        setFindPausedState('interrupted');
        void adapters.nfc.cancelTag(sessionId).catch(() => {});
      })
      .then((fn) => {
        if (cancelled) void fn();
        else remove = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void remove?.();
    };
  }, [adapters, invalidateFindSession]);

  // Persist the active Find target across restarts so timeouts/relaunch keep the selected target.
  useEffect(() => {
    if (action !== 'find' || !box) return;
    void adapters.outbox
      .setValue(
        connection,
        FIND_TARGET_KEY,
        JSON.stringify({
          id: box.id,
          name: box.name,
          locationId: box.locationId,
          shortCode: box.shortCode,
        }),
      )
      .catch(() => {});
  }, [action, adapters, box, connection]);

  const nfcStatus = useNfcStatusText();

  const nonMatchText = useCallback(
    (result: ReadResult): { text: string; verifyDifferent: boolean } => {
      switch (result.status) {
        case 'resolved': {
          const other = describeTargetFromCache(cache, result.target);
          return {
            text: other
              ? t`That is ${isolate(other)}, not this box. Scan another tag.`
              : t`This is a different label. Scan another tag.`,
            verifyDifferent: true,
          };
        }
        case 'ambiguous':
          return {
            text: t`That code matches more than one item, so SheepKeep cannot confirm whether it is this box. Scan another tag.`,
            verifyDifferent: false,
          };
        case 'foreign':
          return {
            text: t`This tag belongs to a different SheepKeep server.`,
            verifyDifferent: false,
          };
        case 'malformed':
          return {
            text: t`This tag does not contain a SheepKeep label URL.`,
            verifyDifferent: false,
          };
        case 'unassigned':
          return { text: t`This label has not been assigned.`, verifyDifferent: true };
        case 'not_kept':
          return { text: t`Not a SheepKeep label.`, verifyDifferent: false };
        case 'unresolved':
          return {
            text: t`This label could not be checked offline, so it is not confirmed as a different box.`,
            verifyDifferent: false,
          };
        default:
          return { text: t`This label is unavailable in your SheepKeep.`, verifyDifferent: false };
      }
    },
    [cache, t],
  );

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setStatus('');
    setCandidates([]);
    setMatched(false);
    try {
      await operation();
    } catch (error) {
      if (isAuthRefusal(error)) {
        onAuthError?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        onAuthError?.('restored');
        return;
      }
      if (live.current) setStatus(errorText(error));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }

  const handleFindResult = useCallback(
    async (result: ReadResult, continuousNfc: boolean, sessionId?: string) => {
      if (!live.current) return;
      if (continuousNfc && (!sessionId || !isCurrentFindSession(sessionId))) return;
      if (box && isTarget(result, box.id)) {
        setMatched(true);
        setFindPausedState(null);
        const announcement = t`Found ${isolate(box.name)}.`;
        setStatus(announcement);
        if (!alreadyAlerted.current) {
          alreadyAlerted.current = true;
          void adapters.feedback.match(connection, announcement).catch(() => {});
        }
        if (continuousNfc && sessionId) {
          if (!isCurrentFindSession(sessionId)) return;
          await adapters.nfc.finishFind(connection, sessionId, announcement).catch(() => {});
        }
        return;
      }
      // Unknown, inaccessible and ambiguous results are never target matches and
      // must not be presented as a definitively different box.
      const { text, verifyDifferent } = nonMatchText(result);
      if (continuousNfc && sessionId && !isCurrentFindSession(sessionId)) return;
      setStatus(text);
      if (verifyDifferent || (result.status !== 'unresolved' && result.status !== 'ambiguous')) {
        void adapters.feedback.nonMatch(connection, text).catch(() => {});
      }
      if (continuousNfc && sessionId) {
        if (!isCurrentFindSession(sessionId)) return;
        await adapters.nfc.continueFind(connection, sessionId, text).catch(() => {});
      }
    },
    [adapters, box, connection, isCurrentFindSession, nonMatchText, t],
  );

  async function read(text: string, mode: 'qr' | 'nfc', format?: string, signal?: AbortSignal) {
    setClaim(undefined);
    const result = await resolveLabel(connection, cache, text, mode, format, false, adapters);
    if (!live.current || signal?.aborted) return;
    if (action === 'find') {
      await handleFindResult(result, false);
      return;
    }
    if (result.status === 'resolved') {
      onOpen(result.target);
      return;
    }
    if (result.status === 'ambiguous') {
      setCandidates(result.candidates);
      setStatus(t`Multiple records match this code. Choose one to open.`);
      return;
    }
    if (result.status === 'foreign')
      setStatus(t`This tag belongs to a different SheepKeep server.`);
    else if (result.status === 'malformed')
      setStatus(t`This tag does not contain a SheepKeep label URL.`);
    else if (result.status === 'unassigned') {
      setStatus(t`This label has not been assigned.`);
      setClaim(result.claim);
    } else if (result.status === 'not_kept') setStatus(t`Not a SheepKeep label.`);
    else if (result.status === 'unresolved') setStatus(t`This label could not be checked offline.`);
    else setStatus(t`This label is unavailable in your SheepKeep.`);
  }

  function scanIdentify() {
    if (inFlight.current) return;
    // Release the camera before asking iOS to start its NFC reader.
    if (scanMode === 'qr') flushSync(() => setScanMode('nfc'));
    else setScanMode('nfc');
    return run(async () => {
      const controller = new AbortController();
      const { signal } = controller;
      identifyRead.current = controller;
      setClaim(undefined);
      try {
        const result = await adapters.nfc.scanTag(connection, { mode: 'read', messages });
        if (!live.current || signal.aborted) return;
        if (result.status === 'read' && result.url)
          await read(result.url, 'nfc', undefined, signal);
        else setStatus(nfcStatus(result));
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        identifyRead.current = null;
      }
    });
  }

  function startQr() {
    if (identifyRead.current) {
      identifyRead.current.abort();
      void adapters.nfc.cancelTag().catch(() => {});
    }
    setStatus('');
    setCandidates([]);
    setClaim(undefined);
    setScanMode('qr');
  }

  function startContinuousFind() {
    return run(async () => {
      alreadyAlerted.current = false;
      setFindPausedState(null);
      // Mint a fresh scan-session identity for this run and invalidate any prior one.
      invalidateFindSession();
      const sessionId = newId();
      findSessionId.current = sessionId;
      const generation = findGeneration.current;
      const isCurrent = () =>
        live.current &&
        findSessionId.current === sessionId &&
        findGeneration.current === generation;
      const remove = await adapters.nfc.onFindReading((event: FindTagEvent) => {
        if (!isCurrent()) return;
        if (event.sessionId !== sessionId) return;
        if (event.status === 'repeated') {
          setStatus(t`Same tag scanned again. Move to another box.`);
          return;
        }
        if (
          event.status === 'blank' ||
          event.status === 'malformed' ||
          event.status === 'unsupported'
        ) {
          const message = nfcStatus(event);
          setStatus(message);
          void adapters.feedback.nonMatch(connection, message).catch(() => {});
          void adapters.nfc.continueFind(connection, sessionId, message).catch(() => {});
          return;
        }
        if (event.status === 'read' && event.url) {
          void resolveLabel(connection, cache, event.url, 'nfc', undefined, false, adapters)
            .then((resolved) => {
              // The server may answer after this session ends or another starts:
              // only the still-current session may act on the result.
              if (isCurrent()) return handleFindResult(resolved, true, sessionId);
            })
            .catch((error: unknown) => {
              if (!isCurrent()) return;
              if (isAuthRefusal(error)) {
                onAuthError?.('expired');
                invalidateFindSession();
                void adapters.nfc.cancelTag(sessionId).catch(() => {});
                return;
              }
              if (isRestoreEpochMismatch(error)) {
                onAuthError?.('restored');
                invalidateFindSession();
                void adapters.nfc.cancelTag(sessionId).catch(() => {});
                return;
              }
              const message = errorText(error);
              setStatus(message);
              void adapters.nfc.continueFind(connection, sessionId, message).catch(() => {});
            });
        }
      });

      try {
        if (!isCurrent()) return;
        setFinding(true);
        const terminal = await adapters.nfc.startFind(connection, { sessionId, messages });
        if (!live.current) return;
        if (terminal.sessionId && terminal.sessionId !== sessionId) return;
        if (findSessionId.current !== sessionId) return;
        // This session has terminated natively; invalidate before surfacing state
        // so no in-flight resolution from it can act afterwards.
        invalidateFindSession();
        if (terminal.status === 'matched') {
          setMatched(true);
        } else if (terminal.status === 'timeout' || terminal.status === 'interrupted') {
          setFindPausedState(terminal.status);
          setStatus(
            terminal.status === 'timeout'
              ? t`The scan timed out. Tap Continue scanning to keep looking for this box.`
              : t`The NFC scan was interrupted. Tap Continue scanning to keep looking.`,
          );
        } else {
          setStatus(nfcStatus(terminal));
        }
      } finally {
        if (findSessionId.current === sessionId) invalidateFindSession();
        if (live.current) setFinding(false);
        await remove();
      }
    });
  }

  async function checkAssignment() {
    if (!box || !url) return false;
    const result = await resolveLabel(connection, cache, url, 'nfc', undefined, true, adapters);
    if (isTarget(result, box.id)) return true;
    setStatus(
      box.isContainer === false
        ? t`The server could not confirm this item’s label. Reopen the item and try again.`
        : t`The server could not confirm this box’s label. Reopen the box and try again.`,
    );
    return false;
  }

  function inspect() {
    return run(async () => {
      setInspection(undefined);
      setExistingOwner(null);
      if (!url || !(await checkAssignment())) return;
      const result = await adapters.nfc.scanTag(connection, { mode: 'inspect', url, messages });
      if (!live.current) return;
      if (result.status !== 'inspected') {
        setStatus(nfcStatus(result));
      } else if (result.url === url) {
        setUnverifiedWrite(false);
        setStatus(t`This tag already contains the verified SheepKeep label.`);
      } else if (!result.writable) {
        setStatus(nfcStatus({ status: 'read_only' }));
      } else if ((result.required ?? 1) > (result.capacity ?? 0)) {
        setStatus(nfcStatus({ status: 'too_small' }));
      } else {
        setUnverifiedWrite(false);
        setInspection(result);
        if (result.url) {
          const owner = await inspectTagOwner(connection, cache, result.url, adapters);
          if (live.current && owner) setExistingOwner(owner);
        }
      }
    });
  }

  function write() {
    return run(async () => {
      if (!url || !inspection?.fingerprint || !(await checkAssignment())) return;
      const result = await adapters.nfc.scanTag(connection, {
        mode: 'write',
        url,
        fingerprint: inspection.fingerprint,
        messages,
      });
      if (!live.current) return;
      setInspection(undefined);
      setExistingOwner(null);
      if (result.status === 'written') {
        setUnverifiedWrite(false);
        setStatus(t`SheepKeep tag verified.`);
      } else {
        if (result.status === 'write_unverified') setUnverifiedWrite(true);
        setStatus(nfcStatus(result));
      }
    });
  }

  function openMatchedBox() {
    if (!box) return;
    void adapters.outbox.deleteValue(connection, FIND_TARGET_KEY).catch(() => {});
    onClearFindTarget?.();
    onOpen({ id: box.id, kind: 'thing', locationId: box.locationId });
  }

  function clearTarget() {
    void adapters.outbox.deleteValue(connection, FIND_TARGET_KEY).catch(() => {});
    onClearFindTarget?.();
    onClose();
  }

  const readCamera = (readout: Read) => {
    if (inFlight.current) return;
    setScanMode(action === 'identify' ? 'qr-result' : 'nfc');
    void run(() => read(readout.text, 'qr', readout.format));
  };

  const heading =
    action === 'identify'
      ? t`Identify a label`
      : action === 'find'
        ? t`Find this box`
        : t`Write NFC tag`;

  const headingIcon =
    action === 'identify' ? (
      <QrCodeIcon size={18} aria-hidden />
    ) : action === 'find' ? (
      <Radar size={18} aria-hidden />
    ) : (
      <Nfc size={18} aria-hidden />
    );

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={heading}
        onBack={onClose}
        icon={headingIcon}
        trailing={
          action === 'find' &&
          box && (
            <Button variant="ghost" size="small" onPress={clearTarget}>
              <X size={15} aria-hidden />
              <Trans>Clear target</Trans>
            </Button>
          )
        }
      />
      {box && (
        <div className="kept-card">
          <div className="flex items-center gap-3">
            <span className="kept-row-lead" aria-hidden>
              <Package size={18} />
            </span>
            <div className="grid min-w-0 gap-0.5">
              <p className="font-semibold">
                <bdi>{box.name}</bdi>
              </p>
              {box.shortCode && (
                <p className="kept-chip justify-self-start">
                  <QrCodeIcon size={13} aria-hidden />
                  <span className="sr-only">
                    <Trans>Label code:</Trans>{' '}
                  </span>
                  <bdi className="ltr">{box.shortCode}</bdi>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      {action === 'identify' && cache && claim && (
        <ClaimBinLabel
          key={claim.code}
          connection={connection}
          cache={cache}
          code={claim.code}
          locationId={claim.locationId}
          onOpen={onOpen}
          onAuthError={onAuthError}
        />
      )}
      {action === 'enroll' ? (
        <div className="kept-card justify-items-center">
          {url && <QrCode value={url} label={t`SheepKeep QR label`} />}
          <div className="flex w-full flex-wrap justify-center gap-2">
            {url?.startsWith('https://') && box && (
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  setBusy(true);
                  setStatus('');
                  void adapters.media
                    .shareLabelPdf(connection, { url, name: box.name })
                    .catch((error: unknown) => setStatus(errorText(error)))
                    .finally(() => setBusy(false));
                }}
              >
                <Share size={16} aria-hidden />
                <Trans>Share QR label PDF</Trans>
              </Button>
            )}
            {canEnroll && url?.startsWith('https://') && (
              <Button isPending={busy} onPress={() => void inspect()}>
                <Nfc size={16} aria-hidden />
                {unverifiedWrite ? <Trans>Verify tag now</Trans> : <Trans>Inspect NFC tag</Trans>}
              </Button>
            )}
          </div>
          {canEnroll && !url?.startsWith('https://') && (
            <p className="text-small text-ink-2">
              <Trans>Connect to your SheepKeep server over HTTPS to enroll NFC tags.</Trans>
            </p>
          )}
          {inspection && (
            <div className="grid w-full gap-3 rounded-xl border border-line bg-sunken p-4">
              {inspection.occupied ? (
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
                <p className="font-semibold">{t`Currently linked to: ${isolate(existingOwner)}`}</p>
              )}
              {inspection.url && (
                <p className="break-all text-small text-ink-2">
                  <bdi>{inspection.url}</bdi>
                </p>
              )}
              <Button isPending={busy} onPress={() => void write()}>
                <Nfc size={16} aria-hidden />
                {inspection.occupied ? (
                  <Trans>Overwrite NFC tag</Trans>
                ) : (
                  <Trans>Write and verify</Trans>
                )}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="kept-card">
            {(action === 'find' || scanMode === 'nfc') && (
              <p className="text-small text-ink-2">
                <Trans>Hold the top of your iPhone close to one tag at a time.</Trans>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {action === 'identify' ? (
                <>
                  <Button
                    isDisabled={scanMode !== 'nfc' && busy}
                    onPress={scanMode === 'nfc' ? startQr : () => void scanIdentify()}
                  >
                    {scanMode === 'nfc' ? (
                      <>
                        <Camera size={18} aria-hidden />
                        <Trans>Scan QR code</Trans>
                      </>
                    ) : (
                      <>
                        <Nfc size={18} aria-hidden />
                        <Trans>Scan NFC tag</Trans>
                      </>
                    )}
                  </Button>
                  {scanMode !== 'qr' && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={scanMode === 'nfc' ? () => void scanIdentify() : startQr}
                    >
                      <Trans>Scan again</Trans>
                    </Button>
                  )}
                </>
              ) : (
                <Button isPending={busy} onPress={() => void startContinuousFind()}>
                  <Nfc size={18} aria-hidden />
                  {finding ? (
                    <Trans>Scanning…</Trans>
                  ) : findPausedState ? (
                    <Trans>Continue scanning</Trans>
                  ) : (
                    <Trans>Scan NFC tag</Trans>
                  )}
                </Button>
              )}
              {finding && (
                <Button
                  variant="secondary"
                  onPress={() => {
                    const sessionId = findSessionId.current ?? undefined;
                    invalidateFindSession();
                    setStatus(t`Scan cancelled.`);
                    void adapters.nfc.cancelTag(sessionId).catch(() => {});
                  }}
                >
                  <Square size={15} aria-hidden />
                  <Trans>Stop scanning</Trans>
                </Button>
              )}
              {action === 'find' && scanMode !== 'qr' && (
                <Button variant="secondary" isDisabled={busy} onPress={() => setScanMode('qr')}>
                  <Camera size={18} aria-hidden />
                  <Trans>Scan QR code</Trans>
                </Button>
              )}
              {action === 'identify' && onProgram && (
                <Button variant="secondary" isDisabled={busy} onPress={onProgram}>
                  <Nfc size={18} aria-hidden />
                  <Trans>Write NFC tag</Trans>
                </Button>
              )}
            </div>
          </div>
          {matched && box && (
            <div className="kept-match-card grid gap-3" role="status">
              <p className="flex items-center gap-2 text-title font-semibold text-ok">
                <CheckCircle2 size={22} aria-hidden />
                <span>{t`Found ${isolate(box.name)}.`}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onPress={openMatchedBox}>
                  <Trans>Open box</Trans>
                  <ArrowRight size={16} className="rtl:rotate-180" aria-hidden />
                </Button>
              </div>
            </div>
          )}
          {scanMode === 'qr' && (
            <div className="relative min-h-52 overflow-hidden rounded-xl bg-charcoal">
              <ScannerView detect={appDetect()} paused={busy} onRead={readCamera} />
              {action === 'find' && (
                <div className="relative z-10 p-2">
                  <Button variant="secondary" onPress={() => setScanMode('nfc')}>
                    <X size={16} aria-hidden />
                    <Trans>Close camera</Trans>
                  </Button>
                </div>
              )}
            </div>
          )}
          <form
            className="kept-card"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim()) void run(() => read(typed.trim(), 'qr'));
            }}
          >
            <TextField label={t`Type the code`} value={typed} onChange={setTyped} />
            <Button type="submit" variant="secondary" isDisabled={!typed.trim() || busy}>
              <Keyboard size={16} aria-hidden />
              <Trans>Open label</Trans>
            </Button>
          </form>
        </>
      )}
      {candidates.length > 0 && (
        <ul className="grid gap-2">
          {candidates.map((candidate) => (
            <li key={`${candidate.kind}:${candidate.id}`}>
              <Button
                variant="secondary"
                className="kept-phone-row"
                onPress={() =>
                  onOpen({
                    id: candidate.id,
                    kind: candidate.kind,
                    locationId: candidate.locationId,
                  })
                }
              >
                <span className="kept-row-lead" aria-hidden>
                  <Package size={18} />
                </span>
                <span className="kept-row-body">
                  <bdi className="font-semibold">{candidate.name || t`Untitled`}</bdi>
                  <bdi className="text-small font-normal text-ink-2">{candidate.locationName}</bdi>
                </span>
                <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!matched && status && (
        <p role="status" className="rounded-xl bg-sunken p-3 text-ink-2">
          {status}
        </p>
      )}
    </section>
  );
}
