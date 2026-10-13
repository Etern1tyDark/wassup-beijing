import { describe, expect, it } from 'vitest';
import { toMoney } from '../domain/money';
import type { Earmark } from '../domain/schemas';
import { buildSnapshot, type LedgerInput } from '../ledger/engine';
import fixture from '../../fixtures/forecast/hand-worked.json';
import {
  RUNWAY_SEARCH_DAYS,
  buildForecastInputs,
  computeRunway,
  obligationOccurrences,
  projectForecast,
  runScenario,
  spendingAlerts,
  withEarmarkDelta,
  type ForecastInputs,
  type Scenario,
} from './index';

const inputs = fixture.inputs as unknown as ForecastInputs;

describe('forecast engine on the hand-worked fixture', () => {
  it('FC-1: projects the daily balance for 90 days, to the rupiah', () => {
    const forecast = projectForecast(inputs);
    expect(forecast.horizonDays).toBe(90);
    expect(forecast.points).toHaveLength(91);

    for (const expected of fixture.expected.balances) {
      const point = forecast.points[expected.day]!;
      expect(point.date).toBe(expected.date);
      expect(point.balance).toBe(expected.balance);
      expect(point.freeCash).toBe(expected.freeCash);
    }

    expect(forecast.lowestFreeCash).toEqual(fixture.expected.lowestFreeCash);
    expect(forecast.firstShortfallDate).toBe(fixture.expected.firstShortfallDate);
  });

  it('leaves overdue invoices out instead of guessing when they will be paid', () => {
    const forecast = projectForecast(inputs);
    expect(forecast.excludedInvoices.map((invoice) => invoice.id)).toEqual(
      fixture.expected.excludedInvoiceIds,
    );
    expect(forecast.events.some((event) => event.refId === 'inv_overdue')).toBe(false);
  });

  it('FC-2: reports runway in days and months from free cash', () => {
    const runway = computeRunway(inputs);
    expect(runway).toMatchObject(fixture.expected.runway);
  });

  it('FC-3: recomputes runway for a late invoice and for a one-off expense', () => {
    for (const expected of fixture.expected.scenarios) {
      const result = runScenario(inputs, expected.scenario as unknown as Scenario);
      expect(result.scenario.runwayDays, expected.name).toBe(expected.runwayDays);
      expect(result.scenario.runwayMonths, expected.name).toBe(expected.runwayMonths);
      expect(result.scenario.depletionDate, expected.name).toBe(expected.depletionDate);
      expect(result.runwayDeltaDays, expected.name).toBe(expected.runwayDeltaDays);
      expect(result.base.runwayDays).toBe(fixture.expected.runway.runwayDays);
    }
  });

  it('FC-4: labels every result with its scenario, inputs and as-of date', () => {
    expect(projectForecast(inputs).label).toBe('Base case · as of 2026-10-13');
    const result = runScenario(inputs, { invoiceLate: { invoiceIds: ['inv_a'], daysLate: 60 } });
    expect(result.label).toBe('Scenario: Client Alpha inv_a paid 60 days late · as of 2026-10-13');
    expect(result.forecast.inputs).toBe(inputs);
    expect(result.forecast.scenario).toEqual({ invoiceLate: { invoiceIds: ['inv_a'], daysLate: 60 } });
  });

  it('ACT-6: an earmark shortens runway, and releasing it restores the exact value', () => {
    const before = computeRunway(inputs);
    // Worked by hand: with 2,000,000 more set aside, free cash on day 48 is
    // 400,000 and falls 50,000 a day, so it first goes negative on day 57.
    const earmarked = withEarmarkDelta(inputs, toMoney(2_000_000));
    expect(computeRunway(earmarked).runwayDays).toBe(57);
    expect(computeRunway(withEarmarkDelta(earmarked, toMoney(-2_000_000))).runwayDays).toBe(
      before.runwayDays,
    );
  });

  it('NFR-2: the same inputs always give the same output', () => {
    expect(projectForecast(inputs)).toEqual(projectForecast(inputs));
  });
});

