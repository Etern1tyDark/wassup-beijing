/**
 * Assign one of a fixed set of categories to a statement row.
 *
 * The description is untrusted text, so it is only ever matched against these
 * patterns to pick a label from this list. It is never interpreted, and a row
 * that matches nothing stays "uncategorised" rather than being guessed at.
 */
const RULES: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: 'transfer', pattern: /\btop-?up (from|to)\b|\bgopay top-?up\b|\bbetween own accounts\b/i },
  { category: 'housing', pattern: /\b(rent|kos|sewa|mortgage)\b/i },
  { category: 'subscriptions', pattern: /\b(subscriptions?|netflix|spotify|figma|adobe)\b/i },
  { category: 'utilities', pattern: /\b(pln|electricity|water|pdam|internet|wifi|pulsa|mobile top-?up)\b/i },
  { category: 'groceries', pattern: /\b(grocery|groceries|supermarket|indomaret|alfamart|market)\b/i },
  { category: 'health', pattern: /\b(pharmacy|apotek|clinic|doctor|hospital|dental|dentist)\b/i },
  { category: 'transport', pattern: /\b(transport|grab|gojek|taxi|fuel|train|food delivery)\b/i },
  { category: 'eating-out', pattern: /\b(coffee|cafe|restaurant|warung|lunch|dinner)\b/i },
];

export function categorise(description: string, amount: number): string {
  const matched = RULES.find((rule) => rule.pattern.test(description));
  if (matched) return matched.category;
  return amount > 0 ? 'income' : 'uncategorised';
}
