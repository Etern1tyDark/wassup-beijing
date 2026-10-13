/**
 * ING-3: read the text of a policy PDF (text-based, up to 20 pages).
 *
 * pdf.js does the parsing. It is passed in rather than imported here, so the
 * browser can load it lazily with its worker (see ./pdf-browser.ts) and the
 * tests can run the very same code on the Node build.
 *
 * Everything this returns is untrusted text: it came from a file, not from the
 * user's keyboard (PRD Section 6).
 */
export const MAX_POLICY_PAGES = 20;
export const MAX_POLICY_BYTES = 5 * 1024 * 1024;

export interface PdfPageText {
  page: number;
  text: string;
}

export type PdfTextResult = { ok: true; pages: PdfPageText[] } | { ok: false; reason: string };

interface PdfPageLike {
  /** Text runs carry `str` and `hasEOL`; marked-content items carry neither and are skipped. */
  getTextContent(): Promise<{ items: readonly unknown[] }>;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy?(): Promise<void>;
}

/** The part of pdf.js this module uses. */
export interface PdfJsLike {
  getDocument(source: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
}

function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-"
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export async function extractPdfText(pdfjs: PdfJsLike, bytes: Uint8Array): Promise<PdfTextResult> {
  if (bytes.length === 0) return { ok: false, reason: 'the file is empty' };
  if (bytes.length > MAX_POLICY_BYTES) {
    return { ok: false, reason: 'the file is larger than 5 MB; upload a text-based PDF of up to 20 pages' };
  }
  if (!isPdf(bytes)) return { ok: false, reason: 'the file is not a PDF' };

  let document: PdfDocumentLike;
  try {
    document = await pdfjs.getDocument({
      // pdf.js takes ownership of the buffer it is given, so hand it a copy.
      data: bytes.slice(),
      isEvalSupported: false,
      verbosity: 0,
      useSystemFonts: false,
      disableFontFace: true,
    }).promise;
  } catch (error) {
    return {
      ok: false,
      reason: `the PDF could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  try {
    if (document.numPages > MAX_POLICY_PAGES) {
      return {
        ok: false,
        reason: `the PDF has ${document.numPages} pages; the limit is ${MAX_POLICY_PAGES}`,
      };
    }

    const pages: PdfPageText[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (item === null || typeof item !== 'object') continue;
        const run = item as { str?: unknown; hasEOL?: unknown };
        if (typeof run.str === 'string') text += run.str;
        if (run.hasEOL === true) text += '\n';
      }
      pages.push({ page: pageNumber, text: text.trim() });
    }

    if (pages.every((page) => page.text === '')) {
      return {
        ok: false,
        reason: 'the PDF has no text layer. Scanned policies are not supported; upload a text-based PDF',
      };
    }
    return { ok: true, pages };
  } finally {
    await document.destroy?.();
  }
}
