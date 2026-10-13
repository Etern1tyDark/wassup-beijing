import { z } from 'zod';

/**
 * All dates in the ledger are calendar dates in ISO `YYYY-MM-DD` form, read in
 * UTC so that the same seed always produces the same fixture (NFR-2).
 */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)')
  .refine(isRealIsoDate, 'not a real calendar date');

export type IsoDate = z.infer<typeof IsoDateSchema>;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Instants (audit timestamps, proposal expiry) must carry an explicit offset. */
export const IsoDateTimeSchema = z
  .string()
  .regex(ISO_DATE_TIME, 'expected an ISO timestamp with an explicit UTC offset')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a parseable timestamp');

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return toIsoDate(parsed) === value;
}

export function parseIsoDate(value: IsoDate): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function toIsoDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const millis = parseIsoDate(to).getTime() - parseIsoDate(from).getTime();
  return Math.round(millis / 86_400_000);
}

export function compareIsoDate(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isBefore(a: IsoDate, b: IsoDate): boolean {
  return compareIsoDate(a, b) < 0;
}

export function isOnOrBefore(a: IsoDate, b: IsoDate): boolean {
  return compareIsoDate(a, b) <= 0;
}

export function isOnOrAfter(a: IsoDate, b: IsoDate): boolean {
  return compareIsoDate(a, b) >= 0;
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add whole months, clamping the day of month (2026-01-31 + 1 month = 2026-02-28).
 * Adding from the original anchor avoids the drift of repeated additions.
 */
export function addMonths(value: IsoDate, months: number): IsoDate {
  const date = parseIsoDate(value);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, monthIndex + months, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth();
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return toIsoDate(new Date(Date.UTC(targetYear, targetMonth, clampedDay)));
}

export function addYears(value: IsoDate, years: number): IsoDate {
  return addMonths(value, years * 12);
}

/** Whole months from `from` to `to` (0 when both fall in the same month). */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

export function todayUtc(): IsoDate {
  return toIsoDate(new Date());
}
