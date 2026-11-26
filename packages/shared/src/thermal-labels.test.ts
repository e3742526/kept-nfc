import { describe, expect, it } from 'vitest';
import { labelStock } from './label-stocks.js';
import {
  defaultPrinterProfile,
  printerOnStock,
  savePrinterStock,
  thermalGeometry,
} from './thermal-labels.js';

describe('thermal print geometry', () => {
  it.each([
    ['thermal_50x20', 50, 20, 400, 160, 591, 236],
    ['thermal_4x6in', 101.6, 152.4, 812, 1218, 1200, 1800],
    ['thermal_1_75x0_75in', 44.45, 19.05, 355, 152, 525, 225],
    ['thermal_2x1in', 50.8, 25.4, 406, 203, 600, 300],
    ['thermal_30_48x20_32', 30.48, 20.32, 244, 162, 360, 240],
  ] as const)(
    'keeps exact physical and nominal raster dimensions for %s',
    (key, w, h, x, y, x300, y300) => {
      expect(labelStock(key).page).toEqual({ w, h });
      expect(thermalGeometry(key, 'single', defaultPrinterProfile(), 1).dots).toEqual({
        w: x,
        h: y,
      });
      expect(
        thermalGeometry(key, 'single', { ...defaultPrinterProfile(), dpi: 300 }, 1).dots,
      ).toEqual({ w: x300, h: y300 });
    },
  );

  it('uses the compact roll by default and checks the actual feed dimensions before rotation', () => {
    const profile = defaultPrinterProfile();
    expect(profile).toMatchObject({ stock: 'thermal_50x20', media: 'gap', speed: 3, darkness: 8 });
    expect(labelStock(profile.stock)).toMatchObject({ cols: 1, rows: 1 });
    expect(() =>
      thermalGeometry(
        profile.stock,
        'single',
        {
          ...profile,
          orientation: 'landscape',
          minMediaWidth: 51,
        },
        1,
      ),
    ).toThrow('media-width');
    expect(() =>
      thermalGeometry(
        profile.stock,
        'single',
        {
          ...profile,
          minFeedLength: 21,
        },
        1,
      ),
    ).toThrow('feed-length');
  });

  it('rotates the page and logical grid, and retains empty space on partial sheets', () => {
    const job = thermalGeometry(
      'thermal_4x6in',
      'cut_2x1',
      { ...defaultPrinterProfile(), orientation: 'landscape' },
      13,
    );
    expect(job.mm).toEqual({ w: 152.4, h: 101.6 });
    expect(job.pages.map((page) => page.length)).toEqual([12, 1]);
    expect(job.pages[0]?.[1]?.cell).toEqual({ x: 203, y: 0, w: 203, h: 406 });
  });

  it('rejects over-width media and cut grids on the wrong stock', () => {
    expect(() =>
      thermalGeometry(
        'thermal_4x6in',
        'single',
        { ...defaultPrinterProfile(), maxMediaWidth: 50 },
        1,
      ),
    ).toThrow();
    expect(() => thermalGeometry('thermal_2x1in', 'cut_2x1', defaultPrinterProfile(), 1)).toThrow();
  });

  it.each(['portrait', 'landscape'] as const)(
    'keeps cut clearance after opposing calibration offsets in %s',
    (orientation) => {
      const stock = 'thermal_4x6in';
      const p = {
        ...defaultPrinterProfile(),
        orientation,
        calibration: {
          [stock]: { top: 0, right: 0, bottom: 0, left: 0, offsetX: -12, offsetY: 12 },
        },
      };
      for (const { cell, ink } of thermalGeometry(stock, 'cut_2x2', p, 6).pages[0] ?? []) {
        expect(ink.x).toBeGreaterThanOrEqual(cell.x + 8);
        expect(ink.y).toBeGreaterThanOrEqual(cell.y + 8);
        expect(ink.x + ink.w).toBeLessThanOrEqual(cell.x + cell.w - 8);
        expect(ink.y + ink.h).toBeLessThanOrEqual(cell.y + cell.h - 8);
      }
    },
  );

  it('recovers independent settings for two rolls on the same printer', () => {
    const large = 'thermal_4x6in';
    const micro = 'thermal_30_48x20_32';
    const first = savePrinterStock(
      { ...defaultPrinterProfile(), gapOrMark: 3, speed: 2 },
      large,
      'cut_4x3',
    );
    const second = savePrinterStock(
      { ...first, gapOrMark: 1.5, speed: 4, dpi: 300 },
      micro,
      'single',
    );
    expect(printerOnStock(second, large)).toMatchObject({
      dpi: 203,
      gapOrMark: 3,
      speed: 2,
      layout: 'cut_4x3',
    });
    expect(printerOnStock(second, micro)).toMatchObject({
      dpi: 300,
      gapOrMark: 1.5,
      speed: 4,
      layout: 'single',
    });
  });

  it('preserves the 20-label Letter layout', () => {
    const office = labelStock('letter_20_2x2in');
    expect(office.page).toEqual({ w: 215.9, h: 279.4 });
    expect(office.cols * office.rows).toBe(20);
  });
});
