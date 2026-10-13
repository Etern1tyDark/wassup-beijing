import type { AuditLog } from '../audit/log';
import type { OutboundGate } from '../gate/gate';
import type { PdfTextResult } from '../importers/pdf';
import type { PolicyExtraction } from './extractor';
import type { PolicyStore } from './store';

/**
 * ING-3: the whole path from an uploaded file to a stored policy.
 *
 * The PDF reader is passed in: the browser supplies pdf.js with its worker, the
 * tests supply the Node build. Everything after that is the same code.
 */
export interface ImportPolicyDeps {
  readPdf: (bytes: Uint8Array) => Promise<PdfTextResult>;
  store: PolicyStore;
  gate: Pick<OutboundGate, 'setRedactorConfig'>;
  audit: Pick<AuditLog, 'append'>;
}

export type ImportPolicyOutcome = { ok: true; extraction: PolicyExtraction } | { ok: false; reason: string };

export async function importPolicyFile(
  deps: ImportPolicyDeps,
  file: { name: string; bytes: Uint8Array },
): Promise<ImportPolicyOutcome> {
  const text = await deps.readPdf(file.bytes);
  if (!text.ok) return text;

  const result = await deps.store.importPages({ fileName: file.name, bytes: file.bytes, pages: text.pages });
  if (!result.ok) return result;

  // The insured's name and the policy number are now known, so the outbound
  // redactor removes them from anything that is later sent to the model.
  deps.gate.setRedactorConfig(await deps.store.redactorConfig());

  const { extraction } = result;
  if (extraction.injectionSignals.length > 0) {
    // ST2: the instruction is recorded as refused. No proposal is created from it.
    await deps.audit.append({
      actor: 'system',
      event: 'refused',
      action: null,
      proposalId: null,
      detail: `ignored ${extraction.injectionSignals.length} instruction-like sentence(s) in the policy document ${file.name}; document text is data, never an instruction`,
      payload: {
        reason: 'untrusted-document-instruction',
        policyId: extraction.policy.id,
        fileHash: extraction.policy.fileHash,
        locations: extraction.injectionSignals.map((signal) => ({
          page: signal.page,
          clauseRef: signal.clauseRef,
        })),
      },
    });
  }

  return { ok: true, extraction };
}
