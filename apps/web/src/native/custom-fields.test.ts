import { describe, expect, it } from 'vitest';
import type { ResolvedField } from '@/api/inventory/types';
import { nativeCustomPatch } from './custom-fields';

const field = (
  key: string,
  kind: ResolvedField['kind'],
  extra: Partial<ResolvedField> = {},
): ResolvedField => ({
  id: key,
  key,
  kind,
  label: key,
  labelKey: null,
  unit: null,
  options: null,
  repeatable: false,
  required: false,
  secret: false,
  sort: 0,
  archivedAt: null,
  source: { typeId: 'test', via: 'own' },
  rowVersion: 1,
  ...extra,
});

describe('native custom patches', () => {
  const record = {
    fields: [
      field('length', 'number'),
      field('insured', 'boolean'),
      field('colours', 'multi_select', { options: ['Blue', 'Red'] }),
      field('readings', 'number', { repeatable: true }),
      field('quotes', 'money', { repeatable: true }),
      field('inspection', 'date', { required: true }),
      field('note', 'text'),
      field('password', 'text', { secret: true }),
      field('old', 'text', { archivedAt: '2026-01-01' }),
    ],
    custom: { length: 8, insured: true, colours: ['Blue'], note: 'delete me', old: 'keep me' },
  };

  it('sends just editable changes, preserving zero, false, the array wire types, and explicit null', () => {
    expect(
      nativeCustomPatch(record, {
        length: '0',
        insured: false,
        note: null,
        readings: ['0', '1.5'],
        quotes: [
          { amount: '0', currency: 'USD' },
          { amount: '12', currency: 'USD' },
        ],
        password: 'ignored',
        old: 'ignored',
        colours: ['Blue'],
      }),
    ).toEqual({
      invalid: [],
      custom: {
        length: 0,
        insured: false,
        note: null,
        readings: [0, 1.5],
        quotes: [
          { amount: '0', currency: 'USD' },
          { amount: '12', currency: 'USD' },
        ],
      },
    });
  });

  it('validates changed options and dates, and excludes fields hidden by the money gate', () => {
    const result = nativeCustomPatch(
      { ...record, moneyHidden: true },
      {
        inspection: null,
        colours: ['Invalid'],
        quotes: [{ amount: '12', currency: 'USD' }],
      },
    );
    expect(result.invalid.map(({ key }) => key)).toEqual(['colours', 'inspection']);
    expect(result.custom).toEqual({});
    expect(nativeCustomPatch(record, { inspection: '2026-02-31' }).invalid).toHaveLength(1);
  });
});
