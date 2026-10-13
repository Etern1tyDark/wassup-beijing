import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentWorld, type AgentWorld } from '../testing/agent-world';
import { groupByRisk, isLowRisk } from './risk';

let w: AgentWorld;
const provenance = { requestedBy: 'ui', untrustedInputs: [] };

beforeEach(async () => {
  w = await createAgentWorld({ seed: true });
});

afterEach(async () => {
  await w.close();
});

async function propose(action: string, params: Record<string, unknown>) {
  const result = await w.actions.propose({ action, params, provenance });
  if (result.kind !== 'proposal') throw new Error(result.reason);
  return result.proposal;
}

describe('low-risk grouping (PRD Section 10)', () => {
  it('treats only proposals that cannot lower safe-to-spend as low-risk', async () => {
    const create = await propose('earmark.create', {
      label: 'A',
      amount: 1_000_000,
      reviewDate: '2027-01-13',
    });
    expect(isLowRisk(create)).toBe(false);
    await w.approveAndExecute(create.proposalId);
    const earmarkId = (await w.repos.earmarks.all())[0]!.id;

    expect(isLowRisk(await propose('earmark.update', { earmarkId, amount: 2_000_000 }))).toBe(false);
    expect(isLowRisk(await propose('earmark.update', { earmarkId, amount: 500_000 }))).toBe(true);
    expect(isLowRisk(await propose('earmark.delete', { earmarkId }))).toBe(true);
    // Adding data is never grouped, even when it adds money.
    expect(
      isLowRisk(
        await propose('transaction.add', {
          accountId: 'acc_bca',
          date: '2026-10-13',
          amount: 100_000,
          merchant: 'Refund',
          category: 'income',
        }),
      ),
    ).toBe(false);
  });

  it('never groups a simulated transfer', async () => {
    await w.settings.update({ featureFlags: { simT3: true } }, '123456');
    const transfer = await propose('transfer', {
      fromAccountId: 'acc_bca',
      toAccountId: 'acc_sandbox',
      amount: 100_000,
    });
    expect(transfer.tier).toBe('T3');
    expect(isLowRisk(transfer)).toBe(false);
  });

  it('forms a group only from two or more low-risk proposals', async () => {
    const create = await propose('earmark.create', {
      label: 'A',
      amount: 1_000_000,
      reviewDate: '2027-01-13',
    });
    await w.approveAndExecute(create.proposalId);
    const earmarkId = (await w.repos.earmarks.all())[0]!.id;

    const lower = await propose('earmark.update', { earmarkId, amount: 500_000 });
    const raise = await propose('earmark.update', { earmarkId, amount: 1_500_000 });
    expect(groupByRisk([lower, raise])).toEqual({ individual: [lower, raise], lowRisk: [] });

    const release = await propose('earmark.delete', { earmarkId });
    expect(groupByRisk([lower, raise, release])).toEqual({ individual: [raise], lowRisk: [lower, release] });
  });
});
