import { NotImplementedError } from '../agent/types';

/**
 * Forecast engine - STUB.
 *
 * TODO FC-1: project the daily balance for 90 days from recurring items, open
 *            invoices and obligations. Must match the fixture within Rp 1.
 * TODO FC-2: report runway in days and months, using free cash.
 * TODO FC-3: what-if scenarios - invoice paid N days late, one-off expense.
 * TODO FC-4: label every forecast with its inputs and its as-of date.
 *
 * The model never computes these numbers; they come from this engine (PRD
 * Section 7). All arithmetic must stay in integer rupiah (NFR-1) and the same
 * inputs must always produce the same output (NFR-2).
 */
export interface ForecastInputs {
  asOf: string;
  /** Recurring obligations with their next occurrence. */
  obligations: ReadonlyArray<{ label: string; amount: number; nextDueDate: string; recurrence: string }>;
  /** Open invoices, expected to be paid on their due date unless a scenario says otherwise. */
  openInvoices: ReadonlyArray<{ id: string; client: string; amount: number; dueDate: string }>;
  /** Starting point of the projection: total balance across accounts. */
  startingBalance: number;
  /** Free cash (balance minus active earmarks), used for runway. */
  freeCash: number;
}

export interface DailyBalancePoint {
  date: string;
  balance: number;
}

export interface ForecastResult {
  asOf: string;
  horizonDays: number;
  points: DailyBalancePoint[];
  /** Inputs that produced this forecast (FC-4). */
  inputs: ForecastInputs;
}

export interface RunwayResult {
  asOf: string;
  runwayDays: number;
  runwayMonths: number;
  inputs: ForecastInputs;
}

export interface Scenario {
  kind: 'invoice-late' | 'one-off-expense';
  invoiceId?: string;
  daysLate?: number;
  extraExpense?: number;
  description?: string;
}

export interface ForecastEngine {
  project(inputs: ForecastInputs, horizonDays: number): Promise<ForecastResult>;
  runway(inputs: ForecastInputs): Promise<RunwayResult>;
  scenario(inputs: ForecastInputs, scenario: Scenario): Promise<ForecastResult>;
}

export function createForecastEngine(): ForecastEngine {
  const notImplemented = (requirement: string, what: string): never => {
    throw new NotImplementedError(what, requirement);
  };

  return {
    project: () => notImplemented('FC-1', 'forecast.project'),
    runway: () => notImplemented('FC-2', 'forecast.runway'),
    scenario: () => notImplemented('FC-3', 'forecast.scenario'),
  };
}
