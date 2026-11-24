/**
 * One printed label (D120, D134), the only way a label is drawn in HTML: the print sheet uses it
 * at its millimetre size, and the builder's sheet preview uses the same component, scaled down.
 * The QR of `<public-url>/l/<code>` with its quiet zone, the code large in Plex Mono, then the
 * name and where it lives. Always black on white, whatever the theme: it is paper. The code is
 * the chip's printed form (7KQ‑4MZ, a non-breaking hyphen) and stays left to right in every
 * language (D143); the name and place take their own direction (`dir=auto`) and the browser
 * shapes Arabic (D97). A compact stock prints the QR and code only; tape prints the code large and
 * the name, with a QR only where the tape is wide enough, the code in a column of its own where it
 * isn't (#303).
 *
 * The name and place are never cut: fit.ts wraps them into lines and steps the font down to the
 * readable minimum, and each line is set as its own block, so the preview, the print and the
 * phone PNGs break them in exactly the same places.
 *
 * Sizes are millimetres from `cellMetrics`, set through React's style prop (the CSSOM, which the
 * CSP allows; a `style` attribute in markup it would not).
 */
import type { LabelStock } from '@kept/shared';
import { useMemo } from 'react';
import type { LabelCellContent } from '@/api/capture/types';
import { FIT_LINE_HEIGHT, type FittedText, fitLabel, type TextMeasure } from './fit';
import {
  CODE_TRACKING,
  cellMetrics,
  codeChars,
  LABEL_MONO,
  LABEL_SANS,
  mm,
  PLACE_INK,
  shownCode,
} from './layout';
import { type Encode, qrMatrix, qrPath } from './qr';

export function LabelCell({
  label,
  stock,
  encode,
  measure,
}: {
  label: LabelCellContent;
  stock: LabelStock;
  /** The QR encoder; null while it loads (the square stays white until then). */
  encode: Encode | null;
  /** How the name and place are measured (`useLabelMeasure`). */
  measure: TextMeasure;
}) {
  const m = cellMetrics(stock, codeChars(label));
  const qr = useMemo(() => {
    if (!encode || m.qr === 0) return null;
    const matrix = qrMatrix(encode, label.url);
    return { d: qrPath(matrix), n: matrix.length };
  }, [encode, label.url, m.qr]);
  const fit = useMemo(() => fitLabel(stock, label, measure), [stock, label, measure]);
  const code = (
    <bdi
      dir="ltr"
      data-slot="label-code"
      className="block font-semibold whitespace-nowrap"
      style={{
        fontFamily: LABEL_MONO,
        fontSize: mm(m.code),
        lineHeight: 1,
        letterSpacing: `${CODE_TRACKING}em`,
      }}
    >
      {shownCode(label)}
    </bdi>
  );
  return (
    <div
      dir="ltr"
      data-slot="label"
      data-fits={fit.fits ? undefined : 'false'}
      data-arrange={m.stacked ? 'stacked' : undefined}
      className={
        m.stacked
          ? 'flex size-full flex-col items-center overflow-hidden bg-white text-center text-black'
          : 'flex size-full items-center overflow-hidden bg-white text-black'
      }
      style={
        m.stacked
          ? { padding: mm(m.pad), rowGap: mm(m.pad * 0.6) }
          : { padding: mm(m.pad), columnGap: mm(m.pad) }
      }
    >
      {m.qr > 0 ? (
        <svg
          aria-hidden="true"
          data-slot="label-qr"
          viewBox={qr ? `0 0 ${qr.n} ${qr.n}` : '0 0 1 1'}
          width={mm(m.qr)}
          height={mm(m.qr)}
          shapeRendering="crispEdges"
          className="shrink-0"
        >
          <rect width="100%" height="100%" fill="#FFFFFF" />
          {qr ? <path d={qr.d} fill="#000000" /> : null}
        </svg>
      ) : null}
      {m.codeColumn > 0 ? (
        // Narrow tape: the code in a column of its own, as large as the tape allows.
        <div className="shrink-0" style={{ inlineSize: mm(m.codeColumn) }}>
          {code}
        </div>
      ) : null}
      <div
        className={
          m.stacked ? 'grid min-h-0 min-w-0 justify-items-center' : 'grid min-w-0 self-stretch'
        }
        // `safe`: a label too long even at the smallest size overflows at the bottom, never
        // above the code. Stacked, the text column is the room under the QR.
        style={
          m.stacked
            ? {
                inlineSize: mm(m.text),
                blockSize: mm(m.room),
                rowGap: mm(m.pad * 0.6),
                alignContent: 'start',
              }
            : { inlineSize: mm(m.text), rowGap: mm(m.pad * 0.6), alignContent: 'safe center' }
        }
      >
        {m.codeColumn > 0 ? null : code}
        {fit.name ? <Lines slot="label-name" part={fit.name} weight={600} color="#000000" /> : null}
        {fit.path ? (
          <Lines slot="label-place" part={fit.path} weight={400} color={PLACE_INK} />
        ) : null}
      </div>
    </div>
  );
}

/** A name or place as its fitted lines, one block each, so the browser never breaks them again. */
function Lines({
  slot,
  part,
  weight,
  color,
}: {
  slot: string;
  part: FittedText;
  weight: 400 | 600;
  color: string;
}) {
  return (
    <p
      dir="auto"
      data-slot={slot}
      className="m-0"
      style={{
        fontFamily: LABEL_SANS,
        fontSize: mm(part.size),
        fontWeight: weight,
        lineHeight: FIT_LINE_HEIGHT,
        color,
      }}
    >
      {part.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line is its position
        <span key={i} className="block whitespace-nowrap">
          {line}
        </span>
      ))}
    </p>
  );
}
