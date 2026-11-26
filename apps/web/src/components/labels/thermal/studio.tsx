import {
  defaultPrinterProfile,
  deviceLabelReference,
  isThermalLabelStock,
  MICRO_THERMAL_STOCK,
  type PrinterProfile,
  printerOnStock,
  profileForBatch,
  savePrinterStock,
  ThermalBatchSpecSchema,
  type ThermalLayout,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CreateLabelBatchBody, LabelBatch } from '@/api/capture/types';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useOnline } from '@/lib/online';
import { useQrEncoder } from '../qr';
import type { PrintApi } from './api';
import {
  calibrationDocument,
  DEFAULT_THERMAL_OPTIONS,
  type ThermalContent,
  type ThermalDocument,
  ThermalFitError,
  thermalDocument,
} from './document';
import { EpcForm } from './epc-form';
import { knownLabelAddress, printSpec, syncPrintConfirmation, syncPrintManifest } from './jobs';
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
const initialStock = 'thermal_4x6in';
const stocksMatch = (stock: string, layout: ThermalLayout) =>
  stock === initialStock ? layout : 'single';

type Prepared =
  | { kind: 'calibration'; doc: ThermalDocument }
  | { kind: 'local'; job: PrintManifest; doc: ThermalDocument }
  | { kind: 'server'; batch: LabelBatch; doc: ThermalDocument };

