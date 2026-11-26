// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { defaultPrinterProfile } from '@kept/shared';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { encode } from 'uqr';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { qrMatrix } from '../qr';
import {
  calibrationDocument,
  DEFAULT_THERMAL_OPTIONS,
  type ThermalContent,
  type ThermalDocument,
  thermalDocument,
} from './document';
import { thermalPdf } from './pdf';

const require = createRequire(import.meta.url);
const identifier = 'TMP-OILZ-9999';
const url = `https://labels.example.org/l/${identifier}-010203040506`;
const label: ThermalContent = { identifier, url };
const profile = defaultPrinterProfile();

beforeAll(async () => {
  const wasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await prepareZXingModule({
    overrides: { wasmBinary: Uint8Array.from(wasm).buffer },
    fireImmediately: true,
  });
});

async function rendered(doc: ThermalDocument, bytes: Uint8Array<ArrayBuffer>) {
  const standardFontDataUrl =
    join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + sep;
  const loading = getDocument({ data: bytes, standardFontDataUrl });
  const reader = await loading.promise;
  try {
    const page = await reader.getPage(1);
    const [, , width, height] = page.view;
    expect(width).toBeCloseTo((doc.mm.w * 72) / 25.4, 8);
    expect(height).toBeCloseTo((doc.mm.h * 72) / 25.4, 8);
    const viewport = page.getViewport({ scale: doc.dpi / 72 });
    const canvas = createCanvas(doc.dots.w, doc.dots.h);
    const context = canvas.getContext('2d');
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const text = (await page.getTextContent()).items.flatMap((item) =>
      'str' in item ? [item.str] : [],
    );
    const raster = context.getImageData(0, 0, doc.dots.w, doc.dots.h);
    const reads = await readBarcodes(raster as unknown as ImageData, {
      formats: ['QRCode', 'Code128'],
    });
    return { text, reads };
  } finally {
    await loading.destroy();
  }
}

