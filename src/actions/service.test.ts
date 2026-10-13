import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { absMoney, toMoney } from '../domain/money';
import { parseStatementCsv } from '../importers/csv';
import { ACTION_NAMES, ACTION_REGISTRY } from './registry';
import { GUARDRAIL_RULES } from './guardrails';
import type { ProposeResult } from './service';
import {
  createTestWorld,
  EXPECTED,
  TEST_DEMO_PIN,
  activeEarmarkFixture,
  type TestWorld,
} from '../testing/harness';

const worlds: TestWorld[] = [];

async function world(options?: Parameters<typeof createTestWorld>[0]): Promise<TestWorld> {
  const created = await createTestWorld(options);
  worlds.push(created);
  return created;
}

afterEach(async () => {
  while (worlds.length > 0) {
    const current = worlds.pop();
    if (current) await current.close();
  }
});

const PROVENANCE = { requestedBy: 'user_turn_1', untrustedInputs: [] };

function earmarkParams(overrides: Record<string, unknown> = {}) {
  return { label: 'Medical reserve', amount: toMoney(3_000_000), reviewDate: '2027-01-13', ...overrides };
}

async function proposeEarmark(w: TestWorld, overrides: Record<string, unknown> = {}): Promise<ProposeResult> {
  return w.actions.propose({
    action: 'earmark.create',
    params: earmarkParams(overrides),
    provenance: PROVENANCE,
  });
}

async function approveAndExecute(w: TestWorld, proposalId: string, pin?: string) {
  const token = await w.issueToken(proposalId);
  const approved = await w.actions.approve({ proposalId, token: token.token, ...(pin ? { pin } : {}) });
  expect(approved.kind).toBe('approved');
  return w.actions.execute(proposalId);
}

function expectRefused(result: ProposeResult): Extract<ProposeResult, { kind: 'refused' }> {
  expect(result.kind).toBe('refused');
  return result as Extract<ProposeResult, { kind: 'refused' }>;
}

/* ------------------------------------------------------------ ACT-1, ACT-2 */

describe('action registry and tiers (ACT-1, ACT-2)', () => {
  it('classifies every action into a tier', () => {
    for (const name of ACTION_NAMES) {
      expect(['T0', 'T1', 'T2', 'T3']).toContain(ACTION_REGISTRY[name].tier);
    }
    expect(ACTION_REGISTRY['earmark.create'].tier).toBe('T2');
    expect(ACTION_REGISTRY['earmark.delete'].tier).toBe('T2');
    expect(ACTION_REGISTRY.undo.tier).toBe('T2');
    expect(ACTION_REGISTRY.transfer.tier).toBe('T3');
    expect(ACTION_REGISTRY.draft_reminder.tier).toBe('T1');
  });

  it('rejects an unknown action name and logs the refusal', async () => {
    const w = await world();
    const result = await w.actions.propose({
      action: 'transfer.everything',
      params: {},
      provenance: PROVENANCE,
    });

    expect(expectRefused(result).reason).toMatch(/not in the action registry/);

    const entries = await w.audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'refused', action: 'transfer.everything', actor: 'agent' });
  });

  it('refuses to turn a T0 read or a T1 draft into an approval proposal (ACT-2)', async () => {
    const w = await world();
    for (const action of ['get_summary', 'draft_reminder']) {
      const result = await w.actions.propose({ action, params: {}, provenance: PROVENANCE });
      expect(expectRefused(result).reason).toMatch(/no side effects/);
    }
    expect(await w.repos.earmarks.all()).toEqual([]);
  });
});

/* --------------------------------------------------- ACT-3, ACT-6 lifecycle */

