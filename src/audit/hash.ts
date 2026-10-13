import type { AuditEntry } from '../domain/schemas';
import {
  GENESIS_PREV_HASH as GENESIS_PREV_HASH_JS,
  canonicalJson as canonicalJsonJs,
  hashEntry as hashEntryJs,
  hashPayload as hashPayloadJs,
  sha256Hex as sha256HexJs,
  verifyChain as verifyChainJs,
} from './chain.js';

/**
 * Typed face of the shared hash-chain implementation in ./chain.js.
 *
 * The implementation lives in plain ESM so the browser, the Vitest suite and
 * the `npm run verify:audit` CLI verify exports with identical code.
 */
export const GENESIS_PREV_HASH: string = GENESIS_PREV_HASH_JS;

export interface ChainVerification {
  ok: boolean;
  checked: number;
  errors: string[];
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonJs(value);
}

export function sha256Hex(input: string | Uint8Array): Promise<string> {
  return sha256HexJs(input);
}

export function hashPayload(payload: unknown): Promise<string> {
  return hashPayloadJs(payload);
}
/** Every field except `hash`; missing fields are normalised to null before hashing. */
export type AuditableEntry = Partial<Omit<AuditEntry, 'hash'>> & Pick<AuditEntry, 'id' | 'seq'>;

export function hashEntry(entry: AuditableEntry): Promise<string> {
  return hashEntryJs(entry);
}

export function verifyChain(entries: readonly AuditEntry[]): Promise<ChainVerification> {
  return verifyChainJs(entries as unknown as Array<Record<string, unknown>>);
}
