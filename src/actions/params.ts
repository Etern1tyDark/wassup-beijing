import { z } from 'zod';
import { MoneySchema } from '../domain/money';
import { IsoDateSchema } from '../domain/time';

/** Amounts that must be strictly positive (a transfer or an earmark of 0 is meaningless). */
export const PositiveMoneySchema = MoneySchema.refine((value) => value > 0, {
  message: 'amount must be greater than zero',
});

/* --------------------------------------------------------- earmark.create */

export const EarmarkCreateParamsSchema = z.object({
  label: z.string().trim().min(1).max(80),
  amount: PositiveMoneySchema,
  reviewDate: IsoDateSchema,
});
export type EarmarkCreateParams = z.infer<typeof EarmarkCreateParamsSchema>;

/* --------------------------------------------------------- earmark.delete */

export const EarmarkDeleteParamsSchema = z.object({
  earmarkId: z.string().min(1),
});
export type EarmarkDeleteParams = z.infer<typeof EarmarkDeleteParamsSchema>;

/* ------------------------------------------------------------------- undo */

export const UndoParamsSchema = z.object({
  /** The audit entry of the executed action to revert. */
  auditEntryId: z.string().min(1),
});
export type UndoParams = z.infer<typeof UndoParamsSchema>;

/* --------------------------------------------------------------- transfer */

export const TransferParamsSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: PositiveMoneySchema,
});
export type TransferParams = z.infer<typeof TransferParamsSchema>;

/* ---------------------------------------------------------------- parsing */

/**
 * Params of a proposal action, validated per action name. Returns a
 * discriminated union so the executor never works with unvalidated values.
 */
export type ParsedActionParams =
  | { action: 'earmark.create'; params: EarmarkCreateParams }
  | { action: 'earmark.delete'; params: EarmarkDeleteParams }
  | { action: 'undo'; params: UndoParams }
  | { action: 'transfer'; params: TransferParams };

export type ParseParamsResult =
  | { ok: true; value: ParsedActionParams }
  | { ok: false; reason: string };

export function parseActionParams(action: string, raw: unknown): ParseParamsResult {
  const fail = (error: z.ZodError): ParseParamsResult => ({
    ok: false,
    reason: error.issues
      .map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
      .join('; '),
  });

  switch (action) {
    case 'earmark.create': {
      const parsed = EarmarkCreateParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'earmark.delete': {
      const parsed = EarmarkDeleteParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'undo': {
      const parsed = UndoParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'transfer': {
      const parsed = TransferParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    default:
      return { ok: false, reason: `action "${action}" has no parameter schema (stub or read-only action)` };
  }
}

/** Parameter paths that untrusted text must never be able to set (PRD Section 6). */
export const PROTECTED_PARAM_PATHS = [
  'amount',
  'accountId',
  'fromAccountId',
  'toAccountId',
  'earmarkId',
  'auditEntryId',
] as const;
