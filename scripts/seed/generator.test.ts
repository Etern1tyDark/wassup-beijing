import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, type IsoDate } from '../../src/domain/time.ts';
import { SeedDatasetSchema } from '../../src/domain/seed.ts';
import { parseStatementCsv } from '../../src/importers/csv';
import {
  ADVERSARIAL_CSV,
  DEFAULT_SEED,
  HISTORY_MONTHS,
  SEED_AS_OF,
  datasetCounts,
  earmarkOverFreeCashFixture,
  generateSeed,
  hashDataset,
  staleDataFixture,
} from './generator.ts';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/seed/manifest.json', import.meta.url)), 'utf8'),
) as { seed: string; asOf: string; hash: string; counts: Record<string, number> };

describe('seed generator is deterministic (NFR-2)', () => {
  it('produces the same hash for the same seed', async () => {
    const first = await hashDataset(generateSeed({ seed: 'rina-v1' }));
    const second = await hashDataset(generateSeed({ seed: 'rina-v1' }));
    expect(first).toBe(second);
  });

  it('produces a different hash for a different seed', async () => {
    const a = await hashDataset(generateSeed({ seed: 'rina-v1' }));
    const b = await hashDataset(generateSeed({ seed: 'rina-v2' }));
    expect(a).not.toBe(b);
  });

  it('matches the checked-in fixture', async () => {
    const dataset = generateSeed({ seed: DEFAULT_SEED, asOf: SEED_AS_OF });
    expect(manifest.seed).toBe(DEFAULT_SEED);
    expect(manifest.hash).toBe(await hashDataset(dataset));
    expect(manifest.counts).toEqual(datasetCounts(dataset));
  });

  it('produces a dataset that passes its own schema', () => {
    expect(SeedDatasetSchema.safeParse(generateSeed()).success).toBe(true);
  });
});

describe('seeded dataset covers the PRD shape (PRD Section 8)', () => {
  const dataset = generateSeed({ seed: DEFAULT_SEED, asOf: SEED_AS_OF });

  it('has 3 to 5 clients', () => {
    const clients = new Set(dataset.invoices.map((invoice) => invoice.client));
    expect(clients.size).toBeGreaterThanOrEqual(3);
    expect(clients.size).toBeLessThanOrEqual(5);
  });

  it('pays invoices 0 to 45 days late', () => {
    const paid = dataset.invoices.filter((invoice) => invoice.paidDate !== null);
    expect(paid.length).toBeGreaterThan(10);
    for (const invoice of paid) {
      const lateDays = daysBetween(invoice.dueDate, invoice.paidDate as IsoDate);
      expect(lateDays, `${invoice.id} paid ${lateDays} days after due`).toBeGreaterThanOrEqual(0);
      expect(lateDays, `${invoice.id} paid ${lateDays} days after due`).toBeLessThanOrEqual(45);
    }
  });

  it('covers six months of history ending on the as-of date', () => {
    const dates = dataset.transactions.map((transaction) => transaction.date).sort();
    const first = dates[0] as IsoDate;
    const last = dates[dates.length - 1] as IsoDate;
    expect(daysBetween(first, SEED_AS_OF)).toBeGreaterThan(150);
    expect(daysBetween(first, SEED_AS_OF)).toBeLessThan(HISTORY_MONTHS * 31);
    expect(last).toBe(SEED_AS_OF);
  });

  it('includes rent, utilities, subscriptions, groceries and two irregular expenses', () => {
    const categories = new Set(dataset.transactions.map((transaction) => transaction.category));
    for (const category of ['housing', 'utilities', 'subscriptions', 'groceries', 'income']) {
      expect(categories.has(category), `missing category ${category}`).toBe(true);
    }
    expect(dataset.transactions.filter((transaction) => transaction.category === 'irregular')).toHaveLength(2);
  });

  it('has one open late invoice that creates the golden-path gap', () => {
    const late = dataset.invoices.find((invoice) => invoice.id === 'inv_late');
    expect(late).toBeDefined();
    expect(late?.paidDate).toBeNull();
    expect(daysBetween(late!.dueDate, SEED_AS_OF)).toBeGreaterThan(30);
  });

  it('keeps the ledger fresh enough to pass the staleness guard', () => {
    const latest = dataset.transactions.map((transaction) => transaction.date).sort().at(-1);
    expect(latest).toBe(SEED_AS_OF);
  });

  it('marks every seeded transaction as untrusted CSV data', () => {
    for (const transaction of dataset.transactions) {
      expect(transaction.source).toBe('csv');
      expect(transaction.untrusted).toBe(true);
    }
  });
});

describe('generated adversarial and edge fixtures', () => {
  it('writes an adversarial CSV whose description field carries an instruction', () => {
    const written = readFileSync(fileURLToPath(new URL('../../fixtures/csv/adversarial.csv', import.meta.url)), 'utf8');
    expect(written).toBe(ADVERSARIAL_CSV);

    const parsed = parseStatementCsv(written);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows.filter((row) => row.injectionSignal)).toHaveLength(1);
  });

  it('writes the earmark-over-free-cash fixture', () => {
    const written = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../fixtures/edge/earmark-over-free-cash.json', import.meta.url)), 'utf8'),
    ) as unknown;
    expect(written).toEqual(earmarkOverFreeCashFixture());
  });

  it('writes the stale-data fixture', () => {
    const written = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../fixtures/edge/stale-data.json', import.meta.url)), 'utf8'),
    ) as unknown;
    expect(written).toEqual(staleDataFixture());
  });

  it('dates the stale fixture more than a day behind its clock', () => {
    const fixture = staleDataFixture();
    const latest = fixture.ledger.transactions.map((transaction) => transaction.date).sort().at(-1) as IsoDate;
    expect(addDays(latest, 1) < (fixture.now ?? '').slice(0, 10)).toBe(true);
  });
});
