import { describe, expect, it, vi, afterEach } from 'vitest';
import { app, fromProviderToolCalls, toProviderMessages, toProviderTools } from './index.ts';

/**
 * The relay is exercised in-process with Hono's `app.request`, so no server and
 * no network are needed.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['MODEL_API_KEY'];
  delete process.env['MODEL_API_URL'];
  delete process.env['MODEL_ID'];
});

describe('relay', () => {
  it('reports that it is not configured', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: false });
  });

  it('refuses to forward without an API key, and says what to do', async () => {
    const response = await app.request('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/MODEL_API_KEY/);
  });

  it('rejects a body without messages', async () => {
    process.env['MODEL_API_KEY'] = 'test-key';
    const response = await app.request('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });

    expect(response.status).toBe(400);
  });

  it('forwards a redacted request with the key and returns the reply', async () => {
    process.env['MODEL_API_KEY'] = 'test-key';
    process.env['MODEL_API_URL'] = 'https://model.example/v1/chat/completions';
    process.env['MODEL_ID'] = 'test-model';

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'Safe to spend is Rp 10.501.000' } }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    });

    const response = await app.request('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '[REDACTED:NAME] asked about rent' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: 'test-model',
      content: 'Safe to spend is Rp 10.501.000',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://model.example/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key');
    const forwarded = calls[0]?.init.body;
    expect(typeof forwarded).toBe('string');
    expect(forwarded as string).toContain('[REDACTED:NAME]');
  });

  it('reports an upstream failure without leaking the key', async () => {
    process.env['MODEL_API_KEY'] = 'test-key';
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 429 })));

    const response = await app.request('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('429');
    expect(body.error).not.toContain('test-key');
  });
});

describe('relay translation to the chat-completions format', () => {
  it('turns tool descriptors into function tools with provider-safe names', () => {
    const tools = toProviderTools([
      {
        name: 'earmark.create',
        description: 'Set money aside',
        parameters: { label: 'string', amount: 'number', reviewDate: 'YYYY-MM-DD' },
      },
      {
        name: 'run_scenario',
        description: 'What-if',
        parameters: { client: 'string?', daysLate: 'number?' },
      },
      { name: 'compare_policies', description: 'Compare', parameters: { criteria: 'string[]' } },
    ]);

    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'earmark__create',
          description: 'Set money aside',
          parameters: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              amount: { type: 'integer' },
              reviewDate: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['label', 'amount', 'reviewDate'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_scenario',
          description: 'What-if',
          parameters: {
            type: 'object',
            properties: { client: { type: 'string' }, daysLate: { type: 'integer' } },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'compare_policies',
          description: 'Compare',
          parameters: {
            type: 'object',
            properties: { criteria: { type: 'array', items: { type: 'string' } } },
            required: ['criteria'],
          },
        },
      },
    ]);
  });

  it('pairs every tool result with the call it answers', () => {
    const messages = toProviderMessages([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'set aside money' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { name: 'get_summary', arguments: {} },
          { name: 'earmark.create', arguments: { amount: 1 } },
        ],
      },
      { role: 'tool', name: 'get_summary', content: '{"asOf":"2026-10-13"}' },
      { role: 'tool', name: 'earmark.create', content: '{"status":"pending-approval"}' },
      { role: 'assistant', content: 'Done.' },
    ]);

    expect(messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'set aside money' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_summary', arguments: '{}' } },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'earmark__create', arguments: '{"amount":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"asOf":"2026-10-13"}' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"status":"pending-approval"}' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('reads tool calls back, restores the names and survives bad arguments', () => {
    expect(
      fromProviderToolCalls([
        { id: 'a', type: 'function', function: { name: 'earmark__create', arguments: '{"amount":3000000}' } },
        { id: 'b', type: 'function', function: { name: 'get_runway', arguments: '' } },
        { id: 'c', type: 'function', function: { name: 'transfer', arguments: 'not json' } },
        { id: 'd', type: 'function', function: {} },
      ]),
    ).toEqual([
      { name: 'earmark.create', arguments: { amount: 3_000_000 } },
      { name: 'get_runway', arguments: {} },
      { name: 'transfer', arguments: {} },
    ]);
    expect(fromProviderToolCalls(undefined)).toEqual([]);
  });

  it('forwards translated tools and returns translated tool calls end to end', async () => {
    process.env['MODEL_API_KEY'] = 'test-key';
    let forwarded: { tools?: unknown[]; messages?: unknown[] } = {};
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      forwarded = JSON.parse(init.body as string) as typeof forwarded;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'x', type: 'function', function: { name: 'get_runway', arguments: '{}' } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const response = await app.request('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'How long can I cover my costs?' }],
        tools: [{ name: 'get_runway', description: 'Runway', parameters: {} }],
      }),
    });

    expect(forwarded.tools).toHaveLength(1);
    expect(await response.json()).toMatchObject({
      content: '',
      toolCalls: [{ name: 'get_runway', arguments: {} }],
    });
  });
});
