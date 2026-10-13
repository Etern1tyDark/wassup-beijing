import type { Clock } from '../actions/clock';

/**
 * The demo runs on a clock anchored to the seed data's as-of date, so every
 * number is reproducible and the seeded ledger is never accidentally stale
 * (NFR-2, ST8). Before any data is loaded it reports the real time.
 */
export interface DemoClock extends Clock {
  anchorTo(asOf: string): void;
  isAnchored(): boolean;
  asOf(): string | null;
}

export function createDemoClock(): DemoClock {
  let anchor: Date | null = null;

  return {
    now: () => (anchor ? new Date(anchor.getTime()) : new Date()),
    anchorTo: (asOf: string) => {
      anchor = new Date(`${asOf}T09:00:00+07:00`);
    },
    isAnchored: () => anchor !== null,
    asOf: () => (anchor ? anchor.toISOString().slice(0, 10) : null),
  };
}
