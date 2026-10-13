import type { ProposalTier, Provenance } from '../domain/schemas';
import { PROTECTED_PARAM_PATHS } from './params';
import { requiresApproval } from './registry';

/**
 * PRD Section 6: a value that came from a document, a CSV field or pasted chat
 * text is untrusted. It can never set the action type, the amount or the target
 * account of a T2 or T3 proposal.
 *
 * The check is structural and runs in code, before guardrails, so no prompt can
 * talk its way past it.
 */
export interface ProvenanceCheck {
  ok: boolean;
  reason: string | null;
  violations: string[];
}

const FORBIDDEN_FIELDS = new Set<string>(
  [...PROTECTED_PARAM_PATHS, 'action', 'tier', 'params'].map((field) => field.toLowerCase()),
);

/** `params.amount`, `amount` and `Amount` all normalise to `amount`. */
function normaliseField(field: string): string {
  const lastSegment = field.split('.').pop() ?? field;
  return lastSegment.trim().toLowerCase();
}

export function checkProvenance(provenance: Provenance, tier: ProposalTier): ProvenanceCheck {
  if (!requiresApproval(tier)) {
    return { ok: true, reason: null, violations: [] };
  }

  const violations: string[] = [];
  for (const input of provenance.untrustedInputs) {
    for (const field of input.fields) {
      if (FORBIDDEN_FIELDS.has(normaliseField(field))) {
        violations.push(`${input.source}:${input.ref} sets "${field}"`);
      }
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      violations,
      reason: `refused: untrusted text cannot set the action, the amount or the target account of a ${tier} proposal (${violations.join('; ')})`,
    };
  }

  return { ok: true, reason: null, violations: [] };
}

/** Untrusted fields that are safe to carry, for the audit payload. */
export function untrustedFieldNames(provenance: Provenance): string[] {
  return provenance.untrustedInputs.flatMap((input) => input.fields);
}

export { normaliseField as normaliseProvenanceField };
