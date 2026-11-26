import type { ThermalDocument } from './document';

export const loadThermalPdf = () => import('pdf-lib');

export async function thermalPdf(document: ThermalDocument): Promise<Uint8Array<ArrayBuffer>> {
  const { PDFDocument, StandardFonts, rgb } = await loadThermalPdf();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const bold = await pdf.embedFont(StandardFonts.CourierBold);
  const black = rgb(0, 0, 0);
  const dot = 72 / document.dpi;
  const points = (mm: number) => Number(((mm * 72) / 25.4).toFixed(9));
  const width = points(document.mm.w);
  const height = points(document.mm.h);
  for (const drawing of document.pages) {
    const page = pdf.addPage([width, height]);
    for (const rect of drawing.ink) {
      page.drawRectangle({
        x: dot * rect.x,
        y: height - dot * (rect.y + rect.h),
        width: dot * rect.w,
        height: dot * rect.h,
        color: black,
        borderWidth: 0,
      });
    }
    for (const text of drawing.text) {
      page.drawText(text.value, {
        x: dot * text.x,
        y: height - dot * text.y,
        size: dot * text.size,
        font: text.bold ? bold : font,
        color: black,
      });
    }
  }
  // Copy so callers can pass the bytes to the Blob/Capacitor APIs that require an ArrayBuffer.
  return Uint8Array.from(await pdf.save());
}
