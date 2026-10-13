import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MoneySchema,
  ZERO_RUPIAH,
  addMoney,
  formatRupiah,
  formatRupiahCompact,
  isMoney,
  parseRupiah,
  subMoney,
  sumMoney,
  toMoney,
} from './money';

describe('money schema (NFR-1)', () => {
  it('accepts integer rupiah', () => {
    expect(MoneySchema.safeParse(0).success).toBe(true);
    expect(MoneySchema.safeParse(-3500000).success).toBe(true);
    expect(MoneySchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it('rejects floating point amounts', () => {
    for (const value of [1.5, -0.01, 3_000_000.0000001, 0.1 + 0.2]) {
      const result = MoneySchema.safeParse(value);
      expect(result.success, `expected ${String(value)} to be rejected`).toBe(false);
    }
  });

  it('rejects unsafe integers', () => {
    for (const value of [2 ** 53, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      expect(MoneySchema.safeParse(value).success, `expected ${String(value)} to be rejected`).toBe(false);
    }
  });

  it('rejects non-finite and non-numeric values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1000', null, {}]) {
      expect(MoneySchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects the same values inside a containing object', () => {
    const Row = z.object({ amount: MoneySchema });
    expect(Row.safeParse({ amount: 1000 }).success).toBe(true);
    expect(Row.safeParse({ amount: 1000.5 }).success).toBe(false);
    expect(Row.safeParse({ amount: 2 ** 60 }).success).toBe(false);
  });

  it('brands the value so a plain number is not assignable', () => {
    expect(isMoney(toMoney(500))).toBe(true);
    expect(isMoney(500.5)).toBe(false);
    expect(ZERO_RUPIAH).toBe(0);
  });

  it('throws when converting a non-integer', () => {
    expect(() => toMoney(1.5)).toThrow(/safe integer/);
    expect(() => toMoney(2 ** 60)).toThrow(/safe integer/);
  });
});

describe('money arithmetic stays on integers', () => {
  it('adds, subtracts and sums without producing fractions', () => {
    expect(addMoney(toMoney(3_000_000), toMoney(2_000_000))).toBe(5_000_000);
    expect(subMoney(toMoney(3_000_000), toMoney(3_500_000))).toBe(-500_000);
    expect(sumMoney([toMoney(1), toMoney(2), toMoney(3)])).toBe(6);
    expect(Number.isInteger(sumMoney([toMoney(149_000), toMoney(412_500)]))).toBe(true);
  });

  it('refuses to overflow the safe integer range', () => {
    expect(() => addMoney(toMoney(Number.MAX_SAFE_INTEGER), toMoney(1))).toThrow(/safe integer/);
  });
});

describe('parseRupiah', () => {
  it('parses plain integer amounts with an optional sign', () => {
    expect(parseRupiah('8500000')).toEqual({ ok: true, value: 8_500_000 });
    expect(parseRupiah('-3500000')).toEqual({ ok: true, value: -3_500_000 });
    expect(parseRupiah(' +1000 ')).toEqual({ ok: true, value: 1_000 });
  });

  it('rejects separators, decimals and junk instead of guessing', () => {
    for (const input of ['8.500.000', '8500.5', 'Rp 8500', '1e6', '', 'abc', '12,5']) {
      const result = parseRupiah(input);
      expect(result.ok, `expected "${input}" to be rejected`).toBe(false);
    }
  });

  it('rejects values outside the safe integer range', () => {
    expect(parseRupiah('99999999999999999999').ok).toBe(false);
  });
});

describe('formatRupiah', () => {
  it('groups with Indonesian separators', () => {
    expect(formatRupiah(toMoney(0))).toBe('Rp 0');
    expect(formatRupiah(toMoney(8_500_000))).toBe('Rp 8.500.000');
    expect(formatRupiah(toMoney(-412_500))).toBe('-Rp 412.500');
    expect(formatRupiah(toMoney(999))).toBe('Rp 999');
  });

  it('renders a compact form for tables', () => {
    expect(formatRupiahCompact(toMoney(1_200_000))).toBe('Rp 1,2 jt');
    expect(formatRupiahCompact(toMoney(850_000))).toBe('Rp 850 rb');
    expect(formatRupiahCompact(toMoney(-3_000_000_000))).toBe('-Rp 3 M');
  });
});