describe('proposal lifecycle (ACT-3, ACT-6)', () => {
  it('changes nothing before approval', async () => {
    const w = await world();
    const before = await w.actions.snapshot();
    expect(before.safeToSpend).toBe(EXPECTED.safeToSpend);

    const result = await proposeEarmark(w);
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;

    expect(result.proposal.status).toBe('pending');
    expect(result.proposal.tier).toBe('T2');
    expect(result.proposal.diff.safeToSpend).toEqual({
      before: EXPECTED.safeToSpend,
      after: EXPECTED.safeToSpend - 3_000_000,
    });
    expect(result.proposal.guardrails.every((rule) => rule.pass)).toBe(true);
    expect(result.proposal.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(await w.repos.earmarks.all()).toEqual([]);
    expect((await w.actions.snapshot()).safeToSpend).toBe(EXPECTED.safeToSpend);
  });

  it('still changes nothing after approval, and changes safe-to-spend after execution', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');

    const token = await w.issueToken(proposed.proposal.proposalId);
    const approved = await w.actions.approve({
      proposalId: proposed.proposal.proposalId,
      token: token.token,
    });
    expect(approved.kind).toBe('approved');
    expect((await w.actions.snapshot()).safeToSpend).toBe(EXPECTED.safeToSpend);

    const executed = await w.actions.execute(proposed.proposal.proposalId);
    expect(executed.kind).toBe('executed');

    const after = await w.actions.snapshot();
    expect(after.safeToSpend).toBe(EXPECTED.safeToSpend - 3_000_000);
    expect(after.freeCash).toBe(EXPECTED.freeCash - 3_000_000);
    expect(after.activeEarmarkCount).toBe(1);

    const earmarks = await w.repos.earmarks.all();
    expect(earmarks).toHaveLength(1);
    expect(earmarks[0]).toMatchObject({ amount: 3_000_000, active: true, label: 'Medical reserve' });
  });

  it('restores safe-to-spend exactly on undo, recorded as a new entry (AUD-2)', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    await approveAndExecute(w, proposed.proposal.proposalId);

    const reduced = (await w.actions.snapshot()).safeToSpend;
    expect(reduced).toBe(EXPECTED.safeToSpend - 3_000_000);

    const undoProposal = await w.actions.undoLast('user');
    if (undoProposal.kind !== 'proposal') throw new Error('expected an undo proposal');
    expect(undoProposal.proposal.action).toBe('undo');

    const undone = await approveAndExecute(w, undoProposal.proposal.proposalId);
    expect(undone.kind).toBe('executed');

    expect((await w.actions.snapshot()).safeToSpend).toBe(EXPECTED.safeToSpend);
    expect((await w.repos.earmarks.all())[0]?.active).toBe(false);

    const events = (await w.audit.list()).map((entry) => entry.event);
    expect(events).toEqual(['proposed', 'approved', 'executed', 'proposed', 'approved', 'undone']);
    expect((await w.audit.verify()).ok).toBe(true);
  });

  it('releases an earmark with earmark.delete and restores it on undo', async () => {
    const w = await world();
    const created = await proposeEarmark(w);
    if (created.kind !== 'proposal') throw new Error('expected a proposal');
    await approveAndExecute(w, created.proposal.proposalId);
    const earmarkId = (await w.repos.earmarks.all())[0]!.id;

    const deletion = await w.actions.propose({
      action: 'earmark.delete',
      params: { earmarkId },
      provenance: PROVENANCE,
    });
    if (deletion.kind !== 'proposal') throw new Error('expected a proposal');
    await approveAndExecute(w, deletion.proposal.proposalId);

    expect((await w.actions.snapshot()).safeToSpend).toBe(EXPECTED.safeToSpend);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error('expected an undo proposal');
    await approveAndExecute(w, undo.proposal.proposalId);

    expect((await w.repos.earmarks.byId(earmarkId))?.active).toBe(true);
    expect((await w.actions.snapshot()).safeToSpend).toBe(EXPECTED.safeToSpend - 3_000_000);
  });

  it('refuses to execute a pending proposal', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');

    const blocked = await w.actions.execute(proposed.proposal.proposalId);
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.reason).toMatch(/nothing changes before approval/);
    expect(await w.repos.earmarks.all()).toEqual([]);
  });

  it('re-checks the guardrails at execution time, so a stale approval cannot slip through', async () => {
    const w = await world();
    const first = await proposeEarmark(w, { amount: toMoney(9_000_000), label: 'First' });
    if (first.kind !== 'proposal') throw new Error('expected a proposal');

    const token = await w.issueToken(first.proposal.proposalId);
    expect(
      (await w.actions.approve({ proposalId: first.proposal.proposalId, token: token.token })).kind,
    ).toBe('approved');

    // The ledger moves after approval: another earmark eats the free cash.
    const second = await proposeEarmark(w, { amount: toMoney(5_000_000), label: 'Second' });
    if (second.kind !== 'proposal') throw new Error('expected a proposal');
    await approveAndExecute(w, second.proposal.proposalId);

    const blocked = await w.actions.execute(first.proposal.proposalId);
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.reason).toMatch(/refused by guardrails/);

    const earmarks = await w.repos.earmarks.all();
    expect(earmarks.filter((earmark) => earmark.active)).toHaveLength(1);
    expect((await w.audit.list()).at(-1)).toMatchObject({ event: 'refused' });
  });

  it('refuses an undo when there is nothing to undo', async () => {
    const w = await world();
    expect(expectRefused(await w.actions.undoLast('user')).reason).toMatch(/nothing to undo/);
  });
});

