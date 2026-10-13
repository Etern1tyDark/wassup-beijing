import { randomHex } from '../domain/ids';
import type { Proposal } from '../domain/schemas';
import { hashProposal } from './proposal-hash';

/**
 * PRD Section 6: approval is a UI event carrying a one-time token bound to the
 * proposal's hash.
 *
 * - the token is issued only for a pending proposal
 * - it is bound to the proposal hash, so approving a changed proposal fails
 * - it can be consumed exactly once
 * - the model never sees this module (enforced by the agent module boundary)
 */
export interface ApprovalToken {
  token: string;
  proposalId: string;
  proposalHash: string;
  issuedAt: string;
  expiresAt: string;
}

export type TokenConsumeResult = { ok: true } | { ok: false; reason: string };

export interface ApprovalService {
  /** Called by the approval card when it renders. Returns a fresh one-time token. */
  issue(proposal: Proposal, now: Date): Promise<ApprovalToken>;
  /** Called when the user presses Approve. Consumes the token on success. */
  consume(input: { token: string; proposal: Proposal; now: Date }): Promise<TokenConsumeResult>;
}

interface StoredToken {
  token: ApprovalToken;
  used: boolean;
}

export function createApprovalService(): ApprovalService {
  const tokens = new Map<string, StoredToken>();

  return {
    issue: (proposal, now) => {
      if (proposal.status !== 'pending') {
        throw new Error(`cannot issue an approval token for a ${proposal.status} proposal`);
      }
      const token: ApprovalToken = {
        token: randomHex(16),
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        issuedAt: now.toISOString(),
        expiresAt: proposal.expiresAt,
      };
      tokens.set(token.token, { token, used: false });
      return Promise.resolve(token);
    },

    consume: async ({ token, proposal, now }) => {
      const stored = tokens.get(token);
      if (!stored) return { ok: false, reason: 'unknown approval token' };
      if (stored.used) return { ok: false, reason: 'this approval token has already been used' };
      if (stored.token.proposalId !== proposal.proposalId) {
        return { ok: false, reason: 'this approval token belongs to a different proposal' };
      }
      if (stored.token.proposalHash !== proposal.proposalHash) {
        return { ok: false, reason: 'the proposal changed since the token was issued' };
      }
      const currentHash = await hashProposal(proposal);
      if (currentHash !== proposal.proposalHash) {
        return { ok: false, reason: 'the proposal changed since it was created' };
      }
      if (new Date(proposal.expiresAt).getTime() < now.getTime()) {
        return { ok: false, reason: 'the proposal has expired' };
      }
      stored.used = true;
      return { ok: true };
    },
  };
}