describe('forecast engine edge cases', () => {
  const base: ForecastInputs = {
    asOf: '2026-10-13',
    startingBalance: toMoney(1_000_000),
    activeEarmarkTotal: toMoney(0),
    obligations: [],
    openInvoices: [],
    variableSpend: { windowDays: 90, total: toMoney(0) },
  };

  it('spreads an amount that does not divide evenly without losing or inventing a rupiah', () => {
    const forecast = projectForecast({
      ...base,
      variableSpend: { windowDays: 90, total: toMoney(1_000_000) },
    });
    expect(forecast.points[1]!.balance).toBe(1_000_000 - 11_111);
    expect(forecast.points[90]!.balance).toBe(0);
    expect(forecast.points.every((point) => Number.isSafeInteger(point.balance))).toBe(true);
  });

  it('reports a capped runway when free cash never runs out', () => {
    const runway = computeRunway(base);
    expect(runway.capped).toBe(true);
    expect(runway.runwayDays).toBe(RUNWAY_SEARCH_DAYS);
    expect(runway.depletionDate).toBeNull();
  });

  it('reports zero days when free cash is already negative', () => {
    const runway = computeRunway({ ...base, activeEarmarkTotal: toMoney(2_000_000) });
    expect(runway.runwayDays).toBe(0);
    expect(runway.depletionDate).toBe('2026-10-13');
  });

  it('keeps the day of month for recurring obligations', () => {
    const dates = obligationOccurrences(
      { id: 'o', label: 'Rent', amount: toMoney(1), dueDate: '2026-01-31', recurrence: 'monthly' },
      '2026-10-13',
      '2027-03-05',
    );
    expect(dates).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('includes an obligation that is due on the as-of date', () => {
    const dates = obligationOccurrences(
      { id: 'o', label: 'Rent', amount: toMoney(1), dueDate: '2026-10-13', recurrence: 'monthly' },
      '2026-10-13',
      '2026-11-13',
    );
    expect(dates).toEqual(['2026-10-13', '2026-11-13']);
  });

  it('repeats yearly obligations and drops one-off items outside the window', () => {
    expect(
      obligationOccurrences(
        { id: 'y', label: 'Premium', amount: toMoney(1), dueDate: '2025-03-01', recurrence: 'yearly' },
        '2026-10-13',
        '2028-10-13',
      ),
    ).toEqual(['2027-03-01', '2028-03-01']);
    expect(
      obligationOccurrences(
        { id: 'x', label: 'Old', amount: toMoney(1), dueDate: '2026-01-01', recurrence: 'once' },
        '2026-10-13',
        '2027-10-13',
      ),
    ).toEqual([]);
  });
});

describe('forecast inputs and alerts from the ledger', () => {
  const ledger: LedgerInput = {
    accounts: [
      { id: 'acc', name: 'BCA-main', type: 'bank', currency: 'IDR', openingBalance: toMoney(5_000_000) },
    ],
    transactions: [
      {
        id: 't1',
        accountId: 'acc',
        date: '2026-10-01',
        amount: toMoney(-900_000),
        merchant: 'Grocery store',
        category: 'groceries',
        source: 'csv',
        untrusted: true,
      },
      {
        id: 't2',
        accountId: 'acc',
        date: '2026-10-01',
        amount: toMoney(-3_500_000),
        merchant: 'Rent',
        category: 'housing',
        source: 'csv',
        untrusted: true,
      },
      {
        id: 't3',
        accountId: 'acc',
        date: '2026-06-01',
        amount: toMoney(-700_000),
        merchant: 'Grocery store',
        category: 'groceries',
        source: 'csv',
        untrusted: true,
      },
      {
        id: 't4',
        accountId: 'acc',
        date: '2026-10-02',
        amount: toMoney(4_000_000),
        merchant: 'Client Alpha',
        category: 'income',
        source: 'csv',
        untrusted: true,
      },
    ],
    invoices: [
      {
        id: 'inv_late',
        client: 'Client Alpha',
        amount: toMoney(3_000_000),
        issueDate: '2026-08-29',
        dueDate: '2026-09-12',
        paidDate: null,
      },
      {
        id: 'inv_paid',
        client: 'Client Alpha',
        amount: toMoney(4_000_000),
        issueDate: '2026-09-01',
        dueDate: '2026-09-15',
        paidDate: '2026-10-02',
      },
    ],
    obligations: [
      {
        id: 'obl_rent',
        label: 'Rent',
        amount: toMoney(3_500_000),
        dueDate: '2026-11-01',
        recurrence: 'monthly',
      },
    ],
    earmarks: [],
  };

  it('measures day-to-day spending over the last 90 days, without fixed costs or income', () => {
    const snapshot = buildSnapshot(ledger, '2026-10-13');
    const built = buildForecastInputs(ledger, snapshot);
    expect(built.variableSpend).toEqual({ windowDays: 90, total: 900_000 });
    expect(built.openInvoices.map((invoice) => invoice.id)).toEqual(['inv_late']);
    expect(built.startingBalance).toBe(snapshot.totalBalance);
  });

  it('raises alerts that move when money is earmarked', () => {
    const alertsFor = (earmarks: Earmark[]) => {
      const input = { ...ledger, earmarks };
      const snapshot = buildSnapshot(input, '2026-10-13');
      const built = buildForecastInputs(input, snapshot);
      return spendingAlerts({
        snapshot,
        forecast: projectForecast(built),
        runway: computeRunway(built),
        earmarks,
      }).map((alert) => alert.id);
    };

    expect(alertsFor([])).toEqual(['forecast-shortfall', 'overdue-invoices']);
    expect(
      alertsFor([
        {
          id: 'e1',
          label: 'Medical reserve',
          amount: toMoney(900_000),
          reviewDate: '2026-10-01',
          createdBy: 'aud_1',
          active: true,
        },
      ]),
    ).toEqual(['safe-to-spend-negative', 'forecast-shortfall', 'overdue-invoices', 'earmark-review-e1']);
  });
});

describe('late-invoice scenarios and overdue invoices', () => {
  it('never counts an overdue invoice, even when the scenario names it', () => {
    const base = computeRunway(inputs);
    const result = runScenario(inputs, { invoiceLate: { invoiceIds: ['inv_overdue'], daysLate: 60 } });
    expect(result.scenario.runwayDays).toBe(base.runwayDays);
    expect(result.forecast.excludedInvoices.map((invoice) => invoice.id)).toEqual(['inv_overdue']);
  });
});
