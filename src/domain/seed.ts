import { z } from 'zod';
import {
  AccountSchema,
  EarmarkSchema,
  InvoiceSchema,
  ObligationSchema,
  TransactionSchema,
} from './schemas';

/**
 * The shape the synthetic data generator produces and the UI bootstraps from
 * (PRD Section 8 "Synthetic data generator"). Deterministic for a given seed.
 */
export const SeedDatasetSchema = z.object({
  seed: z.string().min(1),
  persona: z.string().min(1),
  generatedAt: z.string().min(1),
  asOf: z.string().min(1),
  accounts: z.array(AccountSchema),
  transactions: z.array(TransactionSchema),
  invoices: z.array(InvoiceSchema),
  obligations: z.array(ObligationSchema),
  earmarks: z.array(EarmarkSchema),
});

export type SeedDataset = z.infer<typeof SeedDatasetSchema>;
