import { z } from 'zod';
import {
  AccountSchema,
  EarmarkSchema,
  InvoiceSchema,
  ObligationSchema,
  TransactionSchema,
  type Account,
  type Earmark,
  type Invoice,
  type Obligation,
  type Transaction,
} from '../domain/schemas';
import type { AppDatabase } from './db';

/**
 * LED-3: the only module allowed to write ledger tables.
 *
 * Importers are limited to src/actions/executor.ts (every ledger change) and
 * src/storage/bootstrap.ts (the one-off seed load). The boundary is enforced by
 * eslint.config.js and by src/storage/ledger-write-boundary.test.ts.
 */

function validate<T>(schema: z.ZodType<T>, rows: readonly T[], table: string): Promise<T[]> {
  return Promise.all(
    rows.map((row, index) => {
      const parsed = schema.safeParse(row);
      if (!parsed.success) {
        throw new Error(`refusing to write invalid ${table} row at index ${index}: ${parsed.error.message}`);
      }
      return parsed.data;
    }),
  );
}

export async function putAccounts(db: AppDatabase, accounts: readonly Account[]): Promise<void> {
  await db.accounts.bulkPut(await validate(AccountSchema, accounts, 'accounts'));
}

export async function putTransactions(db: AppDatabase, transactions: readonly Transaction[]): Promise<void> {
  await db.transactions.bulkPut(await validate(TransactionSchema, transactions, 'transactions'));
}

export async function putInvoices(db: AppDatabase, invoices: readonly Invoice[]): Promise<void> {
  await db.invoices.bulkPut(await validate(InvoiceSchema, invoices, 'invoices'));
}

export async function putObligations(db: AppDatabase, obligations: readonly Obligation[]): Promise<void> {
  await db.obligations.bulkPut(await validate(ObligationSchema, obligations, 'obligations'));
}

export async function putEarmarks(db: AppDatabase, earmarks: readonly Earmark[]): Promise<void> {
  await db.earmarks.bulkPut(await validate(EarmarkSchema, earmarks, 'earmarks'));
}

export async function addEarmark(db: AppDatabase, earmark: Earmark): Promise<void> {
  const [validated] = await validate(EarmarkSchema, [earmark], 'earmarks');
  if (validated === undefined) throw new Error('earmark validation produced no row');
  await db.earmarks.put(validated);
}

export async function setEarmarkActive(db: AppDatabase, earmarkId: string, active: boolean): Promise<void> {
  const updated = await db.earmarks.where('id').equals(earmarkId).modify({ active });
  if (updated === 0) throw new Error(`earmark ${earmarkId} does not exist`);
}

export async function addTransaction(db: AppDatabase, transaction: Transaction): Promise<void> {
  const [validated] = await validate(TransactionSchema, [transaction], 'transactions');
  if (validated === undefined) throw new Error('transaction validation produced no row');
  await db.transactions.put(validated);
}
export async function removeTransactions(db: AppDatabase, ids: readonly string[]): Promise<void> {
  await db.transactions.bulkDelete([...ids]);
}
export async function clearLedger(db: AppDatabase): Promise<void> {
  await db.transaction(
    'rw',
    [db.accounts, db.transactions, db.invoices, db.obligations, db.earmarks],
    async () => {
      await Promise.all([
        db.accounts.clear(),
        db.transactions.clear(),
        db.invoices.clear(),
        db.obligations.clear(),
        db.earmarks.clear(),
      ]);
    },
  );
}
