import { Hono } from 'hono';

/**
 * The stateless relay (PRD Section 9).
 *
 * It adds the model API key and forwards an already-redacted request. It stores
 * nothing and logs nothing: the browser is the only place user data lives
 * (NFR-5, NFR-6). The payload it receives has already passed through
 * `src/gate/gate.ts`.
 *
 * Deployment: one serverless function. `npm run relay:dev` runs it locally.
 */
export interface RelayBindings {
  /** OpenAI-compatible chat-completions endpoint. */
  MODEL_API_URL?: string;
  /** Never reaches the browser. */
  MODEL_API_KEY?: string;
  /** Reported back so the privacy panel can label the reply. */
  MODEL_ID?: string;
}

export interface RelayRequestBody {
  messages: Array<{ role: string; content: string; name?: string }>;
  tools?: Array<{ name: string; description: string; parameters: Record<string, string> }>;
}

export const DEFAULT_MODEL_API_URL = 'https://api.example.invalid/v1/chat/completions';

function readBinding(env: RelayBindings | undefined, key: keyof RelayBindings): string | undefined {
  return env?.[key] ?? process.env[key];
}

export const app = new Hono<{ Bindings: RelayBindings }>();

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(readBinding(c.env, 'MODEL_API_KEY')) }));

app.post('/api/model', async (c) => {
  const apiKey = readBinding(c.env, 'MODEL_API_KEY');
  if (!apiKey) {
    return c.json(
      {
        error:
          'the relay is not configured. Set MODEL_API_KEY (and MODEL_API_URL) to enable model calls. Everything except the model keeps working without it.',
      },
      503,
    );
  }

  let body: RelayRequestBody;
  try {
    body = await c.req.json<RelayRequestBody>();
  } catch {
    return c.json({ error: 'expected a JSON body with a "messages" array' }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return c.json({ error: 'expected a JSON body with a "messages" array' }, 400);
  }

  const url = readBinding(c.env, 'MODEL_API_URL') ?? DEFAULT_MODEL_API_URL;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: readBinding(c.env, 'MODEL_ID') ?? 'default',
      messages: body.messages,
      ...(body.tools ? { tools: body.tools } : {}),
    }),
  });

  if (!upstream.ok) {
    return c.json({ error: `the model provider returned ${upstream.status}` }, 502);
  }

  const reply = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
  };

  return c.json({
    model: readBinding(c.env, 'MODEL_ID') ?? 'default',
    content: reply.choices?.[0]?.message?.content ?? '',
    toolCalls: reply.choices?.[0]?.message?.tool_calls ?? [],
  });
});

export default app;
