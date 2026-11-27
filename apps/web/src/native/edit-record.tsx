import { AMOUNT_STRING, CONDITIONS, NATIVE_INVENTORY_PAYLOAD_VERSION, newId } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowRightLeft, Check, CheckCircle2, Compass, Inbox, MapPinOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type {
  Condition,
  MoveBody,
  MovePreview,
  PlaceView,
  PurchaseView,
  ThingView,
  UpdatePlaceBody,
} from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { PLACE_KINDS } from '@/components/places/labels';
import { formValues, isEmptyPatch, toPatch, validate } from '@/components/things/form-model';
import { useConditionLabels } from '@/components/things/labels';
import { useFieldLabel, useTypeName } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { inputClass } from '@/components/ui/field';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import { CategoryPicker } from './category-picker';
import { CustomFieldEditor, nativeCustomPatch } from './custom-fields';
import { type Destination, DestinationPicker } from './destination';
import type { InventoryCache } from './inventory';
import {
  ensureCaptureCompatible,
  isAuthRefusal,
  isRestoreEpochMismatch,
  ReplayError,
  saveOnPhone,
} from './outbox';
import { PhotoDetailsPanel } from './photo-details';
import { PlaceKindSelect } from './place-kind-select';
import { rememberDestination } from './recent-destinations';

