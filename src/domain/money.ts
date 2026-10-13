import { z } from 'zod';

/**
 * Money is an integer number of Indonesian rupiah (NFR-1).
 *
 * The brand makes a plain `number` unusable wherever money is expected, so all
 * arithmetic has to go through the helpers in this module. `z.number().int()`
 * in Zod 4 already rejects non-integers and unsafe integers.
 */
export const MoneySchema = z.number().int().safe().brand<'Money'>();
export type Money = z.infer<typeof MoneySchema>;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export const ZERO_RUPIAH: Money = 0 as Money;

export function isMoney(value: unknown): value is Money {
  return MoneySchema.safeParse(value).success;
}

/** Convert a raw integer into Money, throwing on anything that is not a safe integer. */
export function toMoney(value: number): Money {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Money must be a safe integer, received ${String(value)}`);
  }
  return value as Money;
}

export function addMoney(a: Money, b: Money): Money {
  return toMoney(a + b);
}

export function subMoney(a: Money, b: Money): Money {
  return toMoney(a - b);
}

export function negateMoney(a: Money): Money {
  return toMoney(0 - a);
}

export function absMoney(a: Money): Money {
  return toMoney(Math.abs(a));
}

export function sumMoney(values: readonly Money[]): Money {
  let total = 0;
  for (const value of values) total += value;
  return toMoney(total);
}

/** -1, 0 or 1. Never subtracts into a float. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

export type ParseMoneyResult = { ok: true; value: Money } | { ok: false; reason: string };

const PLAIN_INTEGER = /^[+-]?\d+$/;

/**
 * Parse a rupiah amount as written in the statement CSV: digits only, optional
 * leading sign, no thousands separators, no decimal point (PRD Section 8).
 */
export function parseRupiah(input: string): ParseMoneyResult {
  const text = input.trim();
  if (text === '') return { ok: false, reason: 'amount is empty' };
  if (!PLAIN_INTEGER.test(text)) {
    return { ok: false, reason: `amount "${input}" is not an integer rupiah value` };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: `amount "${input}" is outside the safe integer range` };
  }
  return { ok: true, value: value as Money };
}

/** Format with Indonesian thousands separators: 1234567 -> "Rp 1.234.567". */
export function formatRupiah(amount: Money): string {
  const negative = amount < 0;
  const digits = Math.abs(amount).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += '.';
    grouped += digits[i];
  }
  return `${negative ? '-' : ''}Rp ${grouped}`;
}

/** Compact form for dense tables: Rp 1,2 jt / Rp 850 rb. Integer arithmetic only. */
export function formatRupiahCompact(amount: Money): string {
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000_000) return `${sign}Rp ${tenthsLabel(absolute, 1_000_000_000)} M`;
  if (absolute >= 1_000_000) return `${sign}Rp ${tenthsLabel(absolute, 1_000_000)} jt`;
  if (absolute >= 1_000) return `${sign}Rp ${tenthsLabel(absolute, 1_000)} rb`;
  return `${sign}Rp ${absolute}`;
}

/** Rounded to one decimal, with an Indonesian comma. Never divides money itself. */
function tenthsLabel(absolute: number, divisor: number): string {
  const tenths = Math.round(absolute / (divisor / 10));
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? `${whole}` : `${whole},${fraction}`;
}