/* ------------------------------------------------------------- approval (ST7) */

describe('approval tokens (PRD Section 6, ST7)', () => {
  it('rejects a reused token', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    const token = await w.issueToken(proposed.proposal.proposalId);

    const first = await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token });
    expect(first.kind).toBe('approved');

    const second = await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token });
    expect(second).toEqual({ kind: 'rejected', reason: 'proposal is approved, not pending' });

    // Re-open the proposal to prove the token itself is dead, not just the status.
    const stored = await w.repos.proposals.byId(proposed.proposal.proposalId);
    await w.db.proposals.put({ ...stored!, status: 'pending' });
    const third = await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token });
    expect(third).toEqual({ kind: 'rejected', reason: 'this approval token has already been used' });
  });

  it('rejects an unknown token', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');

    const result = await w.actions.approve({
      proposalId: proposed.proposal.proposalId,
      token: 'not-a-real-token',
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'unknown approval token' });
  });

  it('rejects a token issued for a different proposal', async () => {
    const w = await world();
    const first = await proposeEarmark(w, { label: 'First' });
    const second = await proposeEarmark(w, { label: 'Second' });
    if (first.kind !== 'proposal' || second.kind !== 'proposal') throw new Error('expected proposals');

    const token = await w.issueToken(first.proposal.proposalId);
    const result = await w.actions.approve({ proposalId: second.proposal.proposalId, token: token.token });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'this approval token belongs to a different proposal',
    });
  });

  it('rejects an expired proposal', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    const token = await w.issueToken(proposed.proposal.proposalId);

    w.setNow('2026-10-14T09:00:00+07:00');
    const result = await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token });

    expect(result).toEqual({ kind: 'rejected', reason: 'the proposal has expired' });
    expect((await w.repos.proposals.byId(proposed.proposal.proposalId))?.status).toBe('expired');
  });

  it('rejects approval of a proposal that changed after the token was issued', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    const token = await w.issueToken(proposed.proposal.proposalId);

    const stored = await w.repos.proposals.byId(proposed.proposal.proposalId);
    await w.db.proposals.put({ ...stored!, params: { ...stored!.params, amount: 9_000_000 } });

    const result = await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token });
    expect(result).toEqual({ kind: 'rejected', reason: 'the proposal changed since it was created' });
  });

  it('lets the user reject a proposal, which is logged as a refusal', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');

    await w.actions.reject(proposed.proposal.proposalId);
    expect((await w.repos.proposals.byId(proposed.proposal.proposalId))?.status).toBe('rejected');
    expect((await w.audit.list()).at(-1)).toMatchObject({ event: 'refused', actor: 'user' });
  });
});

