import { addMoney, formatRupiah, minMoney, subMoney, sumMoney, toMoney, type Money } from '../domain/money';
import type { Account, AuditEntry, Earmark, GuardrailResult, Settings, Transaction } from '../domain/schemas';
import type { IsoDate } from '../domain/time';
import type { LedgerSnapshot } from '../ledger/engine';
import {
  MAX_IMPORT_ROWS,
  type EarmarkCreateParams,
  type EarmarkDeleteParams,
  type EarmarkUpdateParams,
  type StatementImportParams,
  type TransactionAddParams,
  type TransferParams,
  type UndoParams,
} from './params';

/**
 * ACT-5 / PRD Section 6: the guardrails that stand between a proposal and the
 * ledger. Every rule is a named, testable function so a violating fixture can
 * point at exactly one rule.
 */
export const MAX_ACTIVE_EARMARKS = 10;

/** No single statement row may move more than this; a bigger figure is a typo or an attack. */
export const MAX_IMPORT_ROW_AMOUNT = toMoney(1_000_000_000);

/** PRD Section 6 simulated T3 limits. Settings can only tighten these. */
export const SIM_T3_PER_TRANSFER_CAP = toMoney(2_000_000);
export const SIM_T3_DAILY_CAP = toMoney(5_000_000);
export const SIM_T3_ALLOWED_ACCOUNT_TYPES: readonly Account['type'][] = ['bank', 'sandbox-savings'];

export const GUARDRAIL_RULES = {
  freeCash: 'amount <= freeCash',
  obligationsCovered: 'leaves obligations due in 30 days covered',
  perActionCap: 'amount <= perActionCap',
  reviewDate: 'reviewDate is set',
  maxActiveEarmarks: `at most ${MAX_ACTIVE_EARMARKS} active earmarks`,
  earmarkActive: 'the earmark exists and is still active',
  earmarkUnchanged: 'the earmark has not changed since this was proposed',
  increaseWithinFreeCash: 'increase <= freeCash',
  transferOwnAccounts: 'both accounts are the user\u2019s own bank or sandbox-savings accounts',
  transferSourceBalance: 'amount <= source account balance',
  transferPerTransferCap: 'amount <= simulated per-transfer cap',
  transferDailyCap: 'today\u2019s simulated transfers + amount <= simulated daily cap',
  importKnownAccounts: 'every row names an account in the ledger',
  importNoDuplicates: 'no row is already in the ledger',
  importNotInFuture: 'no row is dated after today',
  importRowCount: `at most ${MAX_IMPORT_ROWS} rows`,
  importRowSize: 'every row is at most Rp 1.000.000.000',
  importNotTooOld: 'no row is more than a year old',
  transactionAccount: 'the account is in the ledger',
  transactionDate: 'the date is within the last year and not after today',
  transactionCap: 'amount <= perActionCap',
  transactionBalance: 'does not take the account below zero',
  undoReversible: 'the referenced action was executed and is reversible',
  undoNotAlreadyUndone: 'the referenced action has not been undone already',
} as const;

function pass(rule: string, detail: string): GuardrailResult {
  return { rule, pass: true, detail };
}

function fail(rule: string, detail: string): GuardrailResult {
  return { rule, pass: false, detail };
}

export interface EarmarkGuardrailContext {
  snapshot: LedgerSnapshot;
  settings: Settings;
  activeEarmarkCount: number;
}

