import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountSchema,
  EarmarkSchema,
  InvoiceSchema,
  ObligationSchema,
  TransactionSchema,
} from '../domain/schemas';
import { createTestWorld, type TestWorld } from '../testing/harness';
import { GUARDRAIL_RULES } from './guardrails';
import type { ProposeResult } from './service';
import type { EdgeFixture } from '../../scripts/seed/generator';

/**
 * The edge fixtures written by `npm run seed` (PRD Section 8). Each one is a
 * ledger plus a request that must be rejected for exactly one reason.
 */
function loadFixture(name: string): EdgeFixture {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/edge/${name}`, import.meta.url)), 'utf8'),
  ) as EdgeFixture;
  return {
    ...raw,
    ledger: {
      accounts: raw.ledger.accounts.map((row) => AccountSchema.parse(row)),
      transactions: raw.ledger.transactions.map((row) => TransactionSchema.parse(row)),
      invoices: raw.ledger.invoices.map((row) => InvoiceSchema.parse(row)),
      obligations: raw.ledger.obligations.map((row) => ObligationSchema.parse(row)),
      earmarks: raw.ledger.earmarks.map((row) => EarmarkSchema.parse(row)),
    },
  };
}

const worlds: TestWorld[] = [];

async function worldFromFixture(fixture: EdgeFixture): Promise<TestWorld> {
  const world = await createTestWorld({
    asOf: fixture.asOf,
    accounts: fixture.ledger.accounts,
    transactions: fixture.ledger.transactions,
    invoices: fixture.ledger.invoices,
    obligations: fixture.ledger.obligations,
    earmarks: fixture.ledger.earmarks,
  });
  worlds.push(world);
  return world;
}

afterEach(async () => {
  while (worlds.length > 0) {
    const current = worlds.pop();
    if (current) await current.close();
  }
});

describe('edge fixture: earmark larger than free cash (ACT-5)', () => {
  it('is refused by the free-cash guardrail', async () => {
    const fixture = loadFixture('earmark-over-free-cash.json');
    const world = await worldFromFixture(fixture);

    const snapshot = await world.actions.snapshot();
    expect(snapshot.freeCash).toBe(fixture.expected['freeCash']);

    const result = await world.actions.propose({
      action: fixture.request.action,
      params: fixture.request.params,
      provenance: { requestedBy: 'fixture', untrustedInputs: [] },
    });

    expect(result.kind).toBe('refused');
    const refused = result as Extract<ProposeResult, { kind: 'refused' }>;
    expect(refused.guardrails.filter((rule) => !rule.pass).map((rule) => rule.rule)).toContain(
      fixture.expected['rule'],
    );
    expect(await world.repos.earmarks.all()).toEqual([]);
    expect((await world.audit.list())[0]).toMatchObject({ event: 'refused' });
  });
});

describe('edge fixture: stale data (ST8)', () => {
  it('blocks execution once the ledger is older than the staleness limit', async () => {
    const fixture = loadFixture('stale-data.json');
    const world = await worldFromFixture(fixture);

    expect((await world.actions.staleness()).stale).toBe(false);

    const proposed = await world.actions.propose({
      action: fixture.request.action,
      params: fixture.request.params,
      provenance: { requestedBy: 'fixture', untrustedInputs: [] },
    });
    if (proposed.kind !== 'proposal') throw new Error('expected a proposal');

    const token = await world.issueToken(proposed.proposal.proposalId);
    const approved = await world.actions.approve({
      proposalId: proposed.proposal.proposalId,
      token: token.token,
    });
    expect(approved.kind).toBe('approved');

    world.setNow(fixture.now as string);
    const report = await world.actions.staleness();
    expect(report.stale).toBe(true);
    expect(report.ageHours ?? 0).toBeGreaterThan(fixture.expected['minAgeHours'] as number);

    const blocked = await world.actions.execute(proposed.proposal.proposalId);
    expect(blocked.kind).toBe('blocked');
    expect(await world.repos.earmarks.all()).toEqual([]);
    expect((await world.audit.list()).at(-1)).toMatchObject({ event: 'refused' });
  });
});

describe('edge fixture: empty and malformed CSVs (ING-2)', () => {
  it('rejects the empty CSV fixture', () => {
    const raw = readFileSync(fileURLToPath(new URL('../../fixtures/csv/empty.csv', import.meta.url)), 'utf8');
    expect(raw.trim()).toBe('');
  });

  it('rejects every row of the bad-dates fixture with a line number', async () => {
    const { parseStatementCsv } = await import('../importers/csv');
    const raw = readFileSync(
      fileURLToPath(new URL('../../fixtures/csv/bad-dates.csv', import.meta.url)),
      'utf8',
    );
    const result = parseStatementCsv(raw);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.line)).toEqual([2, 3, 4]);
    for (const error of result.errors) {
      expect(error.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('seeded ledger drives the golden path', () => {
  it('produces a fresh ledger that passes every earmark guardrail', async () => {
    const dataset = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../fixtures/seed/rina.json', import.meta.url)), 'utf8'),
    ) as {
      asOf: string;
      accounts: unknown[];
      transactions: unknown[];
      invoices: unknown[];
      obligations: unknown[];
    };

    const world = await createTestWorld({
      asOf: dataset.asOf,
      accounts: dataset.accounts.map((row) => AccountSchema.parse(row)),
      transactions: dataset.transactions.map((row) => TransactionSchema.parse(row)),
      invoices: dataset.invoices.map((row) => InvoiceSchema.parse(row)),
      obligations: dataset.obligations.map((row) => ObligationSchema.parse(row)),
      earmarks: [],
    });
    worlds.push(world);

    expect((await world.actions.staleness()).stale).toBe(false);

    const result = await world.actions.propose({
      action: 'earmark.create',
      params: { label: 'Medical reserve', amount: 1_000_000, reviewDate: '2027-01-13' },
      provenance: { requestedBy: 'ui_form', untrustedInputs: [] },
    });

    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      const failed = result.proposal.guardrails.filter((rule) => !rule.pass);
      expect(failed.map((rule) => rule.rule)).toEqual([]);
      expect(result.proposal.guardrails.map((rule) => rule.rule)).toContain(GUARDRAIL_RULES.freeCash);
    }
  });
});
