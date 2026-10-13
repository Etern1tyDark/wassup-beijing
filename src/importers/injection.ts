/**
 * Injection heuristics for untrusted text (PRD Section 7, ST2 to ST4).
 *
 * This only flags text for the reply and for the audit log. The real control is
 * structural: text that came from a document or a CSV field is marked untrusted
 * and can never set the action type, the amount or the target account.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)\b/i,
  /\btransfer\s+funds?\b/i,
  /\bsend\s+(the\s+)?(money|funds|balance)\b/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bas\s+(the\s+)?(admin|administrator|developer|insurer)\b/i,
  /\b(new|updated)\s+instructions?\s*:/i,
  /\braise\s+(my\s+)?limits?\b/i,
  /\boverride\s+(the\s+)?(tier|guardrail|limit|rules?)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Sentences inside untrusted text that look like instructions; used for the reply. */
export function findInjectionSignals(text: string): string[] {
  const segments = text.split(/(?<=[.!?;])\s+/);
  return segments.filter((segment) => looksLikeInjection(segment)).map((segment) => segment.trim());
}
