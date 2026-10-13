#!/usr/bin/env node
/**
 * LED-3 boundary check.
 *
 * Rule 1 - the ledger write API (src/storage/ledger-writes.ts) may only be
 *          imported by the action executor, the one-off seed loader and itself.
 * Rule 2 - no file outside the write API may write a ledger table
 *          (accounts, transactions, invoices, obligations, earmarks).
 * Rule 3 - the agent layer may never reach approvals, the executor or the write
 *          API, so the model cannot approve or execute.
 *
 * Exported so the Vitest suite runs exactly the same check as `npm run lint:boundary`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const LEDGER_TABLES = ['accounts', 'transactions', 'invoices', 'obligations', 'earmarks'];

export const LEDGER_WRITE_ALLOWLIST = [
  'src/actions/executor.ts',
  'src/storage/bootstrap.ts',
  'src/storage/ledger-writes.ts',
];

export const AGENT_FORBIDDEN_MODULES = ['approvals', 'executor', 'ledger-writes'];

const WRITE_METHODS = 'add|put|bulkAdd|bulkPut|update|delete|bulkDelete|clear|modify';

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * The statement that starts at `start`, with its newlines kept. It ends at the
 * first semicolon or blank line and never runs past 400 characters, so a read on
 * one line is not confused with a write to another table far below it. This is
 * what catches a write split across lines: `db.earmarks` on one line and
 * `.put(x)` on the next.
 */
function readStatement(text, start) {
  const window = text.slice(start, start + 400);
  const end = window.search(/;|\r?\n\s*\r?\n/);
  return end === -1 ? window : window.slice(0, end);
}

/**
 * @param {string} rootDir absolute path of the repository root
 * @returns {{ violations: Array<{file: string, line: number, rule: string, reason: string}>, checked: number }}
 */
export function scanLedgerWrites(rootDir) {
  const violations = [];
  const files = walk(join(rootDir, 'src'));
  const tablePattern = new RegExp(`\\bdb\\.(${LEDGER_TABLES.join('|')})\\b`);
  const methodPattern = new RegExp(`\\.(${WRITE_METHODS})\\(`);

  for (const file of files) {
    const relativePath = toPosix(relative(rootDir, file));
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r\n|\n|\r/);
    const allowedToImport = LEDGER_WRITE_ALLOWLIST.includes(relativePath);
    const isWriteModule = relativePath === 'src/storage/ledger-writes.ts';
    const reportedLines = new Set();

    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }

    lines.forEach((line, index) => {
      const lineNumber = index + 1;

      if (!allowedToImport && /from\s+['"][^'"]*ledger-writes(\.js)?['"]/.test(line)) {
        violations.push({
          file: relativePath,
          line: lineNumber,
          rule: 'ledger-write-import',
          reason: 'only the action executor and the seed loader may import the ledger write API (LED-3)',
        });
      }

      if (!isWriteModule && !reportedLines.has(lineNumber)) {
        const statement = readStatement(text, lineStarts[index]);
        if (tablePattern.test(statement) && methodPattern.test(statement)) {
          reportedLines.add(lineNumber);
          violations.push({
            file: relativePath,
            line: lineNumber,
            rule: 'ledger-table-write',
            reason: 'ledger tables may only be written through src/storage/ledger-writes.ts (LED-3)',
          });
        }
      }

      if (relativePath.startsWith('src/agent/')) {
        for (const forbidden of AGENT_FORBIDDEN_MODULES) {
          if (new RegExp(`from\\s+['"][^'"]*${forbidden}['"]`).test(line)) {
            violations.push({
              file: relativePath,
              line: lineNumber,
              rule: 'agent-approval-boundary',
              reason: `the agent layer must not import ${forbidden}; the model cannot approve or execute (PRD Section 6)`,
            });
          }
        }
      }
    });
  }

  return { violations, checked: files.length };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/'));
if (invokedDirectly) {
  const root = process.cwd();
  const { violations, checked } = scanLedgerWrites(root);
  if (violations.length === 0) {
    console.log(`ledger write boundary OK - ${checked} files checked`);
    process.exit(0);
  }
  console.error(`ledger write boundary FAILED - ${violations.length} violation(s)`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} [${violation.rule}] ${violation.reason}`);
  }
  process.exit(1);
}