/* ------------------------------------------------------------- guardrails */

describe('earmark guardrails (ACT-5)', () => {
  it('rejects an amount above free cash', async () => {
    const w = await world();
    await w.settings.update({ perActionCap: toMoney(20_000_000) }, TEST_DEMO_PIN);

    const refused = expectRefused(await proposeEarmark(w, { amount: toMoney(15_000_000) }));
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.freeCash,
    );
    expect(await w.repos.earmarks.all()).toEqual([]);
  });

  it('rejects an amount that would leave obligations due in 30 days uncovered', async () => {
    const w = await world();
    await w.settings.update({ perActionCap: toMoney(20_000_000) }, TEST_DEMO_PIN);

    const refused = expectRefused(await proposeEarmark(w, { amount: toMoney(12_000_000) }));
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toEqual([
      GUARDRAIL_RULES.obligationsCovered,
    ]);
  });

  it('rejects an amount above the per-action cap', async () => {
    const w = await world();
    await w.settings.update({ perActionCap: toMoney(5_000_000) }, TEST_DEMO_PIN);

    const refused = expectRefused(await proposeEarmark(w, { amount: toMoney(6_000_000) }));
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toEqual([
      GUARDRAIL_RULES.perActionCap,
    ]);
  });

  it('requires a review date', async () => {
    const w = await world();
    const refused = expectRefused(await proposeEarmark(w, { reviewDate: undefined }));
    expect(refused.reason).toMatch(/reviewDate/);
  });

  it('rejects the eleventh active earmark', async () => {
    const w = await world({
      earmarks: Array.from({ length: 10 }, (_, index) => activeEarmarkFixture(index + 1)),
    });

    const refused = expectRefused(await proposeEarmark(w, { amount: toMoney(1_000_000) }));
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toEqual([
      GUARDRAIL_RULES.maxActiveEarmarks,
    ]);
  });

  it('rejects an amount that is not a positive integer', async () => {
    const w = await world();
    expect(expectRefused(await proposeEarmark(w, { amount: 3_000_000.5 })).reason).toMatch(/amount/);
    expect(expectRefused(await proposeEarmark(w, { amount: 0 })).reason).toMatch(/greater than zero/);
  });

  it('rejects deleting an earmark that does not exist', async () => {
    const w = await world();
    const refused = expectRefused(
      await w.actions.propose({
        action: 'earmark.delete',
        params: { earmarkId: 'earmark_missing' },
        provenance: PROVENANCE,
      }),
    );
    expect(refused.guardrails.map((rule) => rule.rule)).toEqual([GUARDRAIL_RULES.earmarkActive]);
  });

  it('rejects undoing the same action twice', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    await approveAndExecute(w, proposed.proposal.proposalId);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error('expected an undo proposal');
    await approveAndExecute(w, undo.proposal.proposalId);

    const second = await w.actions.propose({
      action: 'undo',
      params: { auditEntryId: (await w.audit.list())[2]!.id },
      provenance: PROVENANCE,
    });
    expect(expectRefused(second).guardrails.map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.undoNotAlreadyUndone,
    );
  });
});

/* ------------------------------------------------------------- provenance */

