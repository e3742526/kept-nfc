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
import { suggestWorkshopIcon } from './workshop-icons';

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
  it.each(['thermal_50x20', 'thermal_2x2in', 'thermal_4x6in'])(
    'renders a drawer label with prominent contents and the original QR on %s',
    async (stock) => {
      for (const dpi of [203, 300]) {
        const doc = thermalDocument(
          stock,
          'single',
          { ...profile, dpi },
          { ...DEFAULT_THERMAL_OPTIONS, template: 'drawer', workshopIcon: 'BIT' },
          [
            {
              ...label,
              drawerContents: 'Phillips bits',
              drawerPosition: 'CAB01-R01-C02',
              nfc: 'verified',
              uhf: true,
            },
          ],
          encode,
        );
        const page = doc.pages[0];
        const title = page?.text.find((line) => line.bold);
        const id = page?.text.find((line) => line.value === identifier);
        expect(title?.size).toBeGreaterThan(id?.size ?? Infinity);
        expect(
          page?.text
            .filter((line) => line.bold)
            .map((line) => line.value)
            .join(' '),
        ).toBe('Phillips bits');
        expect(page?.text.some((line) => line.value.includes('NFC / UHF'))).toBe(true);
        expect((await rendered(doc, await thermalPdf(doc))).reads).toContainEqual(
          expect.objectContaining({ text: url }),
        );
        expect(page?.ink.every((r) => [r.x, r.y, r.w, r.h].every(Number.isInteger))).toBe(true);
        expect(
          page?.text.every((line) => line.x + line.value.length * line.size * 0.6 <= doc.dots.w),
        ).toBe(true);
      }
    },
  );

  it('preserves payloads with an embedded icon and falls back on a dense compact QR', async () => {
    const options = {
      ...DEFAULT_THERMAL_OPTIONS,
      template: 'drawer',
      workshopIcon: 'HEX',
      iconPlacement: 'embedded',
    } as const;
    const reference = 'https://sk.test/l/2HX9RB';
    for (const dpi of [203, 300]) {
      const decorated = thermalDocument(
        'thermal_50x20',
        'single',
        { ...profile, dpi },
        { ...options, payload: 'app' },
        [{ identifier: '2HX9RB', url: reference, name: 'Hex bits' }],
        encode,
      );
      expect(decorated.warnings?.separateIcon).toBeUndefined();
      expect((await rendered(decorated, await thermalPdf(decorated))).reads).toContainEqual(
        expect.objectContaining({ text: '2HX9RB' }),
      );
    }
    const dense = thermalDocument(
      'thermal_50x20',
      'single',
      { ...profile, printableHeight: 17 },
      options,
      [{ ...label, name: 'Hex bits' }],
      encode,
    );
    expect(dense.warnings?.separateIcon).toBe(true);
    expect((await rendered(dense, await thermalPdf(dense))).reads).toContainEqual(
      expect.objectContaining({ text: url }),
    );
  });

  it('infers a workshop icon from a numbered prefix, category, or contents', () => {
    expect(suggestWorkshopIcon('HEX-A09Z-0001', 'Driver bits')).toBe('HEX');
    expect(suggestWorkshopIcon('XKXJQ4', 'Drill bits')).toBe('DRL');
    expect(suggestWorkshopIcon('XKXJQ4', '', 'Rotary cutoff wheels')).toBe('ROT');
    expect(suggestWorkshopIcon('XKXJQ4', '', 'Washers and bolts')).toBe('WSH');
    expect(suggestWorkshopIcon('XKXJQ4', '', 'Drawer 9')).toBe('MSC');
  });

  it.each([
    ['thermal_50x20', 203],
    ['thermal_50x20', 300],
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

  it('lays out a compact asset without a storage path and reserves space for both tags', () => {
    const doc = thermalDocument(
      'thermal_50x20',
      'single',
      profile,
      DEFAULT_THERMAL_OPTIONS,
      [
        {
          ...label,
          name: 'Socket',
          contents: '10 mm · ¼-inch drive',
          location: 'Main workshop',
          nfc: 'verified',
          uhf: true,
        },
      ],
      encode,
    );
    const page = doc.pages[0];
    expect(page?.text.map((line) => line.value)).toEqual([
      identifier,
      'Socket',
      '10 mm · 1/4-inch drive',
      'NFC + UHF',
    ]);
    expect(page?.text[0]?.x).toBeGreaterThan(page?.ink[0]?.x ?? Infinity);
    expect(doc.warnings?.threeDotQr).toBe(true);
    expect(doc.warnings?.omittedText).toBe(false);
  });

  it('preserves integer modules and a four-module quiet zone in the compact app QR', async () => {
    const payload = `${identifier}-010203040506`;
    const doc = thermalDocument(
      'thermal_50x20',
      'single',
      profile,
      { ...DEFAULT_THERMAL_OPTIONS, payload: 'app', variant: 'identity' },
      [{ ...label, name: 'Hidden', contents: 'Hidden', nfc: 'pending', uhf: true }],
      encode,
    );
    const page = doc.pages[0];
    if (!page) throw new Error('Missing page');
    const modules = qrMatrix(encode, payload).length;
    const module = page.ink[0]?.h ?? 0;
    expect(module).toBeGreaterThanOrEqual(4);
    const left = Math.min(...page.ink.map((r) => r.x));
    const top = Math.min(...page.ink.map((r) => r.y));
    const bottom = Math.max(...page.ink.map((r) => r.y + r.h));
    const right = Math.max(...page.ink.map((r) => r.x + r.w));
    expect(left - doc.printable.x).toBe(4 * module);
    expect(top - doc.printable.y).toBeGreaterThanOrEqual(4 * module);
    expect(doc.printable.y + doc.printable.h - bottom).toBeGreaterThanOrEqual(4 * module);
    expect(right - left).toBe((modules - 8) * module);
    expect((page.text[0]?.x ?? 0) - right).toBeGreaterThanOrEqual(4 * module);
    expect(page.ink.every((r) => r.h === module && r.w % module === 0)).toBe(true);
    expect(page.text.map((t) => t.value)).toEqual([identifier, 'UHF']);
    expect((await rendered(doc, await thermalPdf(doc))).reads).toContainEqual(
      expect.objectContaining({ text: payload }),
    );
  });

  it('omits overflow while retaining tags and fits a write-in rectangle beside the QR', () => {
    const docs = (content: ThermalContent) =>
      thermalDocument(
        'thermal_50x20',
        'single',
        profile,
        DEFAULT_THERMAL_OPTIONS,
        [content],
        encode,
      );
    const oversized = docs({ ...label, contents: 'A'.repeat(160), nfc: 'verified' });
    expect(oversized.warnings?.omittedText).toBe(true);
    expect(oversized.pages[0]?.text.map((t) => t.value)).toEqual([identifier, 'NFC']);
    // A temporary label avoids printing incidental contents and puts two rules in the text column.
    const temporary = docs({ ...label, name: 'Socket', contents: '10 mm', writeIn: true });
    expect(temporary.pages[0]?.text.map((t) => t.value)).toEqual([identifier]);
    expect(temporary.pages[0]?.ink.filter((r) => r.h === 1)).toHaveLength(2);
    const category = docs({ ...label, name: 'Sockets', nfc: 'verified', uhf: false });
    expect(category.pages[0]?.text.map((t) => t.value)).toEqual([identifier, 'Sockets', 'NFC']);
    expect(category.pages[0]?.ink.filter((r) => r.h === 1)).toHaveLength(1);
  });

  it('rotates the compact design and renders a single calibration page', async () => {
    const rotated = thermalDocument(
      'thermal_50x20',
      'single',
      { ...profile, orientation: 'landscape' },
      DEFAULT_THERMAL_OPTIONS,
      [label],
      encode,
    );
    expect(rotated.mm).toEqual({ w: 20, h: 50 });
    expect(rotated.pages[0]?.text[0]?.rotate).toBe(90);
    expect((await rendered(rotated, await thermalPdf(rotated))).reads).toContainEqual(
      expect.objectContaining({ text: url }),
    );
    const sampleUrl = 'https://example.org/calibration';
    const cal = calibrationDocument('thermal_50x20', profile, sampleUrl, encode);
    expect(cal.pages).toHaveLength(1);
    const proof = await rendered(cal, await thermalPdf(cal));
    expect(proof.text).toEqual(expect.arrayContaining(['TMP-A09Z-0001', 'TOP / QR sample']));
    expect(proof.reads).toContainEqual(expect.objectContaining({ text: sampleUrl }));
  });

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

  it.each(['thermal_30_48x20_32', 'thermal_50x20'])(
    'hides the NFC mark when disabled on %s and keeps the UHF mark',
    (stock) => {
      const doc = thermalDocument(
        stock,
        'single',
        profile,
        { ...DEFAULT_THERMAL_OPTIONS, payload: 'app', variant: 'identity', showNfc: false },
        [{ ...label, nfc: 'verified', uhf: true }],
        encode,
      );
      expect(doc.pages[0]?.text.map((item) => item.value)).toEqual([identifier, 'UHF']);
    },
  );

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
