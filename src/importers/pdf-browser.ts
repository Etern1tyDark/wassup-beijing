import { extractPdfText, type PdfJsLike, type PdfTextResult } from './pdf';

/**
 * Browser entry point for PDF text extraction. pdf.js and its worker are loaded
 * only when a policy is uploaded, and both are served from this origin, so the
 * content security policy still allows nothing but 'self' (NFR-6).
 */
let loading: Promise<PdfJsLike> | null = null;

function loadPdfJs(): Promise<PdfJsLike> {
  loading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return loading;
}

export async function readPdfFile(bytes: Uint8Array): Promise<PdfTextResult> {
  return extractPdfText(await loadPdfJs(), bytes);
}
