import type { Proposal } from '../domain/schemas';

/**
 * Approval fatigue (PRD Section 10): low-risk items are shown together, so the
 * cards that deserve a careful read stand out.
 *
 * A proposal is low-risk when approving it cannot leave the user with less money
 * to spend: it is T2, it does not add data from a file, and its own diff shows
 * safe-to-spend staying the same or going up. Releasing or lowering an earmark
 * and undoing the creation of one are the usual cases.
 *
 * Grouping changes only how cards are laid out. Every proposal in a group is
 * still approved with its own one-time token, re-checked by its own guardrails
 * at execution, and written to the audit log as its own entries.
 */
export function isLowRisk(proposal: Proposal): boolean {
  if (proposal.tier !== 'T2') return false;
  if (proposal.action === 'statement.import' || proposal.action === 'transaction.add') return false;
  const delta = proposal.diff.safeToSpend;
  return delta !== undefined && delta.after >= delta.before;
}

/** Split waiting proposals into the ones to read one by one and the ones that can share a card. */
export function groupByRisk(proposals: readonly Proposal[]): { individual: Proposal[]; lowRisk: Proposal[] } {
  const lowRisk = proposals.filter(isLowRisk);
  // One low-risk item gains nothing from a group of its own.
  if (lowRisk.length < 2) return { individual: [...proposals], lowRisk: [] };
  return { individual: proposals.filter((proposal) => !isLowRisk(proposal)), lowRisk };
}
