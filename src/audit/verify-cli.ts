/**
 * AUD-3: verify an exported audit log.
 *
 *   npm run verify:audit -- path/to/audit-export.json
 *
 * Accepts either the export object written by `audit.exportJson()` or a bare
 * array of entries. Exit code 0 means the chain is intact.
 */
import { readFileSync } from 'node:fs';
import { verifyChain } from './chain.js';

function usage(): never {
  console.error('usage: npm run verify:audit -- <audit-export.json>');
  process.exit(2);
}

const file = process.argv[2];
if (file === undefined || file === '') usage();

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const entries = Array.isArray(parsed)
  ? parsed
  : ((parsed as { entries?: unknown } | null)?.entries as unknown[] | undefined);

if (!Array.isArray(entries)) {
  console.error('expected an array of entries, or an export object with an "entries" array');
  process.exit(2);
}

const result = await verifyChain(entries as Array<Record<string, unknown>>);

if (result.ok) {
  console.log(`audit chain OK - ${result.checked} entries verified`);
  process.exit(0);
}

console.error(`audit chain FAILED - ${result.errors.length} problem(s) in ${result.checked} entries`);
for (const error of result.errors) console.error(`  - ${error}`);
process.exit(1);
