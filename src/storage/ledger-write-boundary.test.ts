import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM tool shared with `npm run lint:boundary`.
import { scanLedgerWrites } from '../../tools/check-ledger-writes.mjs';

const root = decodeURIComponent(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * The violation fixtures are assembled at runtime on purpose: a literal
 * `db.<ledgerTable>` write or a literal `import ... ledger-writes` in this file
 * would be flagged by the scanner itself, which is exactly the behaviour under
 * test. Keeping the fixtures dynamic is what lets this file live inside `src/`.
 */
const LF = String.fromCharCode(10);
const WRITE_API = ['ledger', 'writes'].join('-');
const table = (name: string): string => ['db', name].join('.');

function scanFixture(files: Record<string, string>): {
  violations: Array<{ rule: string }>;
  checked: number;
} {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-'));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = join(directory, 'src', relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    }
    return scanLedgerWrites(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('ledger write boundary (LED-3)', () => {
  it('finds no violation in the real source tree', () => {
    const { violations, checked } = scanLedgerWrites(root);
    expect(checked).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });

  it('detects a file that imports the ledger write API', () => {
    const rogue = [
      `import { addEarmark } from '../storage/${WRITE_API}';`,
      'export const x = addEarmark;',
      '',
    ].join(LF);
    const result = scanFixture({ 'ui/rogue.ts': rogue });
    expect(result.violations.map((violation) => violation.rule)).toEqual(['ledger-write-import']);
  });

  it('detects a direct write to a ledger table', () => {
    const rogue = [`await ${table('transactions')}`, ".delete('txn_1');"].join(LF);
    const result = scanFixture({ 'ui/rogue.ts': rogue });
    expect(result.violations.map((violation) => violation.rule)).toEqual(['ledger-table-write']);
  });

  it('detects a write split across several lines', () => {
    const rogue = [`await ${table('earmarks')}`, "  .where('id')", '  .modify({ active: false });'].join(LF);
    const result = scanFixture({ 'ui/rogue.ts': rogue });
    expect(result.violations.map((violation) => violation.rule)).toEqual(['ledger-table-write']);
  });

  it('detects the agent layer reaching for approvals', () => {
    const rogue = ["import { createApprovalService } from '../actions/approvals';", ''].join(LF);
    const result = scanFixture({ 'agent/rogue.ts': rogue });
    expect(result.violations.map((violation) => violation.rule)).toEqual(['agent-approval-boundary']);
  });

  it('detects the agent layer reaching for the executor', () => {
    const rogue = ["import { createExecutor } from '../actions/executor';", ''].join(LF);
    const result = scanFixture({ 'agent/rogue.ts': rogue });
    expect(result.violations.map((violation) => violation.rule)).toEqual(['agent-approval-boundary']);
  });

  it('allows a read through the repositories', () => {
    const fine = ['const rows = await repos.transactions.all();', ''].join(LF);
    expect(scanFixture({ 'ui/fine.ts': fine }).violations).toEqual([]);
  });

  it('does not confuse a ledger read with a write to a non-ledger table', () => {
    const fine = [`const rows = await ${table('earmarks')}.toArray();`, 'await db.proposals.put(row);'].join(
      LF,
    );
    expect(scanFixture({ 'ui/fine.ts': fine }).violations).toEqual([]);
  });
});
