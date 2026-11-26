import { z } from 'zod';
import {
  COMPACT_THERMAL_STOCK,
  isThermalLabelStock,
  labelStock,
  MICRO_THERMAL_STOCK,
  SQUARE_THERMAL_STOCK,
} from './label-stocks.js';

export const THERMAL_LAYOUTS = {
  single: { cols: 1, rows: 1 },
  cut_4x3: { cols: 1, rows: 2 },
  cut_2x2: { cols: 2, rows: 3 },
  cut_2x1: { cols: 2, rows: 6 },
} as const;

export type ThermalLayout = keyof typeof THERMAL_LAYOUTS;
export type Dimensions = { w: number; h: number };
export type PrintRect = Dimensions & { x: number; y: number };

export type StockCalibration = {
  offsetX: number;
  offsetY: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type PrinterProfile = {
  id: string;
  name: string;
  queue?: string;
  stock: string;
  dpi: number;
  printableWidth?: number;
  printableHeight?: number;
  maxMediaWidth?: number;
  minMediaWidth?: number;
  minFeedLength?: number;
  orientation: 'portrait' | 'landscape';
  scale: number;
  media: 'gap' | 'mark' | 'continuous';
  gapOrMark?: number;
  speed?: number;
  darkness?: number;
  qrMm?: number;
  layout: ThermalLayout;
  adapter?: 'system' | 'browser' | 'niimbot-b1-pro';
  bluetoothId?: string;
  calibration: Record<string, StockCalibration>;
  settingsByStock?: Record<string, StockPrintSettings>;
};

type StockPrintSettings = Pick<
  PrinterProfile,
  | 'dpi'
  | 'orientation'
  | 'scale'
  | 'printableWidth'
  | 'printableHeight'
  | 'maxMediaWidth'
  | 'minMediaWidth'
  | 'minFeedLength'
  | 'media'
  | 'gapOrMark'
  | 'speed'
  | 'darkness'
  | 'qrMm'
  | 'layout'
>;

export function printerOnStock(profile: PrinterProfile, stock: string): PrinterProfile {
  const settings = profile.settingsByStock?.[stock];
  return settings ? { ...profile, ...settings } : profile;
}

export function savePrinterStock(
  profile: PrinterProfile,
  stock: string,
  layout: ThermalLayout,
): PrinterProfile {
  const {
    dpi,
    orientation,
    scale,
    printableWidth,
    printableHeight,
    maxMediaWidth,
    minMediaWidth,
    minFeedLength,
    media,
    gapOrMark,
    speed,
    darkness,
    qrMm,
  } = profile;
  const settings = {
    dpi,
    orientation,
    scale,
    printableWidth,
    printableHeight,
    maxMediaWidth,
    minMediaWidth,
    minFeedLength,
    media,
    gapOrMark,
    speed,
    darkness,
    qrMm,
    layout,
  } as StockPrintSettings;
  return {
    ...profile,
    stock,
    layout,
    settingsByStock: { ...profile.settingsByStock, [stock]: settings },
  };
}

const margin = z.number().min(0).max(100);
const offset = z.number().min(-25).max(25);
export const StockCalibrationSchema = z.strictObject({
  offsetX: offset,
  offsetY: offset,
  top: margin,
  right: margin,
  bottom: margin,
  left: margin,
});

export const ThermalLayoutSchema = z.enum(['single', 'cut_4x3', 'cut_2x2', 'cut_2x1']);
export const WORKSHOP_ICON_CODES = [
  'BIT',
  'HEX',
  'BLT',
  'TOL',
  'CAB',
  'ELE',
  'MEA',
  'ROT',
  'ADH',
  'WSH',
  'DRL',
  'MSC',
] as const;
export type WorkshopIcon = (typeof WORKSHOP_ICON_CODES)[number];

export function supportsDrawerTemplate(stock: string): boolean {
  return (
    stock === COMPACT_THERMAL_STOCK || stock === SQUARE_THERMAL_STOCK || stock === 'thermal_4x6in'
  );
}

const printDistance = z.number().positive().max(1000);
export const ThermalBatchSpecSchema = z.strictObject({
  layout: ThermalLayoutSchema,
  profile: z.strictObject({
    dpi: z.number().int().min(150).max(1200),
    orientation: z.enum(['portrait', 'landscape']),
    scale: z.number().min(60).max(100),
    printableWidth: printDistance.optional(),
    printableHeight: printDistance.optional(),
    maxMediaWidth: printDistance.optional(),
    minMediaWidth: printDistance.optional(),
    minFeedLength: printDistance.optional(),
    qrMm: z.number().min(5).max(125).optional(),
    calibration: StockCalibrationSchema.optional(),
  }),
  options: z.strictObject({
    qrSide: z.enum(['left', 'right']),
    handwriting: z.number().int().min(0).max(6),
    showName: z.boolean(),
    showLocation: z.boolean(),
    showContents: z.boolean(),
    showNfc: z.boolean(),
    showBarcode: z.boolean().optional(),
    payload: z.enum(['url', 'app']).optional(),
    variant: z.enum(['standard', 'identity']).optional(),
    template: z.literal('drawer').optional(),
    workshopIcon: z.enum([...WORKSHOP_ICON_CODES, 'none']).optional(),
    iconPlacement: z.enum(['beside', 'embedded']).optional(),
    identifierPt: z.number().min(0).max(72),
  }),
  category: z.string().trim().max(100).optional(),
  contents: z.string().trim().max(400).optional(),
});
export type ThermalBatchSpec = z.infer<typeof ThermalBatchSpecSchema>;

export function profileForBatch(stock: string, spec: ThermalBatchSpec): PrinterProfile {
  const { calibration, ...profile } = spec.profile;
  return {
    ...defaultPrinterProfile(),
    ...profile,
    stock,
    layout: spec.layout,
    calibration: calibration ? { [stock]: calibration } : {},
  } as PrinterProfile;
}

export const DEFAULT_CALIBRATION: StockCalibration = {
  offsetX: 0,
  offsetY: 0,
  top: 1,
  right: 1,
  bottom: 1,
  left: 1,
};

export function stockCalibration(stock: string): StockCalibration {
  return stock === MICRO_THERMAL_STOCK
    ? { ...DEFAULT_CALIBRATION, top: 0.65, right: 0.65, bottom: 0.65, left: 0.65 }
    : DEFAULT_CALIBRATION;
}

export function defaultPrinterProfile(): PrinterProfile {
  return {
    id: '',
    name: '',
    stock: COMPACT_THERMAL_STOCK,
    dpi: 203,
    orientation: 'portrait',
    scale: 100,
    media: 'gap',
    speed: 3,
    darkness: 8,
    layout: 'single',
    calibration: {},
  };
}

export function nominalDots(mm: Dimensions, dpi: number): Dimensions {
  return { w: Math.round((mm.w * dpi) / 25.4), h: Math.round((mm.h * dpi) / 25.4) };
}

type Slot = { cell: PrintRect; ink: PrintRect };
export type ThermalGeometry = {
  mm: Dimensions;
  dots: Dimensions;
  dpi: number;
  printable: PrintRect;
  pages: Slot[][];
  grid: { cols: number; rows: number };
};

function intersect(a: PrintRect, b: PrintRect): PrintRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.min(a.x + a.w, b.x + b.w) - x,
    h: Math.min(a.y + a.h, b.y + b.h) - y,
  };
}

