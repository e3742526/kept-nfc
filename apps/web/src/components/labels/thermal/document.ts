import {
  COMPACT_THERMAL_STOCK,
  MICRO_THERMAL_STOCK,
  type PrinterProfile,
  type PrintRect,
  parseScan,
  type ThermalGeometry,
  type ThermalLayout,
  thermalGeometry,
} from '@kept/shared';
import JsBarcode from 'jsbarcode';
import { type Encode, qrMatrix } from '../qr';

export type ThermalContent = {
  identifier: string;
  url: string;
  name?: string | undefined;
  location?: string | undefined;
  contents?: string | undefined;
  nfc?: 'verified' | 'pending' | 'unknown' | undefined;
  uhf?: boolean | undefined;
  barcode?: string | undefined;
  writeIn?: boolean | undefined;
};

export type ThermalOptions = {
  qrSide: 'left' | 'right';
  handwriting: number;
  showName: boolean;
  showLocation: boolean;
  showContents: boolean;
  showNfc: boolean;
  showBarcode?: boolean | undefined;
  payload?: 'url' | 'app' | undefined;
  variant?: 'standard' | 'identity' | undefined;
  identifierPt: number;
};

export const DEFAULT_THERMAL_OPTIONS: ThermalOptions = {
  qrSide: 'left',
  handwriting: 2,
  showName: true,
  showLocation: true,
  showContents: true,
  showNfc: true,
  showBarcode: false,
  identifierPt: 0,
};

type Text = { value: string; x: number; y: number; size: number; bold?: boolean; rotate?: 90 };
export type DotPage = { ink: PrintRect[]; text: Text[] };
type FitWarnings = { threeDotQr: boolean; omittedText: boolean };
export type ThermalDocument = Omit<ThermalGeometry, 'pages'> & {
  pages: DotPage[];
  warnings?: FitWarnings;
};

export class ThermalFitError extends Error {
  constructor(readonly reason: 'qr' | 'identifier' | 'settings' | 'payload') {
    super(reason);
  }
}

const glyphWidth = 0.6;
const idPattern = /^[A-Z0-9-]{1,32}$/;
const mmToDots = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

