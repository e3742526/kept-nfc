/**
 * Labels as PNGs made on the phone (D44, D185), for label-printer apps that take an
 * image: one PNG per label at 300 dpi of the stock's cell, shared together through the share
 * sheet where the browser can share files, downloaded otherwise.
 *
 * The same geometry as the print sheet (`cellMetrics`) and the same lines (`fitLabel`). QR modules are filled rectangles on a
 * whole-pixel grid; text is `fillText`, so the canvas shapes Arabic, after the Plex faces have
 * loaded (a canvas never waits for a font on its own). `drawLabel` takes any 2D context, so a
 * test can rasterise it without a canvas.
 */
import type { LabelStock } from '@kept/shared';
import type { LabelCellContent } from '@/api/capture/types';
import { canShareFiles, downloadsWork, saveFile, shareFiles } from '@/lib/files';
import { FIT_LINE_HEIGHT, fitLabel, loadLabelFaces, type TextMeasure } from './fit';
import {
  type CellMetrics,
  CODE_TRACKING,
  captionText,
  cellMetrics,
  codeChars,
  directionOfText,
  LABEL_MONO,
  LABEL_SANS,
  PLACE_INK,
  RULE_INK,
  RULE_WIDTH,
  shownCode,
} from './layout';
import { loadQr, qrMatrix } from './qr';

export const PNG_DPI = 300;

export const pxOf = (millimetres: number) => Math.round((millimetres / 25.4) * PNG_DPI);

/** The PNG's size in pixels: the cell at 300 dpi. */
export function labelPixelSize(stock: LabelStock): { width: number; height: number } {
  return { width: pxOf(stock.cell.w), height: pxOf(stock.cell.h) };
}

/** What `drawLabel` uses of a canvas context. */
export type LabelContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'font' | 'fillStyle' | 'textAlign' | 'textBaseline'
> & { direction: CanvasDirection; letterSpacing?: string };

/** The code, its characters 0.06 em apart as on the HTML label: through the canvas's
 * `letterSpacing` where the browser has it, else one character at a time (the code is Latin in a
 * monospaced face, so nothing is lost drawing it that way). */
function fillCode(ctx: LabelContext, text: string, x: number, y: number, size: number) {
  const spacing = size * CODE_TRACKING;
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(text, x, y);
    ctx.letterSpacing = '0px';
    return;
  }
  let pen = x;
  for (const ch of text) {
    ctx.fillText(ch, pen, y);
    pen += ctx.measureText(ch).width + spacing;
  }
}

/** Draws one label: white ground, the QR (if the stock has one), the code, and the name and
 * place where the stock prints them. `caption` is the "Contents" word a write-in label with no
 * name prints, in the person's language. */