describe('provenance (PRD Section 6, ST2 to ST4)', () => {
  const fixtures = new URL('../../fixtures/csv/', import.meta.url);

  it('rejects a proposal whose amount comes from the adversarial CSV text', async () => {
    const w = await world();
    const csv = parseStatementCsv(readFileSync(fileURLToPath(new URL('adversarial.csv', fixtures)), 'utf8'));
    const flagged = csv.rows.find((row) => row.injectionSignal);
    expect(flagged).toBeDefined();

    const result = await w.actions.propose({
      action: 'earmark.create',
      params: {
        label: 'Imported from statement',
        amount: absMoney(flagged!.amount),
        reviewDate: '2027-01-13',
      },
      provenance: {
        requestedBy: 'agent_turn_9',
        untrustedInputs: [{ source: 'csv', ref: `line ${flagged!.line}`, fields: ['amount'] }],
      },
    });

    const refused = expectRefused(result);
    expect(refused.reason).toMatch(/untrusted text cannot set the action, the amount or the target account/);
    expect(await w.repos.earmarks.all()).toEqual([]);
  });

  it('rejects an untrusted target account', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const refused = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: { fromAccountId: 'acc_bank', toAccountId: 'acc_sandbox', amount: toMoney(100_000) },
        provenance: {
          requestedBy: 'agent_turn_9',
          untrustedInputs: [{ source: 'document', ref: 'policy.pdf p4', fields: ['toAccountId'] }],
        },
      }),
    );
    expect(refused.reason).toMatch(/untrusted text/);
  });

  it('allows an untrusted label, which is only text', async () => {
    const w = await world();
    const result = await w.actions.propose({
      action: 'earmark.create',
      params: earmarkParams({ label: 'Medical reserve (policy clause 4.2)' }),
      provenance: {
        requestedBy: 'agent_turn_3',
        untrustedInputs: [{ source: 'document', ref: 'health-policy.pdf p2', fields: ['label'] }],
      },
    });
    expect(result.kind).toBe('proposal');
  });

  it('normalises dotted and mixed-case parameter paths', async () => {
    const w = await world();
    const refused = expectRefused(
      await w.actions.propose({
        action: 'earmark.create',
        params: earmarkParams(),
        provenance: {
          requestedBy: 'agent_turn_9',
          untrustedInputs: [{ source: 'chat', ref: 'paste', fields: ['params.Amount'] }],
        },
      }),
    );
    expect(refused.reason).toMatch(/untrusted text/);
  });
});

/* ------------------------------------------------------- T3 transfer (ACT-4, ACT-7) */