export function checkEarmarkCreateGuardrails(
  params: EarmarkCreateParams,
  context: EarmarkGuardrailContext,
): GuardrailResult[] {
  const { snapshot, settings } = context;
  const results: GuardrailResult[] = [];

  results.push(
    params.amount <= snapshot.freeCash
      ? pass(
          GUARDRAIL_RULES.freeCash,
          `${formatRupiah(params.amount)} of ${formatRupiah(snapshot.freeCash)} free cash`,
        )
      : fail(
          GUARDRAIL_RULES.freeCash,
          `${formatRupiah(params.amount)} exceeds free cash of ${formatRupiah(snapshot.freeCash)}`,
        ),
  );

  results.push(
    params.amount <= snapshot.safeToSpend
      ? pass(
          GUARDRAIL_RULES.obligationsCovered,
          `${formatRupiah(snapshot.safeToSpend)} stays available after obligations due in 30 days`,
        )
      : fail(
          GUARDRAIL_RULES.obligationsCovered,
          `would leave ${formatRupiah(subMoney(snapshot.safeToSpend, params.amount))} for obligations due in 30 days (${formatRupiah(snapshot.obligationsDueIn30Days)})`,
        ),
  );

  results.push(
    params.amount <= settings.perActionCap
      ? pass(GUARDRAIL_RULES.perActionCap, `per-action cap is ${formatRupiah(settings.perActionCap)}`)
      : fail(
          GUARDRAIL_RULES.perActionCap,
          `${formatRupiah(params.amount)} exceeds the per-action cap of ${formatRupiah(settings.perActionCap)}`,
        ),
  );

  results.push(
    params.reviewDate.length === 10
      ? pass(GUARDRAIL_RULES.reviewDate, `review date ${params.reviewDate}`)
      : fail(GUARDRAIL_RULES.reviewDate, 'a review date is required'),
  );

  results.push(
    context.activeEarmarkCount < MAX_ACTIVE_EARMARKS
      ? pass(
          GUARDRAIL_RULES.maxActiveEarmarks,
          `${context.activeEarmarkCount} of ${MAX_ACTIVE_EARMARKS} active`,
        )
      : fail(
          GUARDRAIL_RULES.maxActiveEarmarks,
          `${context.activeEarmarkCount} active earmarks already; the limit is ${MAX_ACTIVE_EARMARKS}`,
        ),
  );

  return results;
}

export function checkEarmarkDeleteGuardrails(
  params: EarmarkDeleteParams,
  context: { earmark: Earmark | undefined },
): GuardrailResult[] {
  if (!context.earmark) {
    return [fail(GUARDRAIL_RULES.earmarkActive, `earmark ${params.earmarkId} does not exist`)];
  }
  if (!context.earmark.active) {
    return [fail(GUARDRAIL_RULES.earmarkActive, `earmark ${params.earmarkId} is already inactive`)];
  }
  return [pass(GUARDRAIL_RULES.earmarkActive, `${context.earmark.label} is active`)];
}

export interface EarmarkUpdateGuardrailContext {
  earmark: Earmark | undefined;
  snapshot: LedgerSnapshot;
  settings: Settings;
}

export function checkEarmarkUpdateGuardrails(
  params: EarmarkUpdateParams,
  context: EarmarkUpdateGuardrailContext,
): GuardrailResult[] {
  const { earmark, snapshot, settings } = context;
  if (!earmark) return [fail(GUARDRAIL_RULES.earmarkActive, `earmark ${params.earmarkId} does not exist`)];
  if (!earmark.active) {
    return [fail(GUARDRAIL_RULES.earmarkActive, `earmark ${params.earmarkId} is already inactive`)];
  }

  const results: GuardrailResult[] = [pass(GUARDRAIL_RULES.earmarkActive, `${earmark.label} is active`)];

  const previous = params.previous;
  const unchanged =
    previous !== undefined &&
    previous.label === earmark.label &&
    previous.amount === earmark.amount &&
    previous.reviewDate === earmark.reviewDate;
  results.push(
    unchanged
      ? pass(
          GUARDRAIL_RULES.earmarkUnchanged,
          `still ${formatRupiah(earmark.amount)} until ${earmark.reviewDate}`,
        )
      : fail(
          GUARDRAIL_RULES.earmarkUnchanged,
          'the earmark was changed after this card was made; propose the change again',
        ),
  );

  const amount = params.amount ?? earmark.amount;
  const increase = subMoney(amount, earmark.amount);

  // Lowering an earmark frees money, so only an increase is checked against cash.
  results.push(
    increase <= snapshot.freeCash
      ? pass(
          GUARDRAIL_RULES.increaseWithinFreeCash,
          increase > 0
            ? `${formatRupiah(increase)} more, of ${formatRupiah(snapshot.freeCash)} free cash`
            : 'the amount does not go up',
        )
      : fail(
          GUARDRAIL_RULES.increaseWithinFreeCash,
          `${formatRupiah(increase)} more exceeds free cash of ${formatRupiah(snapshot.freeCash)}`,
        ),
  );

  results.push(
    increase <= snapshot.safeToSpend
      ? pass(
          GUARDRAIL_RULES.obligationsCovered,
          `${formatRupiah(subMoney(snapshot.safeToSpend, increase))} stays available after obligations due in 30 days`,
        )
      : fail(
          GUARDRAIL_RULES.obligationsCovered,
          `would leave ${formatRupiah(subMoney(snapshot.safeToSpend, increase))} for obligations due in 30 days (${formatRupiah(snapshot.obligationsDueIn30Days)})`,
        ),
  );

  results.push(
    amount <= settings.perActionCap
      ? pass(GUARDRAIL_RULES.perActionCap, `per-action cap is ${formatRupiah(settings.perActionCap)}`)
      : fail(
          GUARDRAIL_RULES.perActionCap,
          `${formatRupiah(amount)} exceeds the per-action cap of ${formatRupiah(settings.perActionCap)}`,
        ),
  );

  return results;
}

