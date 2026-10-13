import Dexie, { type Table } from 'dexie';
import type {
  Account,
  AuditEntry,
  CoverageItem,
  Earmark,
  Invoice,
  Obligation,
  OutboundRequest,
  Policy,
  Proposal,
  Settings,
  Transaction,
} from '../domain/schemas';

/**
 * Browser-only storage (ING-5, NFR-5). Nothing in this module talks to a network.
 *
 * Ledger tables (accounts, transactions, invoices, obligations, earmarks) are
 * only ever written through src/storage/ledger-writes.ts, which in turn is only
 * imported by the action executor and the initial data loader (LED-3).
 */
export const LEDGER_TABLES = ['accounts', 'transactions', 'invoices', 'obligations', 'earmarks'] as const;
export type LedgerTableName = (typeof LEDGER_TABLES)[number];

export const DATABASE_NAME = 'wassup-beijing';

export class AppDatabase extends Dexie {
  declare accounts: Table<Account, string>;
  declare transactions: Table<Transaction, string>;
  declare invoices: Table<Invoice, string>;
  declare obligations: Table<Obligation, string>;
  declare earmarks: Table<Earmark, string>;
  declare policies: Table<Policy, string>;
  declare coverageItems: Table<CoverageItem, string>;
  declare proposals: Table<Proposal, string>;
  declare auditEntries: Table<AuditEntry, number>;
  declare settings: Table<Settings, string>;
  declare outboundRequests: Table<OutboundRequest, string>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      accounts: 'id, type',
      transactions: 'id, accountId, date, category, source',
      invoices: 'id, client, dueDate, paidDate',
      obligations: 'id, dueDate, recurrence',
      earmarks: 'id, active, reviewDate',
      policies: 'id, type',
      coverageItems: 'id, policyId',
      proposals: 'proposalId, status, createdAt',
      auditEntries: 'seq, id, time, event, proposalId',
      settings: 'id',
      outboundRequests: 'id, time, status',
    });
  }
}

export function createAppDatabase(name?: string): AppDatabase {
  return new AppDatabase(name);
}