describe('T3 transfer (ACT-4, ACT-7)', () => {
  const transferParams = (overrides: Record<string, unknown> = {}) => ({
    fromAccountId: 'acc_bank',
    toAccountId: 'acc_sandbox',
    amount: toMoney(1_000_000),
    ...overrides,
  });

  it('refuses a transfer with a plain reason when SIM_T3 is false, and logs it (ST1)', async () => {
    const w = await world();
    const result = await w.actions.propose({
      action: 'transfer',
      params: transferParams(),
      provenance: { requestedBy: 'user_turn_7', untrustedInputs: [] },
    });

    const refused = expectRefused(result);
    expect(refused.reason).toMatch(/moving money is not enabled in this build/);
    expect(refused.reason).toMatch(/earmark/);

    const entries = await w.audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'refused', action: 'transfer', proposalId: null });
    expect(await w.repos.proposals.all()).toEqual([]);
  });

  it('refuses a transfer to an account the user does not own', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const refused = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: transferParams({ toAccountId: 'acc_someone_else' }),
        provenance: PROVENANCE,
      }),
    );
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transferOwnAccounts,
    );
  });

  it('refuses a transfer from an e-wallet account', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const refused = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: transferParams({ fromAccountId: 'acc_ewallet', toAccountId: 'acc_bank' }),
        provenance: PROVENANCE,
      }),
    );
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transferOwnAccounts,
    );
  });

  it('refuses a transfer above the per-transfer cap', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const refused = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: transferParams({ amount: toMoney(2_000_001) }),
        provenance: PROVENANCE,
      }),
    );
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transferPerTransferCap,
    );
  });

  it('enforces the daily cap across several transfers', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    for (const expectedKind of ['executed', 'executed']) {
      const result = await w.actions.propose({
        action: 'transfer',
        params: transferParams({ amount: toMoney(2_000_000) }),
        provenance: PROVENANCE,
      });
      if (result.kind !== 'proposal') throw new Error('expected a proposal');
      const executed = await approveAndExecute(w, result.proposal.proposalId, TEST_DEMO_PIN);
      expect(executed.kind).toBe(expectedKind);
    }

    const third = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: transferParams({ amount: toMoney(2_000_000) }),
        provenance: PROVENANCE,
      }),
    );
    expect(third.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transferDailyCap,
    );
  });

  it('moves money between the user\u2019s own accounts, labelled SIMULATION, and reverses on undo', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);
    const before = await w.actions.snapshot();

    const result = await w.actions.propose({
      action: 'transfer',
      params: transferParams({ amount: toMoney(2_000_000) }),
      provenance: PROVENANCE,
    });
    if (result.kind !== 'proposal') throw new Error('expected a proposal');
    expect(result.proposal.tier).toBe('T3');

    const executed = await approveAndExecute(w, result.proposal.proposalId, TEST_DEMO_PIN);
    expect(executed.kind).toBe('executed');

    const after = await w.actions.snapshot();
    expect(after.balancesByAccount['acc_bank']).toBe((before.balancesByAccount['acc_bank'] ?? 0) - 2_000_000);
    expect(after.balancesByAccount['acc_sandbox']).toBe(2_000_000);
    expect(after.totalBalance).toBe(before.totalBalance);

    const transferEntry = (await w.audit.list()).find((entry) => entry.event === 'executed');
    expect(transferEntry?.detail).toMatch(/SIMULATION/);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error('expected an undo proposal');
    await approveAndExecute(w, undo.proposal.proposalId, TEST_DEMO_PIN);

    const restored = await w.actions.snapshot();
    expect(restored.balancesByAccount['acc_bank']).toBe(before.balancesByAccount['acc_bank']);
    expect(restored.balancesByAccount['acc_sandbox']).toBe(before.balancesByAccount['acc_sandbox']);
  });

  it('requires a step-up PIN for a simulated transfer', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const result = await w.actions.propose({
      action: 'transfer',
      params: transferParams(),
      provenance: PROVENANCE,
    });
    if (result.kind !== 'proposal') throw new Error('expected a proposal');

    const token = await w.issueToken(result.proposal.proposalId);
    const withoutPin = await w.actions.approve({
      proposalId: result.proposal.proposalId,
      token: token.token,
    });
    expect(withoutPin).toEqual({ kind: 'rejected', reason: 'step-up PIN required for a simulated transfer' });

    const wrongPin = await w.actions.approve({
      proposalId: result.proposal.proposalId,
      token: token.token,
      pin: '000000',
    });
    expect(wrongPin.kind).toBe('rejected');

    // A mistyped PIN must not burn the one-time token.
    const withPin = await w.actions.approve({
      proposalId: result.proposal.proposalId,
      token: token.token,
      pin: TEST_DEMO_PIN,
    });
    expect(withPin.kind).toBe('approved');
  });

  it('refuses a transfer larger than the source account balance', async () => {
    const w = await world();
    await w.settings.update({ featureFlags: { simT3: true } }, TEST_DEMO_PIN);

    const refused = expectRefused(
      await w.actions.propose({
        action: 'transfer',
        params: transferParams({ fromAccountId: 'acc_sandbox', amount: toMoney(500_000) }),
        provenance: PROVENANCE,
      }),
    );
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.transferSourceBalance,
    );
  });
});

/* ------------------------------------------------------------------ staleness */

