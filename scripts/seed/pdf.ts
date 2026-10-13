/**
 * A minimal, dependency-free PDF writer for the synthetic policy documents
 * (PRD Section 8). It writes real text-based PDFs, so the policy pipeline is
 * exercised end to end: bytes -> pdf.js -> text -> clauses -> coverage items.
 *
 * Output is deterministic: no dates, no ids, no compression, so `npm run seed`
 * stays byte-for-byte reproducible (NFR-2).
 *
 * Only printable ASCII is supported, which is all the policies use.
 */
export interface PdfLine {
  text: string;
  bold?: boolean;
  /** White, tiny text: invisible on the page but present in the text layer. */
  hidden?: boolean;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_LEFT = 50;
const FIRST_BASELINE = 790;
const FONT_SIZE = 10;
const LEADING = 14;

/** Lines that fit on one page with the margins above. */
export const PDF_LINES_PER_PAGE = 52;
/** Characters that fit on one line at the body font size. */
export const PDF_LINE_WIDTH = 92;

function escapePdfText(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`PDF text must be printable ASCII: ${JSON.stringify(text)}`);
  }
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageContent(lines: readonly PdfLine[]): string {
  if (lines.length > PDF_LINES_PER_PAGE) {
    throw new Error(`a page holds ${PDF_LINES_PER_PAGE} lines, received ${lines.length}`);
  }
  const out: string[] = ['BT', `${LEADING} TL`, `${MARGIN_LEFT} ${FIRST_BASELINE} Td`];
  for (const line of lines) {
    if (line.hidden) {
      out.push('1 1 1 rg', '/F1 2 Tf', `(${escapePdfText(line.text)}) Tj`, 'T*', '0 0 0 rg');
    } else {
      out.push(`/${line.bold ? 'F2' : 'F1'} ${FONT_SIZE} Tf`, `(${escapePdfText(line.text)}) Tj`, 'T*');
    }
  }
  out.push('ET');
  return out.join('\n');
}

/** Wrap a paragraph to the page width, breaking only at spaces. */
export function wrapText(text: string, width: number = PDF_LINE_WIDTH): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (current.length > 0 && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function buildPdf(pages: ReadonlyArray<readonly PdfLine[]>): Uint8Array {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  // Object numbers: 1 catalog, 2 page tree, 3 and 4 fonts, then a page object
  // and its content stream for every page.
  const pageObjectNumber = (index: number): number => 5 + index * 2;
  const objects: string[] = [];

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((lines, index) => {
    const content = pageContent(lines);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObjectNumber(index) + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  // Every character is ASCII, so one character is one byte and the offsets hold.
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) bytes[index] = body.charCodeAt(index);
  return bytes;
}
