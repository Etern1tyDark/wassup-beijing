/**
 * Write the synthetic fixtures.
 *
 *   npm run seed
 *
 * Deterministic: running it twice produces byte-identical files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADVERSARIAL_CSV,
  DEFAULT_SEED,
  SEED_AS_OF,
  datasetCounts,
  earmarkOverFreeCashFixture,
  generateSeed,
  hashDataset,
  staleDataFixture,
} from './generator.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  console.log(`wrote ${relativePath}`);
}

const dataset = generateSeed({ seed: DEFAULT_SEED, asOf: SEED_AS_OF });
const hash = await hashDataset(dataset);

write('fixtures/seed/rina.json', `${JSON.stringify(dataset, null, 2)}\n`);
write(
  'fixtures/seed/manifest.json',
  `${JSON.stringify(
    {
      seed: dataset.seed,
      persona: dataset.persona,
      asOf: dataset.asOf,
      hash,
      counts: datasetCounts(dataset),
    },
    null,
    2,
  )}\n`,
);

write('fixtures/csv/adversarial.csv', ADVERSARIAL_CSV);
write(
  'fixtures/edge/earmark-over-free-cash.json',
  `${JSON.stringify(earmarkOverFreeCashFixture(), null, 2)}\n`,
);
write('fixtures/edge/stale-data.json', `${JSON.stringify(staleDataFixture(), null, 2)}\n`);

console.log(`seed "${dataset.seed}" -> ${hash}`);
console.log(JSON.stringify(datasetCounts(dataset)));
