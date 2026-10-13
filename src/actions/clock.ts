/**
 * Clock injection. The demo runs on a clock anchored to the seed data's as-of
 * date so every number is reproducible (NFR-2) and the seeded ledger is never
 * accidentally stale.
 */
export interface Clock {
  now(): Date;
}

export function fixedClock(instant: Date | string): Clock {
  const fixed = typeof instant === 'string' ? new Date(instant) : instant;
  return { now: () => new Date(fixed.getTime()) };
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}
