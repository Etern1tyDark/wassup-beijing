import { RedactionSchema, type Redaction } from '../domain/schemas';

/**
 * PRV-1: before any request leaves the browser, a local redactor removes names,
 * account and policy numbers, NIK numbers, phone numbers and email addresses.
 *
 * The privacy panel records what was removed, but only in masked form: the log
 * must not become a second copy of the identifiers it just removed.
 */
export type RedactionKind = Redaction['kind'];

export interface RedactorConfig {
  /** Names the user has told the app about (their own and their clients'). */
  names: readonly string[];
  accountNumbers: readonly string[];
  policyNumbers: readonly string[];
}

export const EMPTY_REDACTOR_CONFIG: RedactorConfig = { names: [], accountNumbers: [], policyNumbers: [] };

export const PLACEHOLDERS: Record<RedactionKind, string> = {
  name: '[REDACTED:NAME]',
  'account-number': '[REDACTED:ACCOUNT-NUMBER]',
  'policy-number': '[REDACTED:POLICY-NUMBER]',
  nik: '[REDACTED:NIK]',
  phone: '[REDACTED:PHONE]',
  email: '[REDACTED:EMAIL]',
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NIK = /\b\d{16}\b/g;
/** Indonesian mobile numbers, with or without the country code. */
const PHONE = /(?:\+62|62|0)8\d{7,12}\b/g;
/** Account-like digit runs. 16-digit NIK and phone numbers are matched first. */
const ACCOUNT_LIKE = /\b\d{10,15}\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Keep the shape, hide the value: 1234567890 -> 12••••••90. */
export function maskValue(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length);
  const visible = value.length >= 8 ? 2 : 1;
  const hidden = '•'.repeat(Math.max(1, value.length - visible * 2));
  return `${value.slice(0, visible)}${hidden}${value.slice(-visible)}`;
}

function collect(redactions: Redaction[], kind: RedactionKind, value: string): void {
  const redaction = RedactionSchema.parse({ kind, value: maskValue(value), placeholder: PLACEHOLDERS[kind] });
  if (!redactions.some((existing) => existing.kind === kind && existing.value === redaction.value)) {
    redactions.push(redaction);
  }
}

/**
 * Apply every rule to one string. Supplied lists are matched first so a known
 * account number is never mislabelled as a NIK.
 */
export function redactText(input: string, config: RedactorConfig): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  let text = input;

  const apply = (pattern: RegExp, kind: RedactionKind, replace: (match: string) => string): void => {
    text = text.replace(pattern, (match) => {
      collect(redactions, kind, match);
      return replace(match);
    });
  };

  apply(EMAIL, 'email', () => PLACEHOLDERS.email);

  for (const accountNumber of config.accountNumbers) {
    if (accountNumber.length === 0) continue;
    apply(new RegExp(`\\b${escapeRegExp(accountNumber)}\\b`, 'g'), 'account-number', () => PLACEHOLDERS['account-number']);
  }

  for (const policyNumber of config.policyNumbers) {
    if (policyNumber.length === 0) continue;
    apply(new RegExp(`\\b${escapeRegExp(policyNumber)}\\b`, 'g'), 'policy-number', () => PLACEHOLDERS['policy-number']);
  }

  apply(NIK, 'nik', () => PLACEHOLDERS.nik);
  apply(PHONE, 'phone', () => PLACEHOLDERS.phone);
  apply(ACCOUNT_LIKE, 'account-number', () => PLACEHOLDERS['account-number']);

  for (const name of config.names) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    apply(new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'gi'), 'name', () => PLACEHOLDERS.name);
  }

  return { text, redactions };
}

/** Walk any JSON-ish value and redact every string inside it. */
export function redactValue(
  value: unknown,
  config: RedactorConfig,
): { value: unknown; redactions: Redaction[] } {
  const redactions: Redaction[] = [];

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = redactText(node, config);
      redactions.push(...result.redactions);
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        output[key] = walk(child);
      }
      return output;
    }
    return node;
  };

  const redacted = walk(value);
  const unique = redactions.filter(
    (redaction, index) =>
      redactions.findIndex(
        (candidate) => candidate.kind === redaction.kind && candidate.value === redaction.value,
      ) === index,
  );

  return { value: redacted, redactions: unique };
}

export interface Redactor {
  redact(value: unknown): { value: unknown; redactions: Redaction[] };
  config(): RedactorConfig;
  setConfig(config: RedactorConfig): void;
}

export function createRedactor(config: RedactorConfig = EMPTY_REDACTOR_CONFIG): Redactor {
  let current = config;
  return {
    redact: (value) => redactValue(value, current),
    config: () => current,
    setConfig: (next) => {
      current = next;
    },
  };
}
