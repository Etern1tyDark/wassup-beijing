import { SeedDatasetSchema, type SeedDataset } from '../domain/seed';
import { DEFAULT_SETTINGS, SettingsSchema } from '../domain/schemas';
import { hashPin } from '../actions/pin';
import type { AppDatabase } from './db';
import {
  clearLedger,
  putAccounts,
  putEarmarks,
  putInvoices,
  putObligations,
  putTransactions,
} from './ledger-writes';

/**
 * Initial data load. This is the only path besides the action executor that
 * touches ledger tables, and it only ever runs from an explicit user action
 * ("Load seed data") or from a test.
 *
 * DEMO_PIN is a seeded demo credential, never a real one.
 */
export const DEMO_PIN = '123456';

export async function loadSeedData(db: AppDatabase, dataset: SeedDataset): Promise<void> {
  const parsed = SeedDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    throw new Error(`refusing to load an invalid seed dataset: ${parsed.error.message}`);
  }
  const data = parsed.data;

  await resetDatabase(db);
  await putAccounts(db, data.accounts);
  await putTransactions(db, data.transactions);
  await putInvoices(db, data.invoices);
  await putObligations(db, data.obligations);
  await putEarmarks(db, data.earmarks);
  await ensureSettings(db);
}

/** Wipe every table. Used by "Load seed data" and by tests. */
export async function resetDatabase(db: AppDatabase): Promise<void> {
  await clearLedger(db);
  await Promise.all([
    db.policies.clear(),
    db.coverageItems.clear(),
    db.policyDocuments.clear(),
    db.proposals.clear(),
    db.auditEntries.clear(),
    db.outboundRequests.clear(),
    db.settings.clear(),
  ]);
}

/** Write default settings (including the demo PIN hash) when none exist yet. */
export async function ensureSettings(db: AppDatabase): Promise<void> {
  const existing = await db.settings.get('app');
  if (existing) return;
  const settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, pinHash: await hashPin(DEMO_PIN) });
  await db.settings.put(settings);
}
