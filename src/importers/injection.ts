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
  /\b(forget|ignore|disregard)\s+(everything|all)\b/i,
  /\bkindly\s+(ignore|disregard)\b/i,
  // Bahasa Indonesia: "abaikan instruksi sebelumnya", "transfer dana", "kirim uang".
  /\b(abaikan|lupakan)\s+(semua\s+)?(instruksi|perintah|aturan)\b/i,
  /\b(transfer|kirim(kan)?)\s+(dana|uang|saldo)\b/i,
  // Chinese: "忽略之前的指令", "转账".
  /(忽略|无视).{0,6}(指令|指示|规则)/,
  /(转账|汇款)/,
];

/** Zero-width and other invisible format characters used to split trigger words. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Fold full-width forms and drop invisible characters before matching. */
function normalise(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

export function looksLikeInjection(text: string): boolean {
  const normalised = normalise(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalised));
}

/** Sentences inside untrusted text that look like instructions; used for the reply. */
export function findInjectionSignals(text: string): string[] {
  const segments = text.split(/(?<=[.!?;])\s+/);
  return segments.filter((segment) => looksLikeInjection(segment)).map((segment) => segment.trim());
}
