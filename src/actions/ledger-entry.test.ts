import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareStatementImport } from '../importers/statement';
import { createAgentWorld, type AgentWorld } from '../testing/agent-world';
import { GUARDRAIL_RULES } from './guardrails';

/**
 * ING-1, ING-2, ING-4 and LED-3: the two ways new transactions enter the
 * ledger. Both are T2 actions, so both go through a proposal, an approval and
 * the executor, and both can be undone.
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/csv/${name}`, import.meta.url)), 'utf8');
}

let w: AgentWorld;

beforeEach(async () => {
  w = await createAgentWorld({ seed: true });
});

afterEach(async () => {
  await w.close();
});

async function proposeImport(fileName: string, text: string) {
  const prepared = await prepareStatementImport(fileName, text);
  if (!prepared.ok) throw new Error(`${fileName} did not parse`);
  return { prepared, result: await w.actions.propose(prepared.proposal) };
}

describe('statement.import (ING-1, LED-3)', () => {
  it('imports the demo statement only after approval, and undo removes exactly those rows', async () => {
    const before = await w.actions.snapshot();
    const rowsBefore = (await w.repos.transactions.all()).length;

    const { prepared, result } = await proposeImport('statement-october.csv', fixture('demo-statement.csv'));
    expect(prepared.rowCount).toBe(3);
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;

    // Worked by hand: -185,000 - 45,000 - 155,000 = -385,000.
    expect(result.proposal.tier).toBe('T2');
    expect(result.proposal.diff.freeCash).toEqual({
      before: before.freeCash,
      after: before.freeCash - 385_000,
    });
    expect(result.proposal.guardrails.map((rule) => rule.pass)).toEqual([true, true, true, true]);
    expect(result.proposal.provenance.untrustedInputs).toEqual([
      { source: 'csv', ref: 'statement-october.csv', fields: ['rows'] },
    ]);

    // Nothing is written before approval.
    expect((await w.repos.transactions.all()).length).toBe(rowsBefore);

    const executed = await w.approveAndExecute(result.proposal.proposalId);
    expect(executed.kind).toBe('executed');
    const added = (await w.repos.transactions.all()).filter((row) => row.id.includes('_aud_'));
    expect(added.map((row) => [row.merchant, row.amount, row.category, row.untrusted])).toEqual([
      ['Pharmacy, Kimia Farma', -185_000, 'health', true],
      ['Coffee shop', -45_000, 'eating-out', true],
      ['Bookstore', -155_000, 'uncategorised', true],
    ]);
    expect((await w.actions.snapshot()).totalBalance).toBe(before.totalBalance - 385_000);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error(undo.reason);
    expect(undo.proposal.diff.freeCash).toEqual({
      before: before.freeCash - 385_000,
      after: before.freeCash,
    });
    expect((await w.approveAndExecute(undo.proposal.proposalId)).kind).toBe('executed');

    expect((await w.repos.transactions.all()).length).toBe(rowsBefore);
    expect(await w.actions.snapshot()).toEqual(before);
    expect((await w.audit.list()).map((entry) => entry.event)).toEqual([
      'proposed',
      'approved',
      'executed',
      'proposed',
      'approved',
      'undone',
    ]);
    expect((await w.audit.verify()).ok).toBe(true);
  });

  it('refuses a file that was already imported', async () => {
    const first = await proposeImport('statement-october.csv', fixture('demo-statement.csv'));
    if (first.result.kind !== 'proposal') throw new Error('expected a proposal');
    await w.approveAndExecute(first.result.proposal.proposalId);

    const second = await proposeImport('statement-october.csv', fixture('demo-statement.csv'));
    expect(second.result.kind).toBe('refused');
    if (second.result.kind !== 'refused') return;
    expect(second.result.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toEqual([
      GUARDRAIL_RULES.importNoDuplicates,
    ]);
    expect(second.result.reason).toContain('3 row(s) are already in the ledger');
  });

  it('refuses rows for an account that is not in the ledger instead of creating one', async () => {
    const { result } = await proposeImport(
      'other.csv',
      'date,description,amount,balance,account\n2026-10-10,Coffee,-20000,100000,Mandiri-savings\n',
    );
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.reason : '').toContain(
      'unknown account name(s): Mandiri-savings',
    );
    expect((await w.repos.accounts.all()).map((account) => account.name)).not.toContain('Mandiri-savings');
  });

  it('refuses rows dated after today', async () => {
    const { result } = await proposeImport(
      'future.csv',
      'date,description,amount,balance,account\n2026-12-01,Coffee,-20000,100000,BCA-main\n',
    );
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.reason : '').toContain(GUARDRAIL_RULES.importNotInFuture);
  });

  it('ING-2: a malformed file never becomes a proposal, and every bad row has a line and a reason', async () => {
    const prepared = await prepareStatementImport('bad-rows.csv', fixture('bad-rows.csv'));
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.errors.length).toBeGreaterThan(0);
    for (const error of prepared.errors) {
      expect(error.line).toBeGreaterThan(1);
      expect(error.reason.length).toBeGreaterThan(0);
    }
    expect(await w.repos.proposals.all()).toEqual([]);
  });

  it('rejects an empty file and a file with only a header', async () => {
    expect((await prepareStatementImport('empty.csv', fixture('empty.csv'))).ok).toBe(false);
    const headerOnly = await prepareStatementImport(
      'header.csv',
      'date,description,amount,balance,account\n',
    );
    expect(headerOnly).toMatchObject({
      ok: false,
      errors: [{ reason: 'the file has a header row but no transactions' }],
    });
  });

  it('NFR-3: prepares and guards a 2,000-row statement quickly', async () => {
    const lines = ['date,description,amount,balance,account'];
    for (let index = 0; index < 2000; index += 1) {
      lines.push(
        `2026-10-${String((index % 13) + 1).padStart(2, '0')},Row ${index},-${1000 + index},1,BCA-main`,
      );
    }
    const started = performance.now();
    const { prepared, result } = await proposeImport('large.csv', `${lines.join('\n')}\n`);
    const elapsed = performance.now() - started;

    expect(prepared.rowCount).toBe(2000);
    expect(result.kind).toBe('proposal');
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('transaction.add (ING-4)', () => {
  const base = {
    accountId: 'acc_bca',
    date: '2026-10-12',
    amount: -50_000,
    merchant: 'Lunch',
    category: 'eating-out',
  };
  const provenance = { requestedBy: 'user_turn_1', untrustedInputs: [] };

  async function refusedRules(params: Record<string, unknown>): Promise<string[]> {
    const result = await w.actions.propose({ action: 'transaction.add', params, provenance });
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    return result.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule);
  }

  it('passes every guardrail for an ordinary expense', async () => {
    const result = await w.actions.propose({ action: 'transaction.add', params: base, provenance });
    expect(result.kind).toBe('proposal');
  });

  it('is refused for an unknown account, a future date, an amount over the cap or an overdraft', async () => {
    expect(await refusedRules({ ...base, accountId: 'acc_nowhere' })).toContain(
      GUARDRAIL_RULES.transactionAccount,
    );
    expect(await refusedRules({ ...base, date: '2026-10-20' })).toEqual([GUARDRAIL_RULES.transactionDate]);
    expect(await refusedRules({ ...base, date: '2024-01-01' })).toEqual([GUARDRAIL_RULES.transactionDate]);
    expect(await refusedRules({ ...base, amount: -10_000_001 })).toContain(GUARDRAIL_RULES.transactionCap);
    expect(await refusedRules({ ...base, accountId: 'acc_sandbox' })).toEqual([
      GUARDRAIL_RULES.transactionBalance,
    ]);
  });

  it('rejects a zero or fractional amount before any guardrail runs', async () => {
    for (const amount of [0, 1.5]) {
      const result = await w.actions.propose({
        action: 'transaction.add',
        params: { ...base, amount },
        provenance,
      });
      expect(result.kind).toBe('refused');
    }
  });

  it('can be undone', async () => {
    const before = await w.actions.snapshot();
    const result = await w.actions.propose({ action: 'transaction.add', params: base, provenance });
    if (result.kind !== 'proposal') throw new Error(result.reason);
    await w.approveAndExecute(result.proposal.proposalId);
    expect((await w.actions.snapshot()).totalBalance).toBe(before.totalBalance - 50_000);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error(undo.reason);
    await w.approveAndExecute(undo.proposal.proposalId);
    expect(await w.actions.snapshot()).toEqual(before);
  });
});
