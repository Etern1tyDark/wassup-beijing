import { canonicalJson, sha256Hex } from '../audit/hash';
import type { Proposal } from '../domain/schemas';

/**
 * The proposal hash is what an approval token is bound to (PRD Section 6).
 *
 * It covers everything that decides what the action would do. `status` is
 * excluded because it changes as the proposal moves through its lifecycle, and
 * `proposalHash` obviously cannot hash itself.
 */
export type ProposalHashInput = Omit<Proposal, 'proposalHash' | 'status'> & { status?: Proposal['status'] };

export async function hashProposal(proposal: ProposalHashInput): Promise<string> {
  const core = {
    proposalId: proposal.proposalId,
    action: proposal.action,
    tier: proposal.tier,
    params: proposal.params,
    provenance: proposal.provenance,
    diff: proposal.diff,
    guardrails: proposal.guardrails,
    expiresAt: proposal.expiresAt,
    idempotencyKey: proposal.idempotencyKey,
    createdAt: proposal.createdAt,
  };
  return `sha256:${await sha256Hex(canonicalJson(core))}`;
}