export function ThermalStudio({
  owner,
  source,
  api,
  nativeOutput,
  batch,
  onSaved,
}: {
  owner: string;
  source: ThermalSource;
  api: PrintApi;
  nativeOutput?: NativeThermalOutput | undefined;
  batch?: LabelBatch | undefined;
  onSaved?: (batch: LabelBatch) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const encode = useQrEncoder();
  const online = useOnline();
  const [address, setAddress] = useState('');
  const [profile, setProfile] = useState(defaultPrinterProfile);
  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [stock, setStock] = useState(batch?.stock ?? initialStock);
  const [layout, setLayout] = useState<ThermalLayout>(batch?.thermal?.layout ?? 'single');
  const [options, setOptions] = useState(batch?.thermal?.options ?? DEFAULT_THERMAL_OPTIONS);
  const [mode, setMode] = useState<'temporary' | 'category'>('temporary');
  const [prefix, setPrefix] = useState('GEN');
  const [count, setCount] = useState(source.blankCount ?? 1);
  const [category, setCategory] = useState(batch?.thermal?.category ?? '');
  const [contents, setContents] = useState(batch?.thermal?.contents ?? '');
  const [labels, setLabels] = useState<ThermalContent[]>(() => (batch ? batchLabels(batch) : []));
  const [jobs, setJobs] = useState<PrintManifest[]>([]);
  const [selected, setSelected] = useState<Prepared | null>(null);
  const [pdf, setPdf] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [attempt, setAttempt] = useState<PrintState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const inFlight = useRef(false);
  const locationId = source.locationId;
  const newNumbered = source.kind === 'blank' && !batch;
  const seriesPrefix = mode === 'temporary' ? 'TMP' : prefix;
  const spec = printSpec(
    stock,
    layout,
    profile,
    options,
    mode === 'category' || batch ? category : '',
    contents,
  );

  useEffect(() => {
    if (online) void loadThermalPdf().catch(() => {});
  }, [online]);

  useEffect(() => {
    let active = true;
    void printStore.preferences
      .get(owner)
      .then((row) => {
        if (!active) return;
        if (row) {
          setProfiles(row.profiles);
          if (row.address) setAddress(row.address);
        }
        const saved = row?.profiles.find((item) => item.id === row.profileId);
        if (batch?.thermal) {
          const rendering = profileForBatch(batch.stock, batch.thermal);
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
  }, [api, owner, batch]);

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
    if (newNumbered || batch) return;
    let active = true;
    void api
      .preview({ ...source, stock: initialStock })
      .then((out) => {
        if (active) setLabels(batchLabels({ labels: out.labels }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, source, newNumbered, batch]);

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
          name: mode === 'category' ? category : undefined,
          contents,
        }))
      : labels.slice(0, 12).map((label) => ({ ...label, contents: contents || label.contents }));
    if (previewLabels.length === 0) return null;
    try {
      return { doc: thermalDocument(stock, layout, profile, options, previewLabels, encode) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [
    address,
    category,
    contents,
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
    if (selected) {
      void thermalPdf(selected.doc)
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
  }, [selected, t]);

  const show = (prepared: Prepared) => {
    setPdf(null);
    setSelected(prepared);
    setAttempt(null);
    setConfirmed(false);
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

  async function remember(saved?: PrinterProfile) {
    await printStore.transaction('rw', printStore.preferences, async () => {
      const prior = await printStore.preferences.get(owner);
      const list = prior?.profiles ?? [];
      const next = saved ? [...list.filter((item) => item.id !== saved.id), saved] : list;
      await printStore.preferences.put({
        owner,
        stock,
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

  async function prepare() {
    if (!encode) return;
    const settings = ThermalBatchSpecSchema.parse(spec);
    await remember();
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
      show({ kind: 'local', doc, job });
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
        thermal: settings,
      }),
      encode,
    );
    show({ kind: 'server', doc, batch: ready });
    onSaved?.(ready);
  }

  function openJob(job: PrintManifest) {
    if (!encode) return;
    const doc = thermalDocument(
      job.stock,
      job.spec.layout,
      profileForBatch(job.stock, job.spec),
      job.spec.options,
      manifestLabels(job),
      encode,
    );
    show({ kind: 'local', doc, job });
    setAttempt(job.prints.at(-1)?.state ?? null);
  }

  async function sync(job: PrintManifest) {
    const next = await syncPrintManifest(job, api);
    setJobs((old) => old.map((row) => (row.id === next.id ? next : row)));
    setSelected((old) =>
      old?.kind === 'local' && old.job.id === next.id ? { ...old, job: next } : old,
    );
  }

  async function mark(state: PrintState) {
    setAttempt(state);
    if (selected?.kind === 'local') {
      await recordPrint(printStore, selected.job.id, state);
      const row = await printStore.jobs.get(selected.job.id);
      if (row) setJobs((old) => old.map((job) => (job.id === row.id ? row : job)));
    }
  }

  async function print() {
    if (!selected || (nativeOutput && !pdf)) return;
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
    if (!selected || selected.kind === 'calibration') return;
    if (selected.kind === 'server') await api.confirm(selected.batch.id);
    await mark('confirmed');
    if (selected.kind === 'local' && selected.job.registration === 'registered') {
      await syncPrintConfirmation(selected.job, api);
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
  const queue = profile.queue?.trim();

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
            profiles={profiles}
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
          />
          <TextField
            label={
              stock === MICRO_THERMAL_STOCK
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
          {preview?.doc?.warnings?.threeDotQr && (
            <Notice tone="warn">
              <Trans>
                This QR prints at three dots per module. Scan a test label before printing the
                batch.
              </Trans>
            </Notice>
          )}
          {preview?.doc?.warnings?.omittedText && (
            <Notice>
              <Trans>
                Some optional text does not fit. The QR and full identifier are preserved.
              </Trans>
            </Notice>
          )}
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
                    show({
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
          {queue && (
            <p className="m-0">
              <Trans>Choose {queue} in the print dialog.</Trans>
            </p>
          )}
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Use the matching paper size, actual size (100%), and no headers or footers.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {canOutput && (nativeOutput || canBrowserPrint()) && (
              <Button isDisabled={busy || (!!nativeOutput && !pdf)} onPress={() => void run(print)}>
                <Trans>Print</Trans>
              </Button>
            )}
            {canOutput && (
              <PdfButton
                pdf={busy ? null : pdf}
                send={(value) =>
                  void run(async () => {
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
              <Trans>
                Partial print recorded. Reprint the missing pages using the page range in the print
                dialog.
              </Trans>
            </Notice>
          )}
          {selected.kind !== 'calibration' &&
            (attempt === 'opened' || attempt === 'submitted' || (!attempt && canOutput)) && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" isDisabled={busy} onPress={() => void run(confirm)}>
                  <Trans>Confirm printed</Trans>
                </Button>
                {(attempt === 'opened' || attempt === 'submitted') && (
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
                  {job.codes[0]} · {job.codes.length}
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
