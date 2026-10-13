import type { Clock } from '../actions/clock';

/**
 * The demo runs on a clock anchored to the seed data's as-of date, so every
 * number is reproducible and the seeded ledger is not stale the moment it is
 * loaded (NFR-2, ST8). Before any data is loaded it reports the real time.
 *
 * From the anchor the clock runs at normal speed. That keeps audit entries and
 * outbound requests in the order they happened, lets proposals expire, and
 * means a ledger left untouched for a day really does go stale.
 *
 * The anchor is kept in localStorage, so a reload continues from where the
 * clock was. It holds a date and a timestamp, and nothing about the user.
 */
export interface DemoClock extends Clock {
  anchorTo(asOf: string): void;
  isAnchored(): boolean;
  asOf(): string | null;
}

interface Anchor {
  /** The seed's as-of date. */
  asOf: string;
  /** Real time, in milliseconds, at which the clock was set to that date. */
  anchoredAt: number;
}

const STORAGE_KEY = 'demo-clock-anchor';

function readStoredAnchor(): Anchor | null {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<Anchor>;
    return typeof parsed.asOf === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.asOf) &&
      typeof parsed.anchoredAt === 'number' &&
      Number.isFinite(parsed.anchoredAt)
      ? { asOf: parsed.asOf, anchoredAt: parsed.anchoredAt }
      : null;
  } catch {
    return null;
  }
}

/** Nine in the morning in Jakarta on the as-of date. */
function startOfDemoDay(asOf: string): number {
  return new Date(`${asOf}T09:00:00+07:00`).getTime();
}

export function createDemoClock(options: { persist?: boolean } = {}): DemoClock {
  const persist = options.persist ?? true;
  let anchor: Anchor | null = persist ? readStoredAnchor() : null;

  const now = (): Date => {
    if (!anchor) return new Date();
    // Never run backwards, even if the system clock was set back.
    const elapsed = Math.max(0, Date.now() - anchor.anchoredAt);
    return new Date(startOfDemoDay(anchor.asOf) + elapsed);
  };

  return {
    now,
    anchorTo: (asOf: string) => {
      anchor = { asOf, anchoredAt: Date.now() };
      if (!persist) return;
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(anchor));
      } catch {
        // Storage can be unavailable (private mode); the anchor then lasts until reload.
      }
    },
    isAnchored: () => anchor !== null,
    asOf: () => (anchor ? now().toISOString().slice(0, 10) : null),
  };
}
