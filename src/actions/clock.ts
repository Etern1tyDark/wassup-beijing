/**
 * Clock injection. The demo runs on a clock anchored to the seed data's as-of
 * date so every number is reproducible (NFR-2) and the seeded ledger is never
 * accidentally stale.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(instant: Date | string): Clock {
  const fixed = typeof instant === 'string' ? new Date(instant) : instant;
  return { now: () => new Date(fixed.getTime()) };
}

/**
 * A clock that reports 09:00 (UTC+7) on the as-of date, offset by whole days.
 * `anchoredClock('2026-10-13', 3)` is the stale-data fixture three days later.
 */
export function anchoredClock(asOf: string, dayOffset = 0): Clock {
  const base = new Date(`${asOf}T09:00:00+07:00`);
  const instant = new Date(base.getTime() + dayOffset * 86_400_000);
  return fixedClock(instant);
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}
