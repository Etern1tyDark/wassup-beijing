import { addDays, addMonths, addYears, isBefore, isOnOrAfter, monthsBetween, type IsoDate } from '../domain/time';
import { addMoney, subMoney, sumMoney, type Money } from '../domain/money';
import type { Account, Earmark, Invoice, Obligation, Transaction } from '../domain/schemas';


/**
 * LED-1 / LED-2: balances, free cash and safe-to-spend.
 *
 * Everything here is a pure function over plain arrays, so the numbers can be
 * reproduced from a fixture without touching storage (NFR-2).
 */

export const OBLIGATION_WINDOW_DAYS = 30;

export interface LedgerInput {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  invoices: readonly Invoice[];
  obligations: readonly Obligation[];
  earmarks: readonly Earmark[];
}

export interface LedgerSnapshot {
  asOf: IsoDate;
  balancesByAccount: Record<string, Money>;
  totalBalance: Money;
  activeEarmarkTotal: Money;
  /** balance - active earmarks */
  freeCash: Money;
  /** obligations falling due in the next 30 days */
  obligationsDueIn30Days: Money;
  /** balance - active earmarks - obligations due within 30 days */
  safeToSpend: Money;
  activeEarmarkCount: number;
  openInvoiceCount: number;
  openInvoiceTotal: Money;
}

/** Balance of one account: opening balance plus every posted transaction. */
export function accountBalance(account: Account, transactions: readonly Transaction[]): Money {
  const relevant = transactions.filter((transaction) => transaction.accountId === account.id);
  return addMoney(account.openingBalance, sumMoney(relevant.map((transaction) => transaction.amount)));
}

export function computeBalances(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): Record<string, Money> {
  const balances: Record<string, Money> = {};
  for (const account of accounts) {
    balances[account.id] = accountBalance(account, transactions);
  }
  return balances;
}

export function activeEarmarkTotal(earmarks: readonly Earmark[]): Money {
  return sumMoney(earmarks.filter((earmark) => earmark.active).map((earmark) => earmark.amount));
}

/**
 * Next occurrence of a recurring obligation on or after `asOf`.
 *
 * Monthly and yearly obligations are anchors: the month is added to the
 * original due date so the day of month never drifts (2026-01-31 stays the 31st).
 */
export function nextDueDate(obligation: Obligation, asOf: IsoDate): IsoDate {
  if (obligation.recurrence === 'once') return obligation.dueDate;
  if (isOnOrAfter(obligation.dueDate, asOf)) return obligation.dueDate;

  if (obligation.recurrence === 'monthly') {
    const months = Math.max(1, monthsBetween(obligation.dueDate, asOf));
    const candidate = addMonths(obligation.dueDate, months);
    return isBefore(candidate, asOf) ? addMonths(obligation.dueDate, months + 1) : candidate;
  }

  const years = Math.max(1, Math.floor(monthsBetween(obligation.dueDate, asOf) / 12));
  const candidate = addYears(obligation.dueDate, years);
  return isBefore(candidate, asOf) ? addYears(obligation.dueDate, years + 1) : candidate;
}

/** Obligations whose next occurrence falls inside the window, with that date. */
export function obligationsDueWithin(
  obligations: readonly Obligation[],
  asOf: IsoDate,
  days: number = OBLIGATION_WINDOW_DAYS,
): Array<{ obligation: Obligation; dueDate: IsoDate }> {
  const horizon = addDays(asOf, days);
  const result: Array<{ obligation: Obligation; dueDate: IsoDate }> = [];
  for (const obligation of obligations) {
    const dueDate = nextDueDate(obligation, asOf);
    if (isBefore(horizon, dueDate)) continue;
    result.push({ obligation, dueDate });
  }
  return result.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

export function buildSnapshot(input: LedgerInput, asOf: IsoDate): LedgerSnapshot {
  const balancesByAccount = computeBalances(input.accounts, input.transactions);
  const totalBalance = sumMoney(Object.values(balancesByAccount));
  const activeEarmarks = input.earmarks.filter((earmark) => earmark.active);
  const activeEarmarkSum = activeEarmarkTotal(activeEarmarks);
  const freeCash = subMoney(totalBalance, activeEarmarkSum);

  const dueSoon = obligationsDueWithin(input.obligations, asOf);
  const obligationsTotal = sumMoney(dueSoon.map((item) => item.obligation.amount));

  const openInvoices = input.invoices.filter((invoice) => invoice.paidDate === null);

  return {
    asOf,
    balancesByAccount,
    totalBalance,
    activeEarmarkTotal: activeEarmarkSum,
    freeCash,
    obligationsDueIn30Days: obligationsTotal,
    safeToSpend: subMoney(freeCash, obligationsTotal),
    activeEarmarkCount: activeEarmarks.length,
    openInvoiceCount: openInvoices.length,
    openInvoiceTotal: sumMoney(openInvoices.map((invoice) => invoice.amount)),
  };
}
