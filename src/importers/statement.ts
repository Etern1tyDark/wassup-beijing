import { sha256Hex } from '../audit/hash';
import type { StatementImportParams } from '../actions/params';
import type { ProposeInput } from '../actions/service';
import { parseStatementCsv, type CsvRowError, type ParsedCsvRow } from './csv';

/**
 * ING-1 / ING-2: turn a statement file into a proposal for the tier engine.
 *
 * Nothing is written here. A file with any malformed row is rejected whole,
 * with the line and reason for each one; a clean file becomes a
 * `statement.import` proposal that the user approves on a card like any other
 * ledger change (LED-3).
 */
export type PreparedStatement =
  | {
      ok: true;
      fileName: string;
      rowCount: number;
      accountNames: string[];
      /** Rows whose description reads like an instruction (ST3). Imported as data only. */
      flagged: ParsedCsvRow[];
      proposal: ProposeInput;
    }
  | { ok: false; fileName: string; errors: CsvRowError[] };

export async function prepareStatementImport(fileName: string, text: string): Promise<PreparedStatement> {
  const parsed = parseStatementCsv(text);
  if (!parsed.ok) return { ok: false, fileName, errors: parsed.errors };
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      fileName,
      errors: [{ line: 1, reason: 'the file has a header row but no transactions', raw: '' }],
    };
  }

  const params: StatementImportParams = {
    fileName,
    fileHash: `sha256:${await sha256Hex(text)}`,
    rows: parsed.rows.map((row) => ({
      line: row.line,
      date: row.date,
      description: row.description,
      amount: row.amount,
      account: row.account,
    })),
  };

  return {
    ok: true,
    fileName,
    rowCount: parsed.rows.length,
    accountNames: parsed.accountNames,
    flagged: parsed.rows.filter((row) => row.injectionSignal),
    proposal: {
      action: 'statement.import',
      params,
      // The rows are file content: recorded as untrusted, and they set neither
      // the action nor any protected parameter.
      provenance: {
        requestedBy: 'ui_statement_import',
        untrustedInputs: [{ source: 'csv', ref: fileName, fields: ['rows'] }],
      },
      actor: 'user',
    },
  };
}