export interface TransferGuardrailContext {
  accounts: readonly Account[];
  settings: Settings;
  /** Sum of today's simulated transfers, from both accounts. */
  simulatedTransfersToday: Money;
  /** Balance per account id, from the ledger engine. */
  accountBalances: Record<string, Money>;
}

export function checkTransferGuardrails(
  params: TransferParams,
  context: TransferGuardrailContext,
): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const from = context.accounts.find((account) => account.id === params.fromAccountId);
  const to = context.accounts.find((account) => account.id === params.toAccountId);

  const owned = (account: Account | undefined): boolean =>
    account !== undefined && SIM_T3_ALLOWED_ACCOUNT_TYPES.includes(account.type);

  if (from === undefined || to === undefined) {
    results.push(
      fail(
        GUARDRAIL_RULES.transferOwnAccounts,
        'one of the accounts is not in the ledger, so the user does not own it',
      ),
    );
  } else if (from.id === to.id) {
    results.push(fail(GUARDRAIL_RULES.transferOwnAccounts, 'source and destination are the same account'));
  } else if (!owned(from) || !owned(to)) {
    results.push(
      fail(
        GUARDRAIL_RULES.transferOwnAccounts,
        `only ${SIM_T3_ALLOWED_ACCOUNT_TYPES.join(' or ')} accounts can take part in a simulated transfer`,
      ),
    );
  } else {
    results.push(
      pass(GUARDRAIL_RULES.transferOwnAccounts, `${from.name} to ${to.name} (both owned, simulated only)`),
    );
  }

  const perTransferCap = minMoney(context.settings.perActionCap, SIM_T3_PER_TRANSFER_CAP);

  results.push(
    params.amount <= perTransferCap
      ? pass(GUARDRAIL_RULES.transferPerTransferCap, `per-transfer cap is ${formatRupiah(perTransferCap)}`)
      : fail(
          GUARDRAIL_RULES.transferPerTransferCap,
          `${formatRupiah(params.amount)} exceeds the per-transfer cap of ${formatRupiah(perTransferCap)}`,
        ),
  );

  const sourceBalance = context.accountBalances[params.fromAccountId] ?? toMoney(0);
  results.push(
    params.amount <= sourceBalance
      ? pass(
          GUARDRAIL_RULES.transferSourceBalance,
          `${formatRupiah(sourceBalance)} available in ${from?.name ?? 'the source account'}`,
        )
      : fail(
          GUARDRAIL_RULES.transferSourceBalance,
          `${formatRupiah(params.amount)} exceeds the ${formatRupiah(sourceBalance)} balance of ${from?.name ?? 'the source account'}`,
        ),
  );

  const dailyCap = minMoney(context.settings.dailyCap, SIM_T3_DAILY_CAP);
  const totalToday = sumMoney([context.simulatedTransfersToday, params.amount]);

  results.push(
    totalToday <= dailyCap
      ? pass(
          GUARDRAIL_RULES.transferDailyCap,
          `${formatRupiah(totalToday)} of ${formatRupiah(dailyCap)} transferred today`,
        )
      : fail(
          GUARDRAIL_RULES.transferDailyCap,
          `${formatRupiah(totalToday)} would exceed the daily cap of ${formatRupiah(dailyCap)}`,
        ),
  );

  return results;
}

/** Key used to recognise a row that is already in the ledger. */
export function duplicateKey(row: {
  accountId: string;
  date: string;
  amount: number;
  merchant: string;
}): string {
  return `${row.accountId}|${row.date}|${row.amount}|${row.merchant}`;
}

export interface StatementImportGuardrailContext {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  today: IsoDate;
  /** One year before today. */
  earliest: IsoDate;
}

