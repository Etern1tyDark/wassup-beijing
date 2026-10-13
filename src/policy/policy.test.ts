import { describe, expect, it } from 'vitest';
import { toMoney } from '../domain/money';
import { extractPdfText } from '../importers/pdf';
import { nodePdfJs, policyFixtureBytes, policyFixturePages } from '../testing/policies';
import { renderPolicyPdf, HEALTH_POLICY, HIDDEN_POLICY_INSTRUCTION } from '../../scripts/seed/policies';
import { buildPdf } from '../../scripts/seed/pdf';
import {
  ADVISER_HANDOFF,
  assessCoverage,
  comparePolicies,
  findRankingLanguage,
  matchCoverageItem,
} from './coverage';
import {
  LOW_CONFIDENCE_THRESHOLD,
  extractPolicy,
  modelSafeClauseText,
  parsePolicyAmount,
  type PolicyExtraction,
} from './extractor';

async function extractFixture(fileName: string): Promise<PolicyExtraction> {
  const result = extractPolicy({
    fileName,
    fileHash: `sha256:${fileName.replace(/[^a-z]/g, '').padEnd(64, '0')}`,
    pages: await policyFixturePages(fileName),
    extractedAt: '2026-10-13T02:00:00.000Z',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.extraction;
}

describe('policy PDFs (ING-3)', () => {
  it('are written deterministically by the seed script', () => {
    expect(renderPolicyPdf(HEALTH_POLICY)).toEqual(policyFixtureBytes('health-policy.pdf'));
  });

  it('rejects a file that is not a PDF, and an empty one', async () => {
    expect(await extractPdfText(nodePdfJs, new TextEncoder().encode('date,description'))).toEqual({
      ok: false,
      reason: 'the file is not a PDF',
    });
    expect(await extractPdfText(nodePdfJs, new Uint8Array())).toMatchObject({ ok: false });
  });

  it('rejects a PDF with more than 20 pages', async () => {
    const pages = Array.from({ length: 21 }, (_, index) => [{ text: `Page ${index + 1}` }]);
    const result = await extractPdfText(nodePdfJs, buildPdf(pages));
    expect(result).toEqual({ ok: false, reason: 'the PDF has 21 pages; the limit is 20' });
  });

  it('rejects a PDF with no text layer instead of guessing', async () => {
    const result = await extractPdfText(nodePdfJs, buildPdf([[]]));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('no text layer');
  });
});

describe('policy extraction (POL-1, POL-5)', () => {
  it('reads the health policy: 14 clauses, every benefit with its page and clause', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');

    expect(policy).toMatchObject({
      displayName: 'Sehat Prima Health Policy',
      type: 'health',
      insurer: 'PT Asuransi Contoh Nusantara',
      startDate: '2026-07-01',
    });
    expect(document.clauses).toHaveLength(14);
    expect(document.pageCount).toBe(2);

    expect(items.map((item) => item.benefit)).toEqual([
      'Inpatient hospital care',
      'Intensive care',
      'Outpatient care',
      'Maternity care',
      'Dental care after an accident',
      'Emergency ambulance',
    ]);

    const inpatient = items[0]!;
    expect(inpatient).toMatchObject({
      limit: 60_000_000,
      deductible: 3_000_000,
      waitingPeriodDays: 30,
      exclusions: ['cosmetic surgery', 'treatment outside Indonesia', 'a private room upgrade'],
      clauseRef: 'Clause 4',
      page: 1,
      confidence: 1,
    });

    // POL-1: every item links to source text that really contains its numbers.
    for (const item of items) {
      const clause = document.clauses.find((candidate) => candidate.clauseRef === item.clauseRef);
      expect(clause, item.benefit).toBeDefined();
      expect(clause!.page).toBe(item.page);
      expect(clause!.title).toBe(item.benefit);
    }
    expect(document.clauses.find((clause) => clause.clauseRef === 'Clause 4')!.text).toContain(
      'Rp 60.000.000',
    );
  });

  it('reads explicit "none" values as zero with full confidence', async () => {
    const { items } = await extractFixture('health-policy.pdf');
    expect(items.find((item) => item.benefit === 'Emergency ambulance')).toMatchObject({
      limit: 1_500_000,
      deductible: 0,
      waitingPeriodDays: 0,
      confidence: 1,
    });
  });

  it('POL-5: marks a clause whose limit cannot be read as low confidence', async () => {
    const { lowConfidence } = await extractFixture('health-policy.pdf');
    expect(lowConfidence.map((item) => item.benefit)).toEqual(['Dental care after an accident']);
    expect(lowConfidence[0]!.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
  });

  it('keeps the personal identifiers for the redactor and out of the clauses', async () => {
    const { document } = await extractFixture('health-policy.pdf');
    expect(document.identifiers).toEqual({
      names: ['Rina Wulandari'],
      policyNumbers: ['SP-2026-0044171'],
      addresses: ['Jl. Kemang Raya No. 12, Jakarta Selatan'],
    });
    const allClauseText = document.clauses.map((clause) => clause.text).join(' ');
    expect(allClauseText).not.toContain('3174015203940007');
    expect(allClauseText).not.toContain('Rina');
  });

  it('reads the travel policy', async () => {
    const { policy, items } = await extractFixture('travel-policy.pdf');
    expect(policy).toMatchObject({ type: 'travel', startDate: '2026-10-01' });
    expect(items.map((item) => item.benefit)).toEqual([
      'Emergency medical treatment and hospital stay abroad',
      'Trip cancellation',
      'Lost or delayed baggage',
      'Flight delay',
      'Personal liability',
    ]);
    expect(items.every((item) => item.confidence === 1)).toBe(true);
  });

  it('refuses a document with no numbered clauses rather than guessing', () => {
    const result = extractPolicy({
      fileName: 'letter.pdf',
      fileHash: 'sha256:abc',
      pages: [{ page: 1, text: 'Dear customer,\nthank you for your payment.' }],
      extractedAt: '2026-10-13T02:00:00.000Z',
    });
    expect(result.ok).toBe(false);
  });

  it('only accepts amounts written as whole rupiah', () => {
    expect(parsePolicyAmount('60.000.000')).toBe(60_000_000);
    expect(parsePolicyAmount('60,000,000')).toBe(60_000_000);
    expect(parsePolicyAmount('1500000')).toBe(1_500_000);
    expect(parsePolicyAmount('60.000,50')).toBeNull();
    expect(parsePolicyAmount('sixty million')).toBeNull();
  });
});

describe('tampered policy (ST2)', () => {
  it('flags the hidden instruction and extracts the same numbers as the clean policy', async () => {
    const clean = await extractFixture('health-policy.pdf');
    const tampered = await extractFixture('health-policy-tampered.pdf');

    expect(tampered.injectionSignals).toEqual([
      { page: 1, clauseRef: 'Clause 4', text: HIDDEN_POLICY_INSTRUCTION },
    ]);
    expect(clean.injectionSignals).toEqual([]);

    const strip = (extraction: PolicyExtraction) =>
      extraction.items.map(({ benefit, limit, deductible, waitingPeriodDays, exclusions }) => ({
        benefit,
        limit,
        deductible,
        waitingPeriodDays,
        exclusions,
      }));
    expect(strip(tampered)).toEqual(strip(clean));
  });

  it('cuts the instruction out of the text that may reach the model', async () => {
    const { document } = await extractFixture('health-policy-tampered.pdf');
    const clause = document.clauses.find((candidate) => candidate.clauseRef === 'Clause 4')!;
    expect(clause.text).toContain('ignore previous instructions');
    const safe = modelSafeClauseText(clause);
    expect(safe).not.toContain('ignore previous instructions');
    expect(safe).not.toContain('8820134455');
    expect(safe).toContain('[instruction-like text removed]');
    expect(safe).toContain('Rp 60.000.000');
  });
});

describe('coverage engine (POL-2, POL-3)', () => {
  const freeCash = toMoney(12_000_000);

  it('computes the worst-case out-of-pocket and the shortfall for a hospital stay', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy,
      document,
      items,
      event: 'hospital stay',
      freeCash,
      asOf: '2026-10-13',
    });

    // Worked by hand: cost 75,000,000; after the 3,000,000 co-payment 72,000,000
    // remains, of which the policy pays its 60,000,000 limit. Out of pocket:
    // 75,000,000 - 60,000,000 = 15,000,000. Shortfall: 15,000,000 - 12,000,000.
    expect(result).toMatchObject({
      kind: 'covered',
      benefit: 'Inpatient hospital care',
      estimatedCost: 75_000_000,
      costBasis: 'reference',
      inWaitingPeriod: false,
      waitingEndsOn: '2026-07-31',
      insurerPays: 60_000_000,
      worstCaseOutOfPocket: 15_000_000,
      shortfall: 3_000_000,
      suggestedReserve: 3_000_000,
    });
    if (result.kind !== 'covered') throw new Error('expected a covered result');
    expect(result.citations.map((citation) => citation.clauseRef)).toEqual(['Clause 4', 'Clause 10']);
    expect(result.citations[0]!.page).toBe(1);
  });

  it('uses the user’s own cost estimate when one is given', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy,
      document,
      items,
      event: 'hospital stay',
      estimatedCost: toMoney(20_000_000),
      freeCash,
      asOf: '2026-10-13',
    });
    // 20,000,000 - 3,000,000 co-payment = 17,000,000 paid by the policy.
    expect(result).toMatchObject({
      costBasis: 'user',
      insurerPays: 17_000_000,
      worstCaseOutOfPocket: 3_000_000,
      shortfall: 0,
    });
  });

  it('pays nothing while the waiting period is still running', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy,
      document,
      items,
      event: 'hospital stay',
      freeCash,
      asOf: '2026-07-15',
    });
    expect(result).toMatchObject({
      inWaitingPeriod: true,
      insurerPays: 0,
      worstCaseOutOfPocket: 75_000_000,
      shortfall: 63_000_000,
    });
  });

  it('assumes the waiting period is running when the start date is unknown', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy: { ...policy, startDate: null },
      document,
      items,
      event: 'hospital stay',
      freeCash,
      asOf: '2026-10-13',
    });
    expect(result).toMatchObject({ inWaitingPeriod: true, waitingEndsOn: null, insurerPays: 0 });
  });

  it('POL-5: returns the raw clause instead of a summary for a low-confidence item', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy,
      document,
      items,
      event: 'dental implants',
      freeCash,
      asOf: '2026-10-13',
    });
    expect(result.kind).toBe('low-confidence');
    if (result.kind !== 'low-confidence') return;
    expect(result.citation.clauseRef).toBe('Clause 8');
    expect(result.citation.text).toContain('up to the amount shown in your policy schedule');
    expect(result.note).toContain("can't confirm");
    expect(result.note).toContain('insurer');
  });

  it('I3: says it cannot confirm a benefit that has no clause, and shows the nearest text', async () => {
    const { policy, document, items } = await extractFixture('health-policy.pdf');
    const result = assessCoverage({
      policy,
      document,
      items,
      event: 'physiotherapy',
      freeCash,
      asOf: '2026-10-13',
    });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.note).toContain("can't confirm");
    expect(result.note).toContain('insurer');
    expect(result.nearest?.clauseRef).toBe('Clause 10');
  });

  it('matches an event to the closest benefit title', async () => {
    const { items } = await extractFixture('health-policy.pdf');
    expect(matchCoverageItem(items, 'hospital stay')?.clauseRef).toBe('Clause 4');
    expect(matchCoverageItem(items, 'ICU')?.clauseRef).toBe('Clause 5');
    expect(matchCoverageItem(items, 'giving birth')?.clauseRef).toBe('Clause 7');
    expect(matchCoverageItem(items, 'a new laptop')).toBeNull();
  });
});

