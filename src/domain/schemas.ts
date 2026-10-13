import { z } from 'zod';
import { MoneySchema } from './money.ts';
import { IsoDateSchema, IsoDateTimeSchema } from './time.ts';

/**
 * Entity schemas from PRD Section 8, frozen on day one.
 *
 * Every schema is also the validator used at the storage boundary, so nothing
 * that did not come from a validated parse can reach the ledger.
 */

/* ------------------------------------------------------------------ Account */

export const AccountTypeSchema = z.enum(['bank', 'e-wallet', 'sandbox-savings']);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: AccountTypeSchema,
  currency: z.literal('IDR'),
  openingBalance: MoneySchema,
});
export type Account = z.infer<typeof AccountSchema>;

/* -------------------------------------------------------------- Transaction */

export const TransactionSourceSchema = z.enum(['csv', 'chat', 'action']);
export type TransactionSource = z.infer<typeof TransactionSourceSchema>;

export const TransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  date: IsoDateSchema,
  /** Negative means outflow. */
  amount: MoneySchema,
  merchant: z.string().min(1),
  category: z.string().min(1),
  source: TransactionSourceSchema,
  /** True when the text came from an untrusted document or CSV field (PRD Section 6). */
  untrusted: z.boolean(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

/* ------------------------------------------------------------------ Invoice */

export const InvoiceSchema = z.object({
  id: z.string().min(1),
  client: z.string().min(1),
  amount: MoneySchema,
  issueDate: IsoDateSchema,
  dueDate: IsoDateSchema,
  /** Null while the invoice is still open. */
  paidDate: IsoDateSchema.nullable(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/* --------------------------------------------------------------- Obligation */

export const RecurrenceSchema = z.enum(['monthly', 'yearly', 'once']);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const ObligationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  amount: MoneySchema,
  dueDate: IsoDateSchema,
  recurrence: RecurrenceSchema,
});
export type Obligation = z.infer<typeof ObligationSchema>;

/* ------------------------------------------------------------------ Earmark */

export const EarmarkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  amount: MoneySchema,
  reviewDate: IsoDateSchema,
  /** Audit entry id that created this earmark. */
  createdBy: z.string().min(1),
  active: z.boolean(),
});
export type Earmark = z.infer<typeof EarmarkSchema>;

/* ------------------------------------------------------------------- Policy */

export const PolicyTypeSchema = z.enum(['health', 'travel']);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

export const PolicySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  type: PolicyTypeSchema,
  insurer: z.string().min(1),
  fileHash: z.string().min(1),
  extractedAt: IsoDateTimeSchema,
});
export type Policy = z.infer<typeof PolicySchema>;

