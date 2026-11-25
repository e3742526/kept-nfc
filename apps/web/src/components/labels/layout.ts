/**
 * Where each label goes and how big its parts are (D44, D134, D175, D185). Pure, so the
 * print sheet (sheet.tsx), the builder's preview and the phone PNG (png.ts) share one geometry
 * and the tests can pin it per stock.
 *
 * All lengths are millimetres. A sheet is physical paper: its cells run left to right from the
 * top-left corner in every language, like the maker's numbering, so the sheet is laid out LTR
 * and only the names inside a label follow their own direction (`dir=auto`, D97).
 */
import {
  cellsFor,
  hasQr,
  isRuled,
  isSheet,
  isStacked,
  isTape,
  type LabelCell,
  type LabelStock,
  PRINTED_CODE_HYPHEN,
  printedCode,
} from '@kept/shared';
import type { LabelCellContent } from '@/api/capture/types';

/** The label's faces: Plex Sans with Plex Sans Arabic for Arabic names (D97), Plex Mono for codes. */
export const LABEL_SANS = '"IBM Plex Sans", "IBM Plex Sans Arabic", sans-serif';
export const LABEL_MONO = '"IBM Plex Mono", monospace';

/** A CSS length in millimetres, rounded to a hundredth so snapshots stay readable. */
export const mm = (n: number) => `${Math.round(n * 100) / 100}mm`;

/** CSS pixels per millimetre (96 per inch). */
export const PX_PER_MM = 96 / 25.4;

/** The paper by name where it has one, so the print dialog picks that paper itself. */
function pageSize(stock: LabelStock): string {
  const { w, h } = stock.page;
  if (w === 210 && h === 297) return 'A4';
  if (w === 215.9 && h === 279.4) return 'letter';
  return `${mm(w)} ${mm(h)}`;
}

/**
 * The one `@page` rule a print view installs for its stock: the paper, and no margin, so the
 * browser's default settings (Margins "Default", scale 100 %) print each label in its cell.
 */
export function pageCss(stock: LabelStock): string {
  return `@page { size: ${pageSize(stock)}; margin: 0; }`;
}

export type PlacedLabel = { label: LabelCellContent; cell: LabelCell };

/**
 * The labels on their pages, from `startCell` (1-based, sheets only; a roll ignores it). Pages
 * with no label are never produced, so a start cell near the end of a sheet can't print a blank
 * page first.
 */
export function placeLabels(
  stock: LabelStock,
  labels: readonly LabelCellContent[],
  startCell = 1,
): PlacedLabel[][] {
  const { pages, cells } = cellsFor(stock, labels.length, isSheet(stock) ? startCell : 1);
  const out: PlacedLabel[][] = Array.from({ length: pages }, () => []);
  cells.forEach((cell, i) => {
    const label = labels[i];
    if (label) out[cell.page]?.push({ label, cell });
  });
  return out;
}

/** Cells per page: 1 on a roll. */
export const perPage = (stock: LabelStock) => stock.cols * stock.rows;

/** The pages `count` labels take from `startCell`, without placing them. */
export function pagesFor(stock: LabelStock, count: number, startCell = 1): number {
  if (count <= 0) return 0;
  const offset = isSheet(stock) ? startCell - 1 : 0;
  return Math.ceil((offset + count) / perPage(stock));
}

/** "Row 4, column 1" for a 1-based cell on a sheet. */
export function rowColOf(stock: LabelStock, cell: number): { row: number; col: number } {
  return { row: Math.floor((cell - 1) / stock.cols) + 1, col: ((cell - 1) % stock.cols) + 1 };
}

export type CellMetrics = {
  /** Inner padding on every side. */
  pad: number;
  /** The QR's side, quiet zone included; 0 on tape too narrow for one. */
  qr: number;
  /**
   * On tape with no QR, the code's own column, before the text column; 0 where the code sits at
   * the top of the text column.
   */
  codeColumn: number;
  /** The text column's width, beside the QR (or the code). */
  text: number;
  /**
   * Font sizes (the em box): the code; the name and the place they start at, before a long one
   * steps down towards `NAME_MIN` and `PATH_MIN` (fit.ts).
   */
  code: number;
  name: number;
  path: number;
  /** A compact stock prints only the QR and the code. */
  compact: boolean;
  /** Whether the place prints: not on a compact stock, nor on tape. */
  place: boolean;
  /** The QR on top, the code and text centred under it (`arrange: 'stacked'`). */
  stacked: boolean;
  /**
   * The text column's height: the label's, less the padding, and less the QR when stacked; on a
   * write-in label, the QR's (the column beside it).
   */
  room: number;
  /**
   * A write-in label (`arrange: 'ruled'`): the code at the top of the text column, the QR at the
   * end of the label, and full-width lines under them. `rules`: the lines' distances from the
   * label's top. A label with no name yet prints the "Contents" word under the code, `caption`
   * large, over a short line `blank` from the top, the text column wide. Null on other stocks.
   */
  ruled: { rules: readonly number[]; caption: number; blank: number } | null;
};

