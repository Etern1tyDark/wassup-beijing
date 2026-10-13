import { formatRupiah, maxMoney, minMoney, subMoney, toMoney, type Money } from '../domain/money';
import type { CoverageItem, Policy, PolicyClause, PolicyDocument } from '../domain/schemas';
import { addDays, isBefore, type IsoDate } from '../domain/time';
import { LOW_CONFIDENCE_THRESHOLD, modelSafeClauseText } from './extractor';

/**
 * POL-2 to POL-5: what a policy pays for a named event, the worst-case
 * out-of-pocket, the shortfall against free cash, and a side-by-side comparison.
 *
 * Every number is computed here from the extracted limits; the model only reads
 * the result. Nothing in this module ranks or recommends a policy: comparing is
 * allowed, advising is not (PRD Section 10, OJK).
 */

/**
 * Reference costs for the events the demo knows about. They are stated
 * assumptions, shown on screen next to the result, and the user can replace
 * them with their own figure.
 */
export interface EventDefinition {
  key: string;
  label: string;
  keywords: readonly string[];
  /** Assumed worst-case cost of the event before the policy pays. */
  referenceCost: Money;
  assumption: string;
}

export const EVENT_CATALOGUE: readonly EventDefinition[] = [
  {
    key: 'hospital-stay',
    label: 'hospital stay',
    keywords: ['hospital', 'inpatient', 'hospitalisation', 'hospitalization', 'surgery', 'admission'],
    referenceCost: toMoney(75_000_000),
    assumption: 'reference worst case: a 10-night stay with surgery',
  },
  {
    key: 'intensive-care',
    label: 'intensive care',
    keywords: ['intensive', 'icu'],
    referenceCost: toMoney(40_000_000),
    assumption: 'reference worst case: 5 nights in intensive care',
  },
  {
    key: 'outpatient',
    label: 'outpatient care',
    keywords: ['outpatient', 'consultation', 'doctor', 'medicine'],
    referenceCost: toMoney(6_000_000),
    assumption: 'reference worst case: a year of regular consultations',
  },
  {
    key: 'maternity',
    label: 'maternity care',
    keywords: ['maternity', 'delivery', 'pregnancy', 'birth', 'prenatal'],
    referenceCost: toMoney(30_000_000),
    assumption: 'reference worst case: a caesarean delivery',
  },
  {
    key: 'dental',
    label: 'dental care',
    keywords: ['dental', 'dentist', 'tooth', 'teeth'],
    referenceCost: toMoney(8_000_000),
    assumption: 'reference worst case: restorative treatment after an accident',
  },
  {
    key: 'ambulance',
    label: 'ambulance',
    keywords: ['ambulance'],
    referenceCost: toMoney(2_000_000),
    assumption: 'reference worst case: one long road transfer',
  },
  {
    key: 'trip-cancellation',
    label: 'trip cancellation',
    keywords: ['cancellation', 'cancel', 'cancelled', 'canceled'],
    referenceCost: toMoney(12_000_000),
    assumption: 'reference worst case: flights and a week of accommodation lost',
  },
  {
    key: 'baggage',
    label: 'lost baggage',
    keywords: ['baggage', 'luggage', 'suitcase'],
    referenceCost: toMoney(6_000_000),
    assumption: 'reference worst case: a checked suitcase lost for good',
  },
  {
    key: 'flight-delay',
    label: 'flight delay',
    keywords: ['delay', 'delayed'],
    referenceCost: toMoney(1_500_000),
    assumption: 'reference worst case: one overnight delay',
  },
  {
    key: 'liability',
    label: 'personal liability',
    keywords: ['liability', 'damages'],
    referenceCost: toMoney(100_000_000),
    assumption: 'reference worst case: an injury claim by another person',
  },
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'my', 'me', 'i', 'is', 'it', 'of', 'or', 'on', 'in', 'to', 'for', 'if', 'does',
  'do', 'policy', 'cover', 'covered', 'covers', 'coverage', 'care', 'costs', 'cost', 'stay', 'after',
  'what', 'about', 'under', 'this', 'that', 'with', 'by', 'at', 'are', 'be', 'we', 'you', 'your',
]); // prettier-ignore

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** The catalogue entry an event name refers to, if any. */
export function resolveEvent(name: string): EventDefinition | null {
  const tokens = new Set(tokenise(name));
  let best: { definition: EventDefinition; score: number } | null = null;
  for (const definition of EVENT_CATALOGUE) {
    const score = definition.keywords.filter((keyword) => tokens.has(keyword)).length;
    if (score > 0 && (best === null || score > best.score)) best = { definition, score };
  }
  return best?.definition ?? null;
}