describe('staleness (ST8)', () => {
  it('blocks execution when the ledger is older than staleDataHours', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    const token = await w.issueToken(proposed.proposal.proposalId);
    expect(
      (await w.actions.approve({ proposalId: proposed.proposal.proposalId, token: token.token })).kind,
    ).toBe('approved');

    w.setNow('2026-10-16T09:00:00+07:00');
    const blocked = await w.actions.execute(proposed.proposal.proposalId);

    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.reason).toMatch(/refresh/);
    expect(await w.repos.earmarks.all()).toEqual([]);
    expect((await w.audit.list()).at(-1)).toMatchObject({ event: 'refused' });
  });

  it('allows execution while the ledger is fresh', async () => {
    const w = await world();
    const proposed = await proposeEarmark(w);
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');
    expect((await approveAndExecute(w, proposed.proposal.proposalId)).kind).toBe('executed');
  });

  it('reports staleness for the UI banner', async () => {
    const w = await world();
    expect((await w.actions.staleness()).stale).toBe(false);
    w.setNow('2026-10-16T09:00:00+07:00');
    const report = await w.actions.staleness();
    expect(report.stale).toBe(true);
    expect(report.ageHours).toBeGreaterThan(24);
  });
});

/* ------------------------------------------------------------------- settings */

describe('settings (PRD Section 6, ST6)', () => {
  it('has no action that can change settings', async () => {
    for (const name of ACTION_NAMES) {
      expect(name).not.toMatch(/settings/i);
    }

    const w = await world();
    for (const name of ['settings.update', 'settings.set', 'admin.setLimits', 'set_perActionCap']) {
      const refused = expectRefused(
        await w.actions.propose({
          action: name,
          params: { perActionCap: toMoney(999_999_999) },
          provenance: PROVENANCE,
        }),
      );
      expect(refused.reason).toMatch(/not in the action registry/);
    }

    const settings = await w.settings.get();
    expect(settings.perActionCap).toBe(10_000_000);
    expect(settings.featureFlags.simT3).toBe(false);
  });

  it('refuses a settings change with the wrong PIN', async () => {
    const w = await world();
    const result = await w.settings.update({ perActionCap: toMoney(1) }, '999999');
    expect(result).toEqual({ ok: false, reason: 'wrong PIN' });
    expect((await w.settings.get()).perActionCap).toBe(10_000_000);
  });

  it('applies a settings change with the correct PIN', async () => {
    const w = await world();
    const result = await w.settings.update({ perActionCap: toMoney(4_000_000) }, TEST_DEMO_PIN);
    expect(result.ok).toBe(true);
    expect((await w.settings.get()).perActionCap).toBe(4_000_000);

    // The new cap is enforced by the guardrails immediately.
    const refused = expectRefused(await proposeEarmark(w, { amount: toMoney(4_500_000) }));
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      GUARDRAIL_RULES.perActionCap,
    );
  });

  it('rejects an invalid settings value', async () => {
    const w = await world();
    const result = await w.settings.update({ staleDataHours: 0 }, TEST_DEMO_PIN);
    expect(result.ok).toBe(false);
  });
});

/* --------------------------------------------------------------- idempotency */

describe('idempotency', () => {
  it('refuses to execute the same intent twice under one idempotency key', async () => {
    const w = await world();
    const key = 'fixed-idempotency-key';

    const first = await w.actions.propose({
      action: 'earmark.create',
      params: earmarkParams({ label: 'First' }),
      provenance: PROVENANCE,
      idempotencyKey: key,
    });
    if (first.kind !== 'proposal') throw new Error('expected a proposal');
    expect((await approveAndExecute(w, first.proposal.proposalId)).kind).toBe('executed');

    // A second proposal carrying the same key is refused outright.
    const second = await w.actions.propose({
      action: 'earmark.create',
      params: earmarkParams({ label: 'Second' }),
      provenance: PROVENANCE,
      idempotencyKey: key,
    });
    expect(expectRefused(second).reason).toMatch(/already proposed/);

    // A restored copy of the same intent cannot execute a second time either.
    const stored = await w.repos.proposals.byId(first.proposal.proposalId);
    await w.db.proposals.put({
      ...stored!,
      proposalId: 'p_restored_copy',
      status: 'approved',
    });
    const replay = await w.actions.execute('p_restored_copy');
    expect(replay.kind).toBe('blocked');
    if (replay.kind === 'blocked') expect(replay.reason).toMatch(/already executed/);

    expect(await w.repos.earmarks.all()).toHaveLength(1);
  });
});
