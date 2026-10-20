/**
 * AUD-3: verify an exported audit log.
 *
 *   npm run verify:audit -- path/to/audit-export.json [--expected-head <hash>]
 *
 * Accepts either the export object written by `audit.exportJson()` or a bare
 * array of entries. Exit code 0 means the chain is intact.
 *
 * The chain is unkeyed: someone who can edit the file can rewrite every entry
 * and recompute every hash. What catches that is a head hash recorded somewhere
 * else (the audit panel shows it; write it down or publish it) and passed as
 * --expected-head. The export's own length and head hash catch a log that was
 * cut short or extended without updating them.
 */
import { readFileSync } from 'node:fs';
import { verifyChain } from './chain.js';

function usage(): never {
  console.error('usage: npm run verify:audit -- <audit-export.json> [--expected-head <hash>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const headFlag = args.indexOf('--expected-head');
const expectedHead = headFlag >= 0 ? args[headFlag + 1] : undefined;
if (headFlag >= 0 && (expectedHead === undefined || expectedHead === '')) usage();
const file = args.filter(
  (arg, index) => !arg.startsWith('--') && (headFlag < 0 || index !== headFlag + 1),
)[0];
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

if (entries.length === 0) {
  console.error('audit chain FAILED - the log is empty, so it proves nothing');
  process.exit(1);
}

const result = await verifyChain(entries as Array<Record<string, unknown>>);
const last = (entries as Array<{ seq?: unknown; hash?: unknown }>).reduce((latest, entry) =>
  Number(entry.seq) > Number(latest.seq) ? entry : latest,
);
const head = typeof last.hash === 'string' ? last.hash : '';

// The export states its own length and head; a log cut short or extended after
// export no longer matches them.
const stated = Array.isArray(parsed)
  ? undefined
  : (parsed as { chain?: { length?: unknown; headHash?: unknown } }).chain;
if (stated && typeof stated.length === 'number' && stated.length !== entries.length) {
  result.ok = false;
  result.errors.push(`the export says ${stated.length} entries but contains ${entries.length}`);
}
if (stated && typeof stated.headHash === 'string' && stated.headHash !== head) {
  result.ok = false;
  result.errors.push('the last entry is not the head hash the export states');
}
if (expectedHead !== undefined && expectedHead !== head) {
  result.ok = false;
  result.errors.push(`head hash ${head} does not match the expected ${expectedHead}`);
}

if (result.ok) {
  console.log(`head hash ${head}`);
  console.log(`audit chain OK - ${result.checked} entries verified`);
  process.exit(0);
}

console.error(`audit chain FAILED - ${result.errors.length} problem(s) in ${result.checked} entries`);
for (const error of result.errors) console.error(`  - ${error}`);
process.exit(1);
