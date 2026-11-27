import { describe, expect, it } from 'vitest';
import { detailRowsFor, leadSuggestion } from './capture-details';

const electrical = { id: 'electrical', name: 'Electrical', colour: null };
const empty = { name: '', quantity: '', note: '', tags: [] };

describe('detailRowsFor', () => {
  it('offers every field the reading fills, matching categories by name', () => {
    const rows = detailRowsFor(
      {
        name: 'Christmas lights',
        description: 'Warm white',
        quantity: 2,
        categories: ['electricals', 'Decorations'],
      },
      empty,
      [electrical],
      true,
    );
    expect(rows.map(({ key, field, value }) => [key, field, value])).toEqual([
      ['name', 'name', 'Christmas lights'],
      ['quantity', 'quantity', '2'],
      ['note', 'note', 'Warm white'],
      ['category:electrical', 'category', 'Electrical'],
      ['category:decorations', 'category', 'Decorations'],
    ]);
    expect(rows[3]?.tag).toBe(electrical);
    expect(rows[4]?.tag).toBeUndefined();
  });

  it('leaves out what the form already has and categories it cannot create', () => {
    const rows = detailRowsFor(
      { name: 'christmas lights', description: 'Warm white', quantity: 2, categories: ['New'] },
      { name: 'Christmas Lights', quantity: '2', note: 'Box of warm white', tags: [] },
      [],
      false,
    );
    expect(rows).toEqual([]);
  });

  it('says what a row replaces or adds to', () => {
    const rows = detailRowsFor(
      { name: 'Lights', description: 'LED', quantity: 3, categories: ['Electrical'] },
      { name: 'Stuff', quantity: '1', note: 'Top shelf', tags: ['electrical'] },
      [electrical],
      true,
    );
    expect(rows).toEqual([
      { key: 'name', field: 'name', value: 'Lights', replaces: 'Stuff' },
      { key: 'quantity', field: 'quantity', value: '3', replaces: '1' },
      { key: 'note', field: 'note', value: 'LED', appends: true },
    ]);
  });
});

describe('leadSuggestion', () => {
  it('picks the item seen in the most photos, the first on a tie', () => {
    expect(
      leadSuggestion([
        { name: 'A', evidence: [0] },
        { name: 'B', evidence: [0, 1] },
        { name: 'C', evidence: [1, 2] },
      ])?.name,
    ).toBe('B');
    expect(leadSuggestion([])).toBeUndefined();
  });
});
