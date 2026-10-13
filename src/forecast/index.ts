import {
  addMoney,
  formatRupiah,
  negateMoney,
  subMoney,
  sumMoney,
  toMoney,
  type Money,
} from '../domain/money';
import type { Earmark, Obligation } from '../domain/schemas';
import {
  addDays,
  addMonths,
  addYears,
  daysBetween,
  isBefore,
  monthsBetween,
  type IsoDate,
} from '../domain/time';
import type { LedgerInput, LedgerSnapshot } from '../ledger/engine';

/**
 * Forecast engine (FC-1 to FC-4).
 *
 * Pure functions over plain data: the same inputs always give the same output
 * (NFR-2) and every amount stays in integer rupiah (NFR-1). The model never
 * computes these numbers; it only reads them from a tool result (PRD Section 7).
 *
 * What goes into the projection:
 * - obligations, at every occurrence inside the window (monthly and yearly
 *   items recur from their original due date, so the day of month never drifts)
 * - open invoices, expected on their due date. An invoice that is already
 *   overdue has no known payment date, so it is left out and reported in
 *   `excludedInvoices` instead of being counted as money that will arrive. A
 *   "paid late" scenario does not bring it back: guessing a date for it would
 *   make the scenario look better than the base case
 * - day-to-day spending, estimated from the last 90 days of history and spread
 *   evenly with integer arithmetic
 * - the scenario, if any (FC-3)
 */
export const FORECAST_HORIZON_DAYS = 90;
/** Runway is searched this far ahead; beyond it the result is reported as capped. */
export const RUNWAY_SEARCH_DAYS = 730;
export const VARIABLE_SPEND_WINDOW_DAYS = 90;
export const DAYS_PER_RUNWAY_MONTH = 30;

/**
 * Categories that are not day-to-day spending: income, fixed costs that are
 * already modelled as obligations, one-off items, and transfers between the
 * user's own accounts (real or simulated).
 */
export const NON_VARIABLE_CATEGORIES: readonly string[] = [
  'income',
  'housing',
  'utilities',
  'subscriptions',
  'irregular',
  'transfer',
  'simulated-transfer',
  'simulated-transfer-reversal',
];

export interface ForecastInvoice {
  id: string;
  client: string;
  amount: Money;
  dueDate: IsoDate;
}

export interface VariableSpend {
  /** Days of history the total was measured over. */
  windowDays: number;
  /** Total day-to-day outflow in that window, as a positive amount. */
  total: Money;
}

export interface ForecastInputs {
  asOf: IsoDate;
  /** Total balance across accounts: the starting point of the projection. */
  startingBalance: Money;
  /** Money set aside by active earmarks; free cash is balance minus this. */
  activeEarmarkTotal: Money;
  obligations: readonly Obligation[];
  openInvoices: readonly ForecastInvoice[];
  variableSpend: VariableSpend;
}

export interface Scenario {
  /** Open invoices paid `daysLate` days after their due date. */
  invoiceLate?: { invoiceIds: readonly string[]; daysLate: number };
  /** A one-off expense, paid on `date` (default: the as-of date). */
  extraExpense?: { amount: Money; date?: IsoDate; label?: string };
}

export type ForecastEventKind = 'invoice' | 'obligation' | 'scenario-expense';

export interface ForecastEvent {
  date: IsoDate;
  /** Signed: positive is an inflow. */
  amount: Money;
  kind: ForecastEventKind;
  label: string;
  refId: string;
}

export interface DailyBalancePoint {
  date: IsoDate;
  balance: Money;
  /** balance minus active earmarks */
  freeCash: Money;
}

export interface ForecastResult {
  asOf: IsoDate;
  horizonDays: number;
  /** One point per day, from the as-of date (index 0) to the horizon. */
  points: DailyBalancePoint[];
  events: ForecastEvent[];
  /** Overdue open invoices that were left out of the projection. */
  excludedInvoices: ForecastInvoice[];
  lowestFreeCash: { date: IsoDate; amount: Money };
  /** First day free cash is below zero inside the horizon, if any. */
  firstShortfallDate: IsoDate | null;
  /** FC-4: what produced this forecast. */
  label: string;
  inputs: ForecastInputs;
  scenario: Scenario | null;
}

export interface RunwayResult {
  asOf: IsoDate;
  /** Days until free cash goes below zero. Equals RUNWAY_SEARCH_DAYS when capped. */
  runwayDays: number;
  /** runwayDays / 30, to one decimal. */
  runwayMonths: number;
  /** True when free cash never went below zero inside the search window. */
  capped: boolean;
  depletionDate: IsoDate | null;
  label: string;
  inputs: ForecastInputs;
  scenario: Scenario | null;
}

