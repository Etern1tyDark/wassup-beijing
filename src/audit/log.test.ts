import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../storage/db';
import { createAuditLog, type AuditLog } from './log';
import { GENESIS_PREV_HASH, hashEntry, verifyChain } from './hash';
import type { AuditEntry } from '../domain/schemas';

let db: AppDatabase;
let audit: AuditLog;
let tick = 0;

function clock(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 9, 13, 3, 0, tick));
}

beforeEach(() => {
  tick = 0;
  db = createAppDatabase(`audit-test-${Math.random().toString(16).slice(2)}`);
  audit = createAuditLog(db, clock);
});

async function seedChain(): Promise<AuditEntry[]> {
  await audit.append({ actor: 'agent', event: 'proposed', action: 'earmark.create', proposalId: 'p_1' });
  await audit.append({ actor: 'user', event: 'approved', action: 'earmark.create', proposalId: 'p_1' });
  await audit.append({
    actor: 'system',
    event: 'executed',
    action: 'earmark.create',
    proposalId: 'p_1',
    payload: { earmarkId: 'ear_1', amount: 3_000_000 },
  });
  return audit.list();
}

describe('audit log (AUD-1)', () => {
  it('starts the chain at the genesis hash', async () => {
    const entry = await audit.append({ actor: 'system', event: 'proposed', detail: 'first' });
    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
    expect(entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('chains each entry to the previous hash', async () => {
    const entries = await seedChain();
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(entries[2]?.prevHash).toBe(entries[1]?.hash);
  });

  it('hashes the payload instead of storing it', async () => {
    await seedChain();
    const entry = await db.auditEntries.get(2);
    expect(entry?.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain('3_000_000');
  });

  it('verifies a clean chain', async () => {
    await seedChain();
    const verification = await audit.verify();
    expect(verification).toEqual({ ok: true, checked: 3, errors: [] });
  });

  it('fails verification when one entry is tampered with', async () => {
    await seedChain();
    const target = await db.auditEntries.get(1);
    expect(target).toBeDefined();
    await db.auditEntries.put({ ...target!, detail: 'tampered' });

    const verification = await audit.verify();
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/hash mismatch/);
  });

  it('fails verification when an entry is deleted', async () => {
    await seedChain();
    await db.auditEntries.delete(1);

    const verification = await audit.verify();
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/expected seq 1, found 2|prevHash does not match/);
  });

  it('fails verification when an entry is inserted', async () => {
    const entries = await seedChain();

    const forged: AuditEntry = {
      ...entries[0]!,
      id: 'aud_forged',
      seq: 1,
      hash: 'sha256:deadbeef',
    };
    await db.auditEntries.put(forged);

    const verification = await audit.verify();
    expect(verification.ok).toBe(false);
  });

  it('exports a verifiable JSON document (AUD-3)', async () => {
    await seedChain();
    const exported = await audit.exportJson();

    expect(exported.chain).toMatchObject({ algorithm: 'sha256', length: 3, verified: true });
    expect(exported.chain.headHash).toBe(exported.entries[2]?.hash);
    expect(await verifyChain(exported.entries)).toEqual({ ok: true, checked: 3, errors: [] });
  });

  it('serialises concurrent appends so the chain never forks', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        audit.append({ actor: 'system', event: 'proposed', detail: `entry ${index}` }),
      ),
    );
    const entries = await audit.list();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((entry) => entry.seq)).size).toBe(10);
    expect((await audit.verify()).ok).toBe(true);
  });
});

describe('canonical hashing', () => {
  it('is order independent for object keys', async () => {
    const a = await hashEntry({ id: 'x', seq: 0, time: 't', actor: 'system', event: 'proposed' });
    const b = await hashEntry({ event: 'proposed', actor: 'system', time: 't', seq: 0, id: 'x' });
    expect(a).toBe(b);
  });

  it('changes when any covered field changes', async () => {
    const base = { id: 'x', seq: 0, time: 't', actor: 'system' as const, event: 'proposed' as const };
    expect(await hashEntry(base)).not.toBe(await hashEntry({ ...base, detail: 'changed' }));
  });
});