export function checkStatementImportGuardrails(
  params: StatementImportParams,
  context: StatementImportGuardrailContext,
): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const idByName = new Map(context.accounts.map((account) => [account.name, account.id]));

  const unknown = [...new Set(params.rows.map((row) => row.account).filter((name) => !idByName.has(name)))];
  results.push(
    unknown.length === 0
      ? pass(
          GUARDRAIL_RULES.importKnownAccounts,
          `${[...new Set(params.rows.map((row) => row.account))].join(', ')}`,
        )
      : fail(
          GUARDRAIL_RULES.importKnownAccounts,
          `unknown account name(s): ${unknown.join(', ')}. Nothing is created or guessed`,
        ),
  );

  const existing = new Set(context.transactions.map((transaction) => duplicateKey(transaction)));
  const duplicates = params.rows.filter((row) => {
    const accountId = idByName.get(row.account);
    return (
      accountId !== undefined &&
      existing.has(duplicateKey({ accountId, date: row.date, amount: row.amount, merchant: row.description }))
    );
  });
  results.push(
    duplicates.length === 0
      ? pass(GUARDRAIL_RULES.importNoDuplicates, 'no row matches an existing transaction')
      : fail(
          GUARDRAIL_RULES.importNoDuplicates,
          `${duplicates.length} row(s) are already in the ledger (first: line ${duplicates[0]!.line}); this file looks like it was imported before`,
        ),
  );

  const future = params.rows.filter((row) => row.date > context.today);
  results.push(
    future.length === 0
      ? pass(GUARDRAIL_RULES.importNotInFuture, `every row is dated on or before ${context.today}`)
      : fail(
          GUARDRAIL_RULES.importNotInFuture,
          `${future.length} row(s) are dated after ${context.today} (first: line ${future[0]!.line})`,
        ),
  );

  const oversized = params.rows.filter((row) => Math.abs(row.amount) > MAX_IMPORT_ROW_AMOUNT);
  results.push(
    oversized.length === 0
      ? pass(GUARDRAIL_RULES.importRowSize, 'no row is unusually large')
      : fail(
          GUARDRAIL_RULES.importRowSize,
          `${oversized.length} row(s) exceed ${formatRupiah(MAX_IMPORT_ROW_AMOUNT)} (first: line ${oversized[0]!.line})`,
        ),
  );

  const old = params.rows.filter((row) => row.date < context.earliest);
  results.push(
    old.length === 0
      ? pass(GUARDRAIL_RULES.importNotTooOld, `every row is dated on or after ${context.earliest}`)
      : fail(
          GUARDRAIL_RULES.importNotTooOld,
          `${old.length} row(s) are dated before ${context.earliest} (first: line ${old[0]!.line})`,
        ),
  );

  results.push(
    params.rows.length <= MAX_IMPORT_ROWS
      ? pass(GUARDRAIL_RULES.importRowCount, `${params.rows.length} rows`)
      : fail(GUARDRAIL_RULES.importRowCount, `${params.rows.length} rows`),
  );

  return results;
}

export interface TransactionAddGuardrailContext {
  accounts: readonly Account[];
  settings: Settings;
  accountBalances: Record<string, Money>;
  today: IsoDate;
  /** One year before today. */
  earliest: IsoDate;
}

export function checkTransactionAddGuardrails(
  params: TransactionAddParams,
  context: TransactionAddGuardrailContext,
): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const account = context.accounts.find((candidate) => candidate.id === params.accountId);

  results.push(
    account
      ? pass(GUARDRAIL_RULES.transactionAccount, account.name)
      : fail(GUARDRAIL_RULES.transactionAccount, `account ${params.accountId} is not in the ledger`),
  );

  results.push(
    params.date <= context.today && params.date >= context.earliest
      ? pass(GUARDRAIL_RULES.transactionDate, params.date)
      : fail(
          GUARDRAIL_RULES.transactionDate,
          `${params.date} is outside ${context.earliest} to ${context.today}`,
        ),
  );

  const size = toMoney(Math.abs(params.amount));
  results.push(
    size <= context.settings.perActionCap
      ? pass(
          GUARDRAIL_RULES.transactionCap,
          `per-action cap is ${formatRupiah(context.settings.perActionCap)}`,
        )
      : fail(
          GUARDRAIL_RULES.transactionCap,
          `${formatRupiah(size)} exceeds the per-action cap of ${formatRupiah(context.settings.perActionCap)}`,
        ),
  );

  const balance = context.accountBalances[params.accountId] ?? toMoney(0);
  const after = toMoney(balance + params.amount);
  results.push(
    after >= 0
      ? pass(
          GUARDRAIL_RULES.transactionBalance,
          `${account?.name ?? 'the account'} would hold ${formatRupiah(after)}`,
        )
      : fail(
          GUARDRAIL_RULES.transactionBalance,
          `${account?.name ?? 'the account'} holds ${formatRupiah(balance)}, so this would leave ${formatRupiah(after)}`,
        ),
  );

  return results;
}

export interface UndoGuardrailContext {
  entry: AuditEntry | undefined;
  reversible: boolean;
  alreadyUndone: boolean;
}

