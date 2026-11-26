import {
  COMPACT_THERMAL_STOCK,
  defaultPrinterProfile,
  deviceLabelReference,
  isThermalLabelStock,
  MICRO_THERMAL_STOCK,
  type PrinterProfile,
  printerOnStock,
  profileForBatch,
  savePrinterStock,
  supportsDrawerTemplate,
  ThermalBatchSpecSchema,
  type ThermalLayout,
  type WorkshopIcon,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { liveQuery } from 'dexie';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CreateLabelBatchBody, LabelBatch, LabelCellContent } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { ErrorState, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { TextField } from '@/components/ui/text-field';
import { sep } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useQrEncoder } from '../qr';
import type { PrintApi } from './api';
import {
  calibrationDocument,
  DEFAULT_THERMAL_OPTIONS,
  type ThermalDocument,
  ThermalFitError,
  thermalDocument,
} from './document';
import { EpcForm } from './epc-form';
import { knownLabelAddress, printSpec, syncPrintConfirmation, syncPrintManifest } from './jobs';
import {
  fitsNiimbotStock,
  isNiimbotStock,
  NIIMBOT_COPY_LIMIT,
  NIIMBOT_PAGE_LIMIT,
  type NiimbotDevice,
  type NiimbotOutput,
  niimbotJob,
  niimbotProfile,
} from './niimbot';
import { isNiimbotError, NiimbotSettings, useNiimbotErrorText } from './niimbot-settings';
import {
  BrowserPrintPages,
  canBrowserPrint,
  type NativeThermalOutput,
  PdfButton,
  saveThermalPdf,
  ThermalPreview,
} from './output';
import { loadThermalPdf, thermalPdf } from './pdf';
import { ReplaceLabelForm } from './replace-form';
import { Choices, PrintNumber, ThermalSettings } from './settings';
import {
  batchLabels,
  createPrintManifest,
  manifestLabels,
  type PrintManifest,
  type PrintState,
  printStore,
  recordPrint,
} from './store';

export type ThermalSource = Omit<CreateLabelBatchBody, 'stock' | 'thermal' | 'dryRun'>;
const initialStock = COMPACT_THERMAL_STOCK;
const stocksMatch = (stock: string, layout: ThermalLayout) =>
  stock === 'thermal_4x6in' ? layout : 'single';

type Prepared = { queue?: string | undefined; stock?: string } & (
  | { kind: 'calibration'; doc: ThermalDocument }
  | { kind: 'cached'; doc: ThermalDocument; label: LabelCellContent }
  | { kind: 'local'; job: PrintManifest; doc: ThermalDocument }
  | { kind: 'server'; batch: LabelBatch; doc: ThermalDocument }
);

function receiptKey(prepared: Prepared) {
  if (prepared.kind === 'server') return `batch:${prepared.batch.id}`;
  if (prepared.kind === 'cached') return `label:${prepared.label.url}`;
}

function observedAttempt(state: PrintState | undefined): PrintState | null {
  return state === 'connecting' ? 'uncertain' : (state ?? null);
}