describe('thermal vector pages', () => {
  it.each([
    ['thermal_4x6in', 203],
    ['thermal_4x6in', 300],
    ['thermal_1_75x0_75in', 203],
    ['thermal_1_75x0_75in', 300],
    ['thermal_2x1in', 203],
    ['thermal_2x1in', 300],
    ['thermal_30_48x20_32', 203],
    ['thermal_30_48x20_32', 300],
  ] as const)(
    'decodes the exact guarded URL from %s at %s DPI and preserves the full ID',
    async (stock, dpi) => {
      const doc = thermalDocument(
        stock,
        'single',
        { ...profile, dpi },
        DEFAULT_THERMAL_OPTIONS,
        [{ ...label, name: 'Cat'.repeat(70), location: 'A'.repeat(120) }],
        encode,
      );
      const output = await rendered(doc, await thermalPdf(doc));
      expect(output.text).toContain(identifier);
      expect(output.reads).toContainEqual(expect.objectContaining({ text: url }));
      const page = doc.pages[0];
      expect(page?.text[0]?.value).toBe(identifier);
      for (const row of page?.text ?? []) {
        expect(row.x + row.value.length * row.size * 0.6).toBeLessThanOrEqual(doc.dots.w);
        expect(row.y).toBeLessThanOrEqual(doc.dots.h);
      }
      for (const { x, y, w, h } of page?.ink ?? []) {
        expect([x, y, w, h].every(Number.isInteger)).toBe(true);
        expect(x + w).toBeLessThanOrEqual(doc.dots.w);
        expect(y + h).toBeLessThanOrEqual(doc.dots.h);
      }
    },
  );

  it('leaves four whole white modules on every side of the micro QR at 203 DPI', () => {
    const doc = thermalDocument(
      'thermal_1_75x0_75in',
      'single',
      profile,
      { ...DEFAULT_THERMAL_OPTIONS, handwriting: 0 },
      [label],
      encode,
    );
    const code = doc.pages[0]?.ink ?? [];
    const first = code[0];
    if (!first) throw new Error('Missing QR');
    const module = first.h;
    expect(module).toBeGreaterThanOrEqual(3);
    const x0 = Math.min(...code.map((mark) => mark.x));
    const x1 = Math.max(...code.map((mark) => mark.x + mark.w));
    const y0 = Math.min(...code.map((mark) => mark.y));
    const y1 = Math.max(...code.map((mark) => mark.y + mark.h));
    expect(x0 - doc.printable.x).toBeGreaterThanOrEqual(4 * module);
    expect(y0 - doc.printable.y).toBeGreaterThanOrEqual(4 * module);
    expect(doc.printable.y + doc.printable.h - y1).toBeGreaterThanOrEqual(4 * module);
    expect(x1 - x0).toBe((qrMatrix(encode, url).length - 8) * module);
    expect(doc.pages[0]?.text[0]?.x).toBeGreaterThanOrEqual(x1 + 4 * module);
  });

  it('rejects long QR payloads and short printable areas instead of reducing scan quality', () => {
    const micro = 'thermal_1_75x0_75in';
    expect(() =>
      thermalDocument(
        micro,
        'single',
        profile,
        DEFAULT_THERMAL_OPTIONS,
        [{ ...label, url: url + 'a'.repeat(150) }],
        encode,
      ),
    ).toThrow('qr');
    expect(() =>
      thermalDocument(
        micro,
        'single',
        { ...profile, printableHeight: 5 },
        DEFAULT_THERMAL_OPTIONS,
        [label],
        encode,
      ),
    ).toThrow('qr');
  });

  it('keeps the QR on the right, and fits a large product barcode alongside mandatory text', async () => {
    const barcode = '5901234123457';
    const doc = thermalDocument(
      'thermal_4x6in',
      'single',
      profile,
      { ...DEFAULT_THERMAL_OPTIONS, showBarcode: true, showNfc: true, handwriting: 4 },
      [
        {
          ...label,
          name: 'Cables',
          location: 'Shelf A',
          contents: 'USB-C',
          nfc: 'verified',
          barcode,
        },
      ],
      encode,
    );
    const output = await rendered(doc, await thermalPdf(doc));
    expect(output.text).toEqual(
      expect.arrayContaining([identifier, 'Cables', 'Shelf A', 'USB-C', 'NFC']),
    );
    expect(output.reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: url }),
        expect.objectContaining({ text: barcode }),
      ]),
    );
    const small = thermalDocument(
      'thermal_2x1in',
      'single',
      profile,
      { ...DEFAULT_THERMAL_OPTIONS, qrSide: 'right' },
      [label],
      encode,
    );
    expect(small.pages[0]?.text[0]?.x).toBeLessThan(small.pages[0]?.ink[0]?.x ?? 0);
  });

  it('prints the explicit compact reference and only verified or registered tag marks', async () => {
    const compact = 'thermal_30_48x20_32';
    const options = {
      ...DEFAULT_THERMAL_OPTIONS,
      payload: 'app' as const,
      variant: 'identity' as const,
    };
    const pending = thermalDocument(
      compact,
      'single',
      profile,
      options,
      [{ ...label, name: 'Optional', nfc: 'pending' }],
      encode,
    );
    expect(pending.pages[0]?.text.map((item) => item.value)).toEqual([identifier]);
    const verified = thermalDocument(
      compact,
      'single',
      profile,
      options,
      [{ ...label, name: 'Optional', nfc: 'verified', uhf: true }],
      encode,
    );
    const output = await rendered(verified, await thermalPdf(verified));
    expect(output.text).toEqual(expect.arrayContaining([identifier, 'NFC', 'UHF']));
    expect(output.text).not.toContain('Optional');
    expect(output.reads).toContainEqual(
      expect.objectContaining({
        text: 'TMP-OILZ-9999-010203040506',
      }),
    );
  });

  it('emits a fixed-size landscape multi-page document and a readable calibration page', async () => {
    const layout = thermalDocument(
      'thermal_4x6in',
      'cut_4x3',
      { ...profile, orientation: 'landscape' },
      DEFAULT_THERMAL_OPTIONS,
      [label, label, label],
      encode,
    );
    const loading = getDocument({ data: await thermalPdf(layout) });
    const pdf = await loading.promise;
    try {
      expect(pdf.numPages).toBe(2);
      expect((await pdf.getPage(1)).view).toEqual([0, 0, 432, 288]);
      expect((await pdf.getPage(2)).view).toEqual([0, 0, 432, 288]);
    } finally {
      await loading.destroy();
    }
    const calibration = calibrationDocument('thermal_1_75x0_75in', profile, url, encode);
    const result = await rendered(calibration, await thermalPdf(calibration));
    expect(result.text).toContain('TMP-A09Z-0001');
    expect(result.reads).toContainEqual(expect.objectContaining({ text: url }));
  });
});