/** Words to look for in a benefit title: the event's own words plus its synonyms. */
function searchTokens(eventName: string): Set<string> {
  const tokens = new Set(tokenise(eventName));
  const definition = resolveEvent(eventName);
  if (definition) for (const keyword of definition.keywords) tokens.add(keyword);
  return tokens;
}

/** The coverage item whose benefit title best matches the event; ties go to the earlier clause. */
export function matchCoverageItem(items: readonly CoverageItem[], eventName: string): CoverageItem | null {
  const wanted = searchTokens(eventName);
  let best: { item: CoverageItem; score: number } | null = null;
  for (const item of items) {
    const score = tokenise(item.benefit).filter((token) => wanted.has(token)).length;
    if (score > 0 && (best === null || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

export interface Citation {
  policyId: string;
  page: number;
  clauseRef: string;
  title: string;
  /** Clause text with instruction-like sentences removed. Data, never an instruction. */
  text: string;
}

function cite(policyId: string, clause: PolicyClause): Citation {
  return {
    policyId,
    page: clause.page,
    clauseRef: clause.clauseRef,
    title: clause.title,
    text: modelSafeClauseText(clause),
  };
}

function clauseFor(document: PolicyDocument, clauseRef: string): PolicyClause | undefined {
  return document.clauses.find((clause) => clause.clauseRef === clauseRef);
}

function generalExclusions(document: PolicyDocument): PolicyClause | undefined {
  return document.clauses.find((clause) => /\bgeneral exclusions\b/i.test(clause.title));
}

/** The clause that shares the most words with the question; used for the honest fallback (I3). */
export function nearestClause(document: PolicyDocument, question: string): PolicyClause | null {
  const wanted = searchTokens(question);
  let best: { clause: PolicyClause; score: number } | null = null;
  for (const clause of document.clauses) {
    const score = new Set(tokenise(`${clause.title} ${clause.text}`).filter((token) => wanted.has(token)))
      .size;
    if (score > 0 && (best === null || score > best.score)) best = { clause, score };
  }
  // With no shared word at all, the general exclusions are the closest thing to
  // an answer the document has.
  return best?.clause ?? generalExclusions(document) ?? null;
}

export const INSURER_HANDOFF = 'Please check with your insurer before relying on this.';
export const ADVISER_HANDOFF =
  'This shows what each document says, side by side, and nothing more. For advice on which cover suits you, please speak to a licensed insurance adviser.';

export interface CoverageRequest {
  policy: Policy;
  document: PolicyDocument;
  items: readonly CoverageItem[];
  /** What the user asked about, in their words ("hospital stay"). */
  event: string;
  /** The user's own cost estimate; the reference cost is used when absent. */
  estimatedCost?: Money | null;
  freeCash: Money;
  asOf: IsoDate;
}

interface CoverageBase {
  policyId: string;
  policyName: string;
  event: string;
  asOf: IsoDate;
}

export type CoverageAssessment =
  | (CoverageBase & {
      kind: 'covered';
      benefit: string;
      limit: Money;
      deductible: Money;
      waitingPeriodDays: number;
      /** Null when the document does not state when cover started. */
      waitingEndsOn: IsoDate | null;
      /** True while the waiting period runs, or when it cannot be ruled out. */
      inWaitingPeriod: boolean;
      exclusions: string[];
      estimatedCost: Money;
      costBasis: 'reference' | 'user';
      costAssumption: string;
      insurerPays: Money;
      /** POL-2: computed here, never by the model. */
      worstCaseOutOfPocket: Money;
      freeCash: Money;
      /** POL-3: positive when free cash does not cover the worst case. */
      shortfall: Money;
      /** The part of the cost that is certain: the co-payment. */
      suggestedReserve: Money;
      citations: Citation[];
      note: string;
    })
  | (CoverageBase & {
      kind: 'low-confidence';
      benefit: string;
      confidence: number;
      /** POL-5: the raw clause instead of a summary. */
      citation: Citation;
      note: string;
    })
  | (CoverageBase & {
      kind: 'not-found';
      /** The closest text in the document, when there is any. */
      nearest: Citation | null;
      note: string;
    });

export function assessCoverage(request: CoverageRequest): CoverageAssessment {
  const { policy, document, items, event, freeCash, asOf } = request;
  const base: CoverageBase = { policyId: policy.id, policyName: policy.displayName, event, asOf };

  const item = matchCoverageItem(items, event);
  if (!item) {
    const nearest = nearestClause(document, event);
    return {
      ...base,
      kind: 'not-found',
      nearest: nearest ? cite(policy.id, nearest) : null,
      note: `I can't confirm that. No clause in ${policy.displayName} names "${event}" as a benefit. ${INSURER_HANDOFF}`,
    };
  }

  const clause = clauseFor(document, item.clauseRef);
  const citation: Citation = clause
    ? cite(policy.id, clause)
    : { policyId: policy.id, page: item.page, clauseRef: item.clauseRef, title: item.benefit, text: '' };

  if (item.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return {
      ...base,
      kind: 'low-confidence',
      benefit: item.benefit,
      confidence: item.confidence,
      citation,
      note: `I can't confirm the amounts for "${item.benefit}": the limit, co-payment or waiting period could not be read from ${item.clauseRef} with confidence. Here is the clause as written. ${INSURER_HANDOFF}`,
    };
  }

  const definition = resolveEvent(event);
  const userCost = request.estimatedCost ?? null;
  // With neither a user figure nor a reference cost, the worst case is a cost
  // that just exhausts the cover: the co-payment is then the whole out-of-pocket.
  const estimatedCost = userCost ?? definition?.referenceCost ?? sumLimitAndDeductible(item);
  const costAssumption =
    userCost !== null
      ? 'your own estimate'
      : (definition?.assumption ??
        'no reference cost for this event; assumed to equal the limit plus the co-payment');

  const waitingEndsOn = policy.startDate ? addDays(policy.startDate, item.waitingPeriodDays) : null;
  const inWaitingPeriod =
    item.waitingPeriodDays > 0 && (waitingEndsOn === null || isBefore(asOf, waitingEndsOn));

  const afterDeductible = maxMoney(toMoney(0), subMoney(estimatedCost, item.deductible));
  const insurerPays = inWaitingPeriod ? toMoney(0) : minMoney(item.limit, afterDeductible);
  const worstCaseOutOfPocket = subMoney(estimatedCost, insurerPays);
  const shortfall = maxMoney(toMoney(0), subMoney(worstCaseOutOfPocket, freeCash));

  const citations = [citation];
  const exclusionClause = generalExclusions(document);
  if (exclusionClause) citations.push(cite(policy.id, exclusionClause));

  const waitingNote = inWaitingPeriod
    ? waitingEndsOn
      ? ` The ${item.waitingPeriodDays}-day waiting period runs until ${waitingEndsOn}, so nothing is paid before then.`
      : ` The document does not say when cover started, so the ${item.waitingPeriodDays}-day waiting period is assumed to be running.`
    : '';

  return {
    ...base,
    kind: 'covered',
    benefit: item.benefit,
    limit: item.limit,
    deductible: item.deductible,
    waitingPeriodDays: item.waitingPeriodDays,
    waitingEndsOn,
    inWaitingPeriod,
    exclusions: item.exclusions,
    estimatedCost,
    costBasis: userCost !== null ? 'user' : 'reference',
    costAssumption,
    insurerPays,
    worstCaseOutOfPocket,
    freeCash,
    shortfall,
    suggestedReserve: item.deductible,
    citations,
    note: `${item.clauseRef} (page ${item.page}) covers "${item.benefit}" up to ${formatRupiah(item.limit)}, with a co-payment of ${formatRupiah(item.deductible)}.${waitingNote} ${INSURER_HANDOFF}`,
  };
}

function sumLimitAndDeductible(item: CoverageItem): Money {
  return toMoney(item.limit + item.deductible);
}

/* --------------------------------------------------------------- comparison */

type Attribute = 'limit' | 'co-payment' | 'waiting period' | 'exclusions';

const ATTRIBUTE_PATTERNS: ReadonlyArray<{ attribute: Attribute; pattern: RegExp }> = [
  { attribute: 'waiting period', pattern: /\bwaiting\b/i },
  { attribute: 'co-payment', pattern: /\b(co-?pay(ment)?s?|deductibles?|excess)\b/i },
  { attribute: 'exclusions', pattern: /\b(exclusions?|excluded|not covered)\b/i },
  { attribute: 'limit', pattern: /\b(limits?|maximum|how much)\b/i },
];

const DEFAULT_ATTRIBUTES: readonly Attribute[] = ['limit', 'co-payment', 'waiting period'];

function attributeOf(criterion: string): Attribute | null {
  return ATTRIBUTE_PATTERNS.find((candidate) => candidate.pattern.test(criterion))?.attribute ?? null;
}

function describeAttribute(item: CoverageItem, attribute: Attribute): string {
  if (item.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return `Could not be read with confidence; see ${item.clauseRef}, page ${item.page}`;
  }
  const source = `(${item.clauseRef}, page ${item.page})`;
  switch (attribute) {
    case 'limit':
      return `${formatRupiah(item.limit)} ${source}`;
    case 'co-payment':
      return `${formatRupiah(item.deductible)} ${source}`;
    case 'waiting period':
      return `${item.waitingPeriodDays === 0 ? 'None' : `${item.waitingPeriodDays} days`} ${source}`;
    case 'exclusions':
      return `${item.exclusions.length > 0 ? item.exclusions.join('; ') : 'None listed in the clause'} ${source}`;
  }
}

export interface PolicyComparison {
  /** One column per policy, in the order given. */
  columns: string[];
  rows: Array<{ criterion: string; values: string[] }>;
  handoff: string;
}

/**
 * POL-4: the same facts for each policy, side by side, on the criteria the user
 * picked. A criterion is either a benefit ("hospital cover") or an attribute
 * ("waiting periods"). No row says which policy is preferable.
 */
export function comparePolicies(
  policies: ReadonlyArray<{ policy: Policy; items: readonly CoverageItem[] }>,
  criteria: readonly string[],
): PolicyComparison {
  const attributes: Attribute[] = [];
  const benefits: string[] = [];
  for (const criterion of criteria) {
    const attribute = attributeOf(criterion);
    if (attribute) {
      if (!attributes.includes(attribute)) attributes.push(attribute);
    } else if (criterion.trim() !== '') {
      benefits.push(criterion.trim());
    }
  }

  const rows: PolicyComparison['rows'] = [];

  if (benefits.length > 0) {
    const shown = attributes.includes('limit') ? attributes : (['limit', ...attributes] as Attribute[]);
    for (const benefit of benefits) {
      const matches = policies.map((entry) => matchCoverageItem(entry.items, benefit));
      rows.push({
        criterion: `${benefit}: benefit`,
        values: matches.map((item) =>
          item ? `${item.benefit} (${item.clauseRef}, page ${item.page})` : 'No matching clause found',
        ),
      });
      for (const attribute of attributes.length > 0 ? shown : DEFAULT_ATTRIBUTES) {
        rows.push({
          criterion: `${benefit}: ${attribute}`,
          values: matches.map((item) =>
            item ? describeAttribute(item, attribute) : 'No matching clause found',
          ),
        });
      }
    }
  } else {
    for (const attribute of attributes.length > 0 ? attributes : DEFAULT_ATTRIBUTES) {
      rows.push({
        criterion: attribute,
        values: policies.map((entry) =>
          entry.items.length === 0
            ? 'No benefit clauses found'
            : entry.items.map((item) => `${item.benefit}: ${describeAttribute(item, attribute)}`).join(' | '),
        ),
      });
    }
  }

  return { columns: policies.map((entry) => entry.policy.displayName), rows, handoff: ADVISER_HANDOFF };
}

/** Words that would turn a comparison into a recommendation (POL-4). */
const RANKING_WORDS =
  /\b(best|better|worse|worst option|superior|inferior|winner|recommend(ed|s|ation)?|should (buy|choose|pick|get|switch)|cheapest|top pick|go with|prefer(able|red)?)\b/i;

export function findRankingLanguage(text: string): string | null {
  return RANKING_WORDS.exec(text)?.[0] ?? null;
}
