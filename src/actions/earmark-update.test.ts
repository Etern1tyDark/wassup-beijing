import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Proposal } from '../domain/schemas';
import { buildForecastInputs, projectForecast } from '../forecast';
import { createAgentWorld, type AgentWorld } from '../testing/agent-world';
import { GUARDRAIL_RULES } from './guardrails';
import { MAX_PENDING_PROPOSALS, PROPOSAL_TTL_MINUTES } from './service';

/**
 * ACT-5: editing an earmark, plus the two controls that keep the approval queue
 * honest: a cap on how many cards may wait, and expiry of the ones nobody
 * decided on.
 */
let w: AgentWorld;
const provenance = { requestedBy: 'ui_earmark_list', untrustedInputs: [] };

beforeEach(async () => {
  w = await createAgentWorld({ seed: true });
});

afterEach(async () => {
  await w.close();
});

async function createEarmark(amount: number): Promise<string> {
  const result = await w.actions.propose({
    action: 'earmark.create',
    params: { label: 'Medical reserve', amount, reviewDate: '2027-01-13' },
    provenance,
  });
  if (result.kind !== 'proposal') throw new Error(result.reason);
  await w.approveAndExecute(result.proposal.proposalId);
  return (await w.repos.earmarks.all())[0]!.id;
}

async function proposeUpdate(params: Record<string, unknown>) {
  return w.actions.propose({ action: 'earmark.update', params, provenance });
}

function failed(result: Awaited<ReturnType<typeof proposeUpdate>>): string[] {
  if (result.kind !== 'refused') throw new Error('expected a refusal');
  return result.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule);
}

describe('earmark.update (ACT-5)', () => {
  it('changes the amount and review date after approval, and undo restores both', async () => {
    const earmarkId = await createEarmark(3_000_000);
    const before = await w.actions.snapshot();

    const result = await proposeUpdate({ earmarkId, amount: 2_000_000, reviewDate: '2027-03-01' });
    if (result.kind !== 'proposal') throw new Error(result.reason);

    // The "before" on the card comes from the ledger.
    expect(result.proposal.params['previous']).toEqual({
      label: 'Medical reserve',
      amount: 3_000_000,
      reviewDate: '2027-01-13',
    });
    expect(result.proposal.diff.freeCash).toEqual({
      before: before.freeCash,
      after: before.freeCash + 1_000_000,
    });
    expect(result.proposal.diff.activeEarmarks).toEqual({ before: 1, after: 1 });
    expect((await w.repos.earmarks.byId(earmarkId))!.amount).toBe(3_000_000);

    expect((await w.approveAndExecute(result.proposal.proposalId)).kind).toBe('executed');
    expect(await w.repos.earmarks.byId(earmarkId)).toMatchObject({
      amount: 2_000_000,
      reviewDate: '2027-03-01',
    });
    expect((await w.actions.snapshot()).freeCash).toBe(before.freeCash + 1_000_000);

    const undo = await w.actions.undoLast('user');
    if (undo.kind !== 'proposal') throw new Error(undo.reason);
    expect(undo.proposal.diff.freeCash).toEqual({
      before: before.freeCash + 1_000_000,
      after: before.freeCash,
    });
    expect((await w.approveAndExecute(undo.proposal.proposalId)).kind).toBe('executed');
    expect(await w.repos.earmarks.byId(earmarkId)).toMatchObject({
      amount: 3_000_000,
      reviewDate: '2027-01-13',
    });
    expect(await w.actions.snapshot()).toEqual(before);
    expect((await w.audit.verify()).ok).toBe(true);
  });

  it('checks an increase against free cash, obligations and the cap', async () => {
    const earmarkId = await createEarmark(1_000_000);
    const snapshot = await w.actions.snapshot();

    expect(failed(await proposeUpdate({ earmarkId, amount: 1_000_000 + snapshot.freeCash + 1 }))).toEqual([
      GUARDRAIL_RULES.increaseWithinFreeCash,
      GUARDRAIL_RULES.obligationsCovered,
      GUARDRAIL_RULES.perActionCap,
    ]);
    // An increase that fits free cash but would eat into the next 30 days of obligations.
    expect(failed(await proposeUpdate({ earmarkId, amount: 1_000_000 + snapshot.safeToSpend + 1 }))).toEqual([
      GUARDRAIL_RULES.obligationsCovered,
    ]);
    // Lowering it is always allowed.
    expect((await proposeUpdate({ earmarkId, amount: 500_000 })).kind).toBe('proposal');
  });

  it('ignores a "previous" value supplied by the caller', async () => {
    const earmarkId = await createEarmark(1_000_000);
    const result = await proposeUpdate({
      earmarkId,
      amount: 900_000,
      previous: { label: 'Forged', amount: 1, reviewDate: '2020-01-01' },
    });
    if (result.kind !== 'proposal') throw new Error(result.reason);
    expect(result.proposal.params['previous']).toEqual({
      label: 'Medical reserve',
      amount: 1_000_000,
      reviewDate: '2027-01-13',
    });
  });

  it('refuses at execution when the earmark changed after the card was made', async () => {
    const earmarkId = await createEarmark(1_000_000);
    const first = await proposeUpdate({ earmarkId, amount: 900_000 });
    const second = await proposeUpdate({ earmarkId, amount: 800_000 });
    if (first.kind !== 'proposal' || second.kind !== 'proposal') throw new Error('expected two proposals');

    expect((await w.approveAndExecute(second.proposal.proposalId)).kind).toBe('executed');
    const stale = await w.approveAndExecute(first.proposal.proposalId);
    expect(stale.kind).toBe('blocked');
    expect(stale.kind === 'blocked' ? stale.reason : '').toContain(GUARDRAIL_RULES.earmarkUnchanged);
    expect((await w.repos.earmarks.byId(earmarkId))!.amount).toBe(800_000);
  });

  it('refuses a change with nothing in it, and a change to a released earmark', async () => {
    const earmarkId = await createEarmark(1_000_000);
    const empty = await proposeUpdate({ earmarkId });
    expect(empty.kind === 'refused' ? empty.reason : '').toContain('give a new label, amount or review date');

    const release = await w.actions.propose({ action: 'earmark.delete', params: { earmarkId }, provenance });
    if (release.kind !== 'proposal') throw new Error(release.reason);
    await w.approveAndExecute(release.proposal.proposalId);
    expect(failed(await proposeUpdate({ earmarkId, amount: 900_000 }))).toEqual([
      GUARDRAIL_RULES.earmarkActive,
    ]);
  });

  it('can be asked for in chat', async () => {
    await createEarmark(3_000_000);
    const turn = await w.agent.send('Lower the medical reserve to Rp 2.000.000');
    const result = turn.toolResults.find((candidate) => candidate.tool === 'earmark.update');
    expect(result?.ok).toBe(true);
    const proposal = (result as { data: { proposal: Proposal } }).data.proposal;
    expect(proposal.params).toMatchObject({ amount: 2_000_000 });
    expect(turn.reply).toContain('I have proposed changing the amount to Rp 2.000.000 on "Medical reserve"');
  });
});