export function ThermalStudio({
  owner,
  source,
  api,
  nativeOutput,
  bluetooth,
  cachedLabel,
  batch,
  reprintStock,
  suggestIcon,
  onSaved,
}: {
  owner: string;
  source: ThermalSource;
  api: PrintApi;
  nativeOutput?: NativeThermalOutput | undefined;
  bluetooth?: NiimbotOutput | undefined;
  cachedLabel?: LabelCellContent | undefined;
  batch?: LabelBatch | undefined;
  reprintStock?: string | undefined;
  suggestIcon?: ((photo: File) => Promise<WorkshopIcon | undefined>) | undefined;
  onSaved?: (batch: LabelBatch) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const bluetoothErrorText = useNiimbotErrorText();
  const confirmDialog = useConfirm();
  const encode = useQrEncoder();
  const online = useOnline();
  const [address, setAddress] = useState('');
  const [profile, setProfile] = useState(defaultPrinterProfile);
  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [stock, setStock] = useState(reprintStock ?? batch?.stock ?? initialStock);
  const [layout, setLayout] = useState(() =>
    stocksMatch(stock, batch?.thermal?.layout ?? 'single'),
  );
  const [options, setOptions] = useState(batch?.thermal?.options ?? DEFAULT_THERMAL_OPTIONS);
  const [mode, setMode] = useState<'temporary' | 'category'>('temporary');
  const [prefix, setPrefix] = useState('GEN');
  const [count, setCount] = useState(source.blankCount ?? 1);
  const [category, setCategory] = useState(batch?.thermal?.category ?? '');
  const [contents, setContents] = useState(batch?.thermal?.contents ?? '');
  const [loaded, setLoaded] = useState<{ labels: LabelCellContent[] } | { error: unknown } | null>(
    null,
  );
  const [previewRetry, setPreviewRetry] = useState(0);
  const [jobs, setJobs] = useState<PrintManifest[]>([]);
  const [selected, setSelected] = useState<Prepared | null>(null);
  const [pdf, setPdf] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [attempt, setAttempt] = useState<PrintState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const inFlight = useRef(false);
  const bluetoothActive = useRef(false);
  const [firstPage, setFirstPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
  const [copies, setCopies] = useState(1);
  const [reported, setReported] = useState<number>();
  const bluetoothId =
    bluetooth && profile.adapter === 'niimbot-b1-pro' ? profile.bluetoothId : undefined;
  const bluetoothReady = !!(
    bluetoothId &&
    selected?.stock &&
    fitsNiimbotStock(selected.stock, selected.doc)
  );
  const validPrintRange =
    Number.isInteger(firstPage) &&
    Number.isInteger(lastPage) &&
    Number.isInteger(copies) &&
    firstPage >= 1 &&
    lastPage >= firstPage &&
    lastPage <= (selected?.doc.pages.length ?? 0) &&
    lastPage - firstPage + 1 <= NIIMBOT_PAGE_LIMIT &&
    copies >= 1 &&
    copies <= NIIMBOT_COPY_LIMIT;

  const selectedJobId = selected?.kind === 'local' ? selected.job.id : undefined;
  const selectedDocument = selected?.doc;
  const locationId = source.locationId;
  const newNumbered = source.kind === 'blank' && !batch;
  const seriesPrefix = mode === 'temporary' ? 'TMP' : prefix;
  const draftCategory = mode === 'category' || batch ? category.trim() : '';
  const draftContents = contents.trim();
  const spec = printSpec(stock, layout, profile, options, draftCategory, draftContents);

  useEffect(() => {
    if (online) void loadThermalPdf().catch(() => {});
  }, [online]);

  useEffect(
    () => () => {
      if (bluetoothActive.current) void bluetooth?.cancel().catch(() => {});
    },
    [bluetooth],
  );

  useEffect(() => {
    let active = true;
    void printStore.preferences
      .get(owner)
      .then((row) => {
        if (!active) return;
        if (row) {
          setProfiles(row.profiles);
          if (row.address) setAddress((current) => current || row.address || '');
        }
        const saved = row?.profiles.find(
          (item) => item.id === row.profileId && (item.adapter !== 'niimbot-b1-pro' || bluetooth),
        );
        if (reprintStock) {
          if (saved && (saved.adapter !== 'niimbot-b1-pro' || isNiimbotStock(reprintStock))) {
            setProfile(printerOnStock(saved, reprintStock));
          }
        } else if (batch?.thermal) {
          const rendering = profileForBatch(batch.stock, batch.thermal);
          if (saved?.adapter === 'niimbot-b1-pro') {
            setProfile(
              isNiimbotStock(batch.stock) ? printerOnStock(saved, batch.stock) : rendering,
            );
            return;
          }
          setProfile(
            saved
              ? { ...saved, ...rendering, id: saved.id, name: saved.name, media: saved.media }
              : rendering,
          );
        } else if (row && isThermalLabelStock(row.stock)) {
          const printer = saved && printerOnStock(saved, row.stock);
          if (printer) setProfile(printer);
          if (!batch) {
            setStock(row.stock);
            setLayout(stocksMatch(row.stock, printer?.layout ?? 'single'));
          }
        }
      })
      .catch(() => {});
    void api
      .address()
      .then(knownLabelAddress)
      .then(async (value) => {
        if (active) setAddress(value);
        await printStore.transaction('rw', printStore.preferences, async () => {
          const row = await printStore.preferences.get(owner);
          await printStore.preferences.put({
            owner,
            profiles: [],
            profileId: '',
            stock: initialStock,
            ...row,
            address: value,
          });
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, owner, batch, reprintStock, bluetooth]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const local = await printStore.jobs
        .where('[owner+locationId]')
        .equals([owner, locationId])
        .toArray();
      if (active) setJobs(local.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      if (!online) return;
      for (const job of local) {
        if (!active) return;
        if (
          job.registration !== 'pending' &&
          !(job.registration === 'registered' && job.confirmedAt && !job.confirmationSynced)
        )
          continue;
        const synced = await syncPrintManifest(job, api);
        if (active) {
          setJobs((old) => old.map((row) => (row.id === synced.id ? synced : row)));
          setSelected((old) =>
            old?.kind === 'local' && old.job.id === synced.id ? { ...old, job: synced } : old,
          );
        }
      }
    };
    void refresh().catch(() => {});
    return () => {
      active = false;
    };
  }, [api, owner, locationId, online]);

  useEffect(() => {
    if (!selectedJobId) return;
    const subscription = liveQuery(() => printStore.jobs.get(selectedJobId)).subscribe({
      next(job) {
        setSelected((old) => {
          if (old?.kind !== 'local' || old.job.id !== selectedJobId) return old;
          const registration = job?.registration ?? 'blocked';
          return old.job.registration === registration
            ? old
            : { ...old, job: job ?? { ...old.job, registration } };
        });
      },
      error() {
        setSelected((old) =>
          old?.kind === 'local' && old.job.id === selectedJobId
            ? { ...old, job: { ...old.job, registration: 'blocked' } }
            : old,
        );
      },
    });
    return () => subscription.unsubscribe();
  }, [selectedJobId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnecting or requesting a retry reloads the draft.
  useEffect(() => {
    if (newNumbered || batch) return;
    let active = true;
    setLoaded(null);
    void api
      .preview({ ...source, stock: initialStock })
      .then((out) => {
        if (active) setLoaded({ labels: out.labels });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ error });
      });
    return () => {
      active = false;
    };
  }, [api, source, newNumbered, batch, online, previewRetry]);

  const offlineLabel =
    !batch &&
    cachedLabel &&
    (!online ||
      (loaded && 'error' in loaded && isApiError(loaded.error) && loaded.error.code === 'offline'))
      ? cachedLabel
      : undefined;
  const labels =
    batch?.labels ??
    (offlineLabel ? [offlineLabel] : loaded && 'labels' in loaded ? loaded.labels : undefined);

  const preview = useMemo(() => {
    if (!encode) return null;
    const example = `${seriesPrefix}-A09Z-0001`;
    const exampleUrl = address
      ? `${address}/l/${deviceLabelReference(example, '00000000-0000-4000-8000-010203040506')}`
      : 'https://labels.example.org/l/TMP-A09Z-0001-010203040506';
    const previewLabels = newNumbered
      ? Array.from({ length: Math.max(1, Math.min(12, count)) }, () => ({
          identifier: example,
          url: exampleUrl,
          name: draftCategory || undefined,
          category: draftCategory || undefined,
          writeIn: mode === 'temporary',
          contents: draftContents,
        }))
      : batchLabels({
          labels: labels?.slice(0, 12) ?? [],
          category: draftCategory,
          contents: draftContents,
        });
    if (previewLabels.length === 0) return null;
    try {
      return { doc: thermalDocument(stock, layout, profile, options, previewLabels, encode) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [
    address,
    draftCategory,
    draftContents,
    count,
    encode,
    labels,
    layout,
    mode,
    newNumbered,
    options,
    profile,
    seriesPrefix,
    stock,
  ]);

  useEffect(() => {
    let active = true;
    setPdf(null);
    if (selectedDocument) {
      void thermalPdf(selectedDocument)
        .then((bytes) => {
          if (active) setPdf(bytes);
        })
        .catch(() => {
          if (active) setProblem(t`Couldn’t prepare the PDF.`);
        });
    }
    return () => {
      active = false;
    };
  }, [selectedDocument, t]);

  const show = async (prepared: Prepared, physicalStock = stock) => {
    const key = receiptKey(prepared);
    const latest = bluetooth && key ? await printStore.receipts.get([owner, key]) : undefined;
    setPdf(null);
    setSelected({ ...prepared, stock: physicalStock, queue: profile.queue?.trim() });
    setAttempt(observedAttempt(latest?.state));
    setConfirmed(false);
    setReported(undefined);
    setFirstPage(1);
    setLastPage(Math.min(prepared.doc.pages.length, NIIMBOT_PAGE_LIMIT));
  };

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(
        error instanceof ThermalFitError
          ? t`The QR and complete identifier need more printable space.`
          : errorText(error),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function remember(saved?: PrinterProfile, physicalStock = stock) {
    await printStore.transaction('rw', printStore.preferences, async () => {
      const prior = await printStore.preferences.get(owner);
      const list = prior?.profiles ?? [];
      const next = saved ? [...list.filter((item) => item.id !== saved.id), saved] : list;
      await printStore.preferences.put({
        owner,
        stock: physicalStock,
        profileId: saved?.id ?? profile.id,
        profiles: next,
        address: address || prior?.address,
      });
      if (saved) {
        setProfiles(next);
        setProfile(saved);
      }
    });
  }

  function restore(id: string) {
    const saved = profiles.find((entry) => entry.id === id) ?? defaultPrinterProfile();
    const next = printerOnStock(saved, saved.stock);
    setProfile(next);
    setStock(next.stock);
    setLayout(stocksMatch(next.stock, next.layout));
  }

  async function selectNiimbot(device: NiimbotDevice) {
    const id = `niimbot:${device.id}`;
    const saved = profiles.find((item) => item.id === id);
    const next = saved ? printerOnStock(saved, saved.stock) : niimbotProfile(device, stock);
    await remember(next, next.stock);
    setStock(next.stock);
    setLayout('single');
  }

  async function forgetNiimbot(id: string) {
    await printStore.transaction('rw', printStore.preferences, async () => {
      const prior = await printStore.preferences.get(owner);
      if (!prior) return;
      const next = prior.profiles.filter((item) => item.id !== id);
      await printStore.preferences.put({
        ...prior,
        profiles: next,
        profileId: prior.profileId === id ? '' : prior.profileId,
      });
      setProfiles(next);
    });
    if (profile.id === id) restore('system');
  }

  async function prepare() {
    if (!encode) return;
    const settings = ThermalBatchSpecSchema.parse(spec);
    // Existing server labels can still print when local browser storage is unavailable.
    await remember().catch(() => {});
    if (newNumbered) {
      // Persist first so even an unexpected render or network failure keeps the reservation.
      let job = await createPrintManifest(
        printStore,
        {
          owner,
          locationId,
          prefix: seriesPrefix,
          origin: knownLabelAddress(address),
          stock,
          spec: settings,
        },
        count,
      );
      setJobs((old) => [job, ...old]);
      const doc = thermalDocument(stock, layout, profile, options, manifestLabels(job), encode);
      if (online) job = await syncPrintManifest(job, api);
      setJobs((old) => old.map((row) => (row.id === job.id ? job : row)));
      await show({ kind: 'local', doc, job });
      return;
    }
    if (offlineLabel) {
      const doc = thermalDocument(
        stock,
        layout,
        profile,
        options,
        batchLabels({ labels: [offlineLabel] }),
        encode,
      );
      await show({ kind: 'cached', doc, label: offlineLabel });
      return;
    }
    const ready = batch ?? (await api.create({ ...source, stock, thermal: settings })).batch;
    const doc = thermalDocument(
      stock,
      layout,
      profile,
      options,
      batchLabels({
        labels: ready.labels,
        category: settings.category,
        contents: settings.contents,
      }),
      encode,
    );
    await show({ kind: 'server', doc, batch: ready });
    onSaved?.(ready);
  }

  async function openJob(job: PrintManifest, useSelectedStock = false) {
    if (!encode) return;
    job = (await printStore.jobs.get(job.id)) ?? { ...job, registration: 'blocked' };
    const doc = thermalDocument(
      useSelectedStock ? stock : job.stock,
      useSelectedStock ? layout : job.spec.layout,
      useSelectedStock ? profile : profileForBatch(job.stock, job.spec),
      job.spec.options,
      manifestLabels(job),
      encode,
    );
    await show({ kind: 'local', doc, job }, useSelectedStock ? stock : job.stock);
    setAttempt(observedAttempt(job.prints.at(-1)?.state));
  }

  async function sync(job: PrintManifest) {
    const next = await syncPrintManifest(job, api);
    setJobs((old) => old.map((row) => (row.id === next.id ? next : row)));
    setSelected((old) =>
      old?.kind === 'local' && old.job.id === next.id ? { ...old, job: next } : old,
    );
  }

  async function mark(state: PrintState) {
    const key = selected && receiptKey(selected);
    if (bluetoothId && key) await printStore.receipts.put({ owner, key, state });
    setAttempt(state);
    if (selected?.kind === 'local') {
      await recordPrint(printStore, selected.job.id, state);
      const row = await printStore.jobs.get(selected.job.id);
      if (row) setJobs((old) => old.map((job) => (job.id === row.id ? row : job)));
    }
  }

  async function outputAllowed() {
    if (!selected) return false;
    if (selected.kind !== 'local') return true;
    const cached = await printStore.jobs.get(selected.job.id);
    if (cached?.registration === 'pending' || cached?.registration === 'registered') return true;
    const job = cached ?? { ...selected.job, registration: 'blocked' as const };
    setSelected({ ...selected, job });
    setJobs((rows) => rows.map((row) => (row.id === job.id ? job : row)));
    return false;
  }

  async function print() {
    if (!selected || (!(bluetooth && bluetoothId) && nativeOutput && !pdf)) return;
    if (!(await outputAllowed())) return;
    if (
      (attempt === 'uncertain' || attempt === 'partial') &&
      !(await confirmDialog({
        title: t`Print these labels again?`,
        body: t`Check the printer output first. Printing again can produce duplicate labels.`,
        confirmLabel: t`Print`,
      }))
    )
      return;

    if (bluetooth && bluetoothId && selected.stock) {
      if (!bluetoothReady || !validPrintRange) return;
      const job = niimbotJob(
        selected.stock,
        selected.doc,
        firstPage,
        lastPage,
        copies,
        profile.darkness ?? 3,
      );
      await mark('connecting');
      bluetoothActive.current = true;
      setReported(undefined);
      try {
        const result = await bluetooth.print(bluetoothId, job);
        setReported(result.completed);
        await mark(result.state === 'completed' ? 'printer-completed' : result.state);
      } catch (error) {
        // A response lost after dispatch cannot distinguish a print from a dropped connection.
        // Native NIIMBOT errors only escape before a print job has been started.
        await mark(isNiimbotError(error) ? 'failed' : 'uncertain');
        setProblem(bluetoothErrorText(error));
      } finally {
        bluetoothActive.current = false;
      }
      return;
    }

    try {
      if (nativeOutput && pdf) {
        const result = await nativeOutput(pdf, false);
        await mark(result === 'cancelled' ? 'cancelled' : 'submitted');
      } else {
        window.print();
        await mark('opened');
      }
    } catch (error) {
      await mark('failed');
      throw error;
    }
  }

  async function confirm() {
    if (!selected || selected.kind === 'calibration' || selected.kind === 'cached') return;
    if (!(await outputAllowed())) return;
    if (selected.kind === 'server') await api.confirm(selected.batch.id);
    await mark('confirmed');
    if (selected.kind === 'local') {
      const latest = await printStore.jobs.get(selected.job.id);
      if (latest?.registration === 'registered') await syncPrintConfirmation(latest, api);
    }
    setConfirmed(true);
  }

  const canPrepare =
    !!preview?.doc &&
    (!newNumbered ||
      (!!address &&
        /^[A-Z]{3}$/.test(seriesPrefix) &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= 500 &&
        (mode === 'temporary' || !!category.trim())));
  const canOutput =
    !!selected &&
    (selected.kind !== 'local' || ['registered', 'pending'].includes(selected.job.registration));
  const queue = selected?.queue;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="grid content-start gap-4">
          {newNumbered && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Choices
                label={t`Label mode`}
                value={mode}
                items={[
                  { id: 'temporary', name: t`Temporary write-in (TMP)` },
                  { id: 'category', name: t`Preprinted category` },
                ]}
                change={setMode}
              />
              <PrintNumber
                label={t`Quantity`}
                value={count}
                min={1}
                max={500}
                change={(value) => setCount(value ?? 0)}
              />
              {mode === 'category' && (
                <>
                  <TextField
                    label={t`Category prefix`}
                    value={prefix}
                    onChange={(value) => setPrefix(value.toUpperCase())}
                    inputProps={{ maxLength: 3, autoCapitalize: 'characters' }}
                  />
                  <TextField
                    label={t`Category name`}
                    value={category}
                    onChange={setCategory}
                    inputProps={{ maxLength: 100 }}
                  />
                </>
              )}
            </div>
          )}
          {!newNumbered && (
            <p className="m-0 font-semibold">
              <Trans>Preprinted inventory or batch reprint</Trans>
            </p>
          )}
          {bluetooth && (
            <NiimbotSettings
              output={bluetooth}
              profile={profile}
              selectPrinter={selectNiimbot}
              forget={forgetNiimbot}
              disabled={busy}
            />
          )}
          <ThermalSettings
            stock={stock}
            setStock={(value) => {
              const printer = printerOnStock(profile, value);
              setProfile(printer);
              setStock(value);
              setLayout(stocksMatch(value, printer.layout));
            }}
            layout={layout}
            setLayout={setLayout}
            profile={profile}
            setProfile={setProfile}
            profiles={profiles.filter((entry) => bluetooth || entry.adapter !== 'niimbot-b1-pro')}
            selectProfile={restore}
            saveProfile={() =>
              void run(async () => {
                ThermalBatchSpecSchema.parse(spec);
                await remember(
                  savePrinterStock(
                    {
                      ...profile,
                      id: profile.id || crypto.randomUUID(),
                      name: profile.name.trim(),
                    },
                    stock,
                    layout,
                  ),
                );
              })
            }
            options={options}
            setOptions={setOptions}
            suggestIcon={suggestIcon}
          />
          <TextField
            label={
              options.template === 'drawer' && supportsDrawerTemplate(stock)
                ? t`Drawer contents`
                : stock === MICRO_THERMAL_STOCK || stock === COMPACT_THERMAL_STOCK
                  ? t`Size or model (optional)`
                  : t`Contents summary (optional)`
            }
            value={contents}
            onChange={setContents}
            inputProps={{ maxLength: 400 }}
          />
          {newNumbered && !address && (
            <Notice>
              <Trans>
                Connect once to load this server’s permanent label address before creating an
                offline batch.
              </Trans>
            </Notice>
          )}
          {!batch && !offlineLabel && loaded && 'error' in loaded && (
            <ErrorState
              error={loaded.error}
              onRetry={() => setPreviewRetry((attempt) => attempt + 1)}
            />
          )}
          {!batch && labels?.length === 0 && (
            <Notice>
              <Trans>Nothing here can be labelled now</Trans>
            </Notice>
          )}
          <DocumentWarnings doc={preview?.doc} />
          {preview?.error && (
            <Notice tone="warn">
              <Trans>
                The QR and complete identifier need more printable space. Check the stock, margins,
                resolution, and label address.
              </Trans>
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button isPending={busy} isDisabled={!canPrepare} onPress={() => void run(prepare)}>
              <Trans>Prepare labels</Trans>
            </Button>
            <Button
              variant="secondary"
              isDisabled={!encode || busy}
              onPress={() =>
                void run(async () => {
                  if (encode)
                    await show({
                      kind: 'calibration',
                      doc: calibrationDocument(
                        stock,
                        profile,
                        'https://example.org/calibration',
                        encode,
                      ),
                    });
                })
              }
            >
              <Trans>Prepare calibration print</Trans>
            </Button>
          </div>
        </div>
        {preview?.doc && <ThermalPreview doc={preview.doc} />}
      </div>
      {selected && (
        <section
          className="grid gap-3 rounded-lg border border-line p-3"
          aria-label={t`Prepared print job`}
        >
          <ThermalPreview doc={selected.doc} />
          {selected.kind === 'local' && <RegistrationStatus job={selected.job} />}
          <DocumentWarnings doc={selected.doc} />
          {queue && !bluetoothId && (
            <p className="m-0">
              <Trans>Choose {queue} in the print dialog.</Trans>
            </p>
          )}
          {bluetoothId ? (
            bluetoothReady ? (
              <div className="grid gap-2">
                <p className="m-0 text-small text-ink-2">
                  <Trans>Load the matching NIIMBOT gap stock before printing.</Trans>
                </p>
                {selected.doc.pages.length > NIIMBOT_PAGE_LIMIT && (
                  <p className="m-0 text-small">{t`Pages in this job: ${selected.doc.pages.length}`}</p>
                )}
                <div className="grid gap-2 sm:grid-cols-3">
                  <PrintNumber
                    label={t`First page`}
                    value={firstPage}
                    min={1}
                    max={selected.doc.pages.length}
                    change={(value) => setFirstPage(value ?? 0)}
                  />
                  <PrintNumber
                    label={t`Last page`}
                    value={lastPage}
                    min={1}
                    max={selected.doc.pages.length}
                    change={(value) => setLastPage(value ?? 0)}
                  />
                  <PrintNumber
                    label={t`Copies per label`}
                    value={copies}
                    min={1}
                    max={NIIMBOT_COPY_LIMIT}
                    change={(value) => setCopies(value ?? 0)}
                  />
                </div>
                {!validPrintRange && (
                  <Notice tone="warn">{t`Select a valid range of up to ${NIIMBOT_PAGE_LIMIT} pages.`}</Notice>
                )}
              </div>
            ) : (
              <Notice tone="warn">
                <Trans>Prepare this job on a supported B1 Pro stock.</Trans>
              </Notice>
            )
          ) : (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                Use the matching paper size, actual size (100%), and no headers or footers.
              </Trans>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {canOutput && (bluetoothId || nativeOutput || canBrowserPrint()) && (
              <Button
                isDisabled={
                  busy ||
                  (bluetoothId ? !bluetoothReady || !validPrintRange : !!nativeOutput && !pdf)
                }
                onPress={() => void run(print)}
              >
                {bluetoothId ? <Trans>Print on B1 Pro</Trans> : <Trans>Print</Trans>}
              </Button>
            )}
            {attempt === 'connecting' && busy && bluetooth && (
              <Button variant="secondary" onPress={() => void bluetooth.cancel().catch(() => {})}>
                <Trans>Cancel print</Trans>
              </Button>
            )}
            {canOutput && (
              <PdfButton
                pdf={busy ? null : pdf}
                send={(value) =>
                  void run(async () => {
                    if (!(await outputAllowed())) return;
                    if (nativeOutput) await nativeOutput(value, true);
                    else await saveThermalPdf(value);
                  })
                }
              />
            )}
          </div>
          {confirmed || attempt === 'confirmed' ? (
            <Notice tone="ok">
              <Trans>Print confirmed.</Trans>
            </Notice>
          ) : null}
          {attempt === 'connecting' && (
            <Notice>
              <Trans>Connecting to the printer or sending labels…</Trans>
            </Notice>
          )}
          {attempt === 'printer-completed' && (
            <Notice tone="ok">
              <Trans>The printer reports completion. Check the printed labels.</Trans>
            </Notice>
          )}
          {attempt === 'uncertain' && (
            <Notice tone="warn">
              <Trans>
                Print completion is uncertain. Check the output before reprinting the same
                identifiers.
              </Trans>
              {reported !== undefined && <p>{t`Labels reported complete: ${reported}`}</p>}
            </Notice>
          )}
          {attempt === 'cancelled' && (
            <Notice>
              <Trans>Print cancelled. The same job is ready to retry.</Trans>
            </Notice>
          )}
          {attempt === 'failed' && (
            <Notice tone="warn">
              <Trans>No output recorded. Reprint the same identifiers from this job.</Trans>
            </Notice>
          )}
          {attempt === 'partial' && (
            <Notice tone="warn">
              <Trans>Partial print recorded. Reprint the missing pages using the page range.</Trans>
            </Notice>
          )}
          {selected.kind !== 'calibration' &&
            selected.kind !== 'cached' &&
            (attempt === 'opened' ||
              attempt === 'submitted' ||
              attempt === 'printer-completed' ||
              attempt === 'uncertain' ||
              (!attempt && canOutput)) && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" isDisabled={busy} onPress={() => void run(confirm)}>
                  <Trans>Confirm printed</Trans>
                </Button>
                {(attempt === 'opened' ||
                  attempt === 'submitted' ||
                  attempt === 'printer-completed' ||
                  attempt === 'uncertain') && (
                  <>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void run(() => mark('partial'))}
                    >
                      <Trans>Record partial print</Trans>
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void run(() => mark('failed'))}
                    >
                      <Trans>No labels printed</Trans>
                    </Button>
                  </>
                )}
              </div>
            )}
          {canOutput && !nativeOutput && canBrowserPrint() && (
            <BrowserPrintPages doc={selected.doc} />
          )}
        </section>
      )}
      {jobs.length > 0 && !batch && (
        <section className="grid gap-2" aria-label={t`Device batch history`}>
          <h2 className="m-0 font-semibold">
            <Trans>Device batch history</Trans>
          </h2>
          <ul className="m-0 grid list-none gap-2 p-0">
            {jobs.map((job) => (
              <li key={job.id} className="grid gap-2 rounded-lg border border-line p-3">
                <bdi className="font-mono">
                  {job.codes[0]}
                  {sep()}
                  {job.codes.length}
                </bdi>
                <RegistrationStatus job={job} />
                {job.confirmedAt && (
                  <p className="m-0 text-small">
                    <Trans>Print confirmed.</Trans>
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {job.registration !== 'collision' && (
                    <Button
                      variant="secondary"
                      isDisabled={!encode || busy}
                      onPress={() => void run(async () => openJob(job))}
                    >
                      <Trans>Open batch for reprint</Trans>
                    </Button>
                  )}
                  {(job.stock !== stock || (bluetoothId && job.spec.profile.dpi !== profile.dpi)) &&
                    job.registration !== 'collision' && (
                      <Button
                        variant="secondary"
                        isDisabled={!encode || busy}
                        onPress={() => void run(async () => openJob(job, true))}
                      >
                        <Trans>Reprint on selected stock</Trans>
                      </Button>
                    )}
                  {job.registration !== 'registered' && job.registration !== 'collision' && (
                    <Button
                      variant="secondary"
                      isDisabled={busy || !online}
                      onPress={() => void run(() => sync(job))}
                    >
                      <Trans>Retry registration</Trans>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {newNumbered && online && <ReplaceLabelForm locationId={locationId} replace={api.replace} />}
      {newNumbered && online && <EpcForm locationId={locationId} register={api.registerTag} />}
      {problem && <Notice tone="danger">{problem}</Notice>}
    </div>
  );
}

function DocumentWarnings({ doc }: { doc?: ThermalDocument | undefined }) {
  const warnings = doc?.warnings;
  if (!warnings) return null;
  return (
    <>
      {warnings.threeDotQr && (
        <Notice tone="warn">
          <Trans>
            This QR prints at three dots per module. Scan a test label before printing the batch.
          </Trans>
        </Notice>
      )}
      {(warnings.omittedText || warnings.omittedIcon) && (
        <Notice>
          <Trans>
            Some optional text or icons do not fit. The QR and full identifier are preserved.
          </Trans>
        </Notice>
      )}
      {warnings.separateIcon && (
        <Notice tone="warn">
          <Trans>
            The category icon moved beside the QR because there is not enough room to embed it.
          </Trans>
        </Notice>
      )}
      {warnings.standardTemplate && (
        <Notice>
          <Trans>This stock uses the standard inventory label for this reprint.</Trans>
        </Notice>
      )}
    </>
  );
}

function RegistrationStatus({ job }: { job: PrintManifest }) {
  if (job.registration === 'registered')
    return (
      <p className="m-0 text-small">
        <Trans>Registered</Trans>
      </p>
    );
  if (job.registration === 'collision')
    return (
      <Notice tone="warn">
        <Trans>
          Series collision. Keep this batch for review, remove any stickers printed from it, and
          prepare a new batch. Use the QR to check an affected sticker because its typed code may
          match another batch.
        </Trans>
      </Notice>
    );
  if (job.registration === 'address-changed')
    return (
      <Notice tone="warn">
        <Trans>
          The permanent label address changed. Ask the server administrator to restore that address
          before retrying registration.
        </Trans>
      </Notice>
    );
  if (job.registration === 'blocked')
    return (
      <Notice tone="warn">
        <Trans>
          The server couldn’t register this batch. Check that you can print labels in this location,
          then retry.
        </Trans>
      </Notice>
    );
  return (
    <Notice tone="warn">
      <Trans>
        Pending registration. Other devices won’t resolve these QR codes until the batch syncs.
      </Trans>
    </Notice>
  );
}
