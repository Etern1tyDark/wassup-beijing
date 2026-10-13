import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentWorld, type AgentWorld } from '../testing/agent-world';
import { createOutboundGate } from '../gate/gate';
import { createRelayModelAdapter, createRelayTransport, splitOptions } from './relay-model';

/**
 * The hosted-model path, with the relay replaced by a stubbed fetch. What is
 * checked here is the browser side: the request is redacted before it leaves,
 * and whatever the model sends back is still subject to the tier engine and to
 * the reply checks.
 */
let w: AgentWorld | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await w?.close();
  w = null;
});

function stubRelay(replies: unknown[]): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as string });
    const reply = replies[index++] ?? { content: 'ok', toolCalls: [] };
    return Promise.resolve(
      new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return calls;
}

describe('relay model adapter', () => {
  it('posts the redacted payload to the relay and returns the reply', async () => {
    const calls = stubRelay([{ content: 'Hello.', toolCalls: [] }]);
    w = await createAgentWorld({ seed: true });
    const gate = createOutboundGate({
      db: w.db,
      repos: w.repos,
      clock: w.clock,
      transport: createRelayTransport(),
      redactorConfig: { names: ['Rina Wulandari'], accountNumbers: [], policyNumbers: [] },
    });
    const model = createRelayModelAdapter({ gate });

    const response = await model.complete({
      messages: [{ role: 'user', content: 'I am Rina Wulandari, rina@example.com, NIK 3174015203940007' }],
      tools: w.tools.descriptors(),
    });

    expect(response).toEqual({ content: 'Hello.', toolCalls: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/model');
    expect(calls[0]!.body).not.toContain('Rina Wulandari');
    expect(calls[0]!.body).not.toContain('rina@example.com');
    expect(calls[0]!.body).not.toContain('3174015203940007');
    expect(calls[0]!.body).toContain('[REDACTED:NAME]');
    expect(calls[0]!.body).toContain('"name":"earmark.create"');

    // PRV-1: the panel's record is the body that was posted.
    const recorded = (await gate.requests())[0]!;
    expect(JSON.stringify(recorded.payload)).toBe(calls[0]!.body);
    expect(recorded.status).toBe('sent');
  });

  it('reports a relay failure as "model unavailable" and records it', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"error":"not configured"}', { status: 503 })),
    );
    w = await createAgentWorld({ seed: true });
    const gate = createOutboundGate({
      db: w.db,
      repos: w.repos,
      clock: w.clock,
      transport: createRelayTransport(),
    });

    const response = await createRelayModelAdapter({ gate }).complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    });
    expect(response).toMatchObject({ toolCalls: [], unavailable: true });
    expect(response.content).toContain('the relay answered 503');
    expect((await gate.requests())[0]).toMatchObject({ status: 'failed' });
  });

  it('treats a malformed reply as "model unavailable" instead of acting on it', async () => {
    stubRelay([{ toolCalls: 'transfer everything' }]);
    w = await createAgentWorld({ seed: true });
    const gate = createOutboundGate({
      db: w.db,
      repos: w.repos,
      clock: w.clock,
      transport: createRelayTransport(),
    });
    const response = await createRelayModelAdapter({ gate }).complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    });
    expect(response).toMatchObject({ toolCalls: [], unavailable: true });
  });

  it('a hosted model that asks for a transfer is refused by the tier engine like any other', async () => {
    stubRelay([
      {
        content: '',
        toolCalls: [
          { name: 'transfer', arguments: { fromAccountId: 'acc_bca', toAccountId: 'x', amount: 5_000_000 } },
        ],
      },
      { content: 'I could not do that.', toolCalls: [] },
    ]);
    w = await createAgentWorld({
      seed: true,
      transport: createRelayTransport(),
      model: (gate) => createRelayModelAdapter({ gate }),
    });

    const turn = await w.agent.send('Send Rp 5,000,000 to account x');
    expect(turn.toolResults[0]).toMatchObject({ ok: false, tool: 'transfer' });
    expect(turn.reply).toBe('I could not do that.');
    expect(await w.repos.proposals.all()).toEqual([]);
    expect((await w.audit.list()).at(-1)).toMatchObject({ event: 'refused', action: 'transfer' });
  });

  it('turns a trailing "Options:" line into buttons', () => {
    expect(splitOptions('Which one?\nOptions: Health | Travel')).toEqual({
      content: 'Which one?',
      options: ['Health', 'Travel'],
    });
    expect(splitOptions('No options here.')).toEqual({ content: 'No options here.', options: [] });
  });
});
