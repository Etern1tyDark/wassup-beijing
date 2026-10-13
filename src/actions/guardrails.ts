import { formatRupiah, minMoney, subMoney, sumMoney, toMoney, type Money } from '../domain/money';
import type { Account, AuditEntry, Earmark, GuardrailResult, Settings } from '../domain/schemas';
import type { LedgerSnapshot } from '../ledger/engine';
import type { EarmarkCreateParams, EarmarkDeleteParams, TransferParams, UndoParams } from './params';

/**
 * ACT-5 / PRD Section 6: the guardrails that stand between a proposal and the
 * ledger. Every rule is a named, testable function so a violating fixture can
 * point at exactly one rule.
 */
export const MAX_ACTIVE_EARMARKS = 10;

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
  transferOwnAccounts: 'both accounts are the user\u2019s own bank or sandbox-savings accounts',
  transferSourceBalance: 'amount <= source account balance',
  transferPerTransferCap: 'amount <= simulated per-transfer cap',
  transferDailyCap: 'today\u2019s simulated transfers + amount <= simulated daily cap',
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

export function failedRules(results: readonly GuardrailResult[]): string[] {
  return results.filter((result) => !result.pass).map((result) => result.rule);
}

export function allPass(results: readonly GuardrailResult[]): boolean {
  return results.every((result) => result.pass);
}