export function drawLabel(
  ctx: LabelContext,
  stock: LabelStock,
  label: LabelCellContent,
  matrix: readonly (readonly boolean[])[],
  caption = 'Contents',
) {
  const { width, height } = labelPixelSize(stock);
  const m = cellMetrics(stock, codeChars(label));
  if (m.ruled) {
    drawRuled(ctx, stock, label, matrix, m, m.ruled, captionText(caption));
    return;
  }
  const pad = pxOf(m.pad);
  const shown = shownCode(label);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // The QR on whole pixels per module, centred in its square, so no module blurs. Narrow tape has
  // none: the code takes its place, in a column of its own.
  const side = pxOf(m.qr);
  if (m.qr > 0) {
    const n = matrix.length;
    const unit = Math.max(1, Math.floor(side / n));
    // Stacked: centred across the top. Else beside the text, centred down the label.
    const qx = m.stacked
      ? Math.floor((width - unit * n) / 2)
      : pad + Math.floor((side - unit * n) / 2);
    const qy = m.stacked ? pad : Math.floor((height - unit * n) / 2);
    ctx.fillStyle = '#000000';
    matrix.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) ctx.fillRect(qx + x * unit, qy + y * unit, unit, unit);
      });
    });
  }

  const beside = m.codeColumn > 0;
  const x0 = m.stacked ? pad : beside ? pad + pxOf(m.codeColumn) + pad : pad + side + pad;
  const textWidth = pxOf(m.text);
  const code = pxOf(m.code);
  type Block = {
    lines: string[];
    step: number;
    font: string;
    color: string;
    rtl: boolean;
    code?: boolean;
  };
  const blocks: Block[] = [];
  ctx.textBaseline = 'top';
  ctx.font = `600 ${code}px ${LABEL_MONO}`;
  const codeBlock: Block = {
    lines: [shown],
    step: code,
    font: ctx.font,
    color: '#000000',
    rtl: false,
    code: true,
  };
  if (beside) {
    ctx.fillStyle = '#000000';
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    fillCode(ctx, shown, pad, Math.round((height - code) / 2), code);
  } else blocks.push(codeBlock);
  // The same lines and sizes as the HTML label (fit.ts), measured on this canvas.
  const measure: TextMeasure = (text, size, weight = 600) => {
    ctx.font = `${weight} 100px ${LABEL_SANS}`;
    return (ctx.measureText(text).width / 100) * size;
  };
  const fit = fitLabel(stock, label, measure);
  for (const [part, text, weight, color] of [
    [fit.name, label.name, 600, '#000000'],
    [fit.path, label.path, 400, PLACE_INK],
  ] as const) {
    if (!part || !text) continue;
    const size = pxOf(part.size);
    blocks.push({
      lines: part.lines,
      step: Math.round(size * FIT_LINE_HEIGHT),
      font: `${weight} ${size}px ${LABEL_SANS}`,
      color,
      rtl: directionOfText(text) === 'rtl',
    });
  }

  // Centred as a block beside the QR, like the HTML label; stacked, centred under the QR.
  const gap = Math.round(pad * 0.6);
  const total =
    blocks.reduce((sum, b) => sum + b.step * b.lines.length, 0) +
    gap * Math.max(0, blocks.length - 1);
  let y = m.stacked ? pad + side + gap : Math.max(pad, Math.round((height - total) / 2));
  for (const b of blocks) {
    ctx.font = b.font;
    ctx.fillStyle = b.color;
    ctx.direction = b.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = m.stacked ? 'center' : b.rtl ? 'right' : 'left';
    const x = m.stacked ? x0 + textWidth / 2 : b.rtl ? x0 + textWidth : x0;
    for (const line of b.lines) {
      // The code's tracking is drawn a character at a time without `letterSpacing`, from the
      // left: centred, it starts half its width before the middle.
      if (b.code && m.stacked) {
        ctx.textAlign = 'left';
        const w = ctx.measureText(line).width + code * CODE_TRACKING * (line.length - 1);
        fillCode(ctx, line, Math.round(x - w / 2), y, code);
        ctx.textAlign = 'center';
      } else if (b.code) fillCode(ctx, line, x, y, code);
      else ctx.fillText(line, x, y);
      y += b.step;
    }
    y += gap;
  }
}

/** The QR on whole pixels per module, centred in its `side`-pixel square at (x, y). */
function drawQr(
  ctx: LabelContext,
  matrix: readonly (readonly boolean[])[],
  x: number,
  y: number,
  side: number,
) {
  const n = matrix.length;
  if (n === 0) return;
  const unit = Math.max(1, Math.floor(side / n));
  const qx = x + Math.floor((side - unit * n) / 2);
  const qy = y + Math.floor((side - unit * n) / 2);
  ctx.fillStyle = '#000000';
  matrix.forEach((row, my) => {
    row.forEach((on, mx) => {
      if (on) ctx.fillRect(qx + mx * unit, qy + my * unit, unit, unit);
    });
  });
}