/** Coordinates in whole dots, from the top left of the paper as it will be printed. */
export function thermalGeometry(
  key: string,
  layout: ThermalLayout,
  profile: PrinterProfile,
  count: number,
): ThermalGeometry {
  if (!isThermalLabelStock(key) || (layout !== 'single' && key !== 'thermal_4x6in')) {
    throw new RangeError('stock');
  }
  const stock = labelStock(key);
  const { dpi, scale } = profile;
  const gridDefinition = THERMAL_LAYOUTS[layout];
  if (!gridDefinition) throw new RangeError('settings');
  const { cols, rows } = gridDefinition;
  const cal = profile.calibration[key] ?? stockCalibration(key);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1000 ||
    !Number.isInteger(dpi) ||
    dpi < 150 ||
    dpi > 1200 ||
    !Number.isFinite(scale) ||
    scale < 60 ||
    scale > 100 ||
    [cal.top, cal.right, cal.bottom, cal.left].some((n) => !Number.isFinite(n) || n < 0) ||
    [cal.offsetX, cal.offsetY].some((n) => !Number.isFinite(n) || Math.abs(n) > 25) ||
    [
      profile.maxMediaWidth,
      profile.minMediaWidth,
      profile.minFeedLength,
      profile.printableWidth,
      profile.printableHeight,
    ].some((n) => n !== undefined && (!Number.isFinite(n) || n <= 0))
  ) {
    throw new RangeError('settings');
  }
  if (profile.maxMediaWidth !== undefined && stock.page.w > profile.maxMediaWidth) {
    throw new RangeError('media-width');
  }
  if (profile.minMediaWidth !== undefined && stock.page.w < profile.minMediaWidth) {
    throw new RangeError('media-width');
  }
  if (profile.minFeedLength !== undefined && stock.page.h < profile.minFeedLength) {
    throw new RangeError('feed-length');
  }

  const landscape = profile.orientation === 'landscape';
  const mm = landscape ? { w: stock.page.h, h: stock.page.w } : stock.page;
  const dots = nominalDots(mm, dpi);
  const dot = (value: number) => Math.round((value * dpi) / 25.4);
  const grid = landscape ? { cols: rows, rows: cols } : { cols, rows };
  const perPage = cols * rows;
  const x = dot(cal.left);
  const y = dot(cal.top);
  const head = {
    w: dot(landscape ? (profile.printableHeight ?? mm.w) : (profile.printableWidth ?? mm.w)),
    h: dot(landscape ? (profile.printableWidth ?? mm.h) : (profile.printableHeight ?? mm.h)),
  };
  const printable = {
    x,
    y,
    w: Math.min(head.w, dots.w - x - dot(cal.right)),
    h: Math.min(head.h, dots.h - y - dot(cal.bottom)),
  };
  if (printable.w <= 0 || printable.h <= 0) throw new RangeError('margins');

  const slots = Array.from({ length: Math.min(count, perPage) }, (_, index) => {
    const col = index % grid.cols;
    const row = Math.floor(index / grid.cols);
    const x = Math.round((col * dots.w) / grid.cols);
    const y = Math.round((row * dots.h) / grid.rows);
    const cell = {
      x,
      y,
      w: Math.round(((col + 1) * dots.w) / grid.cols) - x,
      h: Math.round(((row + 1) * dots.h) / grid.rows) - y,
    };
    const pad = perPage === 1 ? 0 : Math.max(1, dot(1));
    const w = Math.floor(((cell.w - 2 * pad) * scale) / 100);
    const h = Math.floor(((cell.h - 2 * pad) * scale) / 100);
    const inside = {
      x: x + Math.floor((cell.w - w) / 2),
      y: y + Math.floor((cell.h - h) / 2),
      w,
      h,
    };
    const base = intersect(inside, printable);
    const shifted = { ...base, x: base.x + dot(cal.offsetX), y: base.y + dot(cal.offsetY) };
    // Calibration can shift the design, but it cannot consume the cut clearance.
    const usableCell = { x: x + pad, y: y + pad, w: cell.w - 2 * pad, h: cell.h - 2 * pad };
    const ink = intersect(intersect(shifted, usableCell), {
      x: 0,
      y: 0,
      w: Math.min(dots.w, head.w),
      h: Math.min(dots.h, head.h),
    });
    if (ink.w <= 0 || ink.h <= 0) throw new RangeError('margins');
    return { cell, ink };
  });

  return {
    mm,
    dots,
    dpi,
    printable,
    grid,
    pages: Array.from({ length: Math.ceil(count / perPage) }, (_, page) =>
      slots.slice(0, Math.min(perPage, count - page * perPage)),
    ),
  };
}