export interface ScenarioResult {
  label: string;
  base: RunwayResult;
  scenario: RunwayResult;
  /** scenario minus base, in days. Negative means the scenario shortens runway. */
  runwayDeltaDays: number;
  forecast: ForecastResult;
  baseLowestFreeCash: { date: IsoDate; amount: Money };
  /**
   * The stretch the scenario changes: from the as-of date until the late money
   * arrives (or the horizon ends), with the lowest free cash in it, with and
   * without the scenario. A delay can leave the runway untouched and still make
   * these weeks much tighter, and this is where that shows.
   */
  pinch: {
    until: IsoDate;
    base: { date: IsoDate; amount: Money };
    scenario: { date: IsoDate; amount: Money };
  };
}

export interface SpendingAlert {
  id: string;
  severity: 'info' | 'warning';
  message: string;
}

/* ------------------------------------------------------------------ inputs */

/** Build the forecast inputs from the ledger. Used by the dashboard and the tools. */
export function buildForecastInputs(ledger: LedgerInput, snapshot: LedgerSnapshot): ForecastInputs {
  const windowStart = addDays(snapshot.asOf, -VARIABLE_SPEND_WINDOW_DAYS);
  const variable = ledger.transactions.filter(
    (transaction) =>
      transaction.amount < 0 &&
      !NON_VARIABLE_CATEGORIES.includes(transaction.category) &&
      isBefore(windowStart, transaction.date) &&
      !isBefore(snapshot.asOf, transaction.date),
  );

  return {
    asOf: snapshot.asOf,
    startingBalance: snapshot.totalBalance,
    activeEarmarkTotal: snapshot.activeEarmarkTotal,
    obligations: ledger.obligations,
    openInvoices: ledger.invoices
      .filter((invoice) => invoice.paidDate === null)
      .map((invoice) => ({
        id: invoice.id,
        client: invoice.client,
        amount: invoice.amount,
        dueDate: invoice.dueDate,
      })),
    variableSpend: {
      windowDays: VARIABLE_SPEND_WINDOW_DAYS,
      total: negateMoney(sumMoney(variable.map((transaction) => transaction.amount))),
    },
  };
}

/** The same inputs with more (positive) or less (negative) money earmarked. */
export function withEarmarkDelta(inputs: ForecastInputs, delta: Money): ForecastInputs {
  return { ...inputs, activeEarmarkTotal: addMoney(inputs.activeEarmarkTotal, delta) };
}

/* ------------------------------------------------------------------ events */

/** Every occurrence of an obligation from `asOf` to `end`, both inclusive. */
export function obligationOccurrences(obligation: Obligation, asOf: IsoDate, end: IsoDate): IsoDate[] {
  if (obligation.recurrence === 'once') {
    return isBefore(obligation.dueDate, asOf) || isBefore(end, obligation.dueDate)
      ? []
      : [obligation.dueDate];
  }

  const step = obligation.recurrence === 'monthly' ? addMonths : addYears;
  const monthsPerStep = obligation.recurrence === 'monthly' ? 1 : 12;
  // Start one step early; the clamp to the as-of date below removes the excess.
  const first = Math.max(0, Math.floor(monthsBetween(obligation.dueDate, asOf) / monthsPerStep) - 1);

  const dates: IsoDate[] = [];
  for (let index = first; ; index += 1) {
    const date = step(obligation.dueDate, index);
    if (isBefore(end, date)) break;
    if (!isBefore(date, asOf)) dates.push(date);
  }
  return dates;
}

function expectedInvoiceDate(invoice: ForecastInvoice, scenario: Scenario | null): IsoDate {
  const late = scenario?.invoiceLate;
  return late && late.invoiceIds.includes(invoice.id)
    ? addDays(invoice.dueDate, late.daysLate)
    : invoice.dueDate;
}

