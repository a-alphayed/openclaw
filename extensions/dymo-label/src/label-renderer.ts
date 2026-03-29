import PDFDocument from "pdfkit";
import { LABEL_HEIGHT_PT, LABEL_MARGIN, LABEL_WIDTH_PT, type LabelContent } from "./types.js";

/**
 * Render a parts label as a PDF buffer for the Dymo 30336 (1" × 2⅛").
 *
 * The LabelWriter feeds the 1" edge first (portrait). We create a portrait
 * page (72pt × 153pt) and rotate the coordinate system so text reads
 * horizontally on the printed label.
 *
 * Layout (as read on the label):
 *   Line 1: partNumber (bold, left)  binLocation (right)
 *   Line 2: OEM: oemPartNumber
 *   Line 3: description (truncated, single line)
 */
export async function renderLabelPdf(content: LabelContent, copies: number = 1): Promise<Buffer> {
  // Page matches physical feed: 1" wide × 2.125" tall
  const pageW = LABEL_HEIGHT_PT; // 72pt (1")
  const pageH = LABEL_WIDTH_PT; // 153pt (2.125")

  const doc = new PDFDocument({
    size: [pageW, pageH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false,
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Dymo driver ignores lp -n, so we generate one page per copy.
  for (let i = 0; i < copies; i++) {
    doc.addPage({ size: [pageW, pageH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    // Rotate 90° CW so text reads left-to-right on the horizontal label.
    doc.rotate(90, { origin: [0, 0] });
    doc.translate(0, -pageW);

    const margin = LABEL_MARGIN + 2;
    const usableWidth = pageH - margin * 2;
    const leftX = margin;
    let y = margin;

    // Line 1: part number (bold, left) + bin location (right-aligned)
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text(content.partNumber, leftX, y, {
      width: usableWidth,
      ellipsis: true,
      lineBreak: false,
    });

    if (content.binLocation) {
      doc.font("Helvetica").fontSize(8);
      doc.text(content.binLocation, leftX, y, {
        width: usableWidth,
        align: "right",
        ellipsis: true,
        lineBreak: false,
      });
    }

    // Line 2: OEM part number
    y += 16;
    doc.font("Helvetica").fontSize(7);
    doc.text(`OEM: ${content.oemPartNumber}`, leftX, y, {
      width: usableWidth,
      ellipsis: true,
      lineBreak: false,
    });

    // Line 3: description (truncated, single line)
    y += 14;
    doc.font("Helvetica").fontSize(6);
    doc.text(content.description, leftX, y, {
      width: usableWidth,
      ellipsis: true,
      lineBreak: false,
    });
  }

  doc.end();
  return done;
}
