import { PHOTO_DETAILS_MAX_PHOTOS, type PhotoDetails } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, Check, Image, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { AttachmentView, Page, ThingView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import type { FormValues } from '@/components/things/form-model';
import { Button } from '@/components/ui/button';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
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
  const { captureAI, transport } = usePlatform();
  const errorText = useErrorText();
  const [photos, setPhotos] = useState<AttachmentView[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>();
  const [ticked, setTicked] = useState<Set<Target>>(new Set());
  const camera = useRef<HTMLInputElement>(null);
  const read = captureAI?.photoDetails;

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

  if (!read) return null;
  const photoDetails = read;

  function fail(error: unknown) {
    if (isAuthRefusal(error)) onAuthError?.('expired');
    else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
    else setStatus(errorText(error));
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
      const details = await photoDetails(connection, thing.id, { attachmentIds, photo });
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
        <Button variant="secondary" isDisabled={locked} onPress={() => camera.current?.click()}>
          <Camera size={16} aria-hidden />
          <Trans>Take a photo to read</Trans>
        </Button>
        {photos && photos.length > 0 && (
          <Button
            isPending={busy}
            isDisabled={locked || selected.size === 0}
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
          <Button
            isDisabled={locked || chosen.length === 0}
            onPress={() => {
              onApply(applySuggestions(values, chosen, t`Specs`));
              setSuggestions(undefined);
              setStatus(t`Filled in. Check the fields, then save.`);
            }}
          >
            <Check size={16} aria-hidden />
            {plural(chosen.length, { one: 'Fill in # field', other: 'Fill in # fields' })}
          </Button>
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
