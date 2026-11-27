import { normalize, PHOTO_DETAILS_MAX_PHOTOS, type PhotoDetails } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, Check, Image, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { AttachmentView, FileUrl, Page, ThingView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import type { FormValues } from '@/components/things/form-model';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { usePlatform } from './adapters';
import { type CaptureAIModel, type Connection, nativeErrorCode } from './bridge';
import { ChatGPTConnection, useCaptureAI } from './capture-ai';
import type { InventoryCache } from './inventory';
import { previewUrl } from './inventory';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

/** The form fields a suggestion can fill; `specs` is added to the notes. */
type Target = 'name' | 'model' | 'serial' | 'barcode' | 'colour' | 'specs' | 'type';
const TARGETS: readonly Target[] = [
  'name',
  'model',
  'serial',
  'barcode',
  'colour',
  'type',
  'specs',
];
/** Below this the model was unsure: shown, but not ticked. */
const SURE = 0.5;

export type Suggestion = { target: Target; value: string; shown: string; confidence: number };

/** What the answer would change in the form: only values that differ from what is there. */
export function suggestionsFor(
  details: PhotoDetails,
  values: FormValues,
  typeName: (id: string) => string | undefined,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const target of TARGETS) {
    const found = details[target];
    if (!found?.value.trim()) continue;
    const value = found.value.trim();
    if (target === 'type') {
      const id = details.type?.id;
      if (!id || id === values.typeId) continue;
      out.push({ target, value: id, shown: typeName(id) ?? value, confidence: found.confidence });
    } else if (target === 'specs') {
      if (values.notes.includes(value)) continue;
      out.push({ target, value, shown: value, confidence: found.confidence });
    } else if (value !== values[target].trim()) {
      out.push({ target, value, shown: value, confidence: found.confidence });
    }
  }
  return out;
}

/** The model the ChatGPT plan reads photos with, remembered on this iPhone. */
export const DETAILS_MODEL_KEY = 'chatGPTDetailsModel';

/** The remembered model if the plan still lists it, else a Terra model (OpenAI's visual one,
 * GPT-6.1 Terra, made for reading product photos and labels), else the plan's first. */
export function pickDetailsModel(models: readonly CaptureAIModel[], remembered?: string | null) {
  if (remembered && models.some(({ id }) => id === remembered)) return remembered;
  return (
    models.find(({ id, name }) => /terra/i.test(id) || /terra/i.test(name))?.id ??
    models[0]?.id ??
    ''
  );
}

const LIMITS = {
  name: 200,
  brand: 120,
  model: 120,
  serial: 120,
  barcode: 14,
  colour: 60,
  specs: 600,
  type_hint: 80,
} as const;
const PLACEHOLDER = /^(?:unknown|none|n\/?a|not (?:printed|visible|shown|readable)|-+|\?+)$/i;

/**
 * The ChatGPT plan's answer (JSON text, ChatGPTPlan.swift `itemDetailsInstructions`) as details:
 * only the known fields, each a short plain string with a confidence from 0 to 1; a barcode only as
 * 8 to 14 digits; placeholders dropped. Text around the JSON (a code fence) is ignored.
 */
export function parseChatGPTDetails(text: string): {
  details: PhotoDetails;
  typeHint?: { value: string; confidence: number };
} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No details in the answer');
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  if (!raw || typeof raw !== 'object') throw new Error('No details in the answer');
  const read = (key: keyof typeof LIMITS) => {
    const entry = (raw as Record<string, unknown>)[key];
    const box = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const given = box ? box.value : entry;
    let value =
      typeof given === 'string' ? given.trim() : typeof given === 'number' ? String(given) : '';
    if (key === 'barcode') value = value.replace(/\s+/g, '');
    if (!value || value.length > LIMITS[key] || PLACEHOLDER.test(value)) return undefined;
    if (key === 'barcode' && !/^\d{8,14}$/.test(value)) return undefined;
    const c = box && typeof box.confidence === 'number' ? box.confidence : 0.5;
    return { value, confidence: Math.min(1, Math.max(0, c)) };
  };
  const details: PhotoDetails = {};
  for (const key of ['name', 'brand', 'model', 'serial', 'barcode', 'colour', 'specs'] as const) {
    const found = read(key);
    if (found) details[key] = found;
  }
  const typeHint = read('type_hint');
  return typeHint ? { details, typeHint } : { details };
}

