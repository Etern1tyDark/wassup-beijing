import { randomHex } from '../domain/ids';
import { addMoney, negateMoney, sumMoney, toMoney, type Money } from '../domain/money';
import {
  ProposalSchema,
  type AuditActor,
  type AuditEntry,
  type Earmark,
  type GuardrailResult,
  type Proposal,
  type ProposalDiff,
  type Provenance,
  type Settings,
} from '../domain/schemas';
import { addDays, toIsoDate } from '../domain/time';
import { buildForecastInputs, computeRunway } from '../forecast';
import { buildSnapshot, type LedgerInput, type LedgerSnapshot } from '../ledger/engine';
import type { AuditLog } from '../audit/log';
import type { AppDatabase } from '../storage/db';
import type { Repositories } from '../storage/repositories';
import type { ApprovalService, ApprovalToken } from './approvals';
import type { Clock } from './clock';
import { createExecutor, transactionIdPrefix } from './executor';
import {
  allPass,
  checkEarmarkCreateGuardrails,
  checkEarmarkDeleteGuardrails,
  checkEarmarkUpdateGuardrails,
  checkStatementImportGuardrails,
  checkTransactionAddGuardrails,
  checkTransferGuardrails,
  checkUndoEffectGuardrails,
  checkUndoGuardrails,
  failedRules,
  GUARDRAIL_RULES,
  type EarmarkGuardrailContext,
  type UndoEffect,
} from './guardrails';
import { parseActionParams, type ParsedActionParams } from './params';
import { hashProposal } from './proposal-hash';
import { checkProvenance } from './provenance';
import { lookupAction, requiresApproval, type ActionDefinition } from './registry';
import { pinGuardFor } from './pin';
import { evaluateStaleness, type StalenessReport } from './staleness';

/**
 * The tier engine (ACT-1 to ACT-6) and the proposal lifecycle.
 *
 * Flow: propose -> (guardrails, provenance, tier) -> pending proposal ->
 * UI approval event with a one-time token -> approve -> execute.
 *
 * Nothing changes before approval, and the model can only reach `propose()`.
 */

export const PROPOSAL_TTL_MINUTES = 15;

/**
 * Approval fatigue is a risk in its own right (PRD Section 10): a user facing a
 * pile of cards stops reading them. No more than this many proposals may wait
 * at once; the next one is refused until the user decides on the existing ones.
 */
export const MAX_PENDING_PROPOSALS = 5;

export interface ProposeInput {
  action: string;
  params: unknown;
  provenance: Provenance;
  actor?: AuditActor;
  idempotencyKey?: string;
}

export type ProposeResult =
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'refused'; reason: string; auditEntryId: string; guardrails: GuardrailResult[] };

export type ApproveResult = { kind: 'approved'; proposal: Proposal } | { kind: 'rejected'; reason: string };

export type ExecuteResult =
  | { kind: 'executed'; proposal: Proposal; auditEntryId: string; detail: string }
  | { kind: 'blocked'; reason: string; auditEntryId: string | null };

export interface ActionServiceDeps {
  db: AppDatabase;
  repos: Repositories;
  audit: AuditLog;
  approvals: ApprovalService;
  clock: Clock;
}

export interface ActionService {
  ledgerInput(): Promise<LedgerInput>;
  snapshot(): Promise<LedgerSnapshot>;
  staleness(): Promise<StalenessReport>;
  settings(): Promise<Settings>;
  propose(input: ProposeInput): Promise<ProposeResult>;
  issueApprovalToken(proposalId: string): Promise<ApprovalToken>;
  approve(input: { proposalId: string; token: string; pin?: string }): Promise<ApproveResult>;
  reject(proposalId: string, actor?: AuditActor): Promise<{ kind: 'rejected'; reason: string }>;
  execute(proposalId: string): Promise<ExecuteResult>;
  pending(): Promise<Proposal[]>;
  undoLast(actor?: AuditActor): Promise<ProposeResult>;
}

