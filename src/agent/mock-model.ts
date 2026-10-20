import { formatRupiah, toMoney } from '../domain/money';
import type { Proposal } from '../domain/schemas';
import { addDays, addMonths, type IsoDate } from '../domain/time';
import { categorise } from '../importers/categorise';
import type { OutboundGate } from '../gate/gate';
import { ADVISER_HANDOFF, resolveEvent } from '../policy/coverage';
import { UNTRUSTED_OPEN } from './orchestrator';
import type {
  CoverageAssessment,
  PolicyComparison,
  PolicySummary,
  ReminderData,
  RunwayData,
  ScenarioData,
  SpendingData,
  SpendingPeriod,
  SummaryData,
} from './tools';
import type { ModelAdapter, ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from './types';

/**
 * Mock model adapter: deterministic, offline, and routed through the outbound
 * gate so the privacy panel records every call (PRV-1).
 *
 * It stands in for a hosted model with tool calling (decision D5). It is a
 * rule-based stand-in, not a language model: it recognises the requests in the
 * PRD's task scripts, asks for the matching tools, and words the tool results.
 * It exists so the whole flow can be demonstrated and tested without an API key.
 *
 * Like a real model it only ever asks for tools. Whatever it asks for, the tier
 * engine decides; and whatever it writes, the orchestrator checks.
 */
export interface MockModelOptions {
  gate: OutboundGate;
  id?: string;
}

/* ------------------------------------------------------------ slot parsing */

const UNIT_MULTIPLIERS: Record<string, number> = {
  million: 1_000_000,
  juta: 1_000_000,
  jt: 1_000_000,
  k: 1_000,
  rb: 1_000,
  ribu: 1_000,
  thousand: 1_000,
};

/**
 * The first rupiah amount in a sentence: "Rp 3.000.000", "3,000,000",
 * "3 million", "500k". Day counts, dates and bare small numbers are not amounts.
 */
export function extractAmount(text: string): number | null {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');

  // "1,5 jt" and "2.5 million": one or two decimals of a million, kept in integers.
  const decimal = /(?<![\d.,])(\d+)[.,](\d{1,2})\s*(million|juta|jt)\b/i.exec(withoutDates);
  if (decimal) {
    const scale = decimal[2]!.length === 1 ? 100_000 : 10_000;
    const value = Number(decimal[1]) * 1_000_000 + Number(decimal[2]) * scale;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  // The lookbehind stops a match from starting in the middle of a number.
  const pattern =
    /(rp\.?\s*)?(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d.,]*\d)(?:\s*(million|juta|jt|ribu|rb|thousand|k)\b)?(\s*(?:days?|weeks?|months?|years?|%))?/gi;
  for (const match of withoutDates.matchAll(pattern)) {
    if (match[4]) continue;
    const digits = match[2]!.replace(/[.,]/g, '');
    const value = Number(digits) * (match[3] ? UNIT_MULTIPLIERS[match[3].toLowerCase()]! : 1);
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    if (match[1] || match[3] || value >= 1000) return value;
  }
  return null;
}

export function extractReviewDate(text: string): string | null {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  return match ? match[1]! : null;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}; // prettier-ignore

export function extractDays(raw: string): number | null {
  const text = raw.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, (word) =>
    String(WORD_NUMBERS[word.toLowerCase()]),
  );
  const days = /(\d+)\s*days?\b/i.exec(text);
  if (days) return Number(days[1]);
  const weeks = /(\d+)\s*weeks?\b/i.exec(text);
  if (weeks) return Number(weeks[1]) * 7;
  const months = /(\d+)\s*months?\b/i.exec(text);
  if (months) return Number(months[1]) * 30;
  if (/\b(a|one)\s+week\b/i.test(text)) return 7;
  if (/\b(a|one)\s+month\b/i.test(text)) return 30;
  return null;
}

export function extractPeriod(text: string): SpendingPeriod | null {
  if (/\b(last|previous)\s+month\b/i.test(text)) return 'last-month';
  if (/\bthis\s+month\b/i.test(text)) return 'this-month';
  if (/\b(90\s*days|quarter|three months|3 months)\b/i.test(text)) return 'last-90-days';
  if (/\b(30\s*days)\b/i.test(text)) return 'last-30-days';
  return null;
}

function extractClient(text: string): string | null {
  // "Client Bravo", or a capitalised name in "what if Bravo pays late" / "if Bravo is 30 days late".
  const match =
    /\bclient\s+([a-z]+)\b/i.exec(text) ??
    /\b(?:if|when|until)\s+(?!I\b|My\b)([A-Z][a-z]+)\s+(?:pays|paid|is|are|doesn|does|never|only)\b/.exec(
      text,
    ) ??
    /^(?!I\b|My\b|What\b|How\b)([A-Z][a-z]+)\s+(?:pays|is)\b.*\blate\b/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!;
  return `Client ${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()}`;
}

function extractPolicyType(text: string): 'health' | 'travel' | null {
  if (/\b(health|medical|sehat)\b/i.test(text)) return 'health';
  if (/\b(travel|trip|jelajah)\b/i.test(text)) return 'travel';
  return null;
}

/** What the user is asking the policy about: a known event, or the words after "cover". */
function extractEvent(text: string): string | null {
  const known = resolveEvent(text);
  if (known) return known.label;
  const match = /\bcovers?(?:ed)?\s+(?:for\s+)?(?:an?\s+|my\s+|the\s+)?([a-z][a-z -]{2,40}?)\s*[?.!]?$/i.exec(
    text.trim(),
  );
  const phrase = match?.[1]?.trim() ?? null;
  return phrase && !/^(me|it|this|that|anything)$/i.test(phrase) ? phrase : null;
}