/** A write-in label, as `LabelCell` places it: the code, then the name and place or "Contents"
 * over a short line, the QR at the top right, and the lines to write on. */
function drawRuled(
  ctx: LabelContext,
  stock: LabelStock,
  label: LabelCellContent,
  matrix: readonly (readonly boolean[])[],
  m: CellMetrics,
  ruled: NonNullable<CellMetrics['ruled']>,
  caption: string,
) {
  const { width, height } = labelPixelSize(stock);
  const pad = pxOf(m.pad);
  const side = pxOf(m.qr);
  const textWidth = pxOf(m.text);
  const gap = Math.round(pad * 0.6);
  const stroke = Math.max(1, pxOf(RULE_WIDTH));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  drawQr(ctx, matrix, width - pad - side, pad, side);

  ctx.textBaseline = 'top';
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  const code = pxOf(m.code);
  ctx.font = `600 ${code}px ${LABEL_MONO}`;
  ctx.fillStyle = '#000000';
  fillCode(ctx, shownCode(label), pad, pad, code);
  let y = pad + code + gap;

  const measure: TextMeasure = (text, size, weight = 600) => {
    ctx.font = `${weight} 100px ${LABEL_SANS}`;
    return (ctx.measureText(text).width / 100) * size;
  };
  const fit = fitLabel(stock, label, measure);
  for (const [part, text, weight, color] of [
    [fit.name, label.name, 600, '#000000'],
    [fit.path, label.path, 400, PLACE_INK],
  ] as const) {
    if (!part || !text) continue;
    const size = pxOf(part.size);
    const rtl = directionOfText(text) === 'rtl';
    ctx.font = `${weight} ${size}px ${LABEL_SANS}`;
    ctx.fillStyle = color;
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    for (const line of part.lines) {
      ctx.fillText(line, rtl ? pad + textWidth : pad, y);
      y += Math.round(size * FIT_LINE_HEIGHT);
    }
    y += gap;
  }
  if (!fit.name && !fit.path) {
    ctx.font = `400 ${pxOf(ruled.caption)}px ${LABEL_SANS}`;
    ctx.fillStyle = '#000000';
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillText(caption, pad, y);
    ctx.fillStyle = RULE_INK;
    ctx.fillRect(pad, pxOf(ruled.blank), textWidth, stroke);
  }
  ctx.fillStyle = RULE_INK;
  for (const r of ruled.rules) ctx.fillRect(pad, pxOf(r), width - 2 * pad, stroke);
}

/** One PNG file per label, named by its code; `caption` as `drawLabel` takes it. */
export async function labelPngs(
  stock: LabelStock,
  labels: readonly LabelCellContent[],
  caption?: string,
): Promise<File[]> {
  const [encode] = await Promise.all([loadQr(), loadLabelFaces()]);
  const { width, height } = labelPixelSize(stock);
  const files: File[] = [];
  for (const label of labels) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    drawLabel(ctx, stock, label, qrMatrix(encode, label.url), caption);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob gave nothing');
    files.push(new File([blob], `kept-${label.alias ?? label.code}.png`, { type: 'image/png' }));
  }
  return files;
}

/**
 * Hands the PNGs to the share sheet (a label-printer app, Files, Messages) where the browser can
 * share files; otherwise downloads them. 'cancelled' when the person closed the share sheet,
 * 'refused' when the browser wouldn't share and can't download either (an installed iPhone app,
 * lib/files.ts). Pass files made before the press: iOS refuses a share that waited on them.
 */
export async function shareOrDownload(
  files: File[],
  title: string,
): Promise<'shared' | 'downloaded' | 'cancelled' | 'refused'> {
  if (canShareFiles(files)) {
    const how = await shareFiles(files, title);
    if (how !== 'refused') return how;
    // Refused for another reason (too many files, say): download them where that works.
  }
  if (!downloadsWork()) return 'refused';
  for (const file of files) saveFile(file);
  return 'downloaded';
}
