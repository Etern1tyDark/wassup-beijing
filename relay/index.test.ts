import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from './index.ts';

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