function extractCriteria(text: string): string[] {
  const match = /\bon\s+(.+?)[?.!]?$/i.exec(text.trim());
  if (!match) return [];
  return match[1]!
    .split(/,|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function earmarkLabel(text: string): string {
  if (/\b(medical|health|hospital|doctor)\b/i.test(text)) return 'Medical reserve';
  if (/\btax(es)?\b/i.test(text)) return 'Tax reserve';
  if (/\brent\b/i.test(text)) return 'Rent reserve';
  if (/\bemergenc(y|ies)\b/i.test(text)) return 'Emergency fund';
  return 'Reserve';
}

/* -------------------------------------------------------------- the turn */

interface Observation {
  name: string;
  args: Record<string, unknown>;
  /** Parsed tool result, or null when the tool returned an error. */
  data: unknown;
  error: string | null;
}

interface Turn {
  /** The user's message as the model received it. */
  text: string;
  flagged: boolean;
  observations: Observation[];
  /** The user message before this one, if any. */
  previousUserText: string | null;
  /** The assistant's last reply before this turn. */
  previousReply: ModelMessage | null;
  /** The last tool call of the previous turn: what a correction refers to. */
  previousCall: ModelToolCall | null;
  /** The most recent get_coverage call in the conversation. */
  previousCoverage: ModelToolCall | null;
}

function readTurn(messages: readonly ModelMessage[]): Turn {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      lastUser = index;
      break;
    }
  }
  const text = lastUser >= 0 ? messages[lastUser]!.content : '';

  const observations: Observation[] = [];
  const pendingCalls: ModelToolCall[] = [];
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role === 'assistant') pendingCalls.push(...(message.toolCalls ?? []));
    if (message.role === 'tool') {
      const call = pendingCalls.shift();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        parsed = null;
      }
      const error =
        parsed !== null && typeof parsed === 'object' && 'error' in parsed
          ? typeof parsed.error === 'string'
            ? parsed.error
            : JSON.stringify(parsed.error)
          : null;
      observations.push({
        name: message.name ?? call?.name ?? '',
        args: (call?.arguments ?? {}) as Record<string, unknown>,
        data: error === null ? parsed : null,
        error,
      });
    }
  }

  const before = lastUser >= 0 ? messages.slice(0, lastUser) : [];
  const previousUser = [...before].reverse().find((message) => message.role === 'user');
  const previousReply =
    [...before].reverse().find((message) => message.role === 'assistant' && !message.toolCalls) ?? null;
  const calls = before.flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []));

  return {
    text,
    flagged: text.includes(UNTRUSTED_OPEN),
    observations,
    previousUserText: previousUser?.content ?? null,
    previousReply,
    previousCall: calls.at(-1) ?? null,
    previousCoverage: [...calls].reverse().find((call) => call.name === 'get_coverage') ?? null,
  };
}

type Intent =
  | 'secrets'
  | 'exfiltrate'
  | 'privilege'
  | 'undo'
  | 'reminder'
  | 'add-transaction'
  | 'transfer'
  | 'release-earmark'
  | 'update-earmark'
  | 'earmark'
  | 'advice'
  | 'scenario'
  | 'compare'
  | 'runway'
  | 'coverage'
  | 'spending'
  | 'summary'
  | 'accounts'
  | 'invoices'
  | 'earmarks'
  | 'greeting'
  | 'unknown';

