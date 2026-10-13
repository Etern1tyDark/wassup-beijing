import { describe, expect, it } from 'vitest';
import {
  activeEarmarkTotal,
  buildSnapshot,
  computeBalances,
  nextDueDate,
  obligationsDueWithin,
} from './engine';
import {
  AccountSchema,
  EarmarkSchema,
  InvoiceSchema,
  ObligationSchema,
  TransactionSchema,
  type Obligation,
} from '../domain/schemas';

import handWorked from '../../fixtures/ledger/hand-worked.json';

const fixture = handWorked;

function parseFixture() {
  return {
    asOf: fixture.asOf,
    accounts: fixture.input.accounts.map((row) => AccountSchema.parse(row)),
    transactions: fixture.input.transactions.map((row) => TransactionSchema.parse(row)),
    invoices: fixture.input.invoices.map((row) => InvoiceSchema.parse(row)),
    obligations: fixture.input.obligations.map((row) => ObligationSchema.parse(row)),
    earmarks: fixture.input.earmarks.map((row) => EarmarkSchema.parse(row)),
  };
}

describe('ledger engine against the hand-worked fixture (LED-1, LED-2)', () => {
  it('computes the balance of every account', () => {
    const input = parseFixture();
    expect(computeBalances(input.accounts, input.transactions)).toEqual(fixture.expected.balancesByAccount);
  });

  it('computes free cash, obligations due in 30 days and safe-to-spend', () => {
    const input = parseFixture();
    const snapshot = buildSnapshot(input, input.asOf);

    expect(snapshot.totalBalance).toBe(fixture.expected.totalBalance);
    expect(snapshot.activeEarmarkTotal).toBe(fixture.expected.activeEarmarkTotal);
    expect(snapshot.freeCash).toBe(fixture.expected.freeCash);
    expect(snapshot.obligationsDueIn30Days).toBe(fixture.expected.obligationsDueIn30Days);
    expect(snapshot.safeToSpend).toBe(fixture.expected.safeToSpend);
  });

  it('reports earmark and invoice counts', () => {
    const input = parseFixture();
    const snapshot = buildSnapshot(input, input.asOf);

    expect(snapshot.activeEarmarkCount).toBe(fixture.expected.activeEarmarkCount);
    expect(snapshot.openInvoiceCount).toBe(fixture.expected.openInvoiceCount);
    expect(snapshot.openInvoiceTotal).toBe(fixture.expected.openInvoiceTotal);
  });

  it('excludes inactive earmarks from the earmark total', () => {
    const input = parseFixture();
    expect(activeEarmarkTotal(input.earmarks)).toBe(fixture.expected.activeEarmarkTotal);
  });

  it('keeps safe-to-spend consistent with its definition', () => {
    const input = parseFixture();
    const snapshot = buildSnapshot(input, input.asOf);
    expect(snapshot.safeToSpend).toBe(
      snapshot.totalBalance - snapshot.activeEarmarkTotal - snapshot.obligationsDueIn30Days,
    );
  });
});

describe('recurring obligations (LED-2)', () => {
  const monthly: Obligation = ObligationSchema.parse({
    id: 'obl_monthly',
    label: 'Rent',
    amount: 3_500_000,
    dueDate: '2026-01-31',
    recurrence: 'monthly',
  });

  it('rolls a monthly obligation forward without drifting the day of month', () => {
    expect(nextDueDate(monthly, '2026-01-31')).toBe('2026-01-31');
    expect(nextDueDate(monthly, '2026-02-01')).toBe('2026-02-28');
    expect(nextDueDate(monthly, '2026-03-01')).toBe('2026-03-31');
    expect(nextDueDate(monthly, '2026-04-15')).toBe('2026-04-30');
  });

  it('rolls a yearly obligation forward', () => {
    const yearly = ObligationSchema.parse({
      id: 'obl_yearly',
      label: 'Insurance',
      amount: 2_400_000,
      dueDate: '2026-03-01',
      recurrence: 'yearly',
    });
    expect(nextDueDate(yearly, '2026-09-15')).toBe('2027-03-01');
  });

  it('keeps a one-off obligation at its own date', () => {
    const once = ObligationSchema.parse({
      id: 'obl_once',
      label: 'Tax',
      amount: 1_000_000,
      dueDate: '2026-11-01',
      recurrence: 'once',
    });
    expect(nextDueDate(once, '2026-09-15')).toBe('2026-11-01');
    expect(obligationsDueWithin([once], '2026-09-15')).toHaveLength(0);
  });

  it('includes an obligation landing exactly on the 30 day horizon', () => {
    const onHorizon = ObligationSchema.parse({
      id: 'obl_edge',
      label: 'Edge',
      amount: 100,
      dueDate: '2026-10-15',
      recurrence: 'once',
    });
    expect(obligationsDueWithin([onHorizon], '2026-09-15')).toHaveLength(1);
  });
});
