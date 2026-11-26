import { describe, expect, it } from 'vitest';
import {
  cellsFor,
  hasQr,
  isRuled,
  isSheet,
  isStacked,
  isTape,
  isThermalLabelStock,
  LABEL_STOCKS,
  type LabelStock,
  labelStock,
  SQUARE_THERMAL_STOCK,
  usesThermalLabelEditor,
} from './label-stocks.js';

describe('LABEL_STOCKS', () => {
  it('offers square rolls in the thermal editor and preserves the original square roll builder', () => {
    expect(isThermalLabelStock(SQUARE_THERMAL_STOCK)).toBe(true);
    expect(usesThermalLabelEditor(SQUARE_THERMAL_STOCK)).toBe(false);
    expect(usesThermalLabelEditor(SQUARE_THERMAL_STOCK, true)).toBe(true);
  });

  it('has the supported stocks, in order', () => {
    expect(LABEL_STOCKS.map((s) => s.key)).toEqual([
      'thermal_50x20',
      'thermal_30_48x20_32',
      'thermal_4x6in',
      'thermal_1_75x0_75in',
      'thermal_2x1in',
      'thermal_50x30',
      'thermal_40x30',
      'thermal_40x20',
      'thermal_30x20',
      'thermal_50x50',
      'thermal_62x29',
      'thermal_1x1in',
      'thermal_1_5x1in',
      'thermal_1_5x1_5in',
      'thermal_2x2in',
      'tape_9',
      'tape_12',
      'tape_18',
      'tape_24',
      'a4_24_70x37',
      'a4_65_38x21',
      'letter_30_67x25',
      'letter_20_2x2in',
      'letter_writable_8',
      'letter_writable_12',
      'letter_writable_24',
    ]);
  });

  it('has the OL330 write-in sheet: 2-inch squares that add up to Letter', () => {
    const s = LABEL_STOCKS.filter(isRuled);
    expect(s.map((x) => x.key)).toEqual(['letter_20_2x2in']);
    const [ol330] = s as [LabelStock];
    expect([ol330.cols, ol330.rows, ol330.cell, ol330.gap, ol330.margin]).toEqual([
      4,
      5,
      { w: 50.8, h: 50.8 },
      { x: 0, y: 3.175 },
      { top: 6.35, left: 6.35 },
    ]);
    const across = 2 * ol330.margin.left + ol330.cols * ol330.cell.w;
    const down = 2 * ol330.margin.top + ol330.rows * ol330.cell.h + (ol330.rows - 1) * ol330.gap.y;
    expect(across).toBeCloseTo(ol330.page.w, 6);
    expect(down).toBeCloseTo(ol330.page.h, 6);
    // Cell 20 starts 6 inches across and 8.5 inches down, as the template's last label.
    const last = cellsFor(ol330, 20).cells[19];
    expect([last?.x, last?.y]).toEqual([6.35 + 3 * 50.8, 6.35 + 4 * (50.8 + 3.175)]);
    expect(isStacked(ol330)).toBe(false);
  });

  it('has inch rolls that stack the QR over the code, each label its own page', () => {
    const stacked = LABEL_STOCKS.filter(isStacked);
    expect(stacked.map((s) => [s.key, s.cell.w, s.cell.h, s.content])).toEqual([
      ['thermal_1x1in', 25.4, 25.4, 'compact'],
      ['thermal_1_5x1in', 38.1, 25.4, 'compact'],
      ['thermal_1_5x1_5in', 38.1, 38.1, 'full'],
      ['thermal_2x2in', 50.8, 50.8, 'full'],
    ]);
    for (const s of stacked) {
      expect(isSheet(s)).toBe(false);
      expect(s.page).toEqual(s.cell);
      // Room for a 20 × 10 mm NFC inlay under every one.
      expect(Math.max(s.cell.w, s.cell.h)).toBeGreaterThanOrEqual(20);
      expect(Math.min(s.cell.w, s.cell.h)).toBeGreaterThanOrEqual(10);
    }
  });

  it('has label-maker tape 9, 12, 18 and 24 mm wide: one label per thing, a QR from 18 mm', () => {
    const tapes = LABEL_STOCKS.filter(isTape);
    expect(tapes.map((s) => [s.key, s.cell.h, hasQr(s)])).toEqual([
      ['tape_9', 9, false],
      ['tape_12', 12, false],
      ['tape_18', 18, true],
      ['tape_24', 24, true],
    ]);
    for (const s of tapes) {
      expect(isSheet(s)).toBe(false);
      expect(s.content).toBe('tape');
      // A label as long as a short code needs, and never longer than a hand's width.
      expect(s.cell.w).toBeGreaterThanOrEqual(36);
      expect(s.cell.w).toBeLessThanOrEqual(64);
      expect(s.page).toEqual(s.cell);
    }
    expect(LABEL_STOCKS.filter((s) => !isTape(s)).every(hasQr)).toBe(true);
  });

  it.each(LABEL_STOCKS.map((s) => [s.key, s] as const))('%s fits its page', (_key, s) => {
    const width = s.margin.left * 2 + s.cols * s.cell.w + (s.cols - 1) * s.gap.x;
    const height = s.margin.top + s.rows * s.cell.h + (s.rows - 1) * s.gap.y;
    expect(width).toBeCloseTo(s.page.w, 1);
    expect(height).toBeLessThanOrEqual(s.page.h + 0.01);
    expect(s.names.en).toBeTruthy();
    expect(s.names.ar).toBeTruthy();
  });

  it('prints QR and code only on the small stocks', () => {
    expect(LABEL_STOCKS.filter((s) => s.content === 'compact').map((s) => s.key)).toEqual([
      'thermal_1x1in',
      'thermal_1_5x1in',
      'a4_65_38x21',
    ]);
  });
});