/**
 * What a label prints as its code: a numbered label's alias, else the short ID's printed form,
 * both with non-breaking hyphens so they never wrap.
 */
export function shownCode(label: Pick<LabelCellContent, 'code' | 'alias'>): string {
  return label.alias ? label.alias.replaceAll('-', PRINTED_CODE_HYPHEN) : printedCode(label.code);
}

/** How many characters the printed code is: a short ID's 7, a numbered label's 13. */
export const codeChars = (label: { alias?: string }): number =>
  label.alias ? label.alias.length : 7;

/** The smallest name and place a label sets, in mm (about 6.2 pt and 5.7 pt): still readable. */
export const NAME_MIN = 2.2;
export const PATH_MIN = 2.0;

/** The place line's ink: near-black, so it reads on paper. */
export const PLACE_INK = '#222222';

/** The space between the code's characters, in em: the HTML label and the PNG both set it. */
export const CODE_TRACKING = 0.06;

/** Plex Mono's advance is 0.6 em, set 0.06 em apart: the code's width in em, `chars` long (7 for
 * a short ID with its hyphen, 13 for a numbered label). */
const codeEm = (chars = 7) => chars * 0.66;
const CODE_EM = codeEm();

/** Down to a hundredth of a millimetre, so the CSS sets exactly the size the fit worked with. */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

/**
 * The parts of one label, scaled from the designs' 40 × 30 mm label (D134: QR, the code large in
 * mono, the name, the place). The code never wraps: it shrinks to fit the text column. The name
 * starts at about a tenth of the label's height (never larger than four fifths of the code), the
 * place at four fifths of the name; fit.ts steps both down when a long one needs it.
 */
export function cellMetrics(stock: LabelStock, codeChars = 7): CellMetrics {
  if (isTape(stock)) return tapeMetrics(stock, codeChars);
  if (isStacked(stock)) return stackedMetrics(stock, codeChars);
  if (isRuled(stock)) return ruledMetrics(stock, codeChars);
  const { w, h } = stock.cell;
  const pad = Math.max(1.5, h * 0.06);
  const qr = Math.min(h - 2 * pad, w * 0.48);
  const text = Math.max(0, w - qr - 3 * pad);
  const compact = stock.content === 'compact';
  const code = Math.min(h * (compact ? 0.16 : 0.13), text / codeEm(codeChars));
  const name = floor2(Math.max(NAME_MIN, Math.min(h * 0.095, code * 0.8)));
  return {
    pad,
    qr,
    codeColumn: 0,
    text,
    code,
    name,
    path: floor2(Math.max(PATH_MIN, name * 0.8)),
    compact,
    place: !compact,
    stacked: false,
    ruled: null,
    room: h - 2 * pad,
  };
}

/**
 * Square and near-square labels (inch rolls): the QR on top, as wide as the label allows, the code
 * centred under it, and on a full stock the name and place under that. A full label keeps about a
 * fifth of its height for the name, so the QR is never the whole label; the code is sized to the
 * label's width, so a 13-character numbered label stays readable on a 1-inch label (about 7 pt).
 */
function stackedMetrics(stock: LabelStock, codeChars: number): CellMetrics {
  const { w, h } = stock.cell;
  const pad = Math.max(1.2, h * 0.05);
  const gap = pad * 0.6;
  const inner = w - 2 * pad;
  const compact = stock.content === 'compact';
  const code = Math.min(h * 0.1, inner / codeEm(codeChars));
  const words = compact ? 0 : h * 0.22 + gap;
  const qr = Math.max(0, Math.min(inner, h - 2 * pad - gap - code - words));
  const name = floor2(Math.max(NAME_MIN, Math.min(h * 0.07, code * 0.8)));
  return {
    pad,
    qr,
    codeColumn: 0,
    text: inner,
    code,
    name,
    path: floor2(Math.max(PATH_MIN, name * 0.8)),
    compact,
    place: !compact,
    stacked: true,
    ruled: null,
    room: h - 2 * pad - qr - gap,
  };
}

