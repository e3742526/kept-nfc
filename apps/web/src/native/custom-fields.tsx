import { fieldValueSchema } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { inventoryPaths } from '@/api/inventory/paths';
import type {
  AttachmentView,
  Person,
  ResolvedField,
  ThingView,
  Vendor,
} from '@/api/inventory/types';
import { editableFields, parseNumber } from '@/components/things/form-model';
import { useFieldLabel } from '@/components/things/names';
import { useFieldValue } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { readAmount } from '@/lib/amount';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';

type CustomRecord = Pick<ThingView, 'fields' | 'custom' | 'moneyHidden'>;

export function nativeEditableFields(thing: CustomRecord) {
  return editableFields(thing.fields).filter(
    (field) => !(thing.moneyHidden && field.kind === 'money'),
  );
}

function wire(field: ResolvedField, value: unknown): unknown {
  if (Array.isArray(value)) {
    const scalar = { ...field, repeatable: false };
    const items =
      field.repeatable && field.kind !== 'multi_select'
        ? value.map((entry) => wire(scalar, entry)).filter((entry) => entry !== null)
        : value;
    return items.length ? items : null;
  }
  if (value === null || value === undefined || value === '') return null;
  if (field.kind === 'number' && typeof value === 'string') return parseNumber(value);
  if (field.kind === 'money' && typeof value === 'object' && 'amount' in value) {
    const input = value as { amount: string; currency: string };
    if (!input.amount.trim() && !input.currency) return null;
    return { amount: readAmount(input.amount), currency: input.currency };
  }
  if (typeof value === 'string' && field.kind === 'text') return value.trim() || null;
  return value;
}

export function nativeCustomPatch(thing: CustomRecord, drafts: Record<string, unknown>) {
  const custom: Record<string, unknown> = {};
  const invalid: ResolvedField[] = [];
  for (const field of nativeEditableFields(thing)) {
    if (!Object.hasOwn(drafts, field.key)) continue;
    try {
      const value = wire(field, drafts[field.key]);
      if (value === null) {
        if (field.required) invalid.push(field);
        else if (thing.custom[field.key] != null) custom[field.key] = value;
        continue;
      }
      if (JSON.stringify(value) === JSON.stringify(thing.custom[field.key] ?? null)) continue;
      const result = fieldValueSchema({
        kind: field.kind,
        options: field.options ?? undefined,
        repeatable: field.repeatable,
      }).safeParse(value);
      if (result.success) custom[field.key] = result.data;
      else invalid.push(field);
    } catch {
      invalid.push(field);
    }
  }
  return { custom, invalid };
}