/** Today in a time zone, `YYYY-MM-DD`: a purchase can't be dated after it. */
function todayIn(timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

export function EditRecord({
  connection,
  cache,
  thing,
  place,
  mode,
  online = true,
  onClose,
  onChanged,
  onMoved,
  onPhotoQueued,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache;
  thing?: ThingView;
  place?: PlaceView;
  mode: 'edit' | 'move' | 'correct' | 'actions';
  online?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onMoved: (destination: Destination) => void;
  /** A photo was saved on the phone for this thing (it syncs like any capture). */
  onPhotoQueued?: () => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const adapters = usePlatform();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const conditions = useConditionLabels();
  const [base] = useState(() => thing && formValues(thing));
  const [values, setValues] = useState(base);
  const [tags, setTags] = useState(() => thing?.tags.map(({ id }) => id) ?? []);
  const [customDraft, setCustomDraft] = useState<Record<string, unknown>>({});
  const fieldLabel = useFieldLabel();
  const [roomName, setRoomName] = useState(place?.name ?? '');
  const [placeKind, setPlaceKind] = useState(place?.kindKey ?? '');
  const [description, setDescription] = useState(place?.description ?? '');
  const [descriptionSupported, setDescriptionSupported] = useState(false);
  useEffect(() => {
    if (!place) return;
    let current = true;
    void ensureCaptureCompatible(connection, adapters)
      .then((caps) => {
        if (current) setDescriptionSupported(caps.placeDescriptions === true);
      })
      .catch(() => {
        if (current) setDescriptionSupported(false);
      });
    return () => {
      current = false;
    };
  }, [adapters, connection, place]);
  const row = thing ?? place;
  const account = cache.locations.find(({ id }) => id === thing?.locationId)?.ownerAccountId;
  const [rowVersion] = useState(row?.rowVersion);
  const [destination, setDestination] = useState<Destination>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [quantity, setQuantity] = useState('');
  const [moveKey, setMoveKey] = useState(newId);
  const [removeKey] = useState(newId);
  // When it was bought: its purchase's date (#348). Purchases are core, so this shows with the
  // Money module off too; the price and the receipts stay on the web page.
  const purchase = thing?.purchase ?? null;
  const [boughtOn, setBoughtOn] = useState<string | null>(purchase?.purchasedOn ?? null);
  const [receipt, setReceipt] = useState<PurchaseView>();
  const today = todayIn(cache.locations.find(({ id }) => id === thing?.locationId)?.timezone);
  useEffect(() => {
    const id = purchase?.purchaseId;
    if (!id || mode !== 'edit') return;
    let current = true;
    adapters.transport
      .request<PurchaseView>(connection, inventoryPaths.purchase(id))
      .then((view) => {
        if (current) setReceipt(view);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [adapters, connection, mode, purchase?.purchaseId]);
  const others = receipt
    ? receipt.lines.filter((l) => l.id !== purchase?.lineId && l.thing?.id !== thing?.id).length
    : 0;
  const correcting = mode === 'correct';
  const amount = quantity ? Number(quantity) : undefined;
  const badAmount =
    amount !== undefined &&
    (!AMOUNT_STRING.test(quantity) || amount <= 0 || amount > Number(thing?.quantity));
  if (!row) return null;

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      await work();
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else if (error instanceof ApiError && error.status === 412) {
        setStatus(
          t`This record changed while you were editing. Close and reopen it to see the latest version.`,
        );
      } else if (error instanceof ReplayError && error.reason === 'compatibility_hold') {
        setStatus(t`Update this SheepKeep server to use this action.`);
      } else setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function edit() {
    return run(async () => {
      if (thing && base && values) {
        const retyped = values.typeId !== base.typeId;
        const { custom, invalid } = nativeCustomPatch(thing, customDraft);
        const affectedFields = thing.fields.filter(
          (field) =>
            Object.hasOwn(custom, field.key) || invalid.some(({ key }) => key === field.key),
        );
        if (
          retyped &&
          affectedFields.length > 0 &&
          !(await confirm({
            title: t`Change type?`,
            body: [
              t`Unsaved custom-field edits will be discarded. The new type's fields appear after saving.`,
              ...affectedFields.map(fieldLabel),
            ].join('\n'),
            confirmLabel: t`Save`,
            cancelLabel: t`Cancel`,
          }))
        )
          return;
        const errors = validate(base, values, thing.fields, {
          nameRequired: t`This needs a value.`,
          tooLong: (max) => t`At most ${max} characters.`,
          number: t`Enter a number.`,
          quantity: t`Enter a whole number, 0 or more.`,
          url: t`Enter a web address starting with https://.`,
          amount: t`Enter an amount, like 1250 or 1250.50.`,
        });
        const message = Object.values(errors)[0];
        if (message) {
          setStatus(message);
          return;
        }
        const body = toPatch(base, values, thing.fields);
        if (tags.length !== thing.tags.length || thing.tags.some(({ id }) => !tags.includes(id))) {
          body.tagIds = tags;
        }
        if (!retyped) {
          const field = invalid[0];
          if (field) {
            const label = fieldLabel(field);
            setStatus(t`Check the value for ${label}.`);
            return;
          }
          if (Object.keys(custom).length) body.custom = custom;
        }
        if (!isEmptyPatch(body)) {
          await adapters.transport.request(connection, inventoryPaths.thing(thing.id), {
            method: 'PATCH',
            ifMatch: rowVersion,
            body,
          });
        }
        await saveBoughtOn(thing, values.name);
      } else if (place && roomName.trim()) {
        const text = description.trim() || null;
        const descriptionChanged = text !== (place.description ?? null);
        if (
          descriptionChanged &&
          !(await ensureCaptureCompatible(connection, adapters)).placeDescriptions
        )
          throw new ReplayError('compatibility_hold');
        const body: UpdatePlaceBody = {
          ...(roomName.trim() !== place.name ? { name: roomName.trim() } : {}),
          ...(descriptionChanged ? { description: text } : {}),
          ...(placeKind !== place.kindKey ? { kindKey: placeKind } : {}),
        };
        if (Object.keys(body).length)
          await adapters.transport.request(connection, inventoryPaths.place(place.id), {
            method: 'PATCH',
            ifMatch: rowVersion,
            body,
          });
      }
      onChanged();
    });
  }

  /** A new date makes a one-line purchase for the thing, or changes its purchase's date. */
  async function saveBoughtOn(saved: ThingView, name: string) {
    if (!boughtOn || boughtOn === (purchase?.purchasedOn ?? null)) return;
    if (!purchase) {
      const quantity = Number(saved.quantity) > 0 ? Number(saved.quantity) : 1;
      await adapters.transport.request(connection, inventoryPaths.purchases, {
        method: 'POST',
        body: {
          locationId: saved.locationId,
          purchasedOn: boughtOn,
          lines: [
            { description: name.trim() || saved.name || t`Untitled`, quantity, thingId: saved.id },
          ],
        },
      });
      return;
    }
    if (!purchase.purchaseId) return;
    const view = await adapters.transport.request<PurchaseView>(
      connection,
      inventoryPaths.purchase(purchase.purchaseId),
    );
    await adapters.transport.request(connection, inventoryPaths.purchase(purchase.purchaseId), {
      method: 'PATCH',
      ifMatch: view.rowVersion,
      body: { purchasedOn: boughtOn },
    });
  }

  function move() {
    if (!thing || !destination || (!correcting && badAmount)) return;
    const to = destination;
    return run(async () => {
      if (correcting)
        await ensureCaptureCompatible(connection, adapters, NATIVE_INVENTORY_PAYLOAD_VERSION);
      const body: MoveBody = {
        thingIds: [thing.id],
        to: to.kind === 'box' ? { containerId: to.id } : { placeId: to.id },
        ...(correcting ? { intent: 'correct' } : amount === undefined ? {} : { quantity: amount }),
      };
      const preview = await adapters.transport.request<MovePreview>(
        connection,
        inventoryPaths.movePreview,
        { method: 'POST', body },
      );
      if (preview.crossLocation || thing.loanLine || amount !== undefined) {
        const warning = preview.losesSight.length
          ? t`${preview.losesSight.length} people will lose access to this record after the move.`
          : '';
        const loan = thing.loanLine ? t`This item is currently on loan.` : '';
        if (
          !(await confirm({
            title: t`Move to ${to.name}?`,
            body: [preview.targetLocation.name, warning, loan].filter(Boolean).join('\n'),
            confirmLabel: t`Move`,
            cancelLabel: t`Cancel`,
          }))
        )
          return;
      }
      await adapters.transport.request(connection, inventoryPaths.move, {
        method: 'POST',
        body: thing.loanLine ? { ...body, onLoan: 'confirm' } : body,
        idempotencyKey: moveKey,
        ifMatch: rowVersion,
      });
      void rememberDestination(connection, adapters, to.id);
      if (amount !== undefined && amount < Number(thing.quantity)) onChanged();
      else onMoved(to);
    });
  }

  function remove() {
    if (!thing) return;
    const placeId = cache.locations.find(
      (location) => location.id === thing.locationId,
    )?.unplacedPlaceId;
    if (!placeId || thing.placeId === placeId) return;
    return run(async () => {
      if (
        !(await confirm({
          title: t`Remove without a destination?`,
          body: thing.loanLine
            ? t`This item is currently on loan.`
            : t`This record will be available in Unplaced.`,
          confirmLabel: t`Remove`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      await ensureCaptureCompatible(connection, adapters, NATIVE_INVENTORY_PAYLOAD_VERSION);
      const body: MoveBody = {
        thingIds: [thing.id],
        to: { placeId },
        intent: 'remove',
        ...(thing.loanLine ? { onLoan: 'confirm' } : {}),
      };
      await adapters.transport.request(connection, inventoryPaths.move, {
        method: 'POST',
        body,
        idempotencyKey: removeKey,
        ifMatch: rowVersion,
      });
      onChanged();
    });
  }

  function mark(seen: boolean) {
    if (!thing) return;
    return run(async () => {
      await adapters.transport.request(
        connection,
        seen ? inventoryPaths.thingSeen(thing.id) : inventoryPaths.thingNotHere(thing.id),
        {
          method: 'POST',
          body: {},
          ...(seen ? {} : { ifMatch: rowVersion }),
        },
      );
      onChanged();
    });
  }

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-surface p-3">
      {mode === 'edit' && (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void edit();
          }}
        >
          {values ? (
            <>
              {thing && online && (
                <PhotoDetailsPanel
                  connection={connection}
                  cache={cache}
                  thing={thing}
                  values={values}
                  disabled={busy}
                  onApply={setValues}
                  onPhotoTaken={async (photo) => {
                    await saveOnPhone(
                      connection,
                      {
                        locationId: thing.locationId,
                        attachToThingId: thing.id,
                        name: thing.name ?? '',
                        skipServerSuggestions: true,
                      },
                      [{ file: photo, role: 'photo' }],
                      adapters,
                    );
                    onPhotoQueued?.();
                  }}
                  onAuthError={onAuthError}
                />
              )}
              {(
                [
                  ['name', t`Name`, 200],
                  ['quantity', t`Quantity`, 17],
                  ['model', t`Model`, 200],
                  ['serial', t`Serial number`, 100],
                  ['barcode', t`Barcode`, 64],
                  ['colour', t`Colour`, 80],
                  ['manualUrl', t`Manual URL`, 2048],
                ] as const
              ).map(([key, label, maxLength]) => (
                <TextField
                  key={key}
                  label={label}
                  value={values[key]}
                  isDisabled={busy}
                  onChange={(value) => setValues({ ...values, [key]: value })}
                  inputProps={{
                    maxLength,
                    inputMode:
                      key === 'quantity' ? 'decimal' : key === 'manualUrl' ? 'url' : 'text',
                  }}
                />
              ))}
              <label className="grid gap-1 text-small font-semibold">
                <Trans>Notes</Trans>
                <textarea
                  className={inputClass}
                  value={values.notes}
                  maxLength={5000}
                  rows={4}
                  disabled={busy}
                  onChange={(event) => setValues({ ...values, notes: event.currentTarget.value })}
                />
              </label>
              <Select
                label={t`Type`}
                selectedKey={values.typeId ?? 'none'}
                isDisabled={busy}
                items={[
                  { id: 'none', name: t`No type` },
                  ...cache.types.map((type) => ({
                    ...type,
                    name: typeName({
                      ...type,
                      name: type.name === type.builtinKey ? null : type.name,
                    }),
                  })),
                ]}
                onSelectionChange={(key) =>
                  setValues({ ...values, typeId: !key || key === 'none' ? null : String(key) })
                }
              >
                {(option) => <SelectItem id={option.id}>{option.name}</SelectItem>}
              </Select>
              <Select
                label={t`Condition`}
                selectedKey={values.condition ?? 'none'}
                isDisabled={busy}
                items={[
                  { id: 'none', name: t`Unspecified` },
                  ...CONDITIONS.map((id) => ({ id, name: conditions[id] })),
                ]}
                onSelectionChange={(key) =>
                  setValues({
                    ...values,
                    condition: key && key !== 'none' ? (key as Condition) : null,
                  })
                }
              >
                {(option) => <SelectItem id={option.id}>{option.name}</SelectItem>}
              </Select>
              {thing && (!purchase || purchase.purchaseId) && (
                <div className="grid gap-1">
                  <DatePicker
                    label={t`Bought on`}
                    value={boughtOn}
                    onChange={(value) => setBoughtOn(value ?? purchase?.purchasedOn ?? null)}
                    maxValue={today}
                  />
                  {others > 0 && (
                    <p className="m-0 text-small text-ink-2">
                      <Plural
                        value={others}
                        one="This receipt has # other thing on it: the date and shop change for it too."
                        other="This receipt has # other things on it: the date and shop change for them too."
                      />
                    </p>
                  )}
                </div>
              )}
              {thing && account && (
                <CategoryPicker
                  connection={connection}
                  accountId={account}
                  online
                  canCreate
                  options={[
                    ...thing.tags,
                    ...(cache.tags?.filter((tag) => tag.accountId === account) ?? []),
                  ]}
                  selected={tags}
                  disabled={busy}
                  onChange={setTags}
                />
              )}
              {thing && values.typeId === base?.typeId && (
                <CustomFieldEditor
                  thing={thing}
                  drafts={customDraft}
                  onChange={(key, value) =>
                    setCustomDraft((current) => ({ ...current, [key]: value }))
                  }
                />
              )}
              {thing && values.typeId !== base?.typeId && (
                <p className="m-0 text-small text-ink-2">
                  <Trans>The new type's own fields show after you save.</Trans>
                </p>
              )}
            </>
          ) : (
            <>
              <TextField
                label={t`Name`}
                value={roomName}
                onChange={setRoomName}
                maxLength={120}
                isDisabled={busy}
                autoFocus
              />
              {place && PLACE_KINDS.some((kind) => kind === place.kindKey) && (
                <PlaceKindSelect value={placeKind} onChange={setPlaceKind} disabled={busy} />
              )}
              {descriptionSupported && (
                <TextField
                  label={t`Description`}
                  value={description}
                  onChange={setDescription}
                  maxLength={500}
                  isDisabled={busy}
                />
              )}
            </>
          )}
          <Button type="submit" isPending={busy} isDisabled={!(values?.name ?? roomName).trim()}>
            <Check size={16} aria-hidden />
            <Trans>Save</Trans>
          </Button>
        </form>
      )}
      {(mode === 'move' || correcting) && (
        <div className="grid gap-3">
          <DestinationPicker
            connection={connection}
            online={true}
            cache={cache}
            value={destination}
            onChange={(value) => {
              setDestination(value);
              setMoveKey(newId());
            }}
            disabled={busy}
            exclude={thing?.id}
            onlyLocation={correcting ? thing?.locationId : undefined}
            onAuthError={onAuthError}
          />
          {!correcting &&
            thing &&
            !thing.isContainer &&
            !thing.serial &&
            !thing.meters.length &&
            Number(thing.quantity) > 1 && (
              <TextField
                label={t`Quantity to move`}
                value={quantity}
                description={t`Leave blank to move the entire entry.`}
                isDisabled={busy}
                isInvalid={badAmount}
                errorMessage={
                  badAmount ? t`Enter a quantity within the recorded amount.` : undefined
                }
                onChange={(value) => {
                  setQuantity(value);
                  setMoveKey(newId());
                }}
                inputProps={{ inputMode: 'decimal' }}
              />
            )}
          <Button
            isDisabled={
              badAmount || !destination || destination.id === (thing?.containerId ?? thing?.placeId)
            }
            isPending={busy}
            onPress={() => void move()}
          >
            {correcting ? (
              <Compass size={16} aria-hidden />
            ) : (
              <ArrowRightLeft size={16} aria-hidden />
            )}
            {correcting ? t`Correct location` : t`Move`}
          </Button>
        </div>
      )}
      {mode === 'actions' && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" isDisabled={busy} onPress={() => void mark(true)}>
            <CheckCircle2 size={16} aria-hidden />
            <Trans>Seen here</Trans>
          </Button>
          <Button variant="secondary" isDisabled={busy} onPress={() => void mark(false)}>
            <MapPinOff size={16} aria-hidden />
            <Trans>Not here</Trans>
          </Button>
          {thing &&
            thing.placeId !==
              cache.locations.find((location) => location.id === thing.locationId)
                ?.unplacedPlaceId && (
              <Button
                variant="secondary"
                className="col-span-2"
                isDisabled={busy}
                onPress={() => void remove()}
              >
                <Inbox size={16} aria-hidden />
                <Trans>Remove without a destination</Trans>
              </Button>
            )}
        </div>
      )}
      <Button variant="ghost" isDisabled={busy} onPress={onClose}>
        <X size={16} aria-hidden />
        <Trans>Cancel</Trans>
      </Button>
      {status && <p role="alert">{status}</p>}
    </section>
  );
}
