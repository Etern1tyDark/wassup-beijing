import { randomHex } from '../domain/ids';
import { addMoney, subMoney, toMoney } from '../domain/money';
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
import { toIsoDate } from '../domain/time';
import { buildSnapshot, type LedgerInput, type LedgerSnapshot } from '../ledger/engine';
import type { AuditLog } from '../audit/log';
import type { AppDatabase } from '../storage/db';
import type { Repositories } from '../storage/repositories';
import type { ApprovalService, ApprovalToken } from './approvals';
import type { Clock } from './clock';
import { createExecutor } from './executor';
import {
  allPass,
  checkEarmarkCreateGuardrails,
  checkEarmarkDeleteGuardrails,
  checkTransferGuardrails,
  checkUndoGuardrails,
  failedRules,
  GUARDRAIL_RULES,
  type EarmarkGuardrailContext,
} from './guardrails';
import { parseActionParams, type ParsedActionParams } from './params';
import { hashProposal } from './proposal-hash';
import { checkProvenance } from './provenance';
import { lookupAction, requiresApproval, type ActionDefinition } from './registry';
import { verifyPin } from './pin';
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
      case 'undo': {
        const entry = await repos.audit.byId(parsed.params.auditEntryId);
        return checkUndoGuardrails(parsed.params, {
          entry,
          reversible: entry ? (lookupAction(entry.action ?? '')?.reversible ?? false) : false,
          alreadyUndone: entry ? await isAlreadyUndone(entry) : false,
        });
      }
    }
  }

  async function diffFor(
    parsed: ParsedActionParams,
    current: LedgerSnapshot,
    activeEarmarks: readonly Earmark[],
  ): Promise<ProposalDiff> {
    const count = activeEarmarks.length;

    switch (parsed.action) {
      case 'earmark.create': {
        const amount = parsed.params.amount;
        return {
          safeToSpend: { before: current.safeToSpend, after: subMoney(current.safeToSpend, amount) },
          freeCash: { before: current.freeCash, after: subMoney(current.freeCash, amount) },
          activeEarmarks: { before: count, after: count + 1 },
        };
      }
      case 'earmark.delete': {
        const earmark = activeEarmarks.find((candidate) => candidate.id === parsed.params.earmarkId);
        const amount = earmark?.amount ?? toMoney(0);
        return {
          safeToSpend: { before: current.safeToSpend, after: addMoney(current.safeToSpend, amount) },
          freeCash: { before: current.freeCash, after: addMoney(current.freeCash, amount) },
          activeEarmarks: { before: count, after: Math.max(0, count - 1) },
        };
      }
      case 'transfer': {
        // A simulated transfer moves money between the user's own accounts, so
        // the totals do not change.
        return {
          safeToSpend: { before: current.safeToSpend, after: current.safeToSpend },
          freeCash: { before: current.freeCash, after: current.freeCash },
          activeEarmarks: { before: count, after: count },
        };
      }
      case 'undo': {
        const entry = await repos.audit.byId(parsed.params.auditEntryId);
        const original = entry?.proposalId ? await repos.proposals.byId(entry.proposalId) : undefined;
        const amount = typeof original?.params?.['amount'] === 'number' ? original.params['amount'] : 0;
        const restored = toMoney(entry?.action === 'earmark.delete' ? -amount : amount);
        return {
          safeToSpend: { before: current.safeToSpend, after: addMoney(current.safeToSpend, restored) },
          freeCash: { before: current.freeCash, after: addMoney(current.freeCash, restored) },
          activeEarmarks: {
            before: count,
            after: entry?.action === 'earmark.delete' ? count + 1 : Math.max(0, count - 1),
          },
        };
      }
    }
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

    const currentSnapshot = await snapshot();
    const earmarks = await repos.earmarks.all();
    const guardrails = await guardrailsFor(parsed.value, {
      snapshot: currentSnapshot,
      settings: currentSettings,
      activeEarmarks: earmarks.filter((earmark) => earmark.active),
    });

    if (!allPass(guardrails)) {
      const reasons = guardrails
        .filter((result) => !result.pass)
        .map((result) => `${result.rule}: ${result.detail}`)
        .join('; ');
      return refuse(input, `refused by guardrails: ${reasons}`, guardrails);
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
      diff: await diffFor(parsed.value, currentSnapshot, earmarks.filter((earmark) => earmark.active)),
      guardrails,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MINUTES * 60_000).toISOString(),
      idempotencyKey: input.idempotencyKey ?? randomHex(16),
      createdAt: now.toISOString(),
    };

    const proposal = ProposalSchema.parse({ ...unsigned, status: 'pending', proposalHash: await hashProposal(unsigned) });
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

  async function pending(): Promise<Proposal[]> {
    return repos.proposals.byStatus('pending');
  }

  async function issueApprovalToken(proposalId: string): Promise<ApprovalToken> {
    const proposal = await repos.proposals.byId(proposalId);
    if (!proposal) throw new Error(`proposal ${proposalId} does not exist`);
    return approvals.issue(proposal, clock.now());
  }

  async function approve(input: {
    proposalId: string;
    token: string;
    pin?: string;
  }): Promise<ApproveResult> {
    const proposal = await repos.proposals.byId(input.proposalId);
    if (!proposal) return { kind: 'rejected', reason: `proposal ${input.proposalId} does not exist` };
    if (proposal.status !== 'pending') {
      return { kind: 'rejected', reason: `proposal is ${proposal.status}, not pending` };
    }

    const now = clock.now();
    if (new Date(proposal.expiresAt).getTime() < now.getTime()) {
      await db.proposals.put({ ...proposal, status: 'expired' });
      await audit.append({
        actor: 'system',
        event: 'refused',
        action: proposal.action,
        proposalId: proposal.proposalId,
        detail: 'proposal expired before approval',
        payload: { expiresAt: proposal.expiresAt },
      });
      return { kind: 'rejected', reason: 'the proposal has expired' };
    }

    // Step-up PIN for T3 (PRD Section 6). Checked before the token is spent so
    // a mistyped PIN does not burn the one-time token.
    if (proposal.tier === 'T3') {
      const currentSettings = await settings();
      if (!input.pin || !(await verifyPin(input.pin, currentSettings.pinHash))) {
        return { kind: 'rejected', reason: 'step-up PIN required for a simulated transfer' };
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

  async function execute(proposalId: string): Promise<ExecuteResult> {
    const proposal = await repos.proposals.byId(proposalId);
    if (!proposal) return { kind: 'blocked', reason: `proposal ${proposalId} does not exist`, auditEntryId: null };
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

    const currentSettings = await settings();
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
    const executed = [...entries].reverse().find((entry) => entry.event === 'executed');
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
    execute,
    pending,
    undoLast,
  };
}

export { GUARDRAIL_RULES };
