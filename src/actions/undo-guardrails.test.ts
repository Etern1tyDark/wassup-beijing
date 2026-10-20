import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentWorld, type AgentWorld } from '../testing/agent-world';
import { GUARDRAIL_RULES } from './guardrails';
import { isLowRisk } from './risk';

/**
 * An undo changes the ledger like any other action, so it must pass the same
 * limits. Found by the red-team pass: releasing an earmark, spending the freed
 * money on a new earmark, then undoing the release put the first earmark back
 * with no check, and the card showed no change while free cash went negative.
 */
let w: AgentWorld;
const provenance = { requestedBy: 'ui_earmark_list', untrustedInputs: [] };

beforeEach(async () => {
  w = await createAgentWorld({ seed: true });
});

afterEach(async () => {
  await w.close();
});

async function run(action: string, params: Record<string, unknown>) {
  const result = await w.actions.propose({ action, params, provenance });
  if (result.kind !== 'proposal') throw new Error(result.reason);
  expect((await w.approveAndExecute(result.proposal.proposalId)).kind).toBe('executed');
  return result.proposal;
}

async function createEarmark(amount: number, label = 'Medical reserve'): Promise<string> {
  await run('earmark.create', { label, amount, reviewDate: '2027-01-13' });
  const earmarks = await w.repos.earmarks.all();
  return earmarks.find((earmark) => earmark.label === label && earmark.active)!.id;
}

async function executedEntryId(action: string): Promise<string> {
  const entries = await w.repos.audit.all();
  return entries.filter((entry) => entry.event === 'executed' && entry.action === action).at(-1)!.id;
}

describe('undo is checked like the change it makes', () => {
  it('shows the restored earmark on the card of an undone release, and never groups it as low-risk', async () => {
    const earmarkId = await createEarmark(1_000_000);
    await run('earmark.delete', { earmarkId });
    const before = await w.actions.snapshot();

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error(undo.reason);

    expect(undo.proposal.diff.freeCash).toEqual({
      before: before.freeCash,
      after: before.freeCash - 1_000_000,
    });
    expect(undo.proposal.diff.activeEarmarks).toEqual({ before: 0, after: 1 });
    expect(isLowRisk(undo.proposal)).toBe(false);
  });

  it('refuses to restore a released earmark when the freed money was set aside again', async () => {
    const start = await w.actions.snapshot();
    const settings = await w.actions.settings();
    const amount = Math.min(start.safeToSpend, settings.perActionCap);
    // Two earmarks of this size cannot both fit, which is the point.
    expect(amount * 2).toBeGreaterThan(start.freeCash);

    const first = await createEarmark(amount, 'First');
    await run('earmark.delete', { earmarkId: first });
    const releaseEntry = await executedEntryId('earmark.delete');
    await createEarmark(amount, 'Second');

    const result = await w.actions.propose({
      action: 'undo',
      params: { auditEntryId: releaseEntry },
      provenance,
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.freeCash,
    );
    expect((await w.actions.snapshot()).freeCash).toBeGreaterThanOrEqual(0);
  });

  it('refuses to remove income that has already been spent from the account', async () => {
    const accounts = await w.repos.accounts.all();
    const snapshot = await w.actions.snapshot();
    const account = accounts.find((candidate) => (snapshot.balancesByAccount[candidate.id] ?? 0) > 0)!;
    const balance = snapshot.balancesByAccount[account.id]!;
    const settings = await w.actions.settings();
    const income = Math.min(1_000_000, settings.perActionCap);

    await run('transaction.add', {
      accountId: account.id,
      date: snapshot.asOf,
      amount: income,
      merchant: 'Client payment',
      category: 'income',
    });
    const incomeEntry = await executedEntryId('transaction.add');
    // Spend everything that is now in the account.
    const spend = Math.min(balance + income, settings.perActionCap);
    await run('transaction.add', {
      accountId: account.id,
      date: snapshot.asOf,
      amount: -spend,
      merchant: 'Rent',
      category: 'housing',
    });
    const left = (await w.actions.snapshot()).balancesByAccount[account.id]!;
    expect(left).toBeLessThan(income);

    const result = await w.actions.propose({
      action: 'undo',
      params: { auditEntryId: incomeEntry },
      provenance,
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transactionBalance,
    );
  });
});