export function classify(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(system prompt|hidden prompt|your (instructions|rules|prompt))\b/.test(t)) return 'secrets';
  if (/\b(send|e-?mail|export|upload|share|forward|post)\b.*\b(ledger|data|transactions?|statements?|history|balances?)\b/.test(t)) return 'exfiltrate'; // prettier-ignore
  if (
    /\b(admin|administrator|developer|root|sudo)\b/.test(t) ||
    /\b(raise|increase|change|remove|lift|switch|set|disable|bypass|turn off)\b.*\b(limits?|caps?|tiers?|t3|guardrails?|pin|approvals?)\b/.test(
      t,
    )
  ) {
    return 'privilege';
  }
  // Product and investment advice is outside what the agent may do (PRD Section 10).
  if (
    /\b(invest|investing|investment|stocks?|shares|crypto|bitcoin|mutual funds?|reksa ?dana)\b/.test(t) ||
    /\b(which|what)\b.*\b(policy|insurance|insurer|plan)\b.*\b(should|best|better|recommend)\b/.test(t) ||
    /\b(should i|recommend|worth)\b.*\b(get|buy|take out|switch|cancel|upgrade|insurance)\b/.test(t) ||
    /\b(policy|insurance|insurer|plan)\b.*\b(should i (get|buy)|is better|recommend)\b/.test(t) ||
    /\bwhich (one )?is better\b/.test(t)
  ) {
    return 'advice';
  }
  if (/\b(undo|revert|roll back|take (that|it) back|batalkan)\b/.test(t)) return 'undo';
  if (/\b(remind|reminder|chase|follow up)\b/.test(t) || /\b(draft|write)\b.*\b(client|payment|invoice)\b/.test(t)) return 'reminder'; // prettier-ignore
  if (
    /\b(add|record|log|note)\b.*\b(expense|purchase|transaction|income|payment|spent)\b/.test(t) ||
    /^i (just )?(spent|paid|bought|received|got paid)\b/.test(t) ||
    (/^(record|log|beli|bought)\b/.test(t) && extractAmount(t) !== null)
  ) {
    return 'add-transaction';
  }
  const setAside =
    /\b(earmark|set aside|put aside|reserve|sisihkan)\b/.test(t) ||
    (/\b(save|put away|keep aside|ring-?fence)\b/.test(t) && extractAmount(t) !== null);
  if (/\b(earmarks|reserves|set asides?)\b/.test(t) && /\b(what|which|list|show|my)\b/.test(t) && !/\b(release|change|update)\b/.test(t) && extractAmount(t) === null) return 'earmarks'; // prettier-ignore
  if (/\b(don'?t|no longer) need\b/.test(t) && /\b(money|reserve|fund|earmark)\b/.test(t))
    return 'release-earmark';
  if (/\b(release|remove|delete|cancel|free up|don'?t need|no longer need)\b/.test(t) && setAside)
    return 'release-earmark';
  if (/\b(change|update|edit|increase|decrease|raise|lower|reduce)\b/.test(t) && setAside) {
    return 'update-earmark';
  }
  // "Pay" alone is not a transfer: "how much would I pay for a hospital bill" is a coverage question.
  if (
    !setAside &&
    (/\b(transfer|wire|send|move|kirim)\b/.test(t) || /\bpay\b.*\bto\b/.test(t)) &&
    (extractAmount(t) !== null || /\baccount\b/.test(t)) &&
    !/\b(late|what if|bill|hospital|cover(ed|age)?|polic(y|ies)|out[- ]of[- ]pocket)\b/.test(t)
  ) {
    return 'transfer';
  }
  if (setAside) return 'earmark';
  if (/\bcompar|\bdifference between\b|\bboth polic/.test(t)) return 'compare';
  if (
    /\b(what if|suppose|scenario|can i afford)\b/.test(t) ||
    (/\b(pays?|paid)\b/.test(t) && /\blate\b/.test(t)) ||
    (/\blate\b/.test(t) && extractDays(t) !== null)
  ) {
    return 'scenario';
  }
  if (/\b(runwa?y|runwya|how long|survive|last me|run out|months? (do i have )?left|berapa lama|bertahan)\b/.test(t)) return 'runway'; // prettier-ignore
  if (/\b(covers?|covered|coverage|policy|policies|insurance|insurer|out[- ]of[- ]pocket|worst[- ]case|clause|claim|waiting period|exclu\w*|hospital\w*|dental|surgery|physio\w*|asuransi|rawat inap|ditanggung)\b/.test(t)) return 'coverage'; // prettier-ignore
  if (/\b(invoices?|owes? me|owed|unpaid|outstanding|tagihan)\b/.test(t)) return 'invoices';
  if (/\b(accounts?|gopay|bca|e-?wallet|wallet|bank|saldo)\b/.test(t) && !/\b(spend|spent)\b/.test(t)) return 'accounts'; // prettier-ignore
  if (/\b(summary|balances?|safe[- ]to[- ]spend|overview|how am i doing|money do i have|net worth)\b/.test(t)) return 'summary'; // prettier-ignore
  if (/\b(spend|spent|spending|expenses?|pengeluaran|belanja)\b/.test(t)) return 'spending';
  if (/\b(how much|numbers)\b/.test(t)) return 'summary';
  if (/^(hi|hello|hey|halo|hai|good (morning|afternoon|evening)|thanks?|thank you|terima kasih|ok(ay)?|cool)\b/.test(t.trim())) return 'greeting'; // prettier-ignore
  return 'unknown';
}

/* ---------------------------------------------------------------- wording */

const rp = (amount: number): string => formatRupiah(toMoney(amount));

const say = (content: string, options?: string[]): ModelResponse => ({
  content,
  toolCalls: [],
  ...(options && options.length > 0 ? { options } : {}),
});

const call = (content: string, ...toolCalls: ModelToolCall[]): ModelResponse => ({ content, toolCalls });

const CAPABILITIES =
  'I can show your balances and runway, test a what-if, check or compare your policies, draft an invoice reminder, and propose setting money aside for your approval. I cannot move money or change limits.';

function describeRunway(days: number, months: number, capped: boolean): string {
  return capped ? `more than ${days} days` : `${days} days (${months} months)`;
}

function proposalOf(observation: Observation): Proposal | null {
  const data = observation.data as { status?: string; proposal?: Proposal } | null;
  return data?.status === 'pending-approval' && data.proposal ? data.proposal : null;
}

/** Everyday words for the ledger's spending categories. */
const CATEGORY_WORDS: Record<string, string> = {
  food: 'groceries',
  grocery: 'groceries',
  groceries: 'groceries',
  rent: 'housing',
  housing: 'housing',
  bills: 'utilities',
  utilities: 'utilities',
  transport: 'transport',
  transportation: 'transport',
  subscriptions: 'subscriptions',
};

const MONTH_NAME =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/;

function periodLabel(period: SpendingPeriod): string {
  return {
    'this-month': 'this month',
    'last-month': 'last month',
    'last-30-days': 'the last 30 days',
    'last-90-days': 'the last 90 days',
  }[period];
}

/* ---------------------------------------------------------------- handlers */

class Planner {
  private readonly turn: Turn;
  /** Sentence to lead with when this turn is a correction of the previous one (CHAT-3). */
  private prefix = '';

  constructor(turn: Turn) {
    this.turn = turn;
  }

  private seen(name: string): Observation | undefined {
    return this.turn.observations.find((observation) => observation.name === name);
  }

  private lead(sentence: string): string {
    return this.prefix ? `${this.prefix} ${sentence}` : sentence;
  }

  respond(): ModelResponse {
    const { turn } = this;

    if (turn.flagged) {
      return say(
        'I treated that text as data, not as an instruction, so I have not acted on it. It contains wording that reads like a command, which I have flagged. Tell me in your own words what you would like to do.',
      );
    }

    // CHAT-3: "No, I meant last month" re-runs the previous tool with one thing changed.
    if (/^(no|nope|sorry|actually|not that)\b|\bi meant\b/i.test(turn.text.trim())) {
      return this.correction();
    }

    // CHAT-2: a short answer to a clarifying question completes the earlier request.
    let text = turn.text;
    const asked = turn.previousReply;
    if (asked && turn.previousUserText && (asked.options?.length || asked.content.trim().endsWith('?'))) {
      const pickedOption = (asked.options ?? []).some((option) =>
        option.toLowerCase().includes(text.trim().toLowerCase()),
      );
      if (pickedOption || classify(text) === 'unknown') text = `${turn.previousUserText} ${text}`;
    }

    // "and 90 days?", "what about dental?", "what about last month?": re-run the
    // previous tool with the one thing that changed.
    const intent = classify(text);
    if (intent === 'unknown' && turn.previousCall && /^(and|what about|how about)\b/i.test(text.trim())) {
      return this.correction();
    }
    return this.route(intent, text);
  }

  private route(intent: Intent, text: string): ModelResponse {
    switch (intent) {
      case 'secrets':
        return say(
          'I can’t share my instructions. They would not unlock anything: every limit is enforced in code, not in the prompt. I can read your numbers, draft text, or propose a reversible change for your approval.',
        );
      case 'exfiltrate':
        return this.exfiltrate(text);
      case 'privilege':
        return this.privilege(text);
      case 'undo':
        return this.undo();
      case 'reminder':
        return this.reminder(text);
      case 'add-transaction':
        return this.addTransaction(text);
      case 'transfer':
        return this.transfer(text);
      case 'release-earmark':
        return this.releaseEarmark(text);
      case 'update-earmark':
        return this.updateEarmark(text);
      case 'advice':
        return say(
          'I can’t advise on investments or tell you which insurance product to buy, keep or cancel. I can show what your policies say side by side, what an event would cost you, and how long your cash lasts. For advice, please speak to a licensed adviser.',
        );
      case 'earmark':
        return this.earmark(text);
      case 'scenario':
        return this.scenario({
          client: extractClient(text),
          invoiceId: /\binv_[a-z0-9]+\b/i.exec(text)?.[0] ?? null,
          daysLate: /\blate\b/i.test(text) ? extractDays(text) : null,
          extraExpense: /\b(expense|costs?|bill|repairs?|buy|spend|afford|breaks?|need)\b/i.test(text)
            ? extractAmount(text)
            : null,
          mentionsLate: /\blate\b/i.test(text),
        });
      case 'compare':
        return this.compare(extractCriteria(text));
      case 'runway':
        return this.runway();
      case 'coverage':
        return this.coverage(text.replace(/\brawat inap\b/gi, 'hospital stay'));
      case 'spending':
        return this.spending(extractPeriod(text) ?? 'this-month', text);
      case 'summary':
        return this.summary();
      case 'accounts':
      case 'invoices':
      case 'earmarks':
        return this.summary(intent);
      case 'greeting':
        return say(
          /\b(thank|terima)/i.test(text) ? `You’re welcome. ${CAPABILITIES}` : `Hi! ${CAPABILITIES}`,
        );
      case 'unknown':
        return say(CAPABILITIES);
    }
  }

  /* ----------------------------------------------------------- refusals */

  private exfiltrate(text: string): ModelResponse {
    if (!this.seen('data.export')) {
      const destination = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/\S+/i.exec(text)?.[0] ?? 'unspecified';
      return call('Checking whether that is allowed.', { name: 'data.export', arguments: { destination } });
    }
    return say(
      'I can’t send your data anywhere. There is no tool that exports the ledger, and the raw ledger never leaves this browser; the request was refused and logged. You can export the audit log yourself from the Audit panel.',
    );
  }

  private privilege(text: string): ModelResponse {
    if (!this.seen('settings.update')) {
      return call('Checking whether that is allowed.', {
        name: 'settings.update',
        arguments: { request: text.slice(0, 200) },
      });
    }
    return say(
      'I can’t change limits, tiers or the PIN, and nobody can through chat, whoever they say they are. Those change only in the Settings panel, behind your app PIN. The request was refused and logged, and your limits are unchanged.',
    );
  }

  /* -------------------------------------------------------------- reads */

  private summary(focus?: 'accounts' | 'invoices' | 'earmarks'): ModelResponse {
    const observation = this.seen('get_summary');
    if (!observation) return call('Let me pull your numbers.', { name: 'get_summary', arguments: {} });
    if (observation.error) return say(`I could not read the ledger: ${observation.error}`);
    const data = observation.data as SummaryData;
    if (focus === 'accounts') {
      const lines = data.accounts.map((account) => `${account.name} ${rp(account.balance)}`).join(', ');
      return say(
        `Your accounts as of ${data.asOf}: ${lines}. Free cash after earmarks is ${rp(data.freeCash)}.`,
      );
    }
    if (focus === 'invoices') {
      if (data.openInvoices.length === 0)
        return say('No client owes you money right now: every invoice is paid.');
      const lines = data.openInvoices
        .map(
          (invoice) =>
            `${invoice.client} ${rp(invoice.amount)} (${invoice.id}, ${invoice.daysOverdue > 0 ? `${invoice.daysOverdue} days overdue` : `due ${invoice.dueDate}`})`,
        )
        .join('; ');
      return say(`Open invoices: ${lines}. I can draft a reminder or test what happens if one pays late.`);
    }
    if (focus === 'earmarks') {
      if (data.activeEarmarks.length === 0) return say('You have no money set aside right now.');
      const lines = data.activeEarmarks
        .map((earmark) => `${earmark.label} ${rp(earmark.amount)} (review ${earmark.reviewDate})`)
        .join('; ');
      return say(`Set aside: ${lines}. I can change or release any of them, with your approval.`);
    }
    return say(
      `Safe to spend is ${rp(data.safeToSpend)} as of ${data.asOf}. Your total balance is ${rp(data.totalBalance)}, free cash is ${rp(data.freeCash)}, and ${rp(data.obligationsDueIn30Days)} of obligations fall due soon.` +
        (data.dataIsStale ? ' Your data is stale; import a fresh statement before acting on it.' : ''),
    );
  }

  private runway(): ModelResponse {
    const observation = this.seen('get_runway');
    if (!observation) return call('Let me check your runway.', { name: 'get_runway', arguments: {} });
    if (observation.error) return say(`I could not compute the runway: ${observation.error}`);
    const data = observation.data as RunwayData;
    const inputs = data.inputs;
    const headline = data.capped
      ? `Your free cash lasts ${describeRunway(data.runwayDays, data.runwayMonths, true)} on current numbers.`
      : `You can cover your costs for about ${describeRunway(data.runwayDays, data.runwayMonths, false)}: free cash runs out on ${data.depletionDate}.`;
    const excluded =
      inputs.excludedInvoices.length > 0
        ? ` Overdue invoices worth ${rp(inputs.excludedInvoiceTotal)} are left out, because nobody knows when they will be paid.`
        : '';
    return say(
      `${headline} That starts from ${rp(inputs.freeCash)} of free cash as of ${data.asOf} and counts ${rp(inputs.countedInvoiceTotal)} of invoices still to come, your recurring obligations and your typical spending.${excluded}`,
    );
  }

  private spending(period: SpendingPeriod, text = ''): ModelResponse {
    const observation = this.seen('get_spending');
    if (!observation) {
      return call('Let me add that up.', { name: 'get_spending', arguments: { period } });
    }
    if (observation.error) return say(observation.error);
    const data = observation.data as SpendingData;
    const top = data.byCategory[0];
    const lower = text.toLowerCase();
    const askedFor = Object.entries(CATEGORY_WORDS).find(([word]) =>
      new RegExp(`\\b${word}\\b`).test(lower),
    )?.[1];
    const category = data.byCategory.find(
      (entry) => entry.category === askedFor || new RegExp(`\\b${entry.category}\\b`).test(lower),
    );
    const month = MONTH_NAME.exec(lower)?.[1];
    const monthNote =
      month && !extractPeriod(text)
        ? ` I can total this month, last month, or the last thirty or ninety days, so this is ${periodLabel(data.period)}; ask for "last month" if you meant that.`
        : '';
    if (category) {
      return say(
        this.lead(
          `In ${periodLabel(data.period)} (${data.from} to ${data.to}) you spent ${rp(category.total)} on ${category.category}, out of ${rp(data.moneyOut)} in total.${monthNote}`,
        ),
      );
    }
    return say(
      this.lead(
        `In ${periodLabel(data.period)} (${data.from} to ${data.to}) you spent ${rp(data.moneyOut)} and received ${rp(data.moneyIn)}.` +
          (top ? ` The largest category was ${top.category} at ${rp(top.total)}.` : '') +
          (askedFor ? ` I found no ${askedFor} spending in that period.` : '') +
          monthNote,
      ),
    );
  }

  private scenario(slots: {
    client: string | null;
    invoiceId: string | null;
    daysLate: number | null;
    extraExpense: number | null;
    mentionsLate: boolean;
  }): ModelResponse {
    const observation = this.seen('run_scenario');
    if (!observation) {
      if (slots.mentionsLate && slots.daysLate === null) return say('How many days late should I assume?');
      if (slots.client === null && slots.invoiceId === null && slots.extraExpense === null) {
        return say(
          'Which should I test: a client paying late, or a one-off expense? Give me the client and the days, or the amount.',
        );
      }
      return call('Let me run that scenario.', {
        name: 'run_scenario',
        arguments: {
          ...(slots.invoiceId ? { invoiceId: slots.invoiceId } : {}),
          ...(slots.client && !slots.invoiceId ? { client: slots.client } : {}),
          ...(slots.daysLate !== null ? { daysLate: slots.daysLate } : {}),
          ...(slots.extraExpense !== null ? { extraExpense: slots.extraExpense } : {}),
        },
      });
    }
    if (observation.error) {
      // The tool names the clients that do have an open invoice; offer them as choices.
      const clients = /Clients with an open invoice: (.+)$/.exec(observation.error)?.[1];
      const reason = observation.error;
      return say(
        `I can’t run that: ${reason}${/[.?]$/.test(reason) ? '' : '.'}`,
        clients && clients !== 'none' ? clients.split(', ') : undefined,
      );
    }

    const data = observation.data as ScenarioData;
    const base = describeRunway(data.base.runwayDays, data.base.runwayMonths, data.base.capped);
    const changed = describeRunway(
      data.scenario.runwayDays,
      data.scenario.runwayMonths,
      data.scenario.capped,
    );
    const headline =
      data.runwayDeltaDays === 0
        ? `In that scenario your runway stays at ${base}, because the money still arrives before free cash runs out.`
        : `In that scenario your runway goes from ${base} to ${changed}.`;
    const low =
      data.pinch.base.amount === data.pinch.scenario.amount
        ? ''
        : ` Until ${data.pinch.until}, your lowest free cash would be ${rp(data.pinch.scenario.amount)} instead of ${rp(data.pinch.base.amount)}.`;
    const notes = data.notes.length > 0 ? ` ${data.notes.join(' ')}` : '';
    return say(this.lead(`${headline}${low}${notes} (${data.label})`));
  }

  /* ----------------------------------------------------------- policies */

  private coverage(text: string): ModelResponse {
    const { turn } = this;
    const listed = this.seen('list_policies');
    if (!listed) return call('Let me look at your policies.', { name: 'list_policies', arguments: {} });
    if (listed.error) return say(`I could not read your policies: ${listed.error}`);

    const policies = listed.data as PolicySummary[];
    if (policies.length === 0) {
      return say(
        'I can’t check that yet: no policy is loaded. Upload a policy PDF in the Policy panel first.',
      );
    }

    // Which policy: named in the request, the one discussed before, or the only one.
    const type = extractPolicyType(text);
    const named = policies.filter(
      (policy) => policy.type === type || text.toLowerCase().includes(policy.displayName.toLowerCase()),
    );
    const previousId = turn.previousCoverage
      ? (turn.previousCoverage.arguments as { policyId?: string }).policyId
      : undefined;
    const policy =
      (named.length === 1 ? named[0] : undefined) ??
      (type === null ? policies.find((candidate) => candidate.policyId === previousId) : undefined) ??
      (policies.length === 1 ? policies[0] : undefined);

    if (!policy) {
      return say(
        `Which one: ${policies.map((candidate) => candidate.displayName).join(' or ')}?`,
        policies.map((candidate) => candidate.displayName),
      );
    }

    const previousEvent = turn.previousCoverage
      ? (turn.previousCoverage.arguments as { event?: string }).event
      : undefined;
    const wantsNumbers = /\b(out[- ]of[- ]pocket|worst[- ]case|enough|afford|shortfall)\b/i.test(text);
    const event = extractEvent(text) ?? (wantsNumbers ? previousEvent : undefined);

    if (!event) {
      const flag =
        policy.injectionSignals > 0
          ? ' One clause contains text that reads like an instruction; I treated it as data and did not act on it.'
          : '';
      if (wantsNumbers) {
        const benefits = policy.benefits
          .filter((benefit) => !benefit.lowConfidence)
          .map((benefit) => benefit.benefit);
        return say(`Which event should I check against ${policy.displayName}?`, benefits.slice(0, 4));
      }
      return say(
        `${policy.displayName} is loaded. The table lists each benefit with its limit, co-payment and waiting period, and the clause it comes from.${flag} Ask me about an event, such as a hospital stay, to see what you would pay yourself.`,
      );
    }

    const assessed = this.seen('get_coverage');
    if (!assessed) {
      const estimatedCost = extractAmount(text);
      return call('Let me check the clauses.', {
        name: 'get_coverage',
        arguments: { policyId: policy.policyId, event, ...(estimatedCost !== null ? { estimatedCost } : {}) },
      });
    }
    if (assessed.error) return say(`I can’t confirm that: ${assessed.error}`);
    return say(this.lead(this.describeCoverage(assessed.data as CoverageAssessment, wantsNumbers)));
  }

  /** `verdictFirst` is for "is my cash enough?": the answer leads, the clause follows. */
  private describeCoverage(result: CoverageAssessment, verdictFirst = false): string {
    if (result.kind === 'not-found') {
      const nearest = result.nearest
        ? ` The closest text is ${result.nearest.clauseRef} (page ${result.nearest.page}), shown below.`
        : '';
      return `${result.note}${nearest}`;
    }
    if (result.kind === 'low-confidence') return result.note;

    const flagged = result.citations.some((citation) =>
      citation.text.includes('[instruction-like text removed]'),
    )
      ? ' One clause contained text that reads like an instruction; I ignored it as data.'
      : '';
    const waiting = result.inWaitingPeriod
      ? result.waitingEndsOn
        ? ` The waiting period runs until ${result.waitingEndsOn}, so nothing would be paid yet.`
        : ' The document does not say when cover started, so I assumed the waiting period is still running.'
      : '';
    const source = `${result.citations[0]!.clauseRef}, page ${result.citations[0]!.page}`;
    const handoff = `Please check with your insurer before relying on this.${flagged}`;

    if (verdictFirst) {
      const verdict =
        result.shortfall > 0
          ? `No: you would be ${rp(result.shortfall)} short.`
          : 'Yes: your free cash covers the worst case.';
      return (
        `${verdict} For a ${result.event} costing ${rp(result.estimatedCost)} (${result.costAssumption}), the worst case is that you pay ${rp(result.worstCaseOutOfPocket)} yourself, against ${rp(result.freeCash)} of free cash.${waiting} ` +
        `The policy pays up to ${rp(result.limit)} after a co-payment of ${rp(result.deductible)} (${source}). ${handoff}`
      );
    }

    const cash =
      result.shortfall > 0
        ? `Your free cash is ${rp(result.freeCash)}, so you would be ${rp(result.shortfall)} short.`
        : `Your free cash of ${rp(result.freeCash)} covers that.`;
    return (
      `${result.policyName} covers "${result.benefit}" up to ${rp(result.limit)} with a co-payment of ${rp(result.deductible)} (${source}).${waiting} ` +
      `For a ${result.event} costing ${rp(result.estimatedCost)} (${result.costAssumption}), the worst case is that you pay ${rp(result.worstCaseOutOfPocket)} yourself. ${cash} ${handoff}`
    );
  }

  private compare(criteria: string[]): ModelResponse {
    const observation = this.seen('compare_policies');
    if (!observation) {
      return call('Let me put them side by side.', { name: 'compare_policies', arguments: { criteria } });
    }
    if (observation.error) return say(`I can’t compare yet: ${observation.error}.`);
    const data = observation.data as PolicyComparison;
    return say(this.lead(`Here are ${data.columns.join(' and ')} side by side. ${ADVISER_HANDOFF}`));
  }

  /* ------------------------------------------------------------- drafts */

  private reminder(text: string): ModelResponse {
    const observation = this.seen('draft_reminder');
    if (!observation) {
      return call('Let me draft that.', {
        name: 'draft_reminder',
        arguments: {
          ...(/\binv_[a-z0-9]+\b/i.test(text) ? { invoiceId: /\binv_[a-z0-9]+\b/i.exec(text)![0] } : {}),
          tone: /\b(firm|strong|strict|final)\b/i.test(text) ? 'firm' : 'friendly',
        },
      });
    }
    if (observation.error) return say(`I can’t draft a reminder: ${observation.error}.`);
    const data = observation.data as ReminderData;
    return say(
      `Here is a ${data.tone} reminder to ${data.client} for ${data.invoiceId}: ${rp(data.amount)}, ${data.daysOverdue} days overdue. Nothing has been sent; copy the text if you want to use it.`,
    );
  }

  /* ---------------------------------------------------------- proposals */

  private proposed(observation: Observation, done: (proposal: Proposal) => string): ModelResponse {
    const proposal = proposalOf(observation);
    if (proposal) return say(this.lead(done(proposal)));
    const reason = observation.error ?? 'The request was refused.';
    // NFR-7: a refusal says what is allowed instead.
    const instead = /guardrails/.test(reason) ? ' You can try a smaller amount.' : '';
    return say(`I can’t do that. ${sentence(reason)}${instead}`);
  }

  private undo(): ModelResponse {
    const observation = this.seen('undo');
    if (!observation) return call('Let me prepare that.', { name: 'undo', arguments: {} });
    return this.proposed(
      observation,
      () =>
        'I have prepared the undo. Nothing changes until you press Approve on the card; it will then be recorded as a new entry in the audit log.',
    );
  }

  private earmark(text: string): ModelResponse {
    const amount = extractAmount(text);
    const label = earmarkLabel(text);

    const summary = this.seen('get_summary');
    if (!summary) {
      const calls: ModelToolCall[] = [{ name: 'get_summary', arguments: {} }];
      // With no amount, a medical reserve is sized from the policy's co-payment.
      if (amount === null && label === 'Medical reserve')
        calls.push({ name: 'list_policies', arguments: {} });
      else if (amount === null) return say('How much would you like to set aside, and what is it for?');
      return call('Let me check your numbers first.', ...calls);
    }
    if (summary.error) return say(`I could not read the ledger: ${summary.error}`);
    const asOf = (summary.data as SummaryData).asOf;

    let proposedAmount = amount;
    let basis = '';
    if (proposedAmount === null) {
      const policies = (this.seen('list_policies')?.data as PolicySummary[] | null) ?? [];
      const health = policies.find((policy) => policy.type === 'health');
      if (!health) return say('How much would you like to set aside for medical costs?');

      const coverage = this.seen('get_coverage');
      if (!coverage) {
        return call('Let me check what your health policy leaves you to pay.', {
          name: 'get_coverage',
          arguments: { policyId: health.policyId, event: 'hospital stay' },
        });
      }
      const assessed = coverage.data as CoverageAssessment | null;
      if (!assessed || assessed.kind !== 'covered' || assessed.suggestedReserve <= 0) {
        return say('How much would you like to set aside for medical costs?');
      }
      proposedAmount = assessed.suggestedReserve;
      basis = ` The amount is the co-payment in ${assessed.citations[0]!.clauseRef} of ${assessed.policyName}: the part of a hospital stay you are certain to pay yourself.`;
    }

    const created = this.seen('earmark.create');
    if (!created) {
      return call('Here is a proposal to set that money aside.', {
        name: 'earmark.create',
        arguments: {
          label,
          amount: proposedAmount,
          reviewDate: extractReviewDate(text) ?? addMonths(asOf, 3),
        },
      });
    }
    return this.proposed(created, (proposal) => {
      const params = proposal.params as { label: string; amount: number; reviewDate: string };
      return `I have proposed setting aside ${rp(params.amount)} as "${params.label}", to be reviewed on ${params.reviewDate}. Nothing changes until you press Approve on the card.${basis}`;
    });
  }

  private releaseEarmark(text: string): ModelResponse {
    const summary = this.seen('get_summary');
    if (!summary) return call('Let me look at your earmarks.', { name: 'get_summary', arguments: {} });
    if (summary.error) return say(`I could not read the ledger: ${summary.error}`);

    const earmarks = (summary.data as SummaryData).activeEarmarks;
    if (earmarks.length === 0) return say('There is no active earmark to release.');
    const named = earmarks.filter((earmark) => text.toLowerCase().includes(earmark.label.toLowerCase()));
    const target = named.length === 1 ? named[0] : earmarks.length === 1 ? earmarks[0] : undefined;
    if (!target) {
      return say(
        'Which earmark should I release?',
        earmarks.map((earmark) => earmark.label),
      );
    }

    const released = this.seen('earmark.delete');
    if (!released) {
      return call('Here is a proposal to release it.', {
        name: 'earmark.delete',
        arguments: { earmarkId: target.id },
      });
    }
    return this.proposed(
      released,
      () =>
        `I have proposed releasing "${target.label}" (${rp(target.amount)}). Nothing changes until you press Approve on the card.`,
    );
  }

  private updateEarmark(text: string): ModelResponse {
    const summary = this.seen('get_summary');
    if (!summary) return call('Let me look at your earmarks.', { name: 'get_summary', arguments: {} });
    if (summary.error) return say(`I could not read the ledger: ${summary.error}`);

    const earmarks = (summary.data as SummaryData).activeEarmarks;
    if (earmarks.length === 0) return say('There is no active earmark to change.');
    const named = earmarks.filter((earmark) => text.toLowerCase().includes(earmark.label.toLowerCase()));
    const target = named.length === 1 ? named[0] : earmarks.length === 1 ? earmarks[0] : undefined;
    if (!target) {
      return say(
        'Which earmark should I change?',
        earmarks.map((earmark) => earmark.label),
      );
    }

    const amount = extractAmount(text);
    const reviewDate = extractReviewDate(text);
    if (amount === null && reviewDate === null) {
      return say(`What should I change on "${target.label}": the amount or the review date?`);
    }

    const updated = this.seen('earmark.update');
    if (!updated) {
      return call('Here is a proposal to change it.', {
        name: 'earmark.update',
        arguments: {
          earmarkId: target.id,
          ...(amount !== null ? { amount } : {}),
          ...(reviewDate !== null ? { reviewDate } : {}),
        },
      });
    }
    return this.proposed(updated, (proposal) => {
      const params = proposal.params as { amount?: number; reviewDate?: string };
      const changes = [
        ...(params.amount !== undefined ? [`the amount to ${rp(params.amount)}`] : []),
        ...(params.reviewDate !== undefined ? [`the review date to ${params.reviewDate}`] : []),
      ];
      return `I have proposed changing ${changes.join(' and ')} on "${target.label}". Nothing changes until you press Approve on the card.`;
    });
  }

  private addTransaction(text: string): ModelResponse {
    const amount = extractAmount(text);
    if (amount === null) return say('How much was it?');

    const summary = this.seen('get_summary');
    if (!summary) return call('Let me check your accounts.', { name: 'get_summary', arguments: {} });
    if (summary.error) return say(`I could not read the ledger: ${summary.error}`);
    const data = summary.data as SummaryData;

    const wallet = /\b(gopay|e-?wallet|wallet)\b/i.test(text);
    const account =
      data.accounts.find((candidate) =>
        wallet ? candidate.type === 'e-wallet' : candidate.type === 'bank',
      ) ?? data.accounts[0];
    if (!account) return say('There is no account to add it to.');

    const income = /\b(income|received|got paid|earned)\b/i.test(text);
    const merchantMatch =
      /\b(?:for|on|at)\s+(?!rp\b)([a-z][a-z ,'&-]{1,60}?)(?:\s+(?:yesterday|today|from|with|using)\b|[.?!]?$)/i.exec(
        text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').trim(),
      );
    const merchant = merchantMatch ? merchantMatch[1]!.trim() : income ? 'Income' : 'Expense';
    const date: IsoDate =
      extractReviewDate(text) ?? (/\byesterday\b/i.test(text) ? addDays(data.asOf, -1) : data.asOf);
    const signed = income ? amount : -amount;

    const added = this.seen('transaction.add');
    if (!added) {
      return call('Here is the entry for you to confirm.', {
        name: 'transaction.add',
        arguments: {
          accountId: account.id,
          date,
          amount: signed,
          merchant: `${merchant[0]!.toUpperCase()}${merchant.slice(1)}`,
          category: categorise(merchant, signed),
        },
      });
    }
    return this.proposed(added, (proposal) => {
      const params = proposal.params as { merchant: string; amount: number; date: string };
      return `I have prepared the entry "${params.merchant}", ${rp(params.amount)} on ${params.date} in ${account.name}. Nothing is saved until you press Approve on the card.`;
    });
  }

  private transfer(text: string): ModelResponse {
    const amount = extractAmount(text);
    if (amount === null) return say('How much should I check?');

    const summary = this.seen('get_summary');
    if (!summary)
      return call('Let me check whether that is allowed.', { name: 'get_summary', arguments: {} });
    if (summary.error) return say(`I could not read the ledger: ${summary.error}`);
    const accounts = (summary.data as SummaryData).accounts;

    const lower = text.toLowerCase();
    const mentioned = (after: string) =>
      accounts.find((account) => lower.includes(`${after} ${account.name.toLowerCase()}`)) ??
      accounts.find((account) =>
        new RegExp(`\\b${after}\\b[^.]*\\b${account.type.split('-')[0]}\\b`).test(lower),
      );
    const from = mentioned('from') ?? accounts.find((account) => account.type === 'bank');
    const to = mentioned('to');
    // A destination that is not one of the user's accounts is passed as written,
    // so the tier engine can refuse it by name.
    const destination = to?.id ?? /\bto\s+((?:account\s+)?[\w-]+)/i.exec(text)?.[1] ?? 'unknown';

    const moved = this.seen('transfer');
    if (!moved) {
      return call('Let me check whether that is allowed.', {
        name: 'transfer',
        arguments: { fromAccountId: from?.id ?? 'unknown', toAccountId: destination, amount },
      });
    }
    return this.proposed(
      moved,
      () =>
        'I have prepared a simulated transfer between your own accounts. It needs your PIN and your approval on the card, and no real money moves.',
    );
  }

  /* --------------------------------------------------------- correction */

  private correction(): ModelResponse {
    const { turn } = this;
    const previous = turn.previousCall;
    if (!previous) return say('What would you like me to change?');
    const args = previous.arguments as Record<string, unknown>;
    const text = turn.text;

    switch (previous.name) {
      case 'get_spending': {
        const period = extractPeriod(text);
        if (!period)
          return say('Which period did you mean?', ['This month', 'Last month', 'The last 30 days']);
        this.prefix = `Switched from ${periodLabel(args['period'] as SpendingPeriod)} to ${periodLabel(period)}.`;
        return this.spending(period);
      }
      case 'run_scenario': {
        const days = extractDays(text);
        const client = extractClient(text);
        const expense = extractAmount(text);
        if (days === null && client === null && expense === null) {
          return say('What should I change: the client, the number of days or the amount?');
        }
        const changes: string[] = [];
        if (days !== null) changes.push(`${days} days late`);
        if (client !== null) changes.push(client);
        if (expense !== null) changes.push(`an expense of ${rp(expense)}`);
        this.prefix = `Recomputed with ${changes.join(' and ')}.`;
        return this.scenario({
          client: client ?? (typeof args['client'] === 'string' ? args['client'] : null),
          invoiceId: client === null && typeof args['invoiceId'] === 'string' ? args['invoiceId'] : null,
          daysLate: days ?? (typeof args['daysLate'] === 'number' ? args['daysLate'] : null),
          extraExpense: expense ?? (typeof args['extraExpense'] === 'number' ? args['extraExpense'] : null),
          mentionsLate: true,
        });
      }
      case 'get_coverage': {
        const type = extractPolicyType(text);
        const event =
          extractEvent(text) ?? (typeof args['event'] === 'string' ? args['event'] : 'hospital stay');
        this.prefix = 'Checked again with that change.';
        return this.coverage(
          `${type ?? ''} policy cover ${event} ${extractAmount(text) !== null ? rp(extractAmount(text)!) : ''}`,
        );
      }
      case 'compare_policies': {
        const criteria = extractCriteria(text);
        if (criteria.length === 0) return say('Which criteria should I compare on?');
        this.prefix = `Compared again on ${criteria.join(' and ')}.`;
        return this.compare(criteria);
      }
      case 'earmark.create': {
        const amount = extractAmount(text);
        if (amount === null) return say('What amount did you mean?');
        this.prefix = `Changed the amount to ${rp(amount)}; reject the earlier card if you no longer want it.`;
        const label = typeof args['label'] === 'string' ? args['label'] : 'reserve';
        const reviewDate = typeof args['reviewDate'] === 'string' ? args['reviewDate'] : '';
        return this.earmark(`set aside ${rp(amount)} for ${label} ${reviewDate}`);
      }
      default:
        return say('What would you like me to change?');
    }
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capitalised = `${trimmed[0]?.toUpperCase() ?? ''}${trimmed.slice(1)}`;
  return /[.?!]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The rule-based reply for a request, with no network involved. Exported for tests. */
export function planMockResponse(request: ModelRequest): ModelResponse {
  return new Planner(readTurn(request.messages)).respond();
}

export function createMockModelAdapter(options: MockModelOptions): ModelAdapter {
  const id = options.id ?? 'mock-rule-based';

  return {
    id,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      // Every outbound request passes through the gate (PRV-1), including this
      // stand-in: the privacy panel shows what a hosted model would have received.
      const gated = await options.gate.send({
        purpose: 'agent.complete',
        payload: { messages: request.messages, tools: request.tools.map((tool) => tool.name) },
      });

      if (!gated.ok) {
        return {
          content: `I could not reach the model: ${gated.reason}. Your ledger, forecast, policies, earmarks and audit log keep working without it.`,
          toolCalls: [],
          unavailable: true,
        };
      }

      return planMockResponse(request);
    },
  };
}