function Control({
  field,
  value,
  label,
  change,
}: {
  field: ResolvedField;
  value: unknown;
  label: string;
  change: (value: unknown) => void;
}) {
  const { t } = useLingui();
  if (field.repeatable && field.kind !== 'multi_select') {
    const list = Array.isArray(value) ? value : [];
    const scalar = { ...field, repeatable: false };
    return (
      <fieldset className="grid gap-2">
        <legend className="text-small font-semibold">{label}</legend>
        {list.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered field values have no identity of their own.
          <div key={i} className="grid gap-1">
            <Control
              field={scalar}
              value={entry}
              label={`${label} ${i + 1}`}
              change={(next) => change(list.map((prior, at) => (at === i ? next : prior)))}
            />
            <Button
              variant="ghost"
              size="small"
              onPress={() => change(list.filter((_, at) => at !== i))}
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="small"
          isDisabled={list.length >= 50}
          onPress={() => change([...list, null])}
        >
          <Trans>Add another</Trans>
        </Button>
      </fieldset>
    );
  }
  if (field.kind === 'multi_select')
    return (
      <Select
        label={label}
        selectionMode="multiple"
        items={(field.options ?? []).map((id) => ({ id }))}
        value={Array.isArray(value) ? value : []}
        onChange={(keys) => change(keys.map(String))}
      >
        {(item) => <SelectItem id={item.id}>{item.id}</SelectItem>}
      </Select>
    );
  if (field.kind === 'boolean' || (field.kind === 'select' && field.options?.length)) {
    const options =
      field.kind === 'boolean'
        ? [
            { id: 'true', name: t`Yes` },
            { id: 'false', name: t`No` },
          ]
        : (field.options ?? []).map((id) => ({ id, name: id }));
    return (
      <Select
        label={label}
        items={options}
        selectedKey={value == null ? null : String(value)}
        onSelectionChange={(key) =>
          change(key == null ? null : field.kind === 'boolean' ? key === 'true' : String(key))
        }
      >
        {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
      </Select>
    );
  }
  if (field.kind === 'date')
    return (
      <DatePicker
        label={label}
        value={typeof value === 'string' ? value : null}
        onChange={change}
      />
    );
  if (field.kind === 'money') {
    const amount =
      value && typeof value === 'object' && 'amount' in value ? String(value.amount) : '';
    const currency =
      value && typeof value === 'object' && 'currency' in value ? String(value.currency) : '';
    return (
      <div className="grid gap-2">
        <TextField
          label={label}
          value={amount}
          inputProps={{ inputMode: 'decimal' }}
          onChange={(next) => change({ amount: next, currency })}
        />
        <TextField
          label={t`Currency`}
          value={currency}
          inputProps={{ maxLength: 3, autoCapitalize: 'characters' }}
          onChange={(next) => change({ amount, currency: next.toUpperCase() })}
        />
      </div>
    );
  }
  return (
    <TextField
      label={label}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      inputProps={{
        inputMode: field.kind === 'number' ? 'decimal' : field.kind === 'url' ? 'url' : 'text',
      }}
      onChange={change}
    />
  );
}

export function CustomFieldEditor({
  thing,
  drafts,
  onChange,
}: {
  thing: CustomRecord;
  drafts: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const labelOf = useFieldLabel();
  const fields = nativeEditableFields(thing);
  if (!fields.length) return null;
  return (
    <fieldset className="grid gap-3">
      <legend className="font-semibold">
        <Trans>Custom fields</Trans>
      </legend>
      {fields.map((field) => {
        const value = Object.hasOwn(drafts, field.key)
          ? drafts[field.key]
          : thing.custom[field.key];
        const label = labelOf(field);
        return (
          <div key={field.id} className="grid gap-1">
            <Control
              field={field}
              value={value}
              label={field.unit ? `${label} (${field.unit})` : label}
              change={(value) => onChange(field.key, value)}
            />
            {!field.required && value != null && (
              <Button variant="ghost" size="small" onPress={() => onChange(field.key, null)}>
                <Trans>Clear</Trans>
              </Button>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

export function CustomFieldDetails({
  thing,
  connection,
  attachments,
  online,
}: {
  thing: ThingView;
  connection: Connection;
  attachments: AttachmentView[];
  online: boolean;
}) {
  const labelOf = useFieldLabel();
  const format = useFieldValue();
  const fields = thing.fields
    .filter(
      (field) =>
        !field.secret &&
        !field.archivedAt &&
        !(thing.moneyHidden && field.kind === 'money') &&
        thing.custom[field.key] != null,
    )
    .sort((a, b) => a.sort - b.sort);
  if (!fields.length) return null;
  return (
    <section className="kept-card">
      <h3 className="kept-card-title">
        <Trans>Custom fields</Trans>
      </h3>
      <dl className="grid gap-2">
        {fields.map((field) => {
          const raw = thing.custom[field.key];
          const scalar = (value: unknown) => {
            if (typeof value === 'string' && (field.kind === 'person' || field.kind === 'vendor'))
              return (
                <RegistryReference
                  connection={connection}
                  id={value}
                  kind={field.kind === 'person' ? 'people' : 'vendors'}
                  online={online}
                />
              );
            if (field.kind === 'file') {
              const linked = attachments.find(
                (item) => item.file?.id === value || item.id === value,
              );
              return linked?.name ? <bdi>{linked.name}</bdi> : <Trans>Linked record</Trans>;
            }
            return format(field, value);
          };
          return (
            <div key={field.id}>
              <dt className="text-small text-ink-2">{labelOf(field)}</dt>
              <dd className="m-0 break-words">
                {Array.isArray(raw)
                  ? raw.map((value, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: values of one saved field, in order.
                      <div key={index}>{scalar(value)}</div>
                    ))
                  : scalar(raw)}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function RegistryReference({
  connection,
  id,
  kind,
  online,
}: {
  connection: Connection;
  id: string;
  kind: 'people' | 'vendors';
  online: boolean;
}) {
  const { transport } = usePlatform();
  const [name, setName] = useState<string>();
  useEffect(() => {
    setName(undefined);
    if (!online) return;
    let active = true;
    void transport
      .request<Person | Vendor>(connection, inventoryPaths.registryItem(kind, id))
      .then((item) => {
        if (active) setName('displayName' in item ? item.displayName : item.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connection, id, kind, online, transport]);
  return name ? <bdi>{name}</bdi> : <Trans>Linked record</Trans>;
}
