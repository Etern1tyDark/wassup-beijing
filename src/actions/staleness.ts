import { hoursBetween, type Clock } from './clock';

/**
 * PRD Section 6: data older than `Settings.staleDataHours` blocks T2 and T3
 * execution until the user refreshes (ST8).
 */
export interface StalenessInput {
  /** Latest date found in the ledger, if any. */
  latestTransactionDate: string | null;
  settings: { staleDataHours: number };
  now: Date;
}

export interface StalenessReport {
  stale: boolean;
  ageHours: number | null;
  dataAsOf: string | null;
  reason: string | null;
}

export function evaluateStaleness(input: StalenessInput): StalenessReport {
  const candidates: Date[] = [];
  if (input.latestTransactionDate) candidates.push(new Date(`${input.latestTransactionDate}T00:00:00.000Z`));

  if (candidates.length === 0) {
    return {
      stale: true,
      ageHours: null,
      dataAsOf: null,
      reason: 'there is no ledger data yet; import a statement before executing an action',
    };
  }

  const dataAsOf = new Date(Math.max(...candidates.map((candidate) => candidate.getTime())));
  const ageHours = Math.round(hoursBetween(dataAsOf, input.now) * 10) / 10;

  if (ageHours > input.settings.staleDataHours) {
    return {
      stale: true,
      ageHours,
      dataAsOf: dataAsOf.toISOString(),
      reason: `the ledger is ${ageHours} hours old (limit ${input.settings.staleDataHours}); refresh the data before executing`,
    };
  }

  return { stale: false, ageHours, dataAsOf: dataAsOf.toISOString(), reason: null };
}

export async function readStaleness(
  clock: Clock,
  settings: { staleDataHours: number },
  read: () => Promise<{ latestTransactionDate: string | null }>,
): Promise<StalenessReport> {
  const latest = await read();
  return evaluateStaleness({ ...latest, settings, now: clock.now() });
}
