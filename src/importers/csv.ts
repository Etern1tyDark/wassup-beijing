import { randomId } from '../domain/ids';
import { parseRupiah, type Money } from '../domain/money';
import type { Transaction } from '../domain/schemas';
import { IsoDateSchema, type IsoDate } from '../domain/time';
import { looksLikeInjection } from './injection';

/**
 * ING-1 / ING-2: statement CSV importer for the fixed schema in PRD Section 8.
 *
 *   date,description,amount,balance,account
 *
 * A malformed row is reported with its line number and a reason. Nothing is
 * guessed: a row that does not parse cleanly never becomes a transaction, and
 * every description is marked untrusted.
 */
export const CSV_HEADER = ['date', 'description', 'amount', 'balance', 'account'] as const;

export interface CsvRowError {
  /** 1-based line number in the source file, counting the header row. */
  line: number;
  reason: string;
  raw: string;
}

export interface ParsedCsvRow {
  line: number;
  date: IsoDate;
  description: string;
  amount: Money;
  balance: Money;
  account: string;
  /** True when the description reads like an instruction (ST3). */
  injectionSignal: boolean;
}

export interface CsvImportResult {
  /** True only when every data row parsed. */
  ok: boolean;
  rows: ParsedCsvRow[];
  errors: CsvRowError[];
  accountNames: string[];
}

type LineParse = { fields: string[] } | { error: string };

/**
 * Parse one physical line as a CSV record. Quoted fields may contain commas and
 * escaped quotes; a quoted field may not span lines (reported as an error).
 */
function parseCsvLine(line: string): LineParse {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let index = 0;

  while (index < line.length) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      if (current.trim() !== '') return { error: 'unexpected quote inside an unquoted field' };
      current = '';
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      fields.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  if (inQuotes) return { error: 'unterminated quoted field' };
  fields.push(current);
  return { fields };
}

export function parseStatementCsv(text: string): CsvImportResult {
  const errors: CsvRowError[] = [];
  const rows: ParsedCsvRow[] = [];
  const accountNames = new Set<string>();

  const lines = text.split(/\r\n|\n|\r/);
  const firstContentLine = lines.findIndex((line) => line.trim() !== '');

  if (firstContentLine === -1) {
    return {
      ok: false,
      rows,
      errors: [{ line: 1, reason: 'file is empty; a header row is required', raw: '' }],
      accountNames: [],
    };
  }

  const headerLineNumber = firstContentLine + 1;
  const headerParsed = parseCsvLine(lines[firstContentLine] ?? '');
  if ('error' in headerParsed) {
    return {
      ok: false,
      rows,
      errors: [
        {
          line: headerLineNumber,
          reason: `header row: ${headerParsed.error}`,
          raw: lines[firstContentLine] ?? '',
        },
      ],
      accountNames: [],
    };
  }

  const header = headerParsed.fields.map((field) => field.trim().toLowerCase());
  if (
    header.length !== CSV_HEADER.length ||
    !CSV_HEADER.every((name, position) => header[position] === name)
  ) {
    return {
      ok: false,
      rows,
      errors: [
        {
          line: headerLineNumber,
          reason: `header must be exactly "${CSV_HEADER.join(',')}"`,
          raw: lines[firstContentLine] ?? '',
        },
      ],
      accountNames: [],
    };
  }

  for (let index = firstContentLine + 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineNumber = index + 1;
    if (raw.trim() === '') continue;

    const parsed = parseCsvLine(raw);
    if ('error' in parsed) {
      errors.push({ line: lineNumber, reason: parsed.error, raw });
      continue;
    }

    const fields = parsed.fields.map((field) => field.trim());
    if (fields.length !== CSV_HEADER.length) {
      errors.push({
        line: lineNumber,
        reason: `expected ${CSV_HEADER.length} columns (${CSV_HEADER.join(',')}), found ${fields.length}`,
        raw,
      });
      continue;
    }

    const [dateText, description, amountText, balanceText, account] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];

    const dateResult = IsoDateSchema.safeParse(dateText);
    if (!dateResult.success) {
      errors.push({ line: lineNumber, reason: `invalid date "${dateText}" (expected YYYY-MM-DD)`, raw });
      continue;
    }

    if (description === '') {
      errors.push({ line: lineNumber, reason: 'description is empty', raw });
      continue;
    }

    const amountResult = parseRupiah(amountText);
    if (!amountResult.ok) {
      errors.push({ line: lineNumber, reason: amountResult.reason, raw });
      continue;
    }

    const balanceResult = parseRupiah(balanceText);
    if (!balanceResult.ok) {
      errors.push({ line: lineNumber, reason: `balance: ${balanceResult.reason}`, raw });
      continue;
    }

    if (account === '') {
      errors.push({ line: lineNumber, reason: 'account is empty', raw });
      continue;
    }

    accountNames.add(account);
    rows.push({
      line: lineNumber,
      date: dateResult.data,
      description,
      amount: amountResult.value,
      balance: balanceResult.value,
      account,
      injectionSignal: looksLikeInjection(description),
    });
  }

  return { ok: errors.length === 0, rows, errors, accountNames: [...accountNames].sort() };
}

export interface RowsToTransactionsOptions {
  /** Resolve a CSV account name to an account id; unknown names are skipped. */
  accountIdByName: Record<string, string>;
  idFactory?: () => string;
}

/**
 * Turn parsed rows into ledger transactions. Every row keeps `untrusted: true`
 * and `source: 'csv'`, because the text came from a file the user did not type.
 */
export function rowsToTransactions(
  rows: readonly ParsedCsvRow[],
  options: RowsToTransactionsOptions,
): Transaction[] {
  const idFactory = options.idFactory ?? (() => randomId('txn'));
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const accountId = options.accountIdByName[row.account];
    if (accountId === undefined) continue;
    transactions.push({
      id: idFactory(),
      accountId,
      date: row.date,
      amount: row.amount,
      merchant: row.description,
      category: 'uncategorised',
      source: 'csv',
      untrusted: true,
    });
  }
  return transactions;
}
