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
  return [...new Set(numbersIn(reply).filter((token) => token.length > 1 && !allowed.has(token)))];
}

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