function buildEvents(
  inputs: ForecastInputs,
  horizonDays: number,
  scenario: Scenario | null,
): { events: ForecastEvent[]; excludedInvoices: ForecastInvoice[] } {
  const end = addDays(inputs.asOf, horizonDays);
  const events: ForecastEvent[] = [];
  const excludedInvoices: ForecastInvoice[] = [];

  for (const obligation of inputs.obligations) {
    for (const date of obligationOccurrences(obligation, inputs.asOf, end)) {
      events.push({
        date,
        amount: negateMoney(obligation.amount),
        kind: 'obligation',
        label: obligation.label,
        refId: obligation.id,
      });
    }
  }

  for (const invoice of inputs.openInvoices) {
    if (isBefore(invoice.dueDate, inputs.asOf)) {
      excludedInvoices.push(invoice);
      continue;
    }
    const date = expectedInvoiceDate(invoice, scenario);
    if (isBefore(end, date)) continue;
    events.push({
      date,
      amount: invoice.amount,
      kind: 'invoice',
      label: `${invoice.client} ${invoice.id}`,
      refId: invoice.id,
    });
  }

  const expense = scenario?.extraExpense;
  if (expense) {
    const date = expense.date ?? inputs.asOf;
    if (!isBefore(date, inputs.asOf) && !isBefore(end, date)) {
      events.push({
        date,
        amount: negateMoney(expense.amount),
        kind: 'scenario-expense',
        label: expense.label ?? 'One-off expense',
        refId: 'scenario',
      });
    }
  }

  events.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0,
  );
  return { events, excludedInvoices };
}

/** Day-to-day spending up to and including day `day`, with no fractions of a rupiah. */
function cumulativeVariableSpend(spend: VariableSpend, day: number): Money {
  if (spend.windowDays <= 0) return toMoney(0);
  return toMoney(Math.floor((spend.total * day) / spend.windowDays));
}

function walk(inputs: ForecastInputs, horizonDays: number, scenario: Scenario | null) {
  const { events, excludedInvoices } = buildEvents(inputs, horizonDays, scenario);
  const points: DailyBalancePoint[] = [];

  let eventTotal = toMoney(0);
  let cursor = 0;
  for (let day = 0; day <= horizonDays; day += 1) {
    const date = addDays(inputs.asOf, day);
    while (cursor < events.length && !isBefore(date, events[cursor]!.date)) {
      eventTotal = addMoney(eventTotal, events[cursor]!.amount);
      cursor += 1;
    }
    const balance = subMoney(
      addMoney(inputs.startingBalance, eventTotal),
      cumulativeVariableSpend(inputs.variableSpend, day),
    );
    points.push({ date, balance, freeCash: subMoney(balance, inputs.activeEarmarkTotal) });
  }

  return { points, events, excludedInvoices };
}

/* ------------------------------------------------------------------- labels */

export function describeScenario(inputs: ForecastInputs, scenario: Scenario | null): string {
  if (!scenario || (!scenario.invoiceLate && !scenario.extraExpense)) return 'Base case';
  const parts: string[] = [];
  if (scenario.invoiceLate) {
    const names = scenario.invoiceLate.invoiceIds.map((id) => {
      const invoice = inputs.openInvoices.find((candidate) => candidate.id === id);
      return invoice ? `${invoice.client} ${id}` : id;
    });
    parts.push(`${names.join(', ')} paid ${scenario.invoiceLate.daysLate} days late`);
  }
  if (scenario.extraExpense) {
    parts.push(
      `one-off expense of ${formatRupiah(scenario.extraExpense.amount)} on ${scenario.extraExpense.date ?? inputs.asOf}`,
    );
  }
  return `Scenario: ${parts.join('; ')}`;
}

/* ------------------------------------------------------------------- engine */

/** FC-1: daily balance for `horizonDays` days. */
export function projectForecast(
  inputs: ForecastInputs,
  horizonDays: number = FORECAST_HORIZON_DAYS,
  scenario: Scenario | null = null,
): ForecastResult {
  const { points, events, excludedInvoices } = walk(inputs, horizonDays, scenario);

  let lowest = points[0]!;
  let firstShortfallDate: IsoDate | null = null;
  for (const point of points) {
    if (point.freeCash < lowest.freeCash) lowest = point;
    if (firstShortfallDate === null && point.freeCash < 0) firstShortfallDate = point.date;
  }

  return {
    asOf: inputs.asOf,
    horizonDays,
    points,
    events,
    excludedInvoices,
    lowestFreeCash: { date: lowest.date, amount: lowest.freeCash },
    firstShortfallDate,
    label: `${describeScenario(inputs, scenario)} · as of ${inputs.asOf}`,
    inputs,
    scenario,
  };
}

/** FC-2: days and months until free cash goes below zero. */
export function computeRunway(inputs: ForecastInputs, scenario: Scenario | null = null): RunwayResult {
  const { points } = walk(inputs, RUNWAY_SEARCH_DAYS, scenario);
  const depleted = points.find((point) => point.freeCash < 0);
  const runwayDays = depleted ? daysBetween(inputs.asOf, depleted.date) : RUNWAY_SEARCH_DAYS;

  return {
    asOf: inputs.asOf,
    runwayDays,
    runwayMonths: Math.round((runwayDays * 10) / DAYS_PER_RUNWAY_MONTH) / 10,
    capped: !depleted,
    depletionDate: depleted?.date ?? null,
    label: `${describeScenario(inputs, scenario)} · as of ${inputs.asOf}`,
    inputs,
    scenario,
  };
}

