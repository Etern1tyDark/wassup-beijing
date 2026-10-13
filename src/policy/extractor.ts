import { randomId } from '../domain/ids';
import { parseRupiah, toMoney, type Money } from '../domain/money';
import {
  CoverageItemSchema,
  PolicyDocumentSchema,
  PolicySchema,
  type CoverageItem,
  type Policy,
  type PolicyClause,
  type PolicyDocument,
} from '../domain/schemas';
import { IsoDateSchema, type IsoDate } from '../domain/time';
import { findInjectionSignals } from '../importers/injection';
import type { PdfPageText } from '../importers/pdf';

/**
 * POL-1 / POL-5: turn the text of a policy into coverage items, each with the
 * page and clause it came from.
 *
 * The extractor is rule-based and runs in the browser, so the policy view works
 * with no model and no network (PRD Section 7, "Model outage"), the same text
 * always gives the same items (NFR-2), and no number is ever produced by a
 * model. A rule either finds a value or it does not: a clause whose limit
 * cannot be read becomes a low-confidence item, and the interface shows its raw
 * text instead of a summary.
 *
 * Policy text is untrusted input. Nothing here follows it; sentences that read
 * like an instruction are only recorded as injection signals (ST2).
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export interface PolicyExtractionInput {
  fileName: string;
  fileHash: string;
  pages: readonly PdfPageText[];
  extractedAt: string;
}

export interface PolicyExtraction {
  policy: Policy;
  document: PolicyDocument;
  items: CoverageItem[];
  /** Items below the display threshold (POL-5). */
  lowConfidence: CoverageItem[];
  /** Instruction-like text found anywhere in the document (ST2). */
  injectionSignals: Array<{ page: number; clauseRef: string | null; text: string }>;
}

export type PolicyExtractionResult =
  { ok: true; extraction: PolicyExtraction } | { ok: false; reason: string };

const CLAUSE_START = /(?:^|\n)\s*Clause\s+(\d+(?:\.\d+)*)\.\s+/g;

