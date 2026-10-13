/**
 * Hash chain core for the audit log (AUD-1, AUD-3).
 *
 * Written as plain ESM so the browser, the Vitest suite and the `verify:audit`
 * CLI all run the exact same implementation. Web Crypto (`globalThis.crypto`)
 * is available in browsers and in Node 20+, so no dependency is needed.
 */

/** prevHash of the first entry in the chain. */
export const GENESIS_PREV_HASH = `sha256:${'0'.repeat(64)}`;

/** Fields that are covered by an entry's own hash, in canonical order. */
export const ENTRY_HASH_FIELDS = [
  'id',
  'seq',
  'time',
  'actor',
  'event',
  'action',
  'proposalId',
  'detail',
  'payloadHash',
  'prevHash',
];

/**
 * Deterministic JSON: object keys sorted, `undefined` normalised to `null`.
 * Two runs over the same data always produce the same string (NFR-2).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (type === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  throw new Error(`canonicalJson cannot serialise a ${type}`);
}

/**
 * @param {string | Uint8Array} input
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {unknown} payload
 * @returns {Promise<string>}
 */
export async function hashPayload(payload) {
  return `sha256:${await sha256Hex(canonicalJson(payload))}`;
}

/**
 * Hash of one entry, covering its own fields plus `prevHash`.
 *
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string>}
 */
export async function hashEntry(entry) {
  /** @type {Record<string, unknown>} */
  const core = {};
  for (const field of ENTRY_HASH_FIELDS) core[field] = entry[field] ?? null;
  return `sha256:${await sha256Hex(canonicalJson(core))}`;
}

/**
 * Verify seq continuity, hash linkage and per-entry hashes.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {Promise<{ ok: boolean, checked: number, errors: string[] }>}
 */
export async function verifyChain(entries) {
  /** @type {string[]} */
  const errors = [];
  const ordered = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq));
  let previous = GENESIS_PREV_HASH;

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry === undefined) continue;
    const label = `entry ${String(entry.seq)} (${String(entry.id)})`;
    if (Number(entry.seq) !== index) {
      errors.push(`${label}: expected seq ${index}, found ${String(entry.seq)}`);
    }
    if (entry.prevHash !== previous) {
      errors.push(`${label}: prevHash does not match the previous entry`);
    }
    const expected = await hashEntry(entry);
    if (entry.hash !== expected) {
      errors.push(`${label}: hash mismatch (tampered or corrupted)`);
    }
    previous = String(entry.hash);
  }

  return { ok: errors.length === 0, checked: ordered.length, errors };
}
