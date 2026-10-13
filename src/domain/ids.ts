/** Random ids for runtime records. Deterministic ids belong to the seed generator. */
export function randomId(prefix: string): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${uuid.slice(0, 16)}`;
}

/** Hex id for idempotency keys and one-time tokens. */
export function randomHex(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