/** Rejoin the lines pdf.js returns into flowing text. */
function flow(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerValue(header: string, label: string): string | null {
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(header);
  return match ? match[1]!.trim() : null;
}

/** "60.000.000" or "60,000,000" -> 60000000. Anything else is not guessed at. */
export function parsePolicyAmount(text: string): Money | null {
  const cleaned = text.trim().replace(/[.,]$/, '');
  if (!/^\d{1,3}([.,]\d{3})*$/.test(cleaned) && !/^\d+$/.test(cleaned)) return null;
  const parsed = parseRupiah(cleaned.replace(/[.,]/g, ''));
  return parsed.ok ? parsed.value : null;
}

interface RawClause {
  clauseRef: string;
  page: number;
  title: string;
  text: string;
}

function splitClauses(pages: readonly PdfPageText[]): RawClause[] {
  const clauses: RawClause[] = [];
  for (const page of pages) {
    const starts = [...page.text.matchAll(CLAUSE_START)];
    starts.forEach((match, index) => {
      const bodyStart = match.index + match[0].length;
      const bodyEnd = index + 1 < starts.length ? starts[index + 1]!.index : page.text.length;
      const body = flow(page.text.slice(bodyStart, bodyEnd));
      const titleEnd = body.indexOf('. ');
      const title = (titleEnd === -1 ? body : body.slice(0, titleEnd)).trim();
      if (title === '') return;
      clauses.push({
        clauseRef: `Clause ${match[1]!}`,
        page: page.page,
        title,
        text: titleEnd === -1 ? '' : body.slice(titleEnd + 2).trim(),
      });
    });
  }
  return clauses;
}

function inferType(header: string, clauses: readonly RawClause[]): Policy['type'] | null {
  const declared = headerValue(header, 'Policy type')?.toLowerCase();
  if (declared === 'health' || declared === 'travel') return declared;
  const titles = clauses.map((clause) => clause.title.toLowerCase()).join(' ');
  if (/\b(trip|baggage|flight|travel)\b/.test(titles)) return 'travel';
  if (/\b(inpatient|outpatient|hospital|maternity)\b/.test(titles)) return 'health';
  return null;
}

function findStartDate(header: string, clauses: readonly RawClause[]): IsoDate | null {
  const candidates = [
    headerValue(header, 'Policy start date'),
    ...clauses.map((clause) => /\bstarts on (\d{4}-\d{2}-\d{2})\b/i.exec(clause.text)?.[1] ?? null),
  ];
  for (const candidate of candidates) {
    const parsed = IsoDateSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** A clause promises a benefit when the insurer says what it pays. */
function isBenefitClause(clause: RawClause): boolean {
  return /\bwe pay\b/i.test(clause.text);
}

function extractItem(policyId: string, clause: RawClause): CoverageItem {
  let confidence = 1;

  const limitMatch = /\bup to a (?:maximum|limit) of Rp\s?([\d.,]+)/i.exec(clause.text);
  const limit = limitMatch ? parsePolicyAmount(limitMatch[1]!) : null;
  if (limit === null) confidence = 0.3;

  let deductible: Money = toMoney(0);
  const copayMatch = /\b(?:co-?payment|deductible) of Rp\s?([\d.,]+)/i.exec(clause.text);
  if (copayMatch) {
    const parsed = parsePolicyAmount(copayMatch[1]!);
    if (parsed === null) confidence = Math.min(confidence, 0.5);
    else deductible = parsed;
  } else if (!/\bno (?:co-?payment|deductible)\b/i.test(clause.text)) {
    confidence = Math.min(confidence, 0.6);
  }

  let waitingPeriodDays = 0;
  const waitingMatch = /\bwaiting period of (\d{1,4}) days\b/i.exec(clause.text);
  if (waitingMatch) {
    waitingPeriodDays = Number(waitingMatch[1]);
  } else if (!/\bno waiting period\b/i.test(clause.text)) {
    confidence = Math.min(confidence, 0.6);
  }

  const exclusionMatch = /\bNot covered under this clause:\s*([^.]+)\./i.exec(clause.text);
  const exclusions = exclusionMatch
    ? exclusionMatch[1]!
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];

  return CoverageItemSchema.parse({
    id: `${policyId}_${clause.clauseRef.replace(/\s+/g, '').toLowerCase()}`,
    policyId,
    benefit: clause.title,
    limit: limit ?? 0,
    deductible,
    waitingPeriodDays,
    exclusions,
    page: clause.page,
    clauseRef: clause.clauseRef,
    confidence,
  });
}

export function extractPolicy(input: PolicyExtractionInput): PolicyExtractionResult {
  const rawClauses = splitClauses(input.pages);
  if (rawClauses.length === 0) {
    return {
      ok: false,
      reason:
        'no numbered clauses were found ("Clause 1. ..."). This layout is not supported, so nothing was extracted or guessed',
    };
  }

  const firstPage = input.pages[0]?.text ?? '';
  const header = firstPage.slice(0, Math.max(0, firstPage.search(/(?:^|\n)\s*Clause\s+\d/)));
  const displayName =
    header
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? input.fileName;

  const type = inferType(header, rawClauses);
  if (type === null) {
    return { ok: false, reason: 'the document does not say whether it is a health or a travel policy' };
  }

  const policyId = `pol_${input.fileHash.replace(/^sha256:/, '').slice(0, 12) || randomId('doc')}`;

  const clauses: PolicyClause[] = rawClauses.map((clause) => ({
    clauseRef: clause.clauseRef,
    page: clause.page,
    title: clause.title,
    text: clause.text,
    injectionSignals: findInjectionSignals(clause.text),
  }));

  const injectionSignals: PolicyExtraction['injectionSignals'] = [
    ...findInjectionSignals(flow(header)).map((text) => ({ page: 1, clauseRef: null, text })),
    ...clauses.flatMap((clause) =>
      clause.injectionSignals.map((text) => ({ page: clause.page, clauseRef: clause.clauseRef, text })),
    ),
  ];

  const items = rawClauses.filter(isBenefitClause).map((clause) => extractItem(policyId, clause));

  const insured = headerValue(header, 'Insured');
  const policyNumber = headerValue(header, 'Policy number');
  const address = headerValue(header, 'Address');

  const policy = PolicySchema.parse({
    id: policyId,
    displayName,
    type,
    insurer: headerValue(header, 'Insurer') ?? 'Unknown insurer',
    fileHash: input.fileHash,
    extractedAt: input.extractedAt,
    startDate: findStartDate(header, rawClauses),
  });

  const document = PolicyDocumentSchema.parse({
    policyId,
    fileName: input.fileName,
    pageCount: input.pages.length,
    clauses,
    identifiers: {
      names: insured ? [insured] : [],
      policyNumbers: policyNumber ? [policyNumber] : [],
      addresses: address ? [address] : [],
    },
  });

  return {
    ok: true,
    extraction: {
      policy,
      document,
      items,
      lowConfidence: items.filter((item) => item.confidence < LOW_CONFIDENCE_THRESHOLD),
      injectionSignals,
    },
  };
}

/**
 * The clause text as it may be shown to the model: instruction-like sentences
 * are cut out and replaced by a marker, so they are never passed on (ST2).
 */
export function modelSafeClauseText(clause: Pick<PolicyClause, 'text' | 'injectionSignals'>): string {
  let text = clause.text;
  for (const signal of clause.injectionSignals) {
    text = text.split(signal).join('[instruction-like text removed]');
  }
  return text;
}