// The PDF standard font has a finite character set. Optional unsupported characters can be
// omitted. Identifiers are ASCII and always fit in full or the document is rejected.
function printableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replaceAll('⁄', '/')
    .replace(/[^\x20-\x7E·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fitOptional(value: string, width: number, size: number): string {
  return printableText(value)
    .slice(0, Math.floor(width / (size * glyphWidth)))
    .trimEnd();
}

function qrInk(ink: PrintRect[], matrix: boolean[][], x: number, y: number, module: number) {
  // Coalesce black modules by row. Adjacent squares share an edge in vector output.
  matrix.forEach((row, yi) => {
    let start = -1;
    for (let xi = 0; xi <= row.length; xi++) {
      if (row[xi]) {
        if (start < 0) start = xi;
      } else if (start >= 0) {
        ink.push({
          x: x + start * module,
          y: y + yi * module,
          w: (xi - start) * module,
          h: module,
        });
        start = -1;
      }
    }
  });
}

function barcodeInk(page: DotPage, barcode: string, box: PrintRect, dpi: number) {
  if (!/^[ -~]{1,80}$/.test(barcode) || box.h < mmToDots(10, dpi)) return;
  const target: { encodings?: { data: string }[] } = {};
  JsBarcode(target, barcode, { format: 'CODE128', displayValue: false });
  const bars = target.encodings?.map((part) => part.data).join('') ?? '';
  const quiet = 10;
  const module = Math.min(Math.floor(box.w / (bars.length + 2 * quiet)), mmToDots(0.5, dpi));
  if (!bars || module < Math.ceil((dpi * 0.25) / 25.4)) return;
  for (const run of bars.matchAll(/1+/g)) {
    page.ink.push({
      x: box.x + (run.index + quiet) * module,
      y: box.y,
      w: run[0].length * module,
      h: mmToDots(10, dpi),
    });
  }
}

/** Use the space to the right of the QR for one short name, one description and the actual
 * tag associations. Reserve the tag line before fitting the optional copy. */
function drawCompactFields(
  page: DotPage,
  label: ThermalContent,
  options: ThermalOptions,
  box: PrintRect,
  dpi: number,
  warnings: FitWarnings,
) {
  const tags = [label.nfc === 'verified' ? 'NFC' : '', label.uhf ? 'UHF' : '']
    .filter(Boolean)
    .join(' + ');
  const font = Math.ceil((6 * dpi) / 72);
  const line = Math.ceil(font * 1.25);
  const bottom = box.y + box.h;
  const lastOptional = bottom - (tags ? line : 0);
  const identity = options.variant === 'identity';
  let y = box.y;
  const add = (value: string, last: number) => {
    const text = printableText(value);
    if (!text || text.length * font * glyphWidth > box.w || y + line > last) {
      warnings.omittedText = true;
      return;
    }
    y += line;
    page.text.push({ value: text, x: box.x, y, size: font });
  };
  if (!identity && !label.writeIn) {
    if (options.showName && label.name) add(label.name, lastOptional);
    if (options.showContents && label.contents) add(label.contents, lastOptional);
  }
  if (tags) add(tags, bottom);
  if (identity) return;
  const writingSpace = mmToDots(3.2, dpi);
  const requested = label.name && !label.writeIn ? 1 : 2;
  const rows = Math.min(options.handwriting, requested, Math.floor((bottom - y) / writingSpace));
  for (let row = 0; row < rows; row++) {
    page.ink.push({ x: box.x, y: bottom - 1 - row * writingSpace, w: box.w, h: 1 });
  }
}

function drawCell(
  page: DotPage,
  box: PrintRect,
  label: ThermalContent,
  dpi: number,
  profile: PrinterProfile,
  options: ThermalOptions,
  encode: Encode,
  compactWarnings?: FitWarnings,
) {
  const matrix = qrMatrix(encode, labelPayload(label, options));
  const dots = (mm: number) => mmToDots(mm, dpi);
  const pts = (pt: number) => Math.ceil((pt * dpi) / 72);
  const compact = !!compactWarnings || box.h < dots(29);
  const stacked = !compact && box.w < box.h * 1.25;
  const gap = dots(compact ? 0.9 : 2.5);
  const id = label.identifier;
  if (!idPattern.test(id)) throw new ThermalFitError('identifier');
  const minId = pts(compact ? 6 : 8);
  const preferredId = pts(options.identifierPt || (compact ? 8 : 18));
  const minTextWidth = Math.ceil(minId * glyphWidth * id.length);
  const minTextHeight = Math.ceil(minId * 1.2);
  const minimumModule = Math.max(3, Math.ceil((dpi * 0.3) / 25.4));
  const target = compactWarnings
    ? matrix.length *
      Math.max(
        profile.qrMm === undefined ? 4 : minimumModule,
        Math.round(dots(profile.qrMm ?? 16) / matrix.length),
      )
    : Math.max(matrix.length * minimumModule, dots(profile.qrMm ?? (compact ? 17 : 48)));
  const qrSpace = Math.min(
    target,
    stacked ? box.w : box.w - minTextWidth - gap,
    stacked ? Math.floor(box.h * 0.65) : box.h,
  );
  const module = Math.floor(qrSpace / matrix.length);
  if (module < minimumModule) throw new ThermalFitError('qr');
  const qrSize = module * matrix.length;
  const right = !compactWarnings && options.qrSide === 'right';
  const qx = box.x + (stacked ? Math.floor((box.w - qrSize) / 2) : right ? box.w - qrSize : 0);
  const qy = box.y + (compact ? Math.floor((box.h - qrSize) / 2) : 0);
  qrInk(page.ink, matrix, qx, qy, module);

  const tx = stacked || right ? box.x : qx + qrSize + gap;
  const width = stacked ? box.w : box.w - qrSize - gap;
  const top = stacked ? qy + qrSize + gap : box.y;
  const bottom = box.y + box.h;
  const size = Math.min(
    preferredId,
    Math.floor(width / (glyphWidth * id.length)),
    Math.floor((bottom - top) / 1.2),
  );
  if (size < minId || bottom - top < minTextHeight) throw new ThermalFitError('identifier');
  const baseline = top + size;
  page.text.push({ value: id, x: tx, y: baseline, size, bold: true });
  if (compactWarnings) {
    compactWarnings.threeDotQr ||= module === 3;
    drawCompactFields(
      page,
      label,
      options,
      { x: tx, y: baseline, w: width, h: bottom - baseline },
      dpi,
      compactWarnings,
    );
    return;
  }

  const small = pts(compact ? 6 : 9);
  const line = Math.ceil(small * 1.25);
  const handwritingHeight = dots(compact ? 3.2 : 7);
  const requested = Math.min(options.handwriting, compact ? 2 : 6);
  const rows = Math.min(requested, Math.floor((bottom - baseline - gap) / handwritingHeight));
  const lastText = bottom - Math.max(0, rows) * handwritingHeight - gap;
  const optional = [
    options.showName && label.name,
    options.showLocation && label.location,
    !compact && options.showContents && label.contents,
    !compact && options.showNfc && label.nfc === 'verified' && 'NFC',
    !compact && label.uhf && 'UHF',
  ];
  let y = baseline;
  for (const value of optional) {
    if (!value || y + line > lastText) continue;
    const text = fitOptional(value, width, small);
    if (!text) continue;
    y += line;
    page.text.push({ value: text, x: tx, y, size: small });
  }
  if (options.showBarcode && label.barcode && box.w >= dots(70) && box.h >= dots(45)) {
    const barcodeTop = y + gap;
    barcodeInk(
      page,
      label.barcode,
      { x: tx, y: barcodeTop, w: width, h: lastText - barcodeTop },
      dpi,
    );
  }
  const stroke = Math.max(1, dots(0.18));
  for (let row = 0; row < rows; row++) {
    page.ink.push({ x: tx, y: bottom - stroke - row * handwritingHeight, w: width, h: stroke });
  }
}

function drawCompact(
  page: DotPage,
  box: PrintRect,
  label: ThermalContent,
  dpi: number,
  profile: PrinterProfile,
  options: ThermalOptions,
  encode: Encode,
  warnings: FitWarnings,
) {
  if (profile.orientation === 'portrait') {
    drawCell(page, box, label, dpi, profile, options, encode, warnings);
    return;
  }

  // Rotate the horizontal design as a unit so the full label fits the same physical stock.
  const drawing: DotPage = { ink: [], text: [] };
  drawCell(
    drawing,
    { x: 0, y: 0, w: box.h, h: box.w },
    label,
    dpi,
    profile,
    options,
    encode,
    warnings,
  );
  for (const { x, y, w, h } of drawing.ink) {
    page.ink.push({ x: box.x + box.w - y - h, y: box.y + x, w: h, h: w });
  }
  for (const line of drawing.text) {
    page.text.push({ ...line, x: box.x + box.w - line.y, y: box.y + line.x, rotate: 90 });
  }
}

function labelPayload(label: ThermalContent, options: ThermalOptions): string {
  if (options.payload !== 'app') return label.url;
  const code = parseScan(label.url);
  if (code.kind === 'kept') return code.code;
  if (code.kind === 'alias')
    return code.guard ? `${code.alias}-${code.guard.toUpperCase()}` : code.alias;
  throw new ThermalFitError('payload');
}

/** The narrow roll dedicates a full-width baseline to the ID. The rest of the text flows beside
 * the QR, so optional content can disappear without reducing the QR's useful area. */
function drawMicro(
  page: DotPage,
  box: PrintRect,
  label: ThermalContent,
  dpi: number,
  profile: PrinterProfile,
  options: ThermalOptions,
  encode: Encode,
  warnings: FitWarnings,
) {
  const matrix = qrMatrix(encode, labelPayload(label, options));
  const dots = (mm: number) => mmToDots(mm, dpi);
  const pts = (pt: number) => Math.ceil((pt * dpi) / 72);
  if (!idPattern.test(label.identifier)) throw new ThermalFitError('identifier');

  const idSize = Math.min(
    pts(options.identifierPt || 8),
    Math.floor(box.w / (glyphWidth * label.identifier.length)),
  );
  if (idSize < pts(6)) throw new ThermalFitError('identifier');

  // Courier uppercase ink takes less than two thirds of its em above the baseline. Reserve
  // that band plus a gap and a bottom dot, including at the maximum supported ID length.
  const gap = Math.max(2, dots(0.45));
  const idBand = Math.ceil(idSize * 0.62) + gap + 1;
  const minimum = Math.max(3, Math.ceil((dpi * 0.3) / 25.4));
  const capacity = Math.floor(Math.min(box.w, box.h - idBand) / matrix.length);
  const preferred = Math.floor(dots(profile.qrMm ?? 15) / matrix.length);
  const identity = options.variant === 'identity';
  const quality = Math.max(minimum, Math.ceil((dpi * 0.44) / 25.4));
  const module = Math.min(capacity, identity ? capacity : Math.max(quality, preferred));
  if (module < minimum) throw new ThermalFitError('qr');
  if (module === 3) warnings.threeDotQr = true;
  const qrSize = matrix.length * module;
  const right = options.qrSide === 'right';
  const qrX = right ? box.x + box.w - qrSize : box.x;
  qrInk(page.ink, matrix, qrX, box.y, module);
  page.text.push({
    value: label.identifier,
    x: box.x,
    y: box.y + box.h - 1,
    size: idSize,
    bold: true,
  });

  const x = right ? box.x : qrX + qrSize + gap;
  const w = box.w - qrSize - gap;
  const end = box.y + box.h - idBand;
  const size = pts(6);
  const line = Math.ceil(size * 1.16);
  let y = box.y;
  const tags = [label.nfc === 'verified' ? 'NFC' : '', label.uhf ? 'UHF' : ''];
  const content = [
    ...tags,
    !identity && options.showName && label.name,
    !identity && options.showContents && label.contents,
  ];
  for (const value of content) {
    if (!value) continue;
    const text = printableText(value);
    const max = Math.floor(w / (size * glyphWidth));
    const rows = Math.floor((end - y) / line);
    if (!text || max < 3 || rows * max < text.length) {
      warnings.omittedText = true;
      continue;
    }
    for (let cursor = 0; cursor < text.length; cursor += max) {
      y += line;
      page.text.push({ value: text.slice(cursor, cursor + max).trim(), x, y, size });
    }
  }
  if (!identity && options.handwriting > 0 && w >= dots(7) && end - y >= dots(3)) {
    page.ink.push({ x, y: end - 1, w, h: 1 });
  }
}

function cutGuides(page: DotPage, geometry: ThermalGeometry) {
  const { grid, dots, printable } = geometry;
  const stroke = Math.max(1, mmToDots(0.18, geometry.dpi));
  const step = mmToDots(2.4, geometry.dpi);
  const mark = Math.floor(step / 2);
  for (let col = 1; col < grid.cols; col++) {
    const x = Math.round((col * dots.w) / grid.cols);
    if (x < printable.x || x + stroke > printable.x + printable.w) continue;
    for (let y = printable.y; y + mark <= printable.y + printable.h; y += step) {
      page.ink.push({ x, y, w: stroke, h: mark });
    }
  }
  for (let row = 1; row < grid.rows; row++) {
    const y = Math.round((row * dots.h) / grid.rows);
    if (y < printable.y || y + stroke > printable.y + printable.h) continue;
    for (let x = printable.x; x + mark <= printable.x + printable.w; x += step) {
      page.ink.push({ x, y, w: mark, h: stroke });
    }
  }
}

export function thermalDocument(
  stock: string,
  layout: ThermalLayout,
  profile: PrinterProfile,
  options: ThermalOptions,
  labels: readonly ThermalContent[],
  encode: Encode,
): ThermalDocument {
  if (
    !Number.isInteger(options.handwriting) ||
    options.handwriting < 0 ||
    options.handwriting > 6 ||
    !Number.isFinite(options.identifierPt) ||
    options.identifierPt < 0 ||
    options.identifierPt > 72 ||
    (profile.qrMm !== undefined &&
      (!Number.isFinite(profile.qrMm) || profile.qrMm < 5 || profile.qrMm > 125))
  )
    throw new ThermalFitError('settings');
  const { pages, ...size } = thermalGeometry(stock, layout, profile, labels.length);
  let index = 0;
  const warnings = { threeDotQr: false, omittedText: false };
  return {
    ...size,
    warnings,
    pages: pages.map((slots) => {
      const page: DotPage = { ink: [], text: [] };
      cutGuides(page, { ...size, pages });
      for (const slot of slots) {
        const label = labels[index++];
        if (!label) continue;
        if (stock === MICRO_THERMAL_STOCK) {
          drawMicro(page, slot.ink, label, size.dpi, profile, options, encode, warnings);
        } else if (stock === COMPACT_THERMAL_STOCK) {
          drawCompact(page, slot.ink, label, size.dpi, profile, options, encode, warnings);
        } else drawCell(page, slot.ink, label, size.dpi, profile, options, encode);
      }
      return page;
    }),
  };
}

export function calibrationDocument(
  stock: string,
  profile: PrinterProfile,
  url: string,
  encode: Encode,
): ThermalDocument {
  const { pages: slots, ...size } = thermalGeometry(stock, 'single', profile, 1);
  const box = slots[0]?.[0]?.ink;
  if (!box) throw new ThermalFitError('settings');
  const dots = (mm: number) => mmToDots(mm, size.dpi);
  const stroke = Math.max(1, dots(0.18));
  const inset = dots(Math.min(box.w, box.h) < dots(29) ? 0.65 : 1.2);
  const page: DotPage = { ink: [], text: [] };
  const sampleBox = {
    x: box.x + inset,
    y: box.y + inset,
    w: box.w - 2 * inset,
    h: box.h - 2 * inset,
  };
  const sample = {
    identifier: 'TMP-A09Z-0001',
    url,
    name: stock === MICRO_THERMAL_STOCK ? 'TOP / Sample' : 'TOP / QR sample',
  };
  const options = { ...DEFAULT_THERMAL_OPTIONS, handwriting: 0 };
  if (stock === MICRO_THERMAL_STOCK) {
    drawMicro(page, sampleBox, sample, size.dpi, profile, options, encode, {
      threeDotQr: false,
      omittedText: false,
    });
  } else if (stock === COMPACT_THERMAL_STOCK) {
    drawCompact(page, sampleBox, sample, size.dpi, profile, options, encode, {
      threeDotQr: false,
      omittedText: false,
    });
  } else drawCell(page, sampleBox, sample, size.dpi, profile, options, encode);

  const { x, y, w, h } = box;
  page.ink.push({ x, y, w, h: stroke }, { x, y: y + h - stroke, w, h: stroke });
  page.ink.push({ x, y, w: stroke, h }, { x: x + w - stroke, y, w: stroke, h });
  for (let index = 1; dots(index * 5) + stroke < w; index++) {
    page.ink.push({ x: x + dots(index * 5), y: y + h - dots(1), w: stroke, h: dots(1) });
  }
  for (let index = 1; dots(index * 5) + stroke < h; index++) {
    page.ink.push({ x: x + w - dots(1), y: y + dots(index * 5), w: dots(1), h: stroke });
  }
  // The edge ticks mark the physical center without overprinting the QR sample.
  page.ink.push({ x: x + Math.floor(w / 2), y, w: stroke, h: dots(1) });
  page.ink.push({ x, y: y + Math.floor(h / 2), w: dots(1), h: stroke });
  return { ...size, pages: [page] };
}