export function checkUndoGuardrails(params: UndoParams, context: UndoGuardrailContext): GuardrailResult[] {
  const results: GuardrailResult[] = [];

  if (!context.entry || context.entry.event !== 'executed') {
    results.push(
      fail(
        GUARDRAIL_RULES.undoReversible,
        `audit entry ${params.auditEntryId} is not an executed action, so there is nothing to undo`,
      ),
    );
    return results;
  }

  results.push(
    context.reversible
      ? pass(GUARDRAIL_RULES.undoReversible, `${context.entry.action ?? 'action'} is reversible`)
      : fail(GUARDRAIL_RULES.undoReversible, `${context.entry.action ?? 'action'} cannot be undone`),
  );

  results.push(
    context.alreadyUndone
      ? fail(GUARDRAIL_RULES.undoNotAlreadyUndone, 'this action has already been undone')
      : pass(GUARDRAIL_RULES.undoNotAlreadyUndone, 'not undone yet'),
  );

  return results;
}

/** What reversing an executed action would do, worked out from the ledger as it is now. */
export interface UndoEffect {
  /** Change to the money set aside in earmarks (positive puts money back aside). */
  earmarked: Money;
  /** Active earmarks after the undo. */
  earmarkCount: number;
  /** Change to each account's balance. */
  accountDeltas: Record<string, Money>;
}

export interface UndoEffectGuardrailContext {
  snapshot: LedgerSnapshot;
  accounts: readonly Account[];
}

/**
 * An undo is a change to the ledger like any other, so it must pass the same
 * limits as the action it resembles: putting an earmark back is checked like
 * creating one, and removing income is checked like spending it. Only the
 * rules the undo could break are listed, so undoing an earmark stays a
 * one-line card.
 */
export function checkUndoEffectGuardrails(
  effect: UndoEffect,
  context: UndoEffectGuardrailContext,
): GuardrailResult[] {
  const { snapshot } = context;
  const results: GuardrailResult[] = [];
  const balanceChange = sumMoney(Object.values(effect.accountDeltas));
  const freeCashDrop = toMoney(effect.earmarked - balanceChange);

  if (freeCashDrop > 0) {
    results.push(
      freeCashDrop <= snapshot.freeCash
        ? pass(
            GUARDRAIL_RULES.freeCash,
            `${formatRupiah(freeCashDrop)} of ${formatRupiah(snapshot.freeCash)} free cash`,
          )
        : fail(
            GUARDRAIL_RULES.freeCash,
            `undoing this takes ${formatRupiah(freeCashDrop)} from free cash of ${formatRupiah(snapshot.freeCash)}`,
          ),
    );
    if (effect.earmarked > 0) {
      results.push(
        freeCashDrop <= snapshot.safeToSpend
          ? pass(
              GUARDRAIL_RULES.obligationsCovered,
              `${formatRupiah(subMoney(snapshot.safeToSpend, freeCashDrop))} stays available after obligations due in 30 days`,
            )
          : fail(
              GUARDRAIL_RULES.obligationsCovered,
              `would leave ${formatRupiah(subMoney(snapshot.safeToSpend, freeCashDrop))} for obligations due in 30 days (${formatRupiah(snapshot.obligationsDueIn30Days)})`,
            ),
      );
    }
  }

  if (effect.earmarkCount > MAX_ACTIVE_EARMARKS) {
    results.push(
      fail(
        GUARDRAIL_RULES.maxActiveEarmarks,
        `undoing this would make ${effect.earmarkCount} active earmarks; the limit is ${MAX_ACTIVE_EARMARKS}`,
      ),
    );
  }

  for (const [accountId, delta] of Object.entries(effect.accountDeltas)) {
    if (delta >= 0) continue;
    const name = context.accounts.find((account) => account.id === accountId)?.name ?? 'the account';
    const balance = snapshot.balancesByAccount[accountId] ?? toMoney(0);
    const after = addMoney(balance, delta);
    results.push(
      after >= 0
        ? pass(GUARDRAIL_RULES.transactionBalance, `${name} would hold ${formatRupiah(after)}`)
        : fail(
            GUARDRAIL_RULES.transactionBalance,
            `${name} holds ${formatRupiah(balance)}, so undoing this would leave ${formatRupiah(after)}`,
          ),
    );
  }

  return results;
}

export function failedRules(results: readonly GuardrailResult[]): string[] {
  return results.filter((result) => !result.pass).map((result) => result.rule);
}

export function allPass(results: readonly GuardrailResult[]): boolean {
  return results.every((result) => result.pass);
}
