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

/* --------------------------------------------------------- earmark.update */

const EarmarkValuesSchema = z.object({
  label: z.string().trim().min(1).max(80),
  amount: PositiveMoneySchema,
  reviewDate: IsoDateSchema,
});
export type EarmarkValues = z.infer<typeof EarmarkValuesSchema>;

export const EarmarkUpdateParamsSchema = z
  .object({
    earmarkId: z.string().min(1),
    label: EarmarkValuesSchema.shape.label.optional(),
    amount: PositiveMoneySchema.optional(),
    reviewDate: IsoDateSchema.optional(),
    /**
     * The earmark as it was when the change was proposed. The tier engine fills
     * this in from the ledger and overwrites anything a caller supplies; it is
     * what the approval was given against, and what an undo restores.
     */
    previous: EarmarkValuesSchema.optional(),
  })
  .refine(
    (value) => value.label !== undefined || value.amount !== undefined || value.reviewDate !== undefined,
    { message: 'give a new label, amount or review date' },
  );
export type EarmarkUpdateParams = z.infer<typeof EarmarkUpdateParamsSchema>;

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

/* ------------------------------------------------------- statement.import */

/** NFR-3 sizes the importer for 2,000 rows; this is the hard ceiling. */
export const MAX_IMPORT_ROWS = 5000;

export const StatementRowParamsSchema = z.object({
  /** 1-based line in the source file, kept for the audit trail. */
  line: z.number().int().positive(),
  date: IsoDateSchema,
  description: z.string().min(1).max(200),
  amount: MoneySchema,
  /** Account name as written in the file; resolved against the ledger by a guardrail. */
  account: z.string().min(1).max(80),
});
export type StatementRowParams = z.infer<typeof StatementRowParamsSchema>;

export const StatementImportParamsSchema = z.object({
  fileName: z.string().trim().min(1).max(120),
  fileHash: z.string().min(1),
  rows: z.array(StatementRowParamsSchema).min(1).max(MAX_IMPORT_ROWS),
});
export type StatementImportParams = z.infer<typeof StatementImportParamsSchema>;

/* -------------------------------------------------------- transaction.add */

export const TransactionAddParamsSchema = z.object({
  accountId: z.string().min(1),
  date: IsoDateSchema,
  /** Negative means money out. */
  amount: MoneySchema.refine((value) => value !== 0, { message: 'amount must not be zero' }),
  merchant: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40),
});
export type TransactionAddParams = z.infer<typeof TransactionAddParamsSchema>;

/* ---------------------------------------------------------------- parsing */

/**
 * Params of a proposal action, validated per action name. Returns a
 * discriminated union so the executor never works with unvalidated values.
 */
export type ParsedActionParams =
  | { action: 'earmark.create'; params: EarmarkCreateParams }
  | { action: 'earmark.update'; params: EarmarkUpdateParams }
  | { action: 'earmark.delete'; params: EarmarkDeleteParams }
  | { action: 'statement.import'; params: StatementImportParams }
  | { action: 'transaction.add'; params: TransactionAddParams }
  | { action: 'undo'; params: UndoParams }
  | { action: 'transfer'; params: TransferParams };

export type ParseParamsResult = { ok: true; value: ParsedActionParams } | { ok: false; reason: string };

export function parseActionParams(action: string, raw: unknown): ParseParamsResult {
  const fail = (error: z.ZodError): ParseParamsResult => ({
    ok: false,
    reason: error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; '),
  });

  switch (action) {
    case 'earmark.create': {
      const parsed = EarmarkCreateParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'earmark.update': {
      const parsed = EarmarkUpdateParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'earmark.delete': {
      const parsed = EarmarkDeleteParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'statement.import': {
      const parsed = StatementImportParamsSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: { action, params: parsed.data } } : fail(parsed.error);
    }
    case 'transaction.add': {
      const parsed = TransactionAddParamsSchema.safeParse(raw);
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
