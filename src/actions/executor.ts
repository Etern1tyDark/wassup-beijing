import { randomId } from '../domain/ids';
import { negateMoney, absMoney, sumMoney, type Money } from '../domain/money';
import type { Earmark, Proposal, Settings, Transaction } from '../domain/schemas';
import { toIsoDate } from '../domain/time';
import type { AuditLog } from '../audit/log';
import type { Repositories } from '../storage/repositories';
import type { AppDatabase } from '../storage/db';
import { addEarmark, addTransaction, removeTransactions, setEarmarkActive } from '../storage/ledger-writes';
import type { Clock } from './clock';
import type {
  EarmarkCreateParams,
  EarmarkDeleteParams,
  ParsedActionParams,
  TransferParams,
  UndoParams,
} from './params';
import { evaluateStaleness } from './staleness';

/**
 * The action executor (LED-3, ACT-3, ACT-6).
 *
 * This is the only module allowed to import the ledger write API. Every ledger
 * change in the product passes through `execute()` after an approval event, and
 * every change is followed by an audit entry. If the audit append fails, the
 * ledger write is compensated so the two never disagree.
 *
 * `transfer` is simulated only (ACT-7 / D1): it writes two transactions between
 * accounts the user owns, marked SIMULATION, and never touches a payment rail.
 * There is no real money movement anywhere in this codebase.
 */

export const SIMULATED_TRANSFER_CATEGORY = 'simulated-transfer';
export const SIMULATED_TRANSFER_REVERSAL_CATEGORY = 'simulated-transfer-reversal';

export interface ExecutionOutcome {
  ok: boolean;
  reason: string | null;
  detail: string;
  auditEntryId: string | null;
}

export interface ExecutorDeps {
  db: AppDatabase;
  repos: Repositories;
  audit: AuditLog;
  clock: Clock;
}

export interface Executor {
  execute(proposal: Proposal, settings: Settings): Promise<ExecutionOutcome>;
  /** Sum of today's simulated transfer outflows, for the daily cap. */
  simulatedTransfersToday(): Promise<Money>;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { db, repos, audit, clock } = deps;

  async function simulatedTransfersToday(): Promise<Money> {
    const today = toIsoDate(clock.now());
    const transactions = await repos.transactions.all();
    return sumMoney(
      transactions
        .filter(
          (transaction) =>
            transaction.category === SIMULATED_TRANSFER_CATEGORY &&
            transaction.date === today &&
            transaction.amount < 0,
        )
        .map((transaction) => absMoney(transaction.amount)),
    );
  }

  async function blockStale(proposal: Proposal, settings: Settings): Promise<ExecutionOutcome | null> {
    const report = evaluateStaleness({
      latestTransactionDate: await repos.transactions.latestDate(),
      settings,
      now: clock.now(),
    });
    if (!report.stale) return null;

    const entry = await audit.append({
      actor: 'system',
      event: 'refused',
      action: proposal.action,
      proposalId: proposal.proposalId,
      detail: `stale data: ${report.reason ?? 'ledger is out of date'}`,
      payload: { reason: 'stale-data', ageHours: report.ageHours },
    });
    return { ok: false, reason: report.reason, detail: 'blocked: stale data', auditEntryId: entry.id };
  }

  async function execute(proposal: Proposal, settings: Settings): Promise<ExecutionOutcome> {
    const stale = await blockStale(proposal, settings);
    if (stale) return stale;

    const params = proposal.params as ParsedActionParams['params'];

    switch (proposal.action) {
      case 'earmark.create':
        return applyEarmarkCreate(proposal, params as EarmarkCreateParams);
      case 'earmark.delete':
        return applyEarmarkDelete(proposal, params as EarmarkDeleteParams);
      case 'undo':
        return applyUndo(proposal, params as UndoParams);
      case 'transfer':
        return applyTransfer(proposal, params as TransferParams);
      default:
        return {
          ok: false,
          reason: `no executor for ${proposal.action}`,
          detail: 'unimplemented',
          auditEntryId: null,
        };
    }
  }