describe('the approval queue', () => {
  it(`refuses a new proposal while ${MAX_PENDING_PROPOSALS} are waiting, and logs it`, async () => {
    for (let index = 0; index < MAX_PENDING_PROPOSALS; index += 1) {
      const result = await w.actions.propose({
        action: 'earmark.create',
        params: { label: `Reserve ${index}`, amount: 100_000, reviewDate: '2027-01-13' },
        provenance,
      });
      expect(result.kind).toBe('proposal');
    }

    const overflow = await w.actions.propose({
      action: 'earmark.create',
      params: { label: 'One too many', amount: 100_000, reviewDate: '2027-01-13' },
      provenance,
    });
    expect(overflow.kind).toBe('refused');
    expect(overflow.kind === 'refused' ? overflow.reason : '').toContain('already waiting for approval');
    expect((await w.audit.list()).at(-1)).toMatchObject({ event: 'refused', action: 'earmark.create' });

    // Deciding on one frees a slot.
    await w.actions.reject((await w.actions.pending())[0]!.proposalId);
    const retry = await w.actions.propose({
      action: 'earmark.create',
      params: { label: 'Now it fits', amount: 100_000, reviewDate: '2027-01-13' },
      provenance,
    });
    expect(retry.kind).toBe('proposal');
  });

  it('expires a card nobody decided on, and the expired card cannot be approved', async () => {
    const result = await w.actions.propose({
      action: 'earmark.create',
      params: { label: 'Forgotten', amount: 100_000, reviewDate: '2027-01-13' },
      provenance,
    });
    if (result.kind !== 'proposal') throw new Error(result.reason);
    const token = await w.issueToken(result.proposal.proposalId);

    w.setNow(new Date(w.clock.now().getTime() + (PROPOSAL_TTL_MINUTES + 1) * 60_000));
    expect(await w.actions.pending()).toEqual([]);
    expect((await w.repos.proposals.byId(result.proposal.proposalId))!.status).toBe('expired');
    expect((await w.audit.list()).at(-1)!.detail).toBe('proposal expired before approval');

    const approved = await w.actions.approve({ proposalId: result.proposal.proposalId, token: token.token });
    expect(approved.kind).toBe('rejected');
    expect(await w.repos.earmarks.all()).toEqual([]);
  });
});

describe('performance (NFR-3)', () => {
  it('projects the seeded forecast in well under 300 ms', async () => {
    const inputs = buildForecastInputs(await w.actions.ledgerInput(), await w.actions.snapshot());
    const started = performance.now();
    for (let run = 0; run < 20; run += 1) projectForecast(inputs);
    expect((performance.now() - started) / 20).toBeLessThan(300);
  });
});
