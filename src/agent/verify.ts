import { ADVISER_HANDOFF, findRankingLanguage } from '../policy/coverage';

/**
 * Checks on a model reply that run in code, after the model has answered.
 *
 * The system prompt asks for these behaviours, but a prompt is a request, not a
 * control. These functions are the control: a reply that breaks a rule is
 * replaced before the user sees it.
 */

/** Every number in a text, with thousands separators and decimal marks removed. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d.,]*\d|\d/g) ?? []).map((token) => token.replace(/[.,]/g, ''));
}

/**
 * CHAT-1: numbers in the reply that appear in no tool result and in nothing the
 * user typed. Single digits are ignored: they are too common in ordinary
 * sentences to carry a claim about money.
 */
export function unverifiedNumbers(reply: string, sources: readonly string[]): string[] {
  const allowed = new Set(sources.flatMap((source) => numbersIn(source)));
  const unverified = numbersIn(reply).filter((token) => token.length > 1 && !allowed.has(token));

  // A single digit is a claim when a unit follows it ("Rp 9 juta", "3 months"),
  // and so is "1e9".
  for (const match of reply.matchAll(SINGLE_DIGIT_CLAIM)) {
    if (!allowed.has(match[1]!)) unverified.push(match[0].trim());
  }
  for (const match of reply.matchAll(/\b\d+(?:\.\d+)?e\d+\b/gi)) unverified.push(match[0]);

  // An amount in words ("twelve million") must also come from somewhere.
  const lowerSources = sources.map((source) => source.toLowerCase());
  for (const match of reply.toLowerCase().matchAll(AMOUNT_IN_WORDS)) {
    if (!lowerSources.some((source) => source.includes(match[0]))) unverified.push(match[0]);
  }
  return [...new Set(unverified)];
}

const SINGLE_DIGIT_CLAIM =
  /(?<![\d.,])(\d)\s*(juta|jt|million|miliar|billion|ribu|rb|thousand|months?|bulan|days?|hari|weeks?|minggu|years?|tahun|%)(?![a-z])/gi;

const AMOUNT_IN_WORDS =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|seratus)\s+(?:million|billion|thousand|juta|miliar|ribu)\b/g;

export const UNVERIFIED_NUMBER_REPLY =
  "I can't confirm some of the figures I was about to give, so I have left them out. The cards below show only numbers that came from your ledger and your documents.";

export const NEUTRAL_COMPARISON_REPLY = `Here is what each document says. ${ADVISER_HANDOFF}`;

export interface ReplyCheck {
  reply: string;
  /** Why the reply was replaced, if it was. */
  notices: string[];
}

export function checkReply(input: {
  reply: string;
  /** Tool results and user messages from this conversation. */
  sources: readonly string[];
  /** True when a policy tool ran this turn, so ranking language is not allowed. */
  policyTurn: boolean;
}): ReplyCheck {
  const notices: string[] = [];
  let reply = input.reply;

  const unverified = unverifiedNumbers(reply, input.sources);
  if (unverified.length > 0) {
    notices.push(
      `Reply withheld: it contained figures with no tool result behind them (${unverified.join(', ')}).`,
    );
    reply = UNVERIFIED_NUMBER_REPLY;
  }

  if (input.policyTurn) {
    const ranking = findRankingLanguage(reply);
    if (ranking) {
      notices.push(
        `Reply replaced: it used ranking language ("${ranking}"), and policies are compared, never recommended.`,
      );
      reply = NEUTRAL_COMPARISON_REPLY;
    }
  }

  return { reply, notices };
}
