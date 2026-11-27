import { describe, expect, it, vi } from 'vitest';
import type { Detected } from './label-recogniser';
import { ScannerUnavailable } from './scanner';
import { keptCodesIn, productCodesIn } from './still-codes';

const blob = (name: string) => new Blob([name], { type: 'image/jpeg' });
const decode = async (b: Blob) => ({
  source: b as unknown as CanvasImageSource,
  width: 4000,
  height: 3000,
});

describe('product codes in photos', () => {
  it('deduplicates equivalent UPC and EAN reads and skips labels and invalid checksums', async () => {
    const detect = vi
      .fn()
      .mockResolvedValueOnce([
        { rawValue: '036000291452', format: 'upc_a' },
        { rawValue: 'https://kept.example/l/K7D2QX', format: 'qr_code' },
      ])
      .mockResolvedValueOnce([
        { rawValue: '0036000291452', format: 'ean_13' },
        { rawValue: '4006381333932', format: 'ean_13' },
      ]);
    await expect(productCodesIn([blob('a'), blob('b')], { detect, decode, draw })).resolves.toEqual(
      ['036000291452'],
    );
  });

  it('reports distinct products so their UPCs are never confused', async () => {
    const detect = vi.fn(async () => [
      { rawValue: '036000291452', format: 'upc_a' },
      { rawValue: '4006381333931', format: 'ean_13' },
    ]);
    await expect(productCodesIn([blob('a')], { detect, decode, draw })).resolves.toEqual([
      '036000291452',
      '4006381333931',
    ]);
  });
});
const draw = (img: { source: CanvasImageSource }) => img.source as unknown as HTMLCanvasElement;

describe('keptCodesIn', () => {
  it('reads every SheepKeep label in every photo, once each, and nothing else', async () => {
    const found: Record<string, Detected[]> = {
      a: [
        { rawValue: 'https://kept.example/l/K7D2QX', format: 'qr_code' },
        { rawValue: '4006381333931', format: 'ean_13' },
      ],
      b: [
        { rawValue: 'K7D2QX', format: 'qr_code' },
        { rawValue: 'https://home.example/l/ab1100', format: 'qr_code' },
      ],
    };
    const detect = vi.fn(async (source: CanvasImageSource) => {
      const text = await (source as unknown as Blob).text();
      return found[text] ?? [];
    });
    expect(await keptCodesIn([blob('a'), blob('b')], { detect, decode, draw })).toEqual([
      'K7D2QX',
      'AB1100',
    ]);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('skips a photo it cannot read, and stops when there is no scanner', async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new Error('one bad photo'))
      .mockResolvedValueOnce([{ rawValue: 'K7D2QX', format: 'qr_code' }])
      .mockRejectedValueOnce(new ScannerUnavailable());
    const out = await keptCodesIn([blob('a'), blob('b'), blob('c'), blob('d')], {
      detect,
      decode,
      draw,
    });
    expect(out).toEqual(['K7D2QX']);
    expect(detect).toHaveBeenCalledTimes(3);
  });
});
