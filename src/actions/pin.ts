/**
 * PIN hashing for the settings screen (PRD Section 6: limits and tiers change
 * only behind the app PIN, never through chat or an action).
 *
 * PBKDF2-SHA256 through Web Crypto, so the same code runs in the browser and in
 * Node. The salt and iteration count travel with the hash, which keeps the
 * whole credential in the single `Settings.pinHash` field.
 */
const ALGORITHM = 'pbkdf2-sha256';
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return toHex(new Uint8Array(bits));
}

/** Format: `pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>`. */
export async function hashPin(pin: string): Promise<string> {
  if (pin.length === 0) throw new Error('PIN must not be empty');
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const hash = await derive(pin, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${toHex(salt)}$${hash}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [algorithm, iterationsText, saltHex, expectedHex] = parts as [string, string, string, string];
  if (algorithm !== ALGORITHM) return false;
  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  try {
    salt = fromHex(saltHex);
  } catch {
    return false;
  }
  const actual = await derive(pin, salt, iterations);
  return constantTimeEqual(actual, expectedHex);
}

/** Compare without early exit so a wrong PIN does not leak the matching prefix. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
