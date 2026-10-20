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
  /**
   * Postal addresses the app has seen (for example in a policy header). An
   * address has no reliable pattern, so only known ones can be removed.
   */
  addresses?: readonly string[];
}

export const EMPTY_REDACTOR_CONFIG: RedactorConfig = { names: [], accountNumbers: [], policyNumbers: [] };

export const PLACEHOLDERS: Record<RedactionKind, string> = {
  name: '[REDACTED:NAME]',
  'account-number': '[REDACTED:ACCOUNT-NUMBER]',
  'policy-number': '[REDACTED:POLICY-NUMBER]',
  nik: '[REDACTED:NIK]',
  phone: '[REDACTED:PHONE]',
  email: '[REDACTED:EMAIL]',
  address: '[REDACTED:ADDRESS]',
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Payment card numbers, grouped or not; only runs that pass the Luhn check count. */
const CARD = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;
/** NPWP (tax number), as printed: 99.999.999.9-999.999. */
const NPWP = /\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g;
/** NIK, also when written in groups: 3171 0123 4567 8901 or 31.71.01-234567-8901. */
const NIK =
  /\b\d{16}\b|\b\d{2}[ .-]?\d{2}[ .-]?\d{2}[ .-]?\d{6}[ .-]?\d{4}\b|\b\d{4}[ .-]\d{4}[ .-]\d{4}[ .-]\d{4}\b/g;
/**
 * Indonesian mobile numbers, with or without the country code and with any of
 * the usual separators: 0812-3456-7890, +62 812 3456 7890, (+62) 812.3456.7890.
 */
const PHONE = /(?<![\d.,])(?:\(?\+?62\)?|0)[ .-]?8\d{1,3}(?:[ .-]?\d{2,4}){2,3}\b/g;
/** Landlines with an area code in brackets: (021) 555-1234. */
const LANDLINE = /\(0\d{1,3}\)[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g;
/** Account-like digit runs. 16-digit NIK and phone numbers are matched first. */
const ACCOUNT_LIKE = /\b\d{10,15}\b/g;
/** Account numbers written in groups: 123-456-7890, 1234 5678 90. */
const GROUPED_DIGITS = /\b\d{3,6}(?:[ -]\d{2,6}){1,4}\b/g;

/** Zero-width and other invisible format characters that can split an identifier. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Fold full-width digits and letters to ASCII and drop invisible characters, so
 * "０８１２" and "ri\u200Bna@mail.com" cannot slip past the patterns below.
 */
export function normaliseForRedaction(input: string): string {
  return input
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\u00A0/g, ' ');
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** A pattern for a known value that tolerates any case and any run of spaces, dots or dashes. */
function looseLiteral(value: string): RegExp {
  const parts = value
    .trim()
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map(escapeRegExp);
  return new RegExp(`(?<![\\w])${parts.join('[\\s.-]*')}(?![\\w])`, 'gi');
}

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
  let text = normaliseForRedaction(input);

  const apply = (
    pattern: RegExp,
    kind: RedactionKind,
    replace: (match: string) => string,
    accept: (match: string) => boolean = () => true,
  ): void => {
    text = text.replace(pattern, (match) => {
      if (!accept(match)) return match;
      collect(redactions, kind, match);
      return replace(match);
    });
  };
  const digitsOf = (match: string): string => match.replace(/\D/g, '');

  apply(EMAIL, 'email', () => PLACEHOLDERS.email);

  // Known addresses go first: they contain digits that later rules would
  // otherwise pick apart.
  for (const address of config.addresses ?? []) {
    const trimmed = address.trim();
    if (trimmed.length < 6) continue;
    apply(new RegExp(escapeRegExp(trimmed), 'gi'), 'address', () => PLACEHOLDERS.address);
  }

  for (const accountNumber of config.accountNumbers) {
    if (accountNumber.trim().length === 0) continue;
    apply(looseLiteral(accountNumber), 'account-number', () => PLACEHOLDERS['account-number']);
  }

  for (const policyNumber of config.policyNumbers) {
    if (policyNumber.trim().length === 0) continue;
    apply(looseLiteral(policyNumber), 'policy-number', () => PLACEHOLDERS['policy-number']);
  }

  // A card number is not a NIK, though both have 16 digits: the Luhn check tells them apart.
  apply(
    CARD,
    'account-number',
    () => PLACEHOLDERS['account-number'],
    (match) => luhn(digitsOf(match)),
  );
  apply(NPWP, 'nik', () => PLACEHOLDERS.nik);
  apply(NIK, 'nik', () => PLACEHOLDERS.nik);
  apply(
    PHONE,
    'phone',
    () => PLACEHOLDERS.phone,
    (match) => digitsOf(match).length >= 9,
  );
  apply(LANDLINE, 'phone', () => PLACEHOLDERS.phone);
  apply(ACCOUNT_LIKE, 'account-number', () => PLACEHOLDERS['account-number']);
  apply(
    GROUPED_DIGITS,
    'account-number',
    () => PLACEHOLDERS['account-number'],
    (match) => {
      const length = digitsOf(match).length;
      return length >= 10 && length <= 16;
    },
  );

  for (const name of config.names) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    apply(looseLiteral(trimmed), 'name', () => PLACEHOLDERS.name);
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
