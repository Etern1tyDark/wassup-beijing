import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfText, type PdfJsLike, type PdfPageText } from '../importers/pdf';

/**
 * Test helpers for the synthetic policy PDFs. They read the checked-in files
 * with the Node build of pdf.js, so tests run the same extraction code as the
 * browser on the same bytes.
 */
export const nodePdfJs = pdfjs as unknown as PdfJsLike;

export function policyFixtureBytes(fileName: string): Uint8Array {
  // Resolved from the repository root: under jsdom `import.meta.url` is not a file URL.
  return new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures/policies', fileName)));
}

export async function policyFixturePages(fileName: string): Promise<PdfPageText[]> {
  const result = await extractPdfText(nodePdfJs, policyFixtureBytes(fileName));
  if (!result.ok) throw new Error(`could not read ${fileName}: ${result.reason}`);
  return result.pages;
}