export const CoverageItemSchema = z.object({
  id: z.string().min(1),
  policyId: z.string().min(1),
  benefit: z.string().min(1),
  limit: MoneySchema,
  /** Deductible or co-pay. */
  deductible: MoneySchema,
  waitingPeriodDays: z.number().int().nonnegative(),
  exclusions: z.array(z.string()),
  page: z.number().int().positive(),
  clauseRef: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type CoverageItem = z.infer<typeof CoverageItemSchema>;

/* ----------------------------------------------------------- Proposal (ACT) */

export const ProposalTierSchema = z.enum(['T0', 'T1', 'T2', 'T3']);
export type ProposalTier = z.infer<typeof ProposalTierSchema>;

export const ProposalStatusSchema = z.enum([
  'pending',
  'approved',
  'executed',
  'rejected',
  'expired',
  'undone',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const UntrustedSourceSchema = z.enum(['csv', 'document', 'chat']);
export type UntrustedSource = z.infer<typeof UntrustedSourceSchema>;

/** One untrusted origin and the parameter paths that were derived from it. */
export const UntrustedInputSchema = z.object({
  source: UntrustedSourceSchema,
  ref: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1),
});
export type UntrustedInput = z.infer<typeof UntrustedInputSchema>;

export const ProvenanceSchema = z.object({
  requestedBy: z.string().min(1),
  untrustedInputs: z.array(UntrustedInputSchema),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const GuardrailResultSchema = z.object({
  rule: z.string().min(1),
  pass: z.boolean(),
  detail: z.string(),
});
export type GuardrailResult = z.infer<typeof GuardrailResultSchema>;

const MoneyDeltaSchema = z.object({ before: MoneySchema, after: MoneySchema });
const NumberDeltaSchema = z.object({ before: z.number(), after: z.number() });

/** Before/after values rendered on the approval card (PRD Section 6). */
export const ProposalDiffSchema = z.object({
  safeToSpend: MoneyDeltaSchema.optional(),
  freeCash: MoneyDeltaSchema.optional(),
  runwayMonths: NumberDeltaSchema.optional(),
  activeEarmarks: NumberDeltaSchema.optional(),
});
export type ProposalDiff = z.infer<typeof ProposalDiffSchema>;

export const ProposalSchema = z.object({
  proposalId: z.string().min(1),
  action: z.string().min(1),
  tier: ProposalTierSchema,
  params: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  diff: ProposalDiffSchema,
  guardrails: z.array(GuardrailResultSchema),
  expiresAt: IsoDateTimeSchema,
  idempotencyKey: z.string().min(1),
  proposalHash: z.string().min(1),
  status: ProposalStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type Proposal = z.infer<typeof ProposalSchema>;

/* ------------------------------------------------------------------- Audit */

export const AuditActorSchema = z.enum(['user', 'agent', 'system']);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditEventSchema = z.enum(['proposed', 'approved', 'executed', 'refused', 'undone']);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: IsoDateTimeSchema,
  actor: AuditActorSchema,
  event: AuditEventSchema,
  /** Action name when known, including for refusals that never became a proposal. */
  action: z.string().min(1).nullable(),
  proposalId: z.string().min(1).nullable(),
  /** Short human-readable summary; refusal reasons live here (ACT-4). */
  detail: z.string(),
  payloadHash: z.string().min(1),
  prevHash: z.string().min(1),
  hash: z.string().min(1),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/* ---------------------------------------------------------------- Settings */

export const FeatureFlagsSchema = z.object({
  /** D1 / ACT-7: simulated own-account transfers. Default false. */
  simT3: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export const SettingsSchema = z.object({
  id: z.literal('app'),
  perActionCap: MoneySchema.nonnegative(),
  dailyCap: MoneySchema.nonnegative(),
  staleDataHours: z.number().int().positive(),
  /** PBKDF2-SHA256 string produced by src/actions/pin.ts. */
  pinHash: z.string().min(1),
  featureFlags: FeatureFlagsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Omit<Settings, 'pinHash'> = {
  id: 'app',
  perActionCap: 10_000_000 as Settings['perActionCap'],
  dailyCap: 10_000_000 as Settings['dailyCap'],
  staleDataHours: 24,
  featureFlags: { simT3: false },
};

/* ------------------------------------------------------- Outbound requests */

export const RedactionSchema = z.object({
  kind: z.enum(['name', 'account-number', 'policy-number', 'nik', 'phone', 'email']),
  value: z.string().min(1),
  placeholder: z.string().min(1),
});
export type Redaction = z.infer<typeof RedactionSchema>;

export const OutboundRequestStatusSchema = z.enum(['sent', 'blocked', 'failed']);
export type OutboundRequestStatus = z.infer<typeof OutboundRequestStatusSchema>;

/** One row per model call, rendered by the privacy panel (PRV-1). */
export const OutboundRequestSchema = z.object({
  id: z.string().min(1),
  time: IsoDateTimeSchema,
  purpose: z.string().min(1),
  status: OutboundRequestStatusSchema,
  redactions: z.array(RedactionSchema),
  /** The payload exactly as it left the browser, after redaction. */
  payload: z.unknown(),
  blockReason: z.string().nullable(),
  response: z.unknown().nullable(),
});
export type OutboundRequest = z.infer<typeof OutboundRequestSchema>;

/* ------------------------------------------------------------------ Helpers */

export const ENTITY_SCHEMAS = {
  accounts: AccountSchema,
  transactions: TransactionSchema,
  invoices: InvoiceSchema,
  obligations: ObligationSchema,
  earmarks: EarmarkSchema,
  policies: PolicySchema,
  coverageItems: CoverageItemSchema,
  proposals: ProposalSchema,
  auditEntries: AuditEntrySchema,
  settings: SettingsSchema,
  outboundRequests: OutboundRequestSchema,
} as const;
