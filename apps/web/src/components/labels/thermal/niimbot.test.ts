// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defaultPrinterProfile, labelStock, usesThermalLabelEditor } from '@kept/shared';
import { createCanvas } from '@napi-rs/canvas';
import { encode } from 'uqr';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { DEFAULT_THERMAL_OPTIONS, thermalDocument } from './document';
import { fitsNiimbotStock, NIIMBOT_STOCKS, niimbotJob, niimbotProfile } from './niimbot';

afterEach(() => vi.unstubAllGlobals());

const device = { id: '075A6BA9-D3C0-4D44-B28D-466C4DB21040', name: 'B1 Pro' };
const identifier = 'TMP-OILZ-9999';
const url = `https://labels.example.org/l/${identifier}-010203040506`;

it('prints the complete thermal label and a readable QR inside 567 dots', async () => {
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  const stock = 'thermal_50x20';
  const profile = niimbotProfile(device, stock);
  const doc = thermalDocument(
    stock,
    'single',
    profile,
    { ...DEFAULT_THERMAL_OPTIONS, template: 'drawer', workshopIcon: 'BIT' },
    [{ identifier, url, drawerContents: 'Phillips bits', nfc: 'verified' }],
    encode,
  );
  const job = niimbotJob(stock, doc, 1, 1, 2, 3);
  expect(job).toMatchObject({ width: 567, height: 236, copies: 2, density: 3 });
  expect(doc.dots.w).toBe(591);
  expect(doc.pages[0]?.text.some(({ value }) => value === identifier)).toBe(true);
  const bits = Buffer.from(job.pages[0] ?? '', 'base64');
  const stride = Math.ceil(job.width / 8);
  expect(bits).toHaveLength(stride * job.height);
  const raster = createCanvas(job.width, job.height)
    .getContext('2d')
    .createImageData(job.width, job.height);
  for (let y = 0; y < job.height; y++) {
    expect((bits[y * stride + stride - 1] ?? 1) & 1).toBe(0);
    for (let x = 0; x < job.width; x++) {
      const black = (bits[y * stride + (x >> 3)] ?? 0) & (0x80 >> (x & 7));
      const pixel = (y * job.width + x) * 4;
      raster.data.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], pixel);
    }
  }
  const resolve = createRequire(import.meta.url).resolve;
  const wasm = readFileSync(resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await prepareZXingModule({
    overrides: { wasmBinary: Uint8Array.from(wasm).buffer },
    fireImmediately: true,
  });
  expect(
    await readBarcodes(raster as unknown as ImageData, { formats: ['QRCode'] }),
  ).toContainEqual(expect.objectContaining({ text: url }));
});

it('supports six metric stocks and keeps legacy roll batches in their original editor', () => {
  expect(NIIMBOT_STOCKS.map((stock) => labelStock(stock).page)).toEqual([
    { w: 50, h: 20 },
    { w: 40, h: 20 },
    { w: 30, h: 20 },
    { w: 40, h: 30 },
    { w: 50, h: 30 },
    { w: 50, h: 50 },
  ]);
  expect(usesThermalLabelEditor('thermal_50x30')).toBe(false);
  expect(usesThermalLabelEditor('thermal_50x30', true)).toBe(true);
  expect(niimbotProfile(device, 'thermal_4x6in').stock).toBe('thermal_50x20');
});

it('refuses mismatched raster geometry, print ranges and control settings', () => {
  const stock = 'thermal_50x20';
  const labels = [{ identifier, url }];
  const ordinary = thermalDocument(
    stock,
    'single',
    defaultPrinterProfile(),
    DEFAULT_THERMAL_OPTIONS,
    labels,
    encode,
  );
  expect(fitsNiimbotStock(stock, ordinary)).toBe(false);
  const doc = thermalDocument(
    stock,
    'single',
    niimbotProfile(device, stock),
    DEFAULT_THERMAL_OPTIONS,
    labels,
    encode,
  );
  expect(() => niimbotJob(stock, doc, 1, 2, 1, 3)).toThrow(RangeError);
  expect(() => niimbotJob(stock, doc, 1, 1, 1, 8)).toThrow(RangeError);
  expect(() => niimbotJob('thermal_40x20', doc, 1, 1, 1, 3)).toThrow(RangeError);
  expect(
    fitsNiimbotStock(stock, { ...doc, pages: [{ ink: [{ x: 566, y: 0, w: 2, h: 1 }], text: [] }] }),
  ).toBe(false);
});
