import { randomId } from '../domain/ids';
import { AuditEntrySchema, type AuditActor, type AuditEntry, type AuditEvent } from '../domain/schemas';
import type { AppDatabase } from '../storage/db';
import { GENESIS_PREV_HASH, hashEntry, hashPayload, verifyChain, type ChainVerification } from './hash';

/**
 * Append-only, hash-chained audit log (AUD-1, AUD-2, AUD-3).
 *
 * There is no update and no delete in this API on purpose: an undo is recorded
 * as a new entry that points back at the original one.
 */
export interface AppendAuditInput {
  /** Explicit id, so a ledger write and its audit entry can share one identifier. */
  id?: string;
  actor: AuditActor;
  event: AuditEvent;
  action?: string | null;
  proposalId?: string | null;
  detail?: string;
  /** Business payload; only its hash is stored. */
  payload?: unknown;
}

export interface AuditExport {
  exportedAt: string;
  chain: {
    algorithm: 'sha256';
    genesis: string;
    length: number;
    headHash: string;
    verified: boolean;
  };
  entries: AuditEntry[];
}

export interface AuditLog {
  append(input: AppendAuditInput): Promise<AuditEntry>;
  list(): Promise<AuditEntry[]>;
  byId(id: string): Promise<AuditEntry | undefined>;
  last(): Promise<AuditEntry | undefined>;
  exportJson(): Promise<AuditExport>;
  verify(): Promise<ChainVerification>;
}

export function createAuditLog(db: AppDatabase, clock: () => Date): AuditLog {
  // Appends are serialised so two concurrent callers can never read the same
  // head hash and fork the chain.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  }

  async function append(input: AppendAuditInput): Promise<AuditEntry> {
    return enqueue(async () => {
      const previous = await db.auditEntries.orderBy('seq').last();
      const seq = previous ? previous.seq + 1 : 0;
      const prevHash = previous ? previous.hash : GENESIS_PREV_HASH;
      const payloadHash = await hashPayload(input.payload ?? null);

      const unsigned = {
        id: input.id ?? randomId('aud'),
        seq,
        time: clock().toISOString(),
        actor: input.actor,
        event: input.event,
        action: input.action ?? null,
        proposalId: input.proposalId ?? null,
        detail: input.detail ?? '',
        payloadHash,
        prevHash,
      };

      const entry = AuditEntrySchema.parse({ ...unsigned, hash: await hashEntry(unsigned) });
      await db.auditEntries.add(entry);
      return entry;
    });
  }

  return {
    append,
    list: () => db.auditEntries.orderBy('seq').toArray(),
    byId: async (id) => {
      const entries = await db.auditEntries.where('id').equals(id).toArray();
      return entries[0];
    },
    last: () => db.auditEntries.orderBy('seq').last(),
    exportJson: async () => {
      const entries = await db.auditEntries.orderBy('seq').toArray();
      const verification = await verifyChain(entries);
      const head = entries.at(-1);
      return {
        exportedAt: clock().toISOString(),
        chain: {
          algorithm: 'sha256',
          genesis: GENESIS_PREV_HASH,
          length: entries.length,
          headHash: head ? head.hash : GENESIS_PREV_HASH,
          verified: verification.ok,
        },
        entries,
      };
    },
    verify: async () => verifyChain(await db.auditEntries.orderBy('seq').toArray()),
  };
}