describe('policy comparison (POL-4)', () => {
  it('puts both policies side by side on the chosen criteria, with sources and no ranking', async () => {
    const health = await extractFixture('health-policy.pdf');
    const travel = await extractFixture('travel-policy.pdf');
    const comparison = comparePolicies(
      [
        { policy: health.policy, items: health.items },
        { policy: travel.policy, items: travel.items },
      ],
      ['hospital cover', 'waiting periods'],
    );

    expect(comparison.columns).toEqual(['Sehat Prima Health Policy', 'Jelajah Aman Travel Policy']);
    expect(comparison.rows).toEqual([
      {
        criterion: 'hospital cover: benefit',
        values: [
          'Inpatient hospital care (Clause 4, page 1)',
          'Emergency medical treatment and hospital stay abroad (Clause 4, page 1)',
        ],
      },
      {
        criterion: 'hospital cover: limit',
        values: ['Rp 60.000.000 (Clause 4, page 1)', 'Rp 500.000.000 (Clause 4, page 1)'],
      },
      {
        criterion: 'hospital cover: waiting period',
        values: ['30 days (Clause 4, page 1)', 'None (Clause 4, page 1)'],
      },
    ]);
    expect(comparison.handoff).toBe(ADVISER_HANDOFF);

    const everything = JSON.stringify(comparison);
    expect(findRankingLanguage(everything)).toBeNull();
    expect(everything).toContain('licensed insurance adviser');
  });

  it('says so when a policy has no matching clause', async () => {
    const health = await extractFixture('health-policy.pdf');
    const travel = await extractFixture('travel-policy.pdf');
    const comparison = comparePolicies(
      [
        { policy: health.policy, items: health.items },
        { policy: travel.policy, items: travel.items },
      ],
      ['maternity'],
    );
    expect(comparison.rows[0]!.values).toEqual([
      'Maternity care (Clause 7, page 1)',
      'No matching clause found',
    ]);
  });

  it('detects wording that would turn a comparison into a recommendation', () => {
    expect(findRankingLanguage('The travel policy is the better choice.')).toBe('better');
    expect(findRankingLanguage('I recommend the health policy')).toBe('recommend');
    expect(findRankingLanguage('The limit is Rp 60.000.000 (Clause 4)')).toBeNull();
  });
});
