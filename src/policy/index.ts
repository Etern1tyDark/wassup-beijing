import type { CoverageItem, Policy } from '../domain/schemas';
import { NotImplementedError } from '../agent/types';

/**
 * Policy extraction and coverage engine - STUB.
 *
 * TODO POL-1: extract coverage items (benefit, limit, deductible or co-pay,
 *            waiting period, exclusions) with a page and clause reference for
 *            every item. Text-based PDFs up to 20 pages only.
 * TODO POL-2: compute the worst-case out-of-pocket for a named event from the
 *            extracted limits. Computed here, never by the model.
 * TODO POL-3: report a shortfall when the out-of-pocket exceeds free cash.
 * TODO POL-4: compare two policies side by side on criteria the user picks.
 *            No ranking and no "best" wording.
 * TODO POL-5: mark low-confidence extractions and show the raw text instead of a
 *            summary.
 *
 * Policy text is untrusted input: it reaches the model only as a marked data
 * field, and it can never set the action, the amount or the target account
 * (PRD Section 6).
 */
export interface PolicyExtractionInput {
  policyId: string;
  displayName: string;
  type: Policy['type'];
  insurer: string;
  fileHash: string;
  /** Extracted text, one entry per page. */
  pages: ReadonlyArray<{ page: number; text: string }>;
}

export type ExtractedCoverageItem = CoverageItem;

export interface ExtractionResult {
  policy: Policy;
  items: ExtractedCoverageItem[];
  /** Items whose extraction confidence is below the display threshold (POL-5). */
  lowConfidence: ExtractedCoverageItem[];
}

export interface CoverageEvent {
  name: string;
  /** Expected cost of the event before the policy pays. */
  estimatedCost: number;
}

export interface CoverageAssessment {
  policyId: string;
  event: string;
  limit: number;
  deductible: number;
  waitingPeriodDays: number;
  /** Computed by the engine, never by the model (POL-2). */
  worstCaseOutOfPocket: number;
  freeCash: number;
  /** Positive when free cash does not cover the worst case (POL-3). */
  shortfall: number;
  citations: Array<{ page: number; clauseRef: string }>;
}

export interface PolicyExtractor {
  extract(input: PolicyExtractionInput): Promise<ExtractionResult>;
}

export interface CoverageEngine {
  assess(
    policy: Policy,
    items: readonly CoverageItem[],
    event: CoverageEvent,
    freeCash: number,
  ): Promise<CoverageAssessment>;
  compare(
    policies: ReadonlyArray<{ policy: Policy; items: readonly CoverageItem[] }>,
    criteria: readonly string[],
  ): Promise<{ columns: string[]; rows: Array<{ criterion: string; values: string[] }> }>;
}

export function createPolicyExtractor(): PolicyExtractor {
  return {
    extract: () => {
      throw new NotImplementedError('policy extraction', 'POL-1');
    },
  };
}

export function createCoverageEngine(): CoverageEngine {
  return {
    assess: () => {
      throw new NotImplementedError('coverage assessment', 'POL-2');
    },
    compare: () => {
      throw new NotImplementedError('policy comparison', 'POL-4');
    },
  };
}
