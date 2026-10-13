import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '../storage/db';
import { createRepositories } from '../storage/repositories';
import { fixedClock } from '../actions/clock';
import { createOutboundGate, type OutboundGate, type Transport, type TransportRequest } from './gate';
import { maskValue, redactText, redactValue, type RedactorConfig } from './redactor';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/redactor-fixture.json', import.meta.url)), 'utf8'),
) as {
  names: string[];
  accountNumbers: string[];
  policyNumbers: string[];
  input: string;
  mustNotLeak: string[];
  expectedPlaceholders: string[];
};

const config: RedactorConfig = {
  names: fixture.names,
  accountNumbers: fixture.accountNumbers,
  policyNumbers: fixture.policyNumbers,
};

const databases: AppDatabase[] = [];

function database(): AppDatabase {
  const db = createAppDatabase(`gate-${Math.random().toString(16).slice(2)}`);
  databases.push(db);
  return db;
}

function gateWith(transport: Transport, redactorConfig: RedactorConfig = config): OutboundGate {
  const db = database();
  return createOutboundGate({
    db,
    repos: createRepositories(db),
    clock: fixedClock('2026-10-13T09:00:00+07:00'),
    transport,
    redactorConfig,
  });
}

afterEach(async () => {
  while (databases.length > 0) {
    const db = databases.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('redactor (PRV-1)', () => {
  it('removes every identifier type in the fixture', () => {
    const { text, redactions } = redactText(fixture.input, config);

    for (const secret of fixture.mustNotLeak) {
      expect(text, `"${secret}" must not survive redaction`).not.toContain(secret);
    }
    for (const placeholder of fixture.expectedPlaceholders) {
      expect(text).toContain(placeholder);
    }
    expect(new Set(redactions.map((redaction) => redaction.kind))).toEqual(
      new Set(['email', 'nik', 'phone', 'account-number', 'policy-number', 'name']),
    );
  });

  it('records redactions in masked form only', () => {
    const { redactions } = redactText(fixture.input, config);
    for (const redaction of redactions) {
      expect(redaction.value).toMatch(/•/);
      expect(fixture.mustNotLeak).not.toContain(redaction.value);
    }
  });

  it('redacts strings nested in an object', () => {
    const { value } = redactValue(
      { messages: [{ role: 'user', content: fixture.input }], count: 1, ok: true },
      config,
    );
    const serialised = JSON.stringify(value);
    for (const secret of fixture.mustNotLeak) {
      expect(serialised).not.toContain(secret);
    }
    expect(value).toMatchObject({ count: 1, ok: true });
  });

  it('leaves ordinary finance text alone', () => {
    const text = 'Rent October -3500000 balance 10750000 account BCA-main';
    expect(redactText(text, config).text).toBe(text);
  });

  it('masks short and long values without revealing them', () => {
    expect(maskValue('1234')).toBe('••••');
    expect(maskValue('1234567890')).toBe('12••••••90');
  });
});

describe('outbound gate (PRV-1, PRV-2)', () => {
  it('redacts, records and sends', async () => {
    const sent: TransportRequest[] = [];
    const gate = gateWith({
      send: (request) => {
        sent.push(request);
        return Promise.resolve({ content: 'ok' });
      },
    });

    const result = await gate.send({ purpose: 'agent.complete', payload: { content: fixture.input } });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.payload)).not.toContain('Rina Wijaya');

    const requests = await gate.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ purpose: 'agent.complete', status: 'sent', blockReason: null });
    expect(requests[0]?.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests[0]?.payload)).not.toContain('rina.wijaya@example.com');
  });

  it('honours a block decision and never calls the transport (PRV-2)', async () => {
    let called = 0;
    const gate = gateWith({
      send: () => {
        called += 1;
        return Promise.resolve({});
      },
    });
    gate.setBlockDecider(() => ({ block: true, reason: 'the user blocked this request' }));

    const result = await gate.send({ purpose: 'agent.complete', payload: { content: 'hello' } });

    expect(result.ok).toBe(false);
    expect(called).toBe(0);
    const requests = await gate.requests();
    expect(requests[0]).toMatchObject({ status: 'blocked', blockReason: 'the user blocked this request' });
  });

  it('records a failed send without losing the request', async () => {
    const gate = gateWith({ send: () => Promise.reject(new Error('relay offline')) });

    const result = await gate.send({ purpose: 'agent.complete', payload: { content: 'hello' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('relay offline');
    const requests = await gate.requests();
    expect(requests[0]).toMatchObject({ status: 'failed' });
  });

  it('uses the stub transport by default and still records the request', async () => {
    const db = database();
    const gate = createOutboundGate({
      db,
      repos: createRepositories(db),
      clock: fixedClock('2026-10-13T09:00:00+07:00'),
    });

    const result = await gate.send({ purpose: 'agent.complete', payload: { content: 'hi' } });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.ok ? result.response : {})).toContain('stub transport');
    expect(await gate.requests()).toHaveLength(1);
  });

  it('merges per-call identifiers with the gate configuration', async () => {
    const gate = gateWith({ send: () => Promise.resolve({}) }, { names: [], accountNumbers: [], policyNumbers: [] });

    await gate.send({
      purpose: 'agent.complete',
      payload: { content: 'Call Rina Wijaya on 081234567890' },
      redactorConfig: { names: ['Rina Wijaya'] },
    });

    const requests = await gate.requests();
    expect(JSON.stringify(requests[0]?.payload)).not.toContain('Rina Wijaya');
    expect(JSON.stringify(requests[0]?.payload)).not.toContain('081234567890');
  });
});
