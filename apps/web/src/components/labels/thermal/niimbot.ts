import {
  COMPACT_THERMAL_STOCK,
  defaultPrinterProfile,
  labelStock,
  nominalDots,
  type PrinterProfile,
} from '@kept/shared';
import type { DotPage, ThermalDocument } from './document';

export const NIIMBOT_DPI = 300;
export const NIIMBOT_WIDTH = 567;
export const NIIMBOT_PAGE_LIMIT = 40;
export const NIIMBOT_COPY_LIMIT = 20;
export const NIIMBOT_STOCKS = [
  COMPACT_THERMAL_STOCK,
  'thermal_40x20',
  'thermal_30x20',
  'thermal_40x30',
  'thermal_50x30',
  'thermal_50x50',
] as const;

export type NiimbotDevice = { id: string; name: string };
export type NiimbotIdentity = {
  modelId: number;
  protocolGeneration?: number;
  firmware?: string;
  lidOpen?: boolean;
  paperOut?: boolean;
  rollRecognized?: boolean;
  batteryPercent?: number;
};
export type NiimbotResult = {
  state: 'completed' | 'uncertain' | 'cancelled';
  completed: number;
};
export type NiimbotJob = {
  width: number;
  height: number;
  pages: string[];
  copies: number;
  density: number;
};
export type NiimbotOutput = {
  discover(showOtherDevices: boolean): Promise<NiimbotDevice[]>;
  identify(deviceId: string): Promise<NiimbotIdentity>;
  print(deviceId: string, job: NiimbotJob): Promise<NiimbotResult>;
  cancel(): Promise<void>;
};

export function isNiimbotStock(stock: string): boolean {
  return NIIMBOT_STOCKS.some((candidate) => candidate === stock);
}

export function niimbotProfile(device: NiimbotDevice, stock: string): PrinterProfile {
  return {
    ...defaultPrinterProfile(),
    id: `niimbot:${device.id}`,
    name: device.name,
    adapter: 'niimbot-b1-pro',
    bluetoothId: device.id,
    stock: isNiimbotStock(stock) ? stock : COMPACT_THERMAL_STOCK,
    dpi: NIIMBOT_DPI,
    printableWidth: (NIIMBOT_WIDTH * 25.4) / NIIMBOT_DPI,
    maxMediaWidth: 50,
    darkness: 3,
  };
}

function rasterSize(stock: string, doc: ThermalDocument) {
  if (
    !isNiimbotStock(stock) ||
    doc.dpi !== NIIMBOT_DPI ||
    doc.grid.cols !== 1 ||
    doc.grid.rows !== 1
  )
    return;
  const page = labelStock(stock).page;
  const dots = nominalDots(page, NIIMBOT_DPI);
  if (doc.mm.w !== page.w || doc.mm.h !== page.h || doc.dots.w !== dots.w || doc.dots.h !== dots.h)
    return;
  return { width: Math.min(NIIMBOT_WIDTH, dots.w), height: dots.h };
}

export function fitsNiimbotStock(stock: string, doc: ThermalDocument): boolean {
  const size = rasterSize(stock, doc);
  return (
    !!size &&
    doc.pages.every((page) =>
      page.ink.every(
        ({ x, y, w, h }) => x >= 0 && y >= 0 && x + w <= size.width && y + h <= size.height,
      ),
    )
  );
}

/** One bit per dot, black=1, first pixel in the most significant bit. */
function packPage(page: DotPage, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000';
  context.imageSmoothingEnabled = false;
  context.textBaseline = 'alphabetic';
  for (const { x, y, w, h } of page.ink) context.fillRect(x, y, w, h);
  for (const text of page.text) {
    context.save();
    context.translate(text.x, text.y);
    if (text.rotate) context.rotate(Math.PI / 2);
    // The document fits text at a Courier character width of 0.6 em.
    context.font = `${text.bold ? 'bold ' : ''}${text.size}px "Courier New", Courier, monospace`;
    context.fillText(text.value, 0, 0, text.value.length * text.size * 0.6);
    context.restore();
  }

  const { data } = context.getImageData(0, 0, width, height);
  const stride = Math.ceil(width / 8);
  const packed = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4] ?? 255) >= 128) continue;
      const index = y * stride + (x >> 3);
      packed[index] = (packed[index] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return btoa(String.fromCharCode(...packed));
}

export function niimbotJob(
  stock: string,
  doc: ThermalDocument,
  from: number,
  to: number,
  copies: number,
  density: number,
): NiimbotJob {
  const size = rasterSize(stock, doc);
  if (
    !size ||
    !fitsNiimbotStock(stock, doc) ||
    ![from, to, copies, density].every(Number.isInteger) ||
    from < 1 ||
    from > to ||
    to > doc.pages.length ||
    to - from + 1 > NIIMBOT_PAGE_LIMIT ||
    copies < 1 ||
    copies > NIIMBOT_COPY_LIMIT ||
    density < 1 ||
    density > 5
  )
    throw new RangeError('Niimbot print job');
  return {
    ...size,
    copies,
    density,
    pages: doc.pages.slice(from - 1, to).map((page) => packPage(page, size.width, size.height)),
  };
}