describe('cellsFor', () => {
  // The plan's example says 30 labels from start cell 20 "take 2 pages", but cells 20–24 hold 5
  // and a full sheet 24: 29 fit on two pages, and the 30th starts a third.
  it('fills a4_24 from start cell 20: the first 19 cells stay empty, 29 labels fit on 2 pages', () => {
    const stock = labelStock('a4_24_70x37');
    const two = cellsFor(stock, 29, 20);
    expect(two.pages).toBe(2);
    expect(two.cells[0]).toMatchObject({ page: 0, cell: 19, col: 1, row: 6 });
    expect(two.cells[4]).toMatchObject({ page: 0, cell: 23, col: 2, row: 7 });
    expect(two.cells[5]).toMatchObject({ page: 1, cell: 0, col: 0, row: 0 });
    expect(two.cells[28]).toMatchObject({ page: 1, cell: 23 });
    const three = cellsFor(stock, 30, 20);
    expect(three.pages).toBe(3);
    expect(three.cells[29]).toMatchObject({ page: 2, cell: 0 });
  });

  it('places cells in millimetres from the page’s top-left corner', () => {
    const stock = labelStock('letter_30_67x25');
    const { cells } = cellsFor(stock, 4);
    expect(cells[0]).toMatchObject({ x: 4.7625, y: 12.7 });
    expect(cells[1]?.x).toBeCloseTo(4.7625 + 66.675 + 3.175, 6);
    expect(cells[3]).toMatchObject({ col: 0, row: 1 });
    expect(cells[3]?.y).toBeCloseTo(12.7 + 25.4, 6);
  });

  it('ignores the start cell on thermal rolls: one label per page', () => {
    const { pages, cells } = cellsFor(labelStock('thermal_50x30'), 3, 7);
    expect(pages).toBe(3);
    expect(cells.map((c) => [c.page, c.cell, c.x, c.y])).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(isSheet(labelStock('thermal_50x30'))).toBe(false);
    expect(isSheet(labelStock('a4_24_70x37'))).toBe(true);
  });

  it('refuses a start cell off the sheet and an unknown stock', () => {
    expect(() => cellsFor(labelStock('a4_24_70x37'), 1, 25)).toThrow(RangeError);
    expect(() => cellsFor(labelStock('a4_24_70x37'), 1, 0)).toThrow(RangeError);
    expect(() => labelStock('a5_nope')).toThrow(RangeError);
    expect(cellsFor(labelStock('a4_24_70x37'), 0)).toEqual({ pages: 0, cells: [] });
  });
});
