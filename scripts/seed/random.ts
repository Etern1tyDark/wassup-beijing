/**
 * Deterministic pseudo-random number generator (NFR-2).
 *
 * Same seed, same sequence, on every machine and every run. No dependency, no
 * platform randomness, no clock.
 */

/** Hash a string into a 32-bit seed. */
function xmur3(input: string): () => number {
  let h = 1779033703 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    h = Math.imul(h ^ input.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Random {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  sample<T>(items: readonly T[], count: number): T[];
  bool(probability: number): boolean;
}

export function createRandom(seed: string): Random {
  const next = mulberry32(xmur3(seed)());

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`empty range ${min}..${max}`);
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[int(0, items.length - 1)]!;
    },
    sample: <T>(items: readonly T[], count: number): T[] => {
      const pool = [...items];
      const picked: T[] = [];
      while (picked.length < count && pool.length > 0) {
        const index = int(0, pool.length - 1);
        picked.push(pool.splice(index, 1)[0]!);
      }
      return picked;
    },
    bool: (probability: number): boolean => next() < probability,
  };
}