function lowestUntil(forecast: ForecastResult, until: IsoDate): { date: IsoDate; amount: Money } {
  let lowest = forecast.points[0]!;
  for (const point of forecast.points) {
    if (isBefore(until, point.date)) break;
    if (point.freeCash < lowest.freeCash) lowest = point;
  }
  return { date: lowest.date, amount: lowest.freeCash };
}

/** FC-3: the same forecast with an invoice paid late and/or a one-off expense. */
export function runScenario(inputs: ForecastInputs, scenario: Scenario): ScenarioResult {
  const base = computeRunway(inputs);
  const changed = computeRunway(inputs, scenario);
  const baseForecast = projectForecast(inputs);
  const forecast = projectForecast(inputs, FORECAST_HORIZON_DAYS, scenario);
  const horizonEnd = addDays(inputs.asOf, FORECAST_HORIZON_DAYS);

  // The last day on which the scenario still differs from the base case.
  let until = inputs.asOf;
  const late = scenario.invoiceLate;
  for (const invoice of inputs.openInvoices) {
    if (!late?.invoiceIds.includes(invoice.id) || isBefore(invoice.dueDate, inputs.asOf)) continue;
    const arrives = addDays(invoice.dueDate, late.daysLate);
    if (isBefore(until, arrives)) until = arrives;
  }
  // A one-off expense is never paid back, so it weighs on the whole horizon.
  if (scenario.extraExpense || isBefore(horizonEnd, until)) until = horizonEnd;

  return {
    label: `${describeScenario(inputs, scenario)} · as of ${inputs.asOf}`,
    base,
    scenario: changed,
    runwayDeltaDays: changed.runwayDays - base.runwayDays,
    forecast,
    baseLowestFreeCash: baseForecast.lowestFreeCash,
    pinch: {
      until,
      base: lowestUntil(baseForecast, addDays(until, -1)),
      scenario: lowestUntil(forecast, addDays(until, -1)),
    },
  };
}

/* ------------------------------------------------------------------- alerts */

/**
 * ACT-6: alerts that react to the ledger, the forecast and the earmarks. An
 * earmark lowers free cash, so it moves every one of these.
 */
export function spendingAlerts(input: {
  snapshot: LedgerSnapshot;
  forecast: ForecastResult;
  runway: RunwayResult;
  earmarks: readonly Earmark[];
}): SpendingAlert[] {
  const { snapshot, forecast, runway } = input;
  const alerts: SpendingAlert[] = [];

  if (snapshot.safeToSpend < 0) {
    alerts.push({
      id: 'safe-to-spend-negative',
      severity: 'warning',
      message: `Safe to spend is ${formatRupiah(snapshot.safeToSpend)}: obligations due in 30 days exceed free cash.`,
    });
  }

  if (forecast.firstShortfallDate) {
    alerts.push({
      id: 'forecast-shortfall',
      severity: 'warning',
      message: `Free cash is projected to go below zero on ${forecast.firstShortfallDate} (${runway.runwayDays} days from now).`,
    });
  }

  if (forecast.excludedInvoices.length > 0) {
    const total = sumMoney(forecast.excludedInvoices.map((invoice) => invoice.amount));
    alerts.push({
      id: 'overdue-invoices',
      severity: 'warning',
      message: `${forecast.excludedInvoices.length} overdue invoice(s) worth ${formatRupiah(total)} are not counted in the forecast, because their payment date is unknown.`,
    });
  }

  const spend = forecast.inputs.variableSpend;
  if (spend.windowDays > 0 && snapshot.safeToSpend >= 0) {
    // Compared by cross-multiplying, so no amount is ever divided.
    const typicalOver30Days = toMoney(Math.floor((spend.total * 30) / spend.windowDays));
    if (typicalOver30Days > snapshot.safeToSpend) {
      alerts.push({
        id: 'spending-above-safe',
        severity: 'warning',
        message: `Typical day-to-day spending over 30 days (${formatRupiah(typicalOver30Days)}) is more than safe to spend (${formatRupiah(snapshot.safeToSpend)}).`,
      });
    }
  }

  for (const earmark of input.earmarks) {
    if (earmark.active && !isBefore(snapshot.asOf, earmark.reviewDate)) {
      alerts.push({
        id: `earmark-review-${earmark.id}`,
        severity: 'info',
        message: `Earmark "${earmark.label}" reached its review date (${earmark.reviewDate}).`,
      });
    }
  }

  return alerts;
}
