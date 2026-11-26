import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { canShareFiles, saveFile, shareFiles } from '@/lib/files';
import type { DotPage, ThermalDocument } from './document';

function Page({ doc, page }: { doc: ThermalDocument; page: DotPage }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${doc.dots.w} ${doc.dots.h}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      direction="ltr"
      aria-hidden
    >
      <path fill="#fff" d={`M0 0H${doc.dots.w}V${doc.dots.h}H0Z`} />
      <path
        fill="#000"
        shapeRendering="crispEdges"
        d={page.ink.map(({ x, y, w, h }) => `M${x} ${y}h${w}v${h}h-${w}Z`).join('')}
      />
      {page.text.map(({ value, x, y, size, bold, rotate }, i) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: text at a position on a fixed page
          key={i}
          x={x}
          y={y}
          fill="#000"
          fontFamily="Courier New, monospace"
          fontSize={size}
          transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
          fontWeight={bold ? 700 : 400}
          textLength={value.length * size * 0.6}
          lengthAdjust="spacingAndGlyphs"
        >
          {value}
        </text>
      ))}
    </svg>
  );
}

export function ThermalPreview({ doc }: { doc: ThermalDocument }) {
  const { t } = useLingui();
  const page = doc.pages[0];
  return page ? (
    <div
      role="img"
      aria-label={t`Thermal label preview`}
      className="mx-auto w-full max-w-72 overflow-hidden rounded border border-line bg-white"
      style={{ aspectRatio: doc.mm.w / doc.mm.h }}
    >
      <Page doc={doc} page={page} />
    </div>
  ) : null;
}

/** Reuses the browser's print dialog and system queues. No inline CSS under the app's CSP. */
export function BrowserPrintPages({ doc }: { doc: ThermalDocument }) {
  const { w, h } = doc.mm;
  useEffect(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      @page { size: ${w}mm ${h}mm; margin: 0 }
      @media print {
        html, body { margin: 0 !important; padding: 0 !important; background: white !important }
        body > :not(#kept-thermal-pages) { display: none !important }
        #kept-thermal-pages { display: block !important }
        #kept-thermal-pages > div { width: ${w}mm; height: ${h - 0.1}mm; break-inside: avoid; }
        #kept-thermal-pages > div:not(:first-child) { break-before: page }
      }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet);
    };
  }, [w, h]);
  return createPortal(
    <div id="kept-thermal-pages" className="hidden" aria-hidden>
      {doc.pages.map((page, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a page is its position
        <div key={index}>
          <Page doc={doc} page={page} />
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function canBrowserPrint() {
  return (
    typeof window.print === 'function' &&
    typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
    'adoptedStyleSheets' in document
  );
}

export type NativeThermalOutput = (
  pdf: Uint8Array<ArrayBuffer>,
  share: boolean,
) => Promise<'submitted' | 'cancelled' | 'shared'>;

export function PdfButton({
  pdf,
  send,
}: {
  pdf: Uint8Array<ArrayBuffer> | null;
  send: (pdf: Uint8Array<ArrayBuffer>) => void;
}) {
  return (
    <Button variant="secondary" isDisabled={!pdf} onPress={() => pdf && send(pdf)}>
      <Trans>Export PDF</Trans>
    </Button>
  );
}

export async function saveThermalPdf(bytes: Uint8Array<ArrayBuffer>) {
  const file = new File([bytes], 'sheepkeep-labels.pdf', { type: 'application/pdf' });
  if (canShareFiles([file])) {
    const result = await shareFiles([file]);
    if (result === 'refused') throw new Error('PDF share failed');
  } else saveFile(file);
}