/** The form with the chosen suggestions in it; specs go on their own line in the notes. */
export function applySuggestions(
  values: FormValues,
  chosen: readonly Suggestion[],
  specsLabel: string,
): FormValues {
  const next = { ...values };
  for (const s of chosen) {
    if (s.target === 'type') next.typeId = s.value;
    else if (s.target === 'specs') {
      const line = `${specsLabel}: ${s.value}`;
      next.notes = next.notes.trim() ? `${next.notes.trimEnd()}\n${line}` : line;
    } else next[s.target] = s.value;
  }
  return next;
}

/**
 * "Fill in from photos" on a thing's edit form: the AI reads the photos chosen (a nameplate, the
 * label, the box) or one taken now, and suggests values. Ticked ones go into the form; nothing is
 * saved until the person saves the form. A photo taken here is also kept in the thing's photos.
 */
export function PhotoDetailsPanel({
  connection,
  cache,
  thing,
  values,
  disabled,
  onApply,
  onPhotoTaken,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache;
  thing: ThingView;
  values: FormValues;
  disabled: boolean;
  onApply: (values: FormValues) => void;
  /** Keep the photo in the thing's photos (queued on the phone, synced like any capture). */
  onPhotoTaken: (photo: File) => Promise<void>;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const { captureAI, outbox, transport } = usePlatform();
  const errorText = useErrorText();
  const { status: plan, setAccount } = useCaptureAI(connection);
  // The ChatGPT plan unless this iPhone's default photo AI is the server's API key.
  const [provider, setProvider] = useState<'chatgpt' | 'server'>('chatgpt');
  const [models, setModels] = useState<CaptureAIModel[]>([]);
  const [model, setModel] = useState('');
  const [photos, setPhotos] = useState<AttachmentView[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>();
  const [ticked, setTicked] = useState<Set<Target>>(new Set());
  const camera = useRef<HTMLInputElement>(null);
  const viaServer = captureAI?.photoDetails;
  const viaPlan = captureAI?.chatGPTDetails;
  const read = viaServer ?? viaPlan;
  const providers = [
    ...(viaPlan ? [{ id: 'chatgpt' as const, name: t`ChatGPT plan` }] : []),
    ...(viaServer ? [{ id: 'server' as const, name: t`Server API` }] : []),
  ];
  const using = providers.some(({ id }) => id === provider) ? provider : providers[0]?.id;

  useEffect(() => {
    let live = true;
    void outbox
      .getValue(connection, 'defaultPhotoAI')
      .then((value) => {
        if (live && value === 'server') setProvider('server');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connection, outbox]);

  useEffect(() => {
    if (!captureAI || using !== 'chatgpt' || !plan?.chatGPT) return;
    let live = true;
    void Promise.all([
      captureAI.models(connection),
      outbox.getValue(connection, DETAILS_MODEL_KEY).catch(() => null),
    ])
      .then(([listed, remembered]) => {
        if (!live) return;
        setModels(listed);
        setModel(pickDetailsModel(listed, remembered));
        if (!listed.length) setStatus(t`No ChatGPT models are available for this account.`);
      })
      .catch(() => {
        if (live) setStatus(t`Could not load ChatGPT models. Reconnect and try again.`);
      });
    return () => {
      live = false;
    };
  }, [captureAI, connection, outbox, plan?.chatGPT, t, using]);

  useEffect(() => {
    if (!read) return;
    let live = true;
    transport
      .request<Page<AttachmentView>>(
        connection,
        inventoryPaths.thingAttachments(thing.id) + qs({ role: 'photo', limit: 24 }),
      )
      .then((page) => {
        if (!live) return;
        setPhotos(page.items);
        // The newest photos first; most items have one or two, and a label is often the latest.
        setSelected(new Set(page.items.slice(0, PHOTO_DETAILS_MAX_PHOTOS).map(({ id }) => id)));
      })
      .catch(() => {
        if (live) setPhotos([]);
      });
    return () => {
      live = false;
    };
  }, [connection, read, thing.id, transport]);

  if (!read || !using) return null;
  const ready = using === 'server' || (!!plan?.chatGPT && models.some(({ id }) => id === model));

  function fail(error: unknown) {
    const code = nativeErrorCode(error);
    if (isAuthRefusal(error)) onAuthError?.('expired');
    else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
    else if (code === 'quota') setStatus(t`Your ChatGPT plan reached a usage limit.`);
    else if (code === 'reconnect') setStatus(t`Reconnect ChatGPT and try again.`);
    else if (code === 'ai_unavailable') setStatus(t`AI isn't set up here`);
    else if (code === 'image') setStatus(t`Choose a readable photo.`);
    else if (code === 'suggestion')
      setStatus(t`ChatGPT could not read these photos. Try again, or choose fewer photos.`);
    else if (error instanceof SyntaxError || (using === 'chatgpt' && !code))
      setStatus(t`Nothing new was found in these photos.`);
    else setStatus(errorText(error));
  }

  /** The chosen photos read by the ChatGPT plan: signed links the iPhone fetches itself. */
  async function readWithPlan(attachmentIds: string[], photo?: File): Promise<PhotoDetails> {
    if (!viaPlan) return {};
    const fileIds = attachmentIds
      .map((id) => photos?.find((p) => p.id === id)?.file?.id)
      .filter((id): id is string => !!id);
    const urls = await Promise.all(
      fileIds.map(
        async (fileId) =>
          (
            await transport.request<FileUrl>(
              connection,
              inventoryPaths.fileUrl(fileId) + qs({ thingId: thing.id }),
              { method: 'POST', body: { variant: 'display' } },
            )
          ).url,
      ),
    );
    // Local storage signs a path (`/f/<token>`): the iPhone fetches it from this server.
    const absolute = urls.map((url) => new URL(url, connection.origin).href);
    void outbox.setValue(connection, DETAILS_MODEL_KEY, model).catch(() => {});
    const { details, typeHint } = parseChatGPTDetails(
      await viaPlan(connection, model, { urls: absolute, photo }),
    );
    const type = typeHint
      ? cache.types.find((entry) => normalize(entry.name ?? '') === normalize(typeHint.value))
      : undefined;
    return type && typeHint ? { ...details, type: { ...typeHint, id: type.id } } : details;
  }

  async function ask(photo?: File) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    setSuggestions(undefined);
    try {
      if (photo) {
        await onPhotoTaken(photo);
        setStatus(t`Photo kept with this item.`);
      }
      const attachmentIds = [...selected].slice(0, PHOTO_DETAILS_MAX_PHOTOS - (photo ? 1 : 0));
      const details =
        using === 'server' && viaServer
          ? await viaServer(connection, thing.id, { attachmentIds, photo })
          : await readWithPlan(attachmentIds, photo);
      const found = suggestionsFor(
        details,
        values,
        (id) => cache.types.find((type) => type.id === id)?.name,
      );
      setSuggestions(found);
      setTicked(
        new Set(
          found
            .filter(({ target, confidence }) => {
              if (confidence < SURE) return false;
              if (target === 'type') return !values.typeId;
              if (target === 'specs') return true;
              return !values[target].trim();
            })
            .map(({ target }) => target),
        ),
      );
      if (found.length === 0) setStatus(t`Nothing new was found in these photos.`);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < PHOTO_DETAILS_MAX_PHOTOS) next.add(id);
      return next;
    });
  }

  function fill(rows: readonly Suggestion[]) {
    onApply(applySuggestions(values, rows, t`Specs`));
    setSuggestions(undefined);
    setStatus(t`Filled in. Check the fields, then save.`);
  }

  const labels: Record<Target, string> = {
    name: t`Name`,
    model: t`Model`,
    serial: t`Serial number`,
    barcode: t`Barcode`,
    colour: t`Colour`,
    type: t`Type`,
    specs: t`Notes`,
  };
  const chosen = suggestions?.filter(({ target }) => ticked.has(target)) ?? [];
  const locked = disabled || busy;

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-sunken p-3">
      <div className="grid gap-1">
        <h3 className="m-0 flex items-center gap-2 font-semibold">
          <Sparkles size={16} aria-hidden />
          <Trans>Fill in from photos</Trans>
        </h3>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            AI reads the model, serial number and specifications from the item, its label or its
            box. Check what it suggests before you save.
          </Trans>
        </p>
      </div>
      {providers.length > 1 && (
        <Select
          label={t`AI provider`}
          items={providers}
          value={using}
          isDisabled={locked}
          onChange={(key) => {
            if (key === 'chatgpt' || key === 'server') setProvider(key);
            setSuggestions(undefined);
            setStatus('');
          }}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              {item.name}
            </SelectItem>
          )}
        </Select>
      )}
      {using === 'chatgpt' && plan && !plan.chatGPT && (
        <ChatGPTConnection
          connection={connection}
          account={plan.chatGPT}
          isDisabled={locked}
          onChange={setAccount}
        />
      )}
      {using === 'chatgpt' && models.length > 0 && (
        <Select
          label={t`Model`}
          items={models}
          value={model}
          isDisabled={locked}
          onChange={(key) => setModel(String(key ?? ''))}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              {item.name}
            </SelectItem>
          )}
        </Select>
      )}
      {photos && photos.length > 0 && (
        <ul className="kept-photo-grid" aria-label={t`Photos to read`}>
          {photos.map((photo, index) => {
            const src = previewUrl(photo.file?.thumbUrl, connection.origin);
            const isSelected = selected.has(photo.id);
            return (
              <li key={photo.id}>
                <Button
                  variant="secondary"
                  className="kept-photo"
                  aria-pressed={isSelected}
                  aria-label={photo.name ?? t`Photo ${index + 1}`}
                  isDisabled={locked}
                  onPress={() => toggle(photo.id)}
                >
                  {src ? (
                    <img alt="" src={src} loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <Image size={28} aria-hidden />
                  )}
                  {isSelected && (
                    <span className="kept-photo-check" aria-hidden>
                      <Check size={14} />
                    </span>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          isDisabled={locked || !ready}
          onPress={() => camera.current?.click()}
        >
          <Camera size={16} aria-hidden />
          <Trans>Take a photo to read</Trans>
        </Button>
        {photos && photos.length > 0 && (
          <Button
            isPending={busy}
            isDisabled={locked || !ready || selected.size === 0}
            onPress={() => void ask()}
          >
            <Sparkles size={16} aria-hidden />
            <Trans>Read selected photos</Trans>
          </Button>
        )}
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void ask(file);
          }}
        />
      </div>
      {busy && (
        <p className="m-0 text-small text-ink-2" role="status">
          <Trans>Reading the photos…</Trans>
        </p>
      )}
      {suggestions && suggestions.length > 0 && (
        <div className="grid gap-2">
          <ul className="grid gap-2" aria-label={t`Suggestions`}>
            {suggestions.map((s) => {
              const on = ticked.has(s.target);
              const current = s.target === 'type' || s.target === 'specs' ? '' : values[s.target];
              return (
                <li key={s.target}>
                  <Button
                    variant="secondary"
                    className="kept-phone-row"
                    aria-pressed={on}
                    isDisabled={locked}
                    onPress={() =>
                      setTicked((previous) => {
                        const next = new Set(previous);
                        if (next.has(s.target)) next.delete(s.target);
                        else next.add(s.target);
                        return next;
                      })
                    }
                  >
                    <span className="kept-row-lead" aria-hidden>
                      {on ? <Check size={16} /> : null}
                    </span>
                    <span className="kept-row-body">
                      <span className="text-small font-normal text-ink-2">{labels[s.target]}</span>
                      <bdi className="font-semibold">{s.shown}</bdi>
                      {current.trim() && (
                        <span className="text-small font-normal text-ink-2">
                          {t`Replaces: ${current}`}
                        </span>
                      )}
                      {s.confidence < SURE && (
                        <span className="text-small font-normal text-ink-2">
                          <Trans>Not sure</Trans>
                        </span>
                      )}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button isDisabled={locked || chosen.length === 0} onPress={() => fill(chosen)}>
              <Check size={16} aria-hidden />
              {plural(chosen.length, { one: 'Fill in # field', other: 'Fill in # fields' })}
            </Button>
            <Button variant="secondary" isDisabled={locked} onPress={() => fill(suggestions)}>
              <Trans>Accept all</Trans>
            </Button>
          </div>
        </div>
      )}
      {status && (
        <p className="m-0 text-small text-ink-2" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
