import 'fake-indexeddb/auto';
import { createAppDatabase, type AppDatabase } from '../storage/db';
import { DEMO_PIN, ensureSettings, loadSeedData } from '../storage/bootstrap';
import { createRepositories, type Repositories } from '../storage/repositories';
import { createAuditLog, type AuditLog } from '../audit/log';
import { createApprovalService, type ApprovalService, type ApprovalToken } from '../actions/approvals';
import { createActionService, type ActionService } from '../actions/service';
import { createSettingsService, type SettingsService } from '../actions/settings';
import { fixedClock, type Clock } from '../actions/clock';
import { toMoney } from '../domain/money';
import type { SeedDataset } from '../domain/seed';
import type { Account, Earmark, Invoice, Obligation, Transaction } from '../domain/schemas';

/**
 * Shared test world: a real Dexie database on fake-indexeddb, the real audit
 * log, the real approval service and the real action service, with an injected
 * clock. Tests exercise the production code paths, not doubles.
 */
export const TEST_AS_OF = '2026-10-13';
export const TEST_DEMO_PIN = DEMO_PIN;

/**
 * Worked numbers for the default test ledger, as of 2026-10-13:
 *   acc_bank      10,000,000 + 5,000,000 - 1,000,000 = 14,000,000
 *   acc_sandbox                                         0
 *   acc_ewallet     250,000 -   100,000              =  150,000
 *   total balance                                    14,150,000
 *   obligations due in 30 days: rent 3,500,000 + subscriptions 149,000 = 3,649,000
 *   free cash = 14,150,000
 *   safe-to-spend = 10,501,000
 */
export const EXPECTED = {
  totalBalance: 14_150_000,
  freeCash: 14_150_000,
  obligationsDueIn30Days: 3_649_000,
  safeToSpend: 10_501_000,
} as const;

export interface TestWorld {
  db: AppDatabase;
  repos: Repositories;
  audit: AuditLog;
  approvals: ApprovalService;
  actions: ActionService;
  settings: SettingsService;
  clock: Clock;
  asOf: string;
  /** Move the injected clock to a fixed instant. */
  setNow(instant: string | Date): void;
  /** Issue an approval token the way the approval card does. */
  issueToken(proposalId: string): Promise<ApprovalToken>;
  close(): Promise<void>;
}

function baseAccounts(): Account[] {
  return [
    { id: 'acc_bank', name: 'BCA-main', type: 'bank', currency: 'IDR', openingBalance: toMoney(10_000_000) },
    {
      id: 'acc_sandbox',
      name: 'Sandbox savings',
      type: 'sandbox-savings',
      currency: 'IDR',
      openingBalance: toMoney(0),
    },
    { id: 'acc_ewallet', name: 'GoPay', type: 'e-wallet', currency: 'IDR', openingBalance: toMoney(250_000) },
  ];
}

function baseTransactions(): Transaction[] {
  return [
    {
      id: 'txn_income',
      accountId: 'acc_bank',
      date: '2026-10-01',
      amount: toMoney(5_000_000),
      merchant: 'Client Alpha invoice',
      category: 'income',
      source: 'csv',
      untrusted: true,
    },
    {
      id: 'txn_expense',
      accountId: 'acc_bank',
      date: '2026-10-05',
      amount: toMoney(-1_000_000),
      merchant: 'Studio rent part payment',
      category: 'housing',
      source: 'csv',
      untrusted: true,
    },
    {
      id: 'txn_topup',
      accountId: 'acc_ewallet',
      date: TEST_AS_OF,
      amount: toMoney(-100_000),
      merchant: 'Mobile top-up',
      category: 'utilities',
      source: 'csv',
      untrusted: true,
    },
  ];
}

function baseObligations(): Obligation[] {
  return [
    {
      id: 'obl_rent',
      label: 'Rent',
      amount: toMoney(3_500_000),
      dueDate: '2026-10-18',
      recurrence: 'monthly',
    },
    {
      id: 'obl_subs',
      label: 'Subscriptions',
      amount: toMoney(149_000),
      dueDate: '2026-10-23',
      recurrence: 'monthly',
    },
    {
      id: 'obl_yearly',
      label: 'Insurance premium',
      amount: toMoney(2_400_000),
      dueDate: '2027-03-01',
      recurrence: 'yearly',
    },
  ];
}

function baseInvoices(): Invoice[] {
  return [
    {
      id: 'inv_open',
      client: 'Client Alpha',
      amount: toMoney(3_000_000),
      issueDate: '2026-09-20',
      dueDate: '2026-10-04',
      paidDate: null,
    },
  ];
}

export function activeEarmarkFixture(index: number, amount = 100_000): Earmark {
  return {
    id: `earmark_fixture_${index}`,
    label: `Fixture earmark ${index}`,
    amount: toMoney(amount),
    reviewDate: '2027-01-13',
    createdBy: `aud_fixture_${index}`,
    active: true,
  };
}

export interface TestWorldOptions {
  asOf?: string;
  accounts?: Account[];
  transactions?: Transaction[];
  obligations?: Obligation[];
  invoices?: Invoice[];
  earmarks?: Earmark[];
  databaseName?: string;
}

export async function createTestWorld(options: TestWorldOptions = {}): Promise<TestWorld> {
  const asOf = options.asOf ?? TEST_AS_OF;
  const db = createAppDatabase(options.databaseName ?? `test-${Math.random().toString(16).slice(2)}`);

  let current = new Date(`${asOf}T09:00:00+07:00`);
  const clock: Clock = { now: () => new Date(current.getTime()) };

  const dataset: SeedDataset = {
    seed: 'test',
    persona: 'Rina',
    generatedAt: `${asOf}T00:00:00.000Z`,
    asOf,
    accounts: options.accounts ?? baseAccounts(),
    transactions: options.transactions ?? baseTransactions(),
    invoices: options.invoices ?? baseInvoices(),
    obligations: options.obligations ?? baseObligations(),
    earmarks: options.earmarks ?? [],
  };

  await loadSeedData(db, dataset);
  await ensureSettings(db);

  const repos = createRepositories(db);
  const audit = createAuditLog(db, clock.now.bind(clock));
  const approvals = createApprovalService();
  const actions = createActionService({ db, repos, audit, approvals, clock });
  const settings = createSettingsService(db, audit);

  return {
    db,
    repos,
    audit,
    approvals,
    actions,
    settings,
    clock,
    asOf,
    setNow: (instant) => {
      current = typeof instant === 'string' ? new Date(instant) : instant;
    },
    issueToken: (proposalId) => actions.issueApprovalToken(proposalId),
    close: async () => {
      db.close();
      await db.delete();
    },
  };
}

export { fixedClock };