/** The write-in lines' ink and weight (0.45 pt): grey, so handwriting reads over them. */
export const RULE_INK = '#8C8C8C';
export const RULE_WIDTH = 0.16;

/** The "Contents" word as a write-in label prints it: in capitals, where the script has them. */
export const captionText = (caption: string) => caption.toLocaleUpperCase();

/**
 * A write-in label (the OL330 sheet's 2-inch squares): the code at the top left, the QR at the top
 * right (two fifths of the label, quiet zone included), and under them lines a hand-width apart
 * (6.7 mm on 2 inches, a little under college ruling) down to the label's foot. Taken from a sheet
 * laid out for the stock. With no name, "Contents" and a short line sit under the code; with
 * one, the name and place take their place, fitted beside the QR.
 */
function ruledMetrics(stock: LabelStock, codeChars: number): CellMetrics {
  const { w, h } = stock.cell;
  const pad = Math.max(1.5, w * 0.055);
  const qr = w * 0.4;
  const text = Math.max(0, w - qr - 3 * pad);
  const code = Math.min(h * 0.073, text / codeEm(codeChars));
  const name = floor2(Math.max(NAME_MIN, Math.min(h * 0.06, code * 0.8)));
  const step = h * 0.132;
  const rules: number[] = [];
  for (let y = h - 1.4 * pad; y >= pad + qr + step / 2; y -= step) rules.unshift(floor2(y));
  return {
    pad,
    qr,
    codeColumn: 0,
    text,
    code,
    name,
    path: floor2(Math.max(PATH_MIN, name * 0.8)),
    compact: false,
    place: true,
    stacked: false,
    room: qr,
    ruled: { rules, caption: floor2(h * 0.0486), blank: floor2(pad + qr * 0.77) },
  };
}

/**
 * Tape (#303): the label is a band across the tape (three quarters of narrow tape, 18 mm of
 * 24 mm tape, as an 18 mm print head prints it), and the code is set large in it, since the code
 * is what is read on tape: by eye, and by the scanner from its printed text where there is no QR.
 * Narrow tape (no QR): the code fills most of the band's height in a column of its own, the name
 * beside it. Wide tape: the QR fills the band, the code and the name beside it, as on a roll.
 * The place never prints on tape.
 */
function tapeMetrics(stock: LabelStock, codeChars: number): CellMetrics {
  const { w, h } = stock.cell;
  const pad = h <= 12 ? h * 0.125 : Math.max(1.5, (h - 18) / 2);
  const band = h - 2 * pad;
  if (hasQr(stock)) {
    const qr = band;
    const text = Math.max(0, w - qr - 3 * pad);
    const code = Math.min(band * 0.42, text / codeEm(codeChars));
    const name = floor2(Math.max(NAME_MIN, Math.min(band * 0.2, code * 0.6)));
    return {
      pad,
      qr,
      codeColumn: 0,
      text,
      code,
      name,
      path: PATH_MIN,
      compact: false,
      place: false,
      stacked: false,
      ruled: null,
      room: h - 2 * pad,
    };
  }
  const code = band * 0.62 * Math.min(1, CODE_EM / codeEm(codeChars));
  const codeColumn = code * codeEm(codeChars);
  const text = Math.max(0, w - codeColumn - 3 * pad);
  const name = floor2(Math.max(NAME_MIN, Math.min(band * 0.4, code * 0.6)));
  return {
    pad,
    qr: 0,
    codeColumn,
    text,
    code,
    name,
    path: PATH_MIN,
    compact: false,
    place: false,
    stacked: false,
    ruled: null,
    room: h - 2 * pad,
  };
}

/** The name's direction for the canvas (the HTML uses `dir=auto`): its first strong letter's. */
export function directionOfText(text: string): 'ltr' | 'rtl' {
  const m = text.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]|[֐-ࣿיִ-﷿ﹰ-﻿]/);
  return m && /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(m[0]) ? 'rtl' : 'ltr';
}
