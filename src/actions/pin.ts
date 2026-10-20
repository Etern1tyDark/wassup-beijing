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
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
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

/** Wrong PINs allowed before the PIN is locked for a while. */
export const PIN_FREE_ATTEMPTS = 5;
const PIN_BASE_LOCK_MS = 30_000;
const PIN_MAX_LOCK_MS = 15 * 60_000;

export type PinCheck = { ok: true } | { ok: false; reason: string; failures: number; locked: boolean };

export interface PinGuard {
  check(pin: string | undefined, stored: string, now?: number): Promise<PinCheck>;
}

/**
 * Online guessing limit for the app PIN: after five wrong PINs in a row the PIN
 * is locked for 30 seconds, doubling with each further miss up to 15 minutes.
 * One guard per database, so the settings screen and the T3 step-up share the
 * count. It lives in memory: a reload resets it, and the stored hash can still
 * be attacked offline by someone with the device (SECURITY.md, known risks).
 */
export function createPinGuard(): PinGuard {
  let failures = 0;
  let lockedUntil = 0;
  return {
    check: async (pin, stored, now = Date.now()) => {
      if (now < lockedUntil) {
        const seconds = Math.ceil((lockedUntil - now) / 1000);
        return { ok: false, reason: `PIN locked after ${failures} wrong attempts; try again in ${seconds} s`, failures, locked: true }; // prettier-ignore
      }
      if (pin !== undefined && pin !== '' && (await verifyPin(pin, stored))) {
        failures = 0;
        return { ok: true };
      }
      failures += 1;
      if (failures >= PIN_FREE_ATTEMPTS) {
        lockedUntil = now + Math.min(PIN_MAX_LOCK_MS, PIN_BASE_LOCK_MS * 2 ** (failures - PIN_FREE_ATTEMPTS));
      }
      return { ok: false, reason: 'wrong PIN', failures, locked: failures >= PIN_FREE_ATTEMPTS };
    },
  };
}

const guards = new WeakMap<object, PinGuard>();

/** The guard shared by everything that checks the PIN against one database. */
export function pinGuardFor(owner: object): PinGuard {
  let guard = guards.get(owner);
  if (!guard) {
    guard = createPinGuard();
    guards.set(owner, guard);
  }
  return guard;
}
