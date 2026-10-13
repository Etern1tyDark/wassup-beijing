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
import type { AppDatabase } from './db';

/**
 * Read-only access to storage. Nothing here can change the ledger, so the
 * agent, the UI and the ledger engine all depend on this module instead of on
 * the tables directly.
 */
export interface Repositories {
  accounts: {
    all(): Promise<Account[]>;
    byId(id: string): Promise<Account | undefined>;
  };
  transactions: {
    all(): Promise<Transaction[]>;
    byAccount(accountId: string): Promise<Transaction[]>;
    latestDate(): Promise<string | null>;
  };
  invoices: {
    all(): Promise<Invoice[]>;
    open(): Promise<Invoice[]>;
  };
  obligations: {
    all(): Promise<Obligation[]>;
  };
  earmarks: {
    all(): Promise<Earmark[]>;
    active(): Promise<Earmark[]>;
    byId(id: string): Promise<Earmark | undefined>;
  };
  policies: {
    all(): Promise<Policy[]>;
    byId(id: string): Promise<Policy | undefined>;
  };
  coverageItems: {
    all(): Promise<CoverageItem[]>;
    byPolicy(policyId: string): Promise<CoverageItem[]>;
  };
  proposals: {
    all(): Promise<Proposal[]>;
    byId(proposalId: string): Promise<Proposal | undefined>;
    byStatus(status: Proposal['status']): Promise<Proposal[]>;
    byIdempotencyKey(key: string): Promise<Proposal | undefined>;
  };
  audit: {
    all(): Promise<AuditEntry[]>;
    byId(id: string): Promise<AuditEntry | undefined>;
    last(): Promise<AuditEntry | undefined>;
    byProposal(proposalId: string): Promise<AuditEntry[]>;
  };
  settings: {
    get(): Promise<Settings | undefined>;
  };
  outboundRequests: {
    all(): Promise<OutboundRequest[]>;
    byId(id: string): Promise<OutboundRequest | undefined>;
  };
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    accounts: {
      all: () => db.accounts.toArray(),
      byId: (id) => db.accounts.get(id),
    },
    transactions: {
      all: () => db.transactions.toArray(),
      byAccount: (accountId) => db.transactions.where('accountId').equals(accountId).toArray(),
      latestDate: async () => {
        const latest = await db.transactions.orderBy('date').last();
        return latest?.date ?? null;
      },
    },
    invoices: {
      all: () => db.invoices.toArray(),
      open: async () => (await db.invoices.toArray()).filter((invoice) => invoice.paidDate === null),
    },
    obligations: {
      all: () => db.obligations.toArray(),
    },
    earmarks: {
      all: () => db.earmarks.toArray(),
      active: async () => (await db.earmarks.toArray()).filter((earmark) => earmark.active),
      byId: (id) => db.earmarks.get(id),
    },
    policies: {
      all: () => db.policies.toArray(),
      byId: (id) => db.policies.get(id),
    },
    coverageItems: {
      all: () => db.coverageItems.toArray(),
      byPolicy: (policyId) => db.coverageItems.where('policyId').equals(policyId).toArray(),
    },
    proposals: {
      all: () => db.proposals.toArray(),
      byId: (proposalId) => db.proposals.get(proposalId),
      byStatus: (status) => db.proposals.where('status').equals(status).toArray(),
      byIdempotencyKey: async (key) => {
        const matches = await db.proposals.toArray();
        return matches.find((proposal) => proposal.idempotencyKey === key);
      },
    },
    audit: {
      all: () => db.auditEntries.orderBy('seq').toArray(),
      byId: async (id) => {
        const entries = await db.auditEntries.where('id').equals(id).toArray();
        return entries[0];
      },
      last: () => db.auditEntries.orderBy('seq').last(),
      byProposal: (proposalId) => db.auditEntries.where('proposalId').equals(proposalId).toArray(),
    },
    settings: {
      get: () => db.settings.get('app'),
    },
    outboundRequests: {
      all: () => db.outboundRequests.orderBy('time').reverse().toArray(),
      byId: (id) => db.outboundRequests.get(id),
    },
  };
}
