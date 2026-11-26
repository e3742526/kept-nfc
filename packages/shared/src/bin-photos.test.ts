import { describe, expect, it } from 'vitest';
import { type BinPhoto, groupBinPhotos } from './bin-photos.js';

/** Seconds after the first photo: a garage sorted in one pass, a label photo opening most bins. */
const at = (s: number) => 1_800_000_000_000 + s * 1000;
const photo = (key: string, s: number, code?: string): BinPhoto => ({
  key,
  takenAt: at(s),
  codes: code ? [code] : [],
});

describe('groupBinPhotos', () => {
  it('splits a roll at its label photos and keeps each bin’s photos together', () => {
    const plan = groupBinPhotos([
      photo('a1', 0, 'BIN-0001'),
      photo('a2', 10, 'BIN-0001'),
      photo('a3', 106),
      photo('b1', 250, 'BIN-0002'),
      photo('b2', 260),
      photo('b3', 270),
    ]);
    expect(plan.unassigned).toEqual([]);
    expect(plan.groups).toEqual([
      // a3 sits between two bins: the pause puts it with BIN-0001, flagged for a look.
      { code: 'BIN-0001', photos: ['a1', 'a2', 'a3'], labelPhotos: ['a1', 'a2'], guessed: ['a3'] },
      { code: 'BIN-0002', photos: ['b1', 'b2', 'b3'], labelPhotos: ['b1'], guessed: [] },
    ]);
  });

  it('cuts photos between two bins at the longest pause, and flags them', () => {
    // The contents were shot before their label: the pause before them says which bin they are.
    const plan = groupBinPhotos([
      photo('d1', 0, 'BIN-0004'),
      photo('d2', 60, 'BIN-0004'),
      photo('f1', 348),
      photo('f2', 455, 'BIN-0006'),
    ]);
    expect(plan.groups.map((g) => [g.code, g.photos, g.guessed])).toEqual([
      ['BIN-0004', ['d1', 'd2'], []],
      ['BIN-0006', ['f1', 'f2'], ['f1']],
    ]);
  });

  it('flags every photo between two bins, whichever way the pause cuts', () => {
    const plan = groupBinPhotos([
      photo('j1', 0, 'BIN-0010'),
      photo('k1', 27),
      photo('k2', 32),
      photo('k3', 101, 'BIN-0011'),
    ]);
    expect(plan.groups[0]).toMatchObject({ photos: ['j1', 'k1', 'k2'], guessed: ['k1', 'k2'] });
    expect(plan.groups[1]).toMatchObject({ photos: ['k3'], guessed: [] });
  });

  it('a bin labelled twice apart in the roll is one group', () => {
    const plan = groupBinPhotos([
      photo('a', 0, 'BIN-0001'),
      photo('b', 5, 'BIN-0002'),
      photo('c', 9, 'BIN-0001'),
    ]);
    expect(plan.groups.map((g) => [g.code, g.photos])).toEqual([
      ['BIN-0001', ['a', 'c']],
      ['BIN-0002', ['b']],
    ]);
  });

  it('sorts by the time taken, then keeps the given order', () => {
    const plan = groupBinPhotos([
      photo('late', 30),
      { key: 'undated', takenAt: null, codes: [] },
      photo('label', 0, 'BIN-0001'),
    ]);
    expect(plan.groups[0]?.photos).toEqual(['label', 'late', 'undated']);
  });

  it('photos before the first label go to the first bin, flagged; with no label, none', () => {
    const plan = groupBinPhotos([photo('x', 0), photo('y', 5, 'BIN-0001')]);
    expect(plan.groups[0]).toMatchObject({ photos: ['x', 'y'], guessed: ['x'] });
    expect(groupBinPhotos([photo('x', 0)])).toEqual({ groups: [], unassigned: ['x'] });
  });

  it('reads only the codes `isBinCode` accepts, the first of a photo’s', () => {
    const plan = groupBinPhotos(
      [
        { key: 'p', takenAt: at(0), codes: ['https://example.org', 'BIN-0003'] },
        { key: 'q', takenAt: at(1), codes: ['0123456789012'] },
      ],
      { isBinCode: (c) => /^BIN-\d{4}$/.test(c) },
    );
    expect(plan.groups).toEqual([
      { code: 'BIN-0003', photos: ['p', 'q'], labelPhotos: ['p'], guessed: [] },
    ]);
  });
});
