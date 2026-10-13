import type { CoverageItem, Policy, PolicyDocument } from '../domain/schemas';
import { sha256Hex } from '../audit/hash';
import type { PdfPageText } from '../importers/pdf';
import type { AppDatabase } from '../storage/db';
import type { Repositories } from '../storage/repositories';
import type { RedactorConfig } from '../gate/redactor';
import { extractPolicy, type PolicyExtraction } from './extractor';

/**
 * Policy storage (ING-3, ING-5). Policies are reference documents, not part of
 * the ledger: loading one changes no balance and proposes no action, so it does
 * not go through the action executor. Like the ledger, they live only in
 * IndexedDB.
 */
export interface LoadedPolicy {
  policy: Policy;
  document: PolicyDocument;
  items: CoverageItem[];
}

export type ImportPolicyResult = { ok: true; extraction: PolicyExtraction } | { ok: false; reason: string };

export interface PolicyStore {
  /** Extract a policy from page text and save it, replacing an earlier copy of the same file. */
  importPages(input: {
    fileName: string;
    bytes: Uint8Array;
    pages: readonly PdfPageText[];
  }): Promise<ImportPolicyResult>;
  all(): Promise<LoadedPolicy[]>;
  remove(policyId: string): Promise<void>;
  /** Names and policy numbers from every stored policy, for the outbound redactor. */
  redactorConfig(): Promise<RedactorConfig>;
}

export function createPolicyStore(deps: {
  db: AppDatabase;
  repos: Repositories;
  now: () => Date;
}): PolicyStore {
  const { db, repos } = deps;

  async function all(): Promise<LoadedPolicy[]> {
    const [policies, documents, items] = await Promise.all([
      repos.policies.all(),
      repos.policyDocuments.all(),
      repos.coverageItems.all(),
    ]);
    const loaded: LoadedPolicy[] = [];
    for (const policy of policies) {
      const document = documents.find((candidate) => candidate.policyId === policy.id);
      if (!document) continue;
      loaded.push({ policy, document, items: items.filter((item) => item.policyId === policy.id) });
    }
    return loaded.sort((a, b) => (a.policy.displayName < b.policy.displayName ? -1 : 1));
  }

  async function remove(policyId: string): Promise<void> {
    await db.transaction('rw', [db.policies, db.coverageItems, db.policyDocuments], async () => {
      await db.policies.delete(policyId);
      await db.policyDocuments.delete(policyId);
      await db.coverageItems.where('policyId').equals(policyId).delete();
    });
  }

  return {
    all,
    remove,

    importPages: async ({ fileName, bytes, pages }) => {
      const result = extractPolicy({
        fileName,
        fileHash: `sha256:${await sha256Hex(bytes)}`,
        pages,
        extractedAt: deps.now().toISOString(),
      });
      if (!result.ok) return result;

      const { policy, document, items } = result.extraction;
      await db.transaction('rw', [db.policies, db.coverageItems, db.policyDocuments], async () => {
        await db.coverageItems.where('policyId').equals(policy.id).delete();
        await db.policies.put(policy);
        await db.policyDocuments.put(document);
        await db.coverageItems.bulkPut(items);
      });
      return result;
    },

    redactorConfig: async () => {
      const documents = await repos.policyDocuments.all();
      return {
        names: [...new Set(documents.flatMap((document) => document.identifiers.names))],
        accountNumbers: [],
        policyNumbers: [...new Set(documents.flatMap((document) => document.identifiers.policyNumbers))],
        addresses: [...new Set(documents.flatMap((document) => document.identifiers.addresses))],
      };
    },
  };
}