  async function applyEarmarkCreate(
    proposal: Proposal,
    params: EarmarkCreateParams,
  ): Promise<ExecutionOutcome> {
    const auditId = randomId('aud');
    const earmark: Earmark = {
      id: randomId('earmark'),
      label: params.label,
      amount: params.amount,
      reviewDate: params.reviewDate,
      createdBy: auditId,
      active: true,
    };

    await addEarmark(db, earmark);
    try {
      const entry = await audit.append({
        id: auditId,
        actor: 'system',
        event: 'executed',
        action: 'earmark.create',
        proposalId: proposal.proposalId,
        detail: `set aside ${earmark.amount} for "${earmark.label}" until ${earmark.reviewDate}`,
        payload: { earmarkId: earmark.id, amount: earmark.amount, reviewDate: earmark.reviewDate },
      });
      return {
        ok: true,
        reason: null,
        detail: `earmark ${earmark.id} created`,
        auditEntryId: entry.id,
      };
    } catch (error) {
      // Compensate: the ledger must never move without an audit entry.
      await setEarmarkActive(db, earmark.id, false);
      throw error;
    }
  }

  async function applyEarmarkDelete(
    proposal: Proposal,
    params: EarmarkDeleteParams,
  ): Promise<ExecutionOutcome> {
    await setEarmarkActive(db, params.earmarkId, false);
    try {
      const entry = await audit.append({
        actor: 'system',
        event: 'executed',
        action: 'earmark.delete',
        proposalId: proposal.proposalId,
        detail: `released earmark ${params.earmarkId}`,
        payload: { earmarkId: params.earmarkId },
      });
      return {
        ok: true,
        reason: null,
        detail: `earmark ${params.earmarkId} released`,
        auditEntryId: entry.id,
      };
    } catch (error) {
      await setEarmarkActive(db, params.earmarkId, true);
      throw error;
    }
  }

  async function applyTransfer(proposal: Proposal, params: TransferParams): Promise<ExecutionOutcome> {
    const accounts = await repos.accounts.all();
    const from = accounts.find((account) => account.id === params.fromAccountId);
    const to = accounts.find((account) => account.id === params.toAccountId);
    if (!from || !to) {
      return {
        ok: false,
        reason: 'one of the accounts no longer exists',
        detail: 'refused',
        auditEntryId: null,
      };
    }

    const auditId = randomId('aud');
    const date = toIsoDate(clock.now());
    const out: Transaction = {
      id: `txn_${auditId}_out`,
      accountId: from.id,
      date,
      amount: negateMoney(params.amount),
      merchant: `SIMULATED TRANSFER to ${to.name}`,
      category: SIMULATED_TRANSFER_CATEGORY,
      source: 'action',
      untrusted: false,
    };
    const inflow: Transaction = {
      id: `txn_${auditId}_in`,
      accountId: to.id,
      date,
      amount: params.amount,
      merchant: `SIMULATED TRANSFER from ${from.name}`,
      category: SIMULATED_TRANSFER_CATEGORY,
      source: 'action',
      untrusted: false,
    };

    await addTransaction(db, out);
    try {
      await addTransaction(db, inflow);
    } catch (error) {
      await compensateTransactions([out.id]);
      throw error;
    }

    try {
      const entry = await audit.append({
        id: auditId,
        actor: 'system',
        event: 'executed',
        action: 'transfer',
        proposalId: proposal.proposalId,
        detail: `SIMULATION: moved ${params.amount} from ${from.name} to ${to.name}; no real money moved`,
        payload: { fromAccountId: from.id, toAccountId: to.id, amount: params.amount, simulation: true },
      });
      return {
        ok: true,
        reason: null,
        detail: `simulated transfer ${out.id}/${inflow.id}`,
        auditEntryId: entry.id,
      };
    } catch (error) {
      await compensateTransactions([out.id, inflow.id]);
      throw error;
    }
  }

