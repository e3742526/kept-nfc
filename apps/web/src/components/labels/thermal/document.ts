import {
  COMPACT_THERMAL_STOCK,
  MICRO_THERMAL_STOCK,
  type PrinterProfile,
  type PrintRect,
  parseScan,
  supportsDrawerTemplate,
  type ThermalGeometry,
  type ThermalLayout,
  thermalGeometry,
  type WorkshopIcon,
} from '@kept/shared';
import JsBarcode from 'jsbarcode';
import { type Encode, QUIET_ZONE, qrMatrix } from '../qr';
import { suggestWorkshopIcon, workshopInk } from './workshop-icons';

export type ThermalContent = {
  identifier: string;
  url: string;
  name?: string | undefined;
  location?: string | undefined;
  contents?: string | undefined;
  category?: string | undefined;
  drawerContents?: string | undefined;
  drawerPosition?: string | undefined;
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
  template?: 'drawer' | undefined;
  workshopIcon?: WorkshopIcon | 'none' | undefined;
  iconPlacement?: 'beside' | 'embedded' | undefined;
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
type FitWarnings = {
  threeDotQr: boolean;
  omittedText: boolean;
  separateIcon?: boolean;
  omittedIcon?: boolean;
  standardTemplate?: boolean;
};
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
    .replace(/[^\x20-\x7E\u00b7]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fitOptional(value: string, width: number, size: number): string {
  return printableText(value)
    .slice(0, Math.max(0, Math.floor(width / (size * glyphWidth))))
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
  const tags = [options.showNfc && label.nfc === 'verified' ? 'NFC' : '', label.uhf ? 'UHF' : '']
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

function wrapDrawerTitle(value: string, width: number, size: number, rows: number): string[] {
  const columns = Math.floor(width / (size * glyphWidth));
  if (columns < 1) return [];
  const result: string[] = [];
  let rest = value;
  while (rest && result.length < rows) {
    if (rest.length <= columns) {
      result.push(rest);
      return result;
    }
    const wordEnd = rest.lastIndexOf(' ', columns);
    if (wordEnd <= 0) return [];
    result.push(rest.slice(0, wordEnd));
    rest = rest.slice(wordEnd).trimStart();
  }
  return rest ? [] : result;
}

function drawDrawer(
  page: DotPage,
  box: PrintRect,
  label: ThermalContent,
  dpi: number,
  profile: PrinterProfile,
  options: ThermalOptions,
  encode: Encode,
  warnings: FitWarnings,
) {
  const dots = (mm: number) => mmToDots(mm, dpi);
  const pts = (pt: number) => Math.ceil((pt * dpi) / 72);
  const compact = box.h < dots(29);
  const gap = dots(compact ? 1.1 : 2.5);
  const id = label.identifier;
  if (!idPattern.test(id)) throw new ThermalFitError('identifier');
  const minIdSize = pts(compact ? 6 : 8);
  const idEmWidth = id.length * glyphWidth;
  const maxQr = Math.min(box.h, box.w - gap - Math.ceil(idEmWidth * minIdSize));
  const preferredQr = dots(profile.qrMm ?? (compact ? 17 : box.w < dots(65) ? 22 : 38));
  const payload = labelPayload(label, options);
  const minModule = Math.max(3, Math.ceil((dpi * 0.3) / 25.4));
  const icon =
    options.workshopIcon === 'none'
      ? null
      : (options.workshopIcon ??
        suggestWorkshopIcon(
          id,
          label.category ?? '',
          label.contents ?? '',
          label.drawerContents ?? '',
          label.name ?? '',
        ));
  let matrix = qrMatrix(encode, payload);
  const moduleFor = (side: number, minimum: number) =>
    Math.min(Math.floor(maxQr / side), Math.max(minimum, Math.round(preferredQr / side)));
  let module = moduleFor(matrix.length, minModule);
  let embedded = false;
  if (icon && options.iconPlacement === 'embedded') {
    try {
      // Versions 2–6 keep the centered patch clear of finder, format and alignment patterns.
      const stronger = encode(payload, {
        ecc: 'H',
        border: QUIET_ZONE,
        minVersion: 2,
        maxVersion: 6,
      }).data;
      const embeddedMinimum = Math.max(4, minModule);
      const strongModule = moduleFor(stronger.length, embeddedMinimum);
      if (strongModule >= embeddedMinimum && stronger.length <= 41 + 2 * QUIET_ZONE) {
        matrix = stronger;
        module = strongModule;
        embedded = true;
      }
    } catch {
      // The plain code above still uses the exact payload if it cannot fit in versions 2–6 at H.
    }
  }
  if (module < minModule) throw new ThermalFitError('qr');
  warnings.threeDotQr ||= module === 3;
  const qrSize = matrix.length * module;
  const qx = box.x;
  const qy = box.y + (compact ? Math.floor((box.h - qrSize) / 2) : 0);
  const center = Math.floor(matrix.length / 2);
  if (embedded) {
    for (const row of matrix.slice(center - 3, center + 4)) row.fill(false, center - 3, center + 4);
  }
  qrInk(page.ink, matrix, qx, qy, module);
  if (embedded && icon) {
    workshopInk(page.ink, icon, {
      x: qx + (center - 2) * module,
      y: qy + (center - 2) * module,
      w: 5 * module,
      h: 5 * module,
    });
  }

  const x = qx + qrSize + gap;
  const w = box.x + box.w - x;
  const small = pts(compact ? 6 : 8);
  const tagParts = [
    options.showNfc && label.nfc === 'verified' ? 'NFC' : '',
    label.uhf ? 'UHF' : '',
  ].filter(Boolean);
  const tags = tagParts.join(' / ');
  const position = options.showLocation ? printableText(label.drawerPosition ?? '') : '';
  const metadata = [position, tags].filter(Boolean).join(', ');
  const fits = (text: string) => !!text && text.length * small * glyphWidth <= w;
  const footer = fits(metadata)
    ? [metadata]
    : [...(fits(tags) ? [tags] : tagParts), position].filter(fits).slice(0, 2);
  const bottom = box.y + Math.min(box.h, Math.max(qrSize, dots(compact ? 17 : 34))) - 1;
  const footerAdvance = small + Math.floor(gap / 2);
  while (footer.length && minIdSize + footer.length * footerAdvance + gap > bottom - box.y)
    footer.pop();
  const idBaseline = bottom - footer.length * footerAdvance - (footer.length ? gap : 0);
  const idSize = Math.min(
    pts(options.identifierPt || (compact ? 8 : 12)),
    Math.floor(w / idEmWidth),
    idBaseline - box.y,
  );
  if (idSize < minIdSize) throw new ThermalFitError('identifier');
  if (!footer.includes(metadata)) {
    warnings.omittedText ||=
      Boolean(position && !footer.includes(position)) ||
      (!footer.includes(tags) && tagParts.some((tag) => !footer.includes(tag)));
  }
  page.text.push({ value: id, x, y: idBaseline, size: idSize });
  footer.forEach((value, index) => {
    page.text.push({
      value,
      x,
      y: bottom - (footer.length - index - 1) * footerAdvance,
      size: small,
    });
  });

  const preferredIconSize = icon && !embedded ? dots(compact ? 5.5 : 8) : 0;
  const maxTitleHeight = idBaseline - idSize - box.y - gap;
  const iconBelowQr =
    !compact &&
    box.w < dots(65) &&
    qy + qrSize + gap + preferredIconSize <= bottom &&
    qrSize >= preferredIconSize;
  const availableIconSize = iconBelowQr
    ? preferredIconSize
    : Math.min(preferredIconSize, maxTitleHeight, w);
  const iconSize = availableIconSize >= Math.max(9, dots(3)) ? availableIconSize : 0;
  if (preferredIconSize && !iconSize) warnings.omittedIcon = true;
  else if (iconSize && options.iconPlacement === 'embedded') warnings.separateIcon = true;
  const titleWidth = w - (iconSize && !iconBelowQr ? iconSize + gap : 0);
  if (icon && iconSize) {
    workshopInk(page.ink, icon, {
      x: iconBelowQr ? qx + Math.floor((qrSize - iconSize) / 2) : x + w - iconSize,
      y: iconBelowQr ? qy + qrSize + gap : box.y,
      w: iconSize,
      h: iconSize,
    });
  }
  const titleValue =
    (options.showContents && (label.drawerContents || label.contents)) ||
    (options.showName && label.name) ||
    '';
  const title = printableText(titleValue);
  warnings.omittedText ||= !!titleValue.trim() && !title;
  let titleBottom = box.y;
  if (title) {
    const minTitleSize = pts(compact ? 7 : 10);
    let size = pts(compact ? 11 : 20);
    let lines: string[] = [];
    for (; size >= minTitleSize; size--) {
      const advance = Math.ceil(size * 1.15);
      const rows = Math.min(2, Math.floor(maxTitleHeight / advance));
      lines = wrapDrawerTitle(title, titleWidth, size, rows);
      if (lines.length) break;
    }
    if (!lines.length) {
      const fitted = fitOptional(title, titleWidth - 3 * minTitleSize * glyphWidth, minTitleSize);
      if (fitted && maxTitleHeight >= Math.ceil(minTitleSize * 1.15)) lines = [`${fitted}...`];
      size = minTitleSize;
      warnings.omittedText = true;
    }
    for (const line of lines) {
      titleBottom += Math.ceil(size * 1.15);
      page.text.push({ value: line, x, y: titleBottom, size, bold: true });
    }
  }
  const handwritingHeight = dots(compact ? 3.2 : box.h >= dots(85) ? 10 : 7);
  const writingTop = Math.max(bottom + gap, titleBottom + gap);
  const rows = Math.min(
    options.handwriting,
    Math.floor((box.y + box.h - writingTop) / handwritingHeight),
  );
  for (let row = 1; row <= rows; row++) {
    page.ink.push({
      x: compact ? x : box.x,
      y: writingTop + row * handwritingHeight - 1,
      w: compact ? w : box.w,
      h: 1,
    });
  }
  if (
    compact &&
    options.handwriting > 0 &&
    maxTitleHeight >= Math.max(iconSize, titleBottom - box.y) + handwritingHeight
  ) {
    page.ink.push({ x, y: box.y + maxTitleHeight - 1, w, h: 1 });
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
  const draw = options.template === 'drawer' ? drawDrawer : drawCell;
  if (profile.orientation === 'portrait') {
    draw(page, box, label, dpi, profile, options, encode, warnings);
    return;
  }

  // Rotate the horizontal design as a unit so the full label fits the same physical stock.
  const drawing: DotPage = { ink: [], text: [] };
  draw(drawing, { x: 0, y: 0, w: box.h, h: box.w }, label, dpi, profile, options, encode, warnings);
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
  const tags = [options.showNfc && label.nfc === 'verified' ? 'NFC' : '', label.uhf ? 'UHF' : ''];
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
  const warnings: FitWarnings = { threeDotQr: false, omittedText: false };
  if (options.template === 'drawer' && !supportsDrawerTemplate(stock)) {
    // A cross-stock reprint still uses the original payload and ID.
    warnings.standardTemplate = true;
    options = { ...options, template: undefined };
  }
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
        } else if (options.template === 'drawer') {
          drawDrawer(page, slot.ink, label, size.dpi, profile, options, encode, warnings);
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