/** What the agent is allowed to see: propose, and read. Never approve. */
export type ProposalPort = Pick<ActionService, 'propose'>;

export function createActionService(deps: ActionServiceDeps): ActionService {
  const { db, repos, audit, approvals, clock } = deps;
  const executor = createExecutor({ db, repos, audit, clock });

  // Executions are serialised. Guardrails read the ledger and the write happens
  // later, so two concurrent executions could otherwise both pass the same daily
  // cap check and both write.
  let executionTail: Promise<unknown> = Promise.resolve();
  function enqueueExecution<T>(operation: () => Promise<T>): Promise<T> {
    const next = executionTail.then(operation, operation);
    executionTail = next.catch(() => undefined);
    return next;
  }

  async function settings(): Promise<Settings> {
    const current = await repos.settings.get();
    if (!current) throw new Error('settings are not initialised; load the seed data first');
    return current;
  }

  async function ledgerInput(): Promise<LedgerInput> {
    const [accounts, transactions, invoices, obligations, earmarks] = await Promise.all([
      repos.accounts.all(),
      repos.transactions.all(),
      repos.invoices.all(),
      repos.obligations.all(),
      repos.earmarks.all(),
    ]);
    return { accounts, transactions, invoices, obligations, earmarks };
  }

  async function snapshot(): Promise<LedgerSnapshot> {
    return buildSnapshot(await ledgerInput(), toIsoDate(clock.now()));
  }

  async function staleness(): Promise<StalenessReport> {
    return evaluateStaleness({
      latestTransactionDate: await repos.transactions.latestDate(),
      settings: await settings(),
      now: clock.now(),
    });
  }

  async function refuse(
    input: ProposeInput,
    reason: string,
    guardrails: GuardrailResult[] = [],
  ): Promise<ProposeResult> {
    const entry = await audit.append({
      actor: input.actor ?? 'agent',
      event: 'refused',
      action: input.action,
      proposalId: null,
      detail: reason,
      payload: { action: input.action, params: input.params, guardrails: failedRules(guardrails) },
    });
    return { kind: 'refused', reason, auditEntryId: entry.id, guardrails };
  }

  async function isAlreadyUndone(entry: AuditEntry): Promise<boolean> {
    if (!entry.proposalId) return false;
    const entries = await repos.audit.byProposal(entry.proposalId);
    return entries.some((candidate) => candidate.event === 'undone');
  }

  async function guardrailsFor(
    parsed: ParsedActionParams,
    context: { snapshot: LedgerSnapshot; settings: Settings; activeEarmarks: Earmark[] },
  ): Promise<GuardrailResult[]> {
    switch (parsed.action) {
      case 'earmark.create': {
        const earmarkContext: EarmarkGuardrailContext = {
          snapshot: context.snapshot,
          settings: context.settings,
          activeEarmarkCount: context.activeEarmarks.length,
        };
        return checkEarmarkCreateGuardrails(parsed.params, earmarkContext);
      }
      case 'earmark.update': {
        return checkEarmarkUpdateGuardrails(parsed.params, {
          earmark: await repos.earmarks.byId(parsed.params.earmarkId),
          snapshot: context.snapshot,
          settings: context.settings,
        });
      }
      case 'earmark.delete': {
        const earmark = await repos.earmarks.byId(parsed.params.earmarkId);
        return checkEarmarkDeleteGuardrails(parsed.params, { earmark });
      }
      case 'transfer': {
        return checkTransferGuardrails(parsed.params, {
          accounts: await repos.accounts.all(),
          settings: context.settings,
          simulatedTransfersToday: await executor.simulatedTransfersToday(),
          accountBalances: context.snapshot.balancesByAccount,
        });
      }
      case 'statement.import': {
        return checkStatementImportGuardrails(parsed.params, {
          accounts: await repos.accounts.all(),
          transactions: await repos.transactions.all(),
          today: context.snapshot.asOf,
          earliest: addDays(context.snapshot.asOf, -366),
        });
      }
      case 'transaction.add': {
        return checkTransactionAddGuardrails(parsed.params, {
          accounts: await repos.accounts.all(),
          settings: context.settings,
          accountBalances: context.snapshot.balancesByAccount,
          today: context.snapshot.asOf,
          earliest: addDays(context.snapshot.asOf, -366),
        });
      }
      case 'undo': {
        const entry = await repos.audit.byId(parsed.params.auditEntryId);
        const basic = checkUndoGuardrails(parsed.params, {
          entry,
          reversible: entry ? (lookupAction(entry.action ?? '')?.reversible ?? false) : false,
          alreadyUndone: entry ? await isAlreadyUndone(entry) : false,
        });
        if (!entry || !allPass(basic)) return basic;
        return [
          ...basic,
          ...checkUndoEffectGuardrails(await undoEffect(entry, context.activeEarmarks), {
            snapshot: context.snapshot,
            accounts: await repos.accounts.all(),
          }),
        ];
      }
    }
  }

  /** Net effect of every row of an import whose account is in the ledger. */
  async function importNet(rows: ReadonlyArray<{ account: string; amount: number }>): Promise<number> {
    const names = new Set((await repos.accounts.all()).map((account) => account.name));
    let net = 0;
    for (const row of rows) if (names.has(row.account)) net += row.amount;
    return net;
  }

  /**
   * What a proposal would do to the two things every figure derives from: the
   * money set aside in earmarks and the total balance.
   */
  async function effectOf(
    parsed: ParsedActionParams,
    activeEarmarks: readonly Earmark[],
  ): Promise<{ earmarked: number; balance: number; earmarkCount: number }> {
    const count = activeEarmarks.length;

    switch (parsed.action) {
      case 'earmark.create':
        return { earmarked: parsed.params.amount, balance: 0, earmarkCount: count + 1 };
      case 'earmark.update': {
        const earmark = activeEarmarks.find((candidate) => candidate.id === parsed.params.earmarkId);
        const change = earmark ? (parsed.params.amount ?? earmark.amount) - earmark.amount : 0;
        return { earmarked: change, balance: 0, earmarkCount: count };
      }
      case 'earmark.delete': {
        const earmark = activeEarmarks.find((candidate) => candidate.id === parsed.params.earmarkId);
        return {
          earmarked: negateMoney(earmark?.amount ?? toMoney(0)),
          balance: 0,
          earmarkCount: Math.max(0, count - 1),
        };
      }
      case 'transfer':
        // A simulated transfer moves money between the user's own accounts, so
        // the totals do not change.
        return { earmarked: 0, balance: 0, earmarkCount: count };
      case 'statement.import':
        return { earmarked: 0, balance: await importNet(parsed.params.rows), earmarkCount: count };
      case 'transaction.add':
        return { earmarked: 0, balance: parsed.params.amount, earmarkCount: count };
      case 'undo': {
        const entry = await repos.audit.byId(parsed.params.auditEntryId);
        if (!entry) return { earmarked: 0, balance: 0, earmarkCount: count };
        const effect = await undoEffect(entry, activeEarmarks);
        return {
          earmarked: effect.earmarked,
          balance: sumMoney(Object.values(effect.accountDeltas)),
          earmarkCount: effect.earmarkCount,
        };
      }
    }
  }

  /**
   * What reversing an executed action would do to the ledger as it is now. The
   * figures come from the stored earmark and the rows that execution wrote, not
   * from the original proposal, so the card and the guardrails see the same
   * effect the executor will apply.
   */
  async function undoEffect(entry: AuditEntry, activeEarmarks: readonly Earmark[]): Promise<UndoEffect> {
    const count = activeEarmarks.length;
    const none: UndoEffect = { earmarked: toMoney(0), earmarkCount: count, accountDeltas: {} };
    const original = entry.proposalId ? await repos.proposals.byId(entry.proposalId) : undefined;
    const earmarkId = original?.params?.['earmarkId'];

    switch (entry.action) {
      case 'earmark.create': {
        const earmark = (await repos.earmarks.all()).find((candidate) => candidate.createdBy === entry.id);
        if (!earmark?.active) return none;
        return { ...none, earmarked: negateMoney(earmark.amount), earmarkCount: Math.max(0, count - 1) };
      }
      case 'earmark.delete': {
        const earmark = typeof earmarkId === 'string' ? await repos.earmarks.byId(earmarkId) : undefined;
        if (!earmark || earmark.active) return none;
        return { ...none, earmarked: earmark.amount, earmarkCount: count + 1 };
      }
      case 'earmark.update': {
        const earmark = typeof earmarkId === 'string' ? await repos.earmarks.byId(earmarkId) : undefined;
        const previous = (original?.params?.['previous'] as { amount?: unknown } | undefined)?.amount;
        if (!earmark?.active || typeof previous !== 'number') return none;
        return { ...none, earmarked: toMoney(previous - earmark.amount) };
      }
      case 'statement.import':
      case 'transaction.add': {
        const prefix = transactionIdPrefix(entry.id);
        const accountDeltas: Record<string, Money> = {};
        for (const transaction of await repos.transactions.all()) {
          if (!transaction.id.startsWith(prefix)) continue;
          accountDeltas[transaction.accountId] = toMoney(
            (accountDeltas[transaction.accountId] ?? 0) - transaction.amount,
          );
        }
        return { ...none, accountDeltas };
      }
      default:
        // A transfer between the user's own accounts moves no totals.
        return none;
    }
  }

  /** The before/after figures on the approval card (PRD Section 6, ACT-6). */
  async function diffFor(
    parsed: ParsedActionParams,
    current: LedgerSnapshot,
    ledger: LedgerInput,
  ): Promise<ProposalDiff> {
    const activeEarmarks = ledger.earmarks.filter((earmark) => earmark.active);
    const effect = await effectOf(parsed, activeEarmarks);
    const change = toMoney(effect.balance - effect.earmarked);

    const inputs = buildForecastInputs(ledger, current);
    const runwayAfter = computeRunway({
      ...inputs,
      startingBalance: addMoney(inputs.startingBalance, toMoney(effect.balance)),
      activeEarmarkTotal: addMoney(inputs.activeEarmarkTotal, toMoney(effect.earmarked)),
    });

    return {
      safeToSpend: { before: current.safeToSpend, after: addMoney(current.safeToSpend, change) },
      freeCash: { before: current.freeCash, after: addMoney(current.freeCash, change) },
      runwayMonths: { before: computeRunway(inputs).runwayMonths, after: runwayAfter.runwayMonths },
      activeEarmarks: { before: activeEarmarks.length, after: effect.earmarkCount },
    };
  }

  async function propose(input: ProposeInput): Promise<ProposeResult> {
    const definition: ActionDefinition | undefined = lookupAction(input.action);
    if (!definition) {
      return refuse(input, `refused: "${input.action}" is not in the action registry (ACT-1)`);
    }

    if (!requiresApproval(definition.tier)) {
      return refuse(
        input,
        `refused: ${input.action} is a ${definition.tier} action with no side effects; it is not proposed for approval`,
      );
    }

    const parsed = parseActionParams(input.action, input.params);
    if (!parsed.ok) {
      return refuse(input, `refused: ${parsed.reason}`);
    }

    // The "before" of an earmark change comes from the ledger, never from the caller.
    if (parsed.value.action === 'earmark.update') {
      const earmark = await repos.earmarks.byId(parsed.value.params.earmarkId);
      const { previous: _ignored, ...requested } = parsed.value.params;
      void _ignored;
      parsed.value.params = earmark
        ? {
            ...requested,
            previous: { label: earmark.label, amount: earmark.amount, reviewDate: earmark.reviewDate },
          }
        : requested;
    }

    const provenance = checkProvenance(input.provenance, definition.tier);
    if (!provenance.ok) {
      return refuse(input, provenance.reason ?? 'refused: untrusted input');
    }

    const currentSettings = await settings();

    // ACT-4: T3 money movement is refused with a plain reason and logged.
    if (definition.tier === 'T3' && !currentSettings.featureFlags.simT3) {
      return refuse(
        input,
        'refused: moving money is not enabled in this build. Only reading, drafting and reversible ledger changes are allowed. You can set money aside with an earmark instead.',
      );
    }

    const ledger = await ledgerInput();
    const currentSnapshot = buildSnapshot(ledger, toIsoDate(clock.now()));
    const guardrails = await guardrailsFor(parsed.value, {
      snapshot: currentSnapshot,
      settings: currentSettings,
      activeEarmarks: ledger.earmarks.filter((earmark) => earmark.active),
    });

    if (!allPass(guardrails)) {
      const reasons = guardrails
        .filter((result) => !result.pass)
        .map((result) => `${result.rule}: ${result.detail}`)
        .join('; ');
      return refuse(input, `refused by guardrails: ${reasons}`, guardrails);
    }

    const waiting = await pending();
    if (waiting.length >= MAX_PENDING_PROPOSALS) {
      return refuse(
        input,
        `refused: ${waiting.length} proposals are already waiting for approval. Approve or reject those cards first`,
      );
    }

    if (input.idempotencyKey) {
      const duplicates = await repos.proposals.allByIdempotencyKey(input.idempotencyKey);
      const live = duplicates.find(
        (candidate) => candidate.status !== 'rejected' && candidate.status !== 'expired',
      );
      if (live) {
        return refuse(input, 'refused: this action was already proposed (idempotency key reused)');
      }
    }

    const now = clock.now();
    const unsigned = {
      proposalId: `p_${randomHex(8)}`,
      action: input.action,
      tier: definition.tier,
      params: parsed.value.params as Record<string, unknown>,
      provenance: input.provenance,
      diff: await diffFor(parsed.value, currentSnapshot, ledger),
      guardrails,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MINUTES * 60_000).toISOString(),
      idempotencyKey: input.idempotencyKey ?? randomHex(16),
      createdAt: now.toISOString(),
    };

    const proposal = ProposalSchema.parse({
      ...unsigned,
      status: 'pending',
      proposalHash: await hashProposal(unsigned),
    });
    await db.proposals.put(proposal);

    await audit.append({
      actor: input.actor ?? 'agent',
      event: 'proposed',
      action: proposal.action,
      proposalId: proposal.proposalId,
      detail: `proposed ${proposal.action} (${proposal.tier})`,
      payload: { proposalHash: proposal.proposalHash, params: proposal.params },
    });

    return { kind: 'proposal', proposal };
  }

  async function expire(proposal: Proposal): Promise<void> {
    await db.proposals.put({ ...proposal, status: 'expired' });
    await audit.append({
      actor: 'system',
      event: 'refused',
      action: proposal.action,
      proposalId: proposal.proposalId,
      detail: 'proposal expired before approval',
      payload: { expiresAt: proposal.expiresAt },
    });
  }

  /** Proposals still waiting. One whose time has run out is expired and logged on the way. */
  async function pending(): Promise<Proposal[]> {
    const now = clock.now().getTime();
    const live: Proposal[] = [];
    for (const proposal of await repos.proposals.byStatus('pending')) {
      if (new Date(proposal.expiresAt).getTime() < now) await expire(proposal);
      else live.push(proposal);
    }
    return live;
  }

  async function issueApprovalToken(proposalId: string): Promise<ApprovalToken> {
    const proposal = await repos.proposals.byId(proposalId);
    if (!proposal) throw new Error(`proposal ${proposalId} does not exist`);
    return approvals.issue(proposal, clock.now());
  }

  async function approve(input: { proposalId: string; token: string; pin?: string }): Promise<ApproveResult> {
    const proposal = await repos.proposals.byId(input.proposalId);
    if (!proposal) return { kind: 'rejected', reason: `proposal ${input.proposalId} does not exist` };
    if (proposal.status !== 'pending') {
      return { kind: 'rejected', reason: `proposal is ${proposal.status}, not pending` };
    }

    const now = clock.now();
    if (new Date(proposal.expiresAt).getTime() < now.getTime()) {
      await expire(proposal);
      return { kind: 'rejected', reason: 'the proposal has expired' };
    }

    // Step-up PIN for T3 (PRD Section 6). Checked before the token is spent so
    // a mistyped PIN does not burn the one-time token.
    if (proposal.tier === 'T3') {
      const currentSettings = await settings();
      const pinCheck = await pinGuardFor(db).check(input.pin, currentSettings.pinHash);
      if (!pinCheck.ok) {
        await audit.append({
          actor: 'user',
          event: 'refused',
          action: proposal.action,
          proposalId: proposal.proposalId,
          detail: `step-up PIN refused: ${pinCheck.reason} (${pinCheck.failures} in a row)`,
          payload: { reason: 'pin', failures: pinCheck.failures, locked: pinCheck.locked },
        });
        return {
          kind: 'rejected',
          reason: pinCheck.locked ? pinCheck.reason : 'step-up PIN required for a simulated transfer',
        };
      }
    }

    const consumed = await approvals.consume({ token: input.token, proposal, now });
    if (!consumed.ok) {
      await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: `approval rejected: ${consumed.reason}`,
        payload: { reason: consumed.reason },
      });
      return { kind: 'rejected', reason: consumed.reason };
    }

    const approved = ProposalSchema.parse({ ...proposal, status: 'approved' });
    await db.proposals.put(approved);
    await audit.append({
      actor: 'user',
      event: 'approved',
      action: approved.action,
      proposalId: approved.proposalId,
      detail: `approved ${approved.action}`,
      payload: { proposalHash: approved.proposalHash },
    });

    return { kind: 'approved', proposal: approved };
  }

  async function reject(proposalId: string, actor: AuditActor = 'user') {
    const proposal = await repos.proposals.byId(proposalId);
    if (!proposal) return { kind: 'rejected' as const, reason: `proposal ${proposalId} does not exist` };
    if (proposal.status !== 'pending') {
      return { kind: 'rejected' as const, reason: `proposal is ${proposal.status}, not pending` };
    }
    await db.proposals.put({ ...proposal, status: 'rejected' });
    await audit.append({
      actor,
      event: 'refused',
      action: proposal.action,
      proposalId: proposal.proposalId,
      detail: `the user rejected ${proposal.action}`,
      payload: { proposalHash: proposal.proposalHash },
    });
    return { kind: 'rejected' as const, reason: 'rejected by the user' };
  }

  async function runExecution(proposalId: string): Promise<ExecuteResult> {
    const proposal = await repos.proposals.byId(proposalId);
    if (!proposal)
      return { kind: 'blocked', reason: `proposal ${proposalId} does not exist`, auditEntryId: null };
    if (proposal.status !== 'approved') {
      return {
        kind: 'blocked',
        reason: `nothing changes before approval: this proposal is ${proposal.status}`,
        auditEntryId: null,
      };
    }

    const sameIntent = await repos.proposals.allByIdempotencyKey(proposal.idempotencyKey);
    const alreadyExecuted = sameIntent.find(
      (candidate) => candidate.status === 'executed' && candidate.proposalId !== proposal.proposalId,
    );
    if (alreadyExecuted) {
      return {
        kind: 'blocked',
        reason: 'this action was already executed (idempotency key reused)',
        auditEntryId: null,
      };
    }

    // The proposal must still hash to what was approved. Anything that changed
    // the stored proposal after approval is refused here.
    const currentHash = await hashProposal(proposal);
    if (currentHash !== proposal.proposalHash) {
      const entry = await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: 'refused at execution: the proposal changed after it was approved',
        payload: { reason: 'proposal-hash-mismatch' },
      });
      return {
        kind: 'blocked',
        reason: 'the proposal changed after it was approved',
        auditEntryId: entry.id,
      };
    }

    const currentSettings = await settings();

    // The T3 kill switch is re-read at execution time, not just at propose time.
    if (proposal.tier === 'T3' && !currentSettings.featureFlags.simT3) {
      const entry = await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: 'refused at execution: simulated transfers are disabled',
        payload: { reason: 'sim-t3-disabled' },
      });
      return {
        kind: 'blocked',
        reason: 'refused: simulated transfers are disabled. Nothing was moved.',
        auditEntryId: entry.id,
      };
    }

    // Guardrails are checked again at execution time: the ledger may have moved
    // between approval and execution, and an approval is for a state, not a blank
    // cheque. A proposal that no longer passes is refused and logged.
    const reparsed = parseActionParams(proposal.action, proposal.params);
    if (!reparsed.ok) {
      const entry = await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: `refused at execution: ${reparsed.reason}`,
        payload: { reason: reparsed.reason },
      });
      return { kind: 'blocked', reason: reparsed.reason, auditEntryId: entry.id };
    }

    const [currentSnapshot, allEarmarks] = await Promise.all([snapshot(), repos.earmarks.all()]);
    const rechecked = await guardrailsFor(reparsed.value, {
      snapshot: currentSnapshot,
      settings: currentSettings,
      activeEarmarks: allEarmarks.filter((earmark) => earmark.active),
    });

    if (!allPass(rechecked)) {
      const reasons = rechecked
        .filter((result) => !result.pass)
        .map((result) => `${result.rule}: ${result.detail}`)
        .join('; ');
      const entry = await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: `refused at execution by guardrails: ${reasons}`,
        payload: { guardrails: failedRules(rechecked) },
      });
      return { kind: 'blocked', reason: `refused by guardrails: ${reasons}`, auditEntryId: entry.id };
    }

    const outcome = await executor.execute(proposal, currentSettings);

    if (!outcome.ok) {
      const auditEntryId =
        outcome.auditEntryId ??
        (
          await audit.append({
            actor: 'system',
            event: 'refused',
            action: proposal.action,
            proposalId: proposal.proposalId,
            detail: outcome.reason ?? 'execution refused',
            payload: { reason: outcome.reason },
          })
        ).id;
      return { kind: 'blocked', reason: outcome.reason ?? 'execution refused', auditEntryId };
    }

    const executed = ProposalSchema.parse({ ...proposal, status: 'executed' });
    await db.proposals.put(executed);

    return {
      kind: 'executed',
      proposal: executed,
      auditEntryId: outcome.auditEntryId ?? '',
      detail: outcome.detail,
    };
  }

  async function undoLast(actor: AuditActor = 'user'): Promise<ProposeResult> {
    const entries = await repos.audit.all();
    // Settings changes are logged as executed too, but have no proposal and cannot be undone.
    const executed = [...entries]
      .reverse()
      .find((entry) => entry.event === 'executed' && entry.proposalId !== null);
    if (!executed) {
      return refuse(
        { action: 'undo', params: {}, provenance: { requestedBy: 'ui', untrustedInputs: [] }, actor },
        'refused: there is nothing to undo',
      );
    }
    return propose({
      action: 'undo',
      params: { auditEntryId: executed.id },
      provenance: { requestedBy: actor === 'user' ? 'ui_undo_button' : 'agent_turn', untrustedInputs: [] },
      actor,
    });
  }

  return {
    ledgerInput,
    snapshot,
    staleness,
    settings,
    propose,
    issueApprovalToken,
    approve,
    reject,
    execute: (proposalId) => enqueueExecution(() => runExecution(proposalId)),
    pending,
    undoLast,
  };
}

export { GUARDRAIL_RULES };