  async function applyUndo(proposal: Proposal, params: UndoParams): Promise<ExecutionOutcome> {
    const original = await repos.audit.byId(params.auditEntryId);
    if (!original) {
      return { ok: false, reason: 'the audit entry no longer exists', detail: 'refused', auditEntryId: null };
    }

    const reversal = await reverseEffect(original.action, original.id, original.proposalId);
    if (!reversal.ok) {
      return { ok: false, reason: reversal.reason, detail: 'refused', auditEntryId: null };
    }

    try {
      const entry = await audit.append({
        actor: 'system',
        event: 'undone',
        action: 'undo',
        // The convention: an undo entry points at the proposal it reverts.
        proposalId: original.proposalId,
        detail: `undid ${original.action ?? 'action'} (audit ${original.id}): ${reversal.detail}`,
        payload: {
          undoneAuditEntryId: original.id,
          action: original.action,
          undoProposalId: proposal.proposalId,
        },
      });
      return { ok: true, reason: null, detail: reversal.detail, auditEntryId: entry.id };
    } catch (error) {
      await reversal.compensate();
      throw error;
    }
  }

  async function reverseEffect(
    action: string | null,
    originalAuditEntryId: string,
    originalProposalId: string | null,
  ): Promise<{ ok: true; detail: string; compensate: () => Promise<void> } | { ok: false; reason: string }> {
    if (action === 'earmark.create') {
      const earmarks = await repos.earmarks.all();
      const earmark = earmarks.find((candidate) => candidate.createdBy === originalAuditEntryId);
      if (!earmark) return { ok: false, reason: 'the earmark created by that action no longer exists' };
      await setEarmarkActive(db, earmark.id, false);
      return {
        ok: true,
        detail: `earmark ${earmark.id} released`,
        compensate: async () => setEarmarkActive(db, earmark.id, true),
      };
    }

    if (action === 'earmark.delete') {
      if (!originalProposalId) return { ok: false, reason: 'the original proposal is unknown' };
      const original = await repos.proposals.byId(originalProposalId);
      const earmarkId = original?.params?.['earmarkId'];
      if (typeof earmarkId !== 'string') {
        return { ok: false, reason: `cannot undo ${action}: the original proposal has no earmark reference` };
      }
      await setEarmarkActive(db, earmarkId, true);
      return {
        ok: true,
        detail: `earmark ${earmarkId} restored`,
        compensate: async () => setEarmarkActive(db, earmarkId, false),
      };
    }

    if (action === 'transfer') {
      if (!originalProposalId) return { ok: false, reason: 'the original proposal is unknown' };
      const original = await repos.proposals.byId(originalProposalId);
      const fromAccountId = original?.params?.['fromAccountId'];
      const toAccountId = original?.params?.['toAccountId'];
      const amount = original?.params?.['amount'];
      if (
        typeof fromAccountId !== 'string' ||
        typeof toAccountId !== 'string' ||
        typeof amount !== 'number'
      ) {
        return { ok: false, reason: 'cannot undo the transfer: the original proposal is incomplete' };
      }

      const auditId = randomId('aud');
      const date = toIsoDate(clock.now());
      const back: Transaction = {
        id: `txn_${auditId}_rev_in`,
        accountId: fromAccountId,
        date,
        amount: amount as Money,
        merchant: 'SIMULATED TRANSFER reversal',
        category: SIMULATED_TRANSFER_REVERSAL_CATEGORY,
        source: 'action',
        untrusted: false,
      };
      const forward: Transaction = {
        id: `txn_${auditId}_rev_out`,
        accountId: toAccountId,
        date,
        amount: negateMoney(amount as Money),
        merchant: 'SIMULATED TRANSFER reversal',
        category: SIMULATED_TRANSFER_REVERSAL_CATEGORY,
        source: 'action',
        untrusted: false,
      };

      await addTransaction(db, back);
      try {
        await addTransaction(db, forward);
      } catch (error) {
        await compensateTransactions([back.id]);
        throw error;
      }
      return {
        ok: true,
        detail: `simulated transfer of ${amount} reversed`,
        compensate: async () => compensateTransactions([back.id, forward.id]),
      };
    }

    return { ok: false, reason: `action "${action ?? 'unknown'}" cannot be undone` };
  }

  async function compensateTransactions(ids: readonly string[]): Promise<void> {
    await removeTransactions(db, ids);
  }

  return { execute, simulatedTransfersToday };
}
