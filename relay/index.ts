import { Hono } from 'hono';

/**
 * The stateless relay (PRD Section 9).
 *
 * It adds the model API key and forwards an already-redacted request. It stores
 * nothing and logs nothing: the browser is the only place user data lives
 * (NFR-5, NFR-6). The payload it receives has already passed through
 * `src/gate/gate.ts`.
 *
 * It also translates between the app's own message and tool shapes and the
 * OpenAI-compatible chat-completions format, so provider details stay next to
 * the provider key and out of the browser.
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

export interface RelayMessage {
  role: string;
  content: string;
  /** Tool name, on tool results. */
  name?: string;
  /** Tool calls the assistant made in this message. */
  toolCalls?: Array<{ name: string; arguments: unknown }>;
}

export interface RelayTool {
  name: string;
  description: string;
  /** Parameter name to a short type hint: "string", "number?", "string[]". */
  parameters: Record<string, string>;
}

export interface RelayRequestBody {
  messages: RelayMessage[];
  tools?: RelayTool[];
}

/* ---------------------------------------------------- provider translation */

/**
 * The app's tool names contain dots ("earmark.create"), which the
 * chat-completions format does not allow in a function name.
 */
export function toProviderToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function fromProviderToolName(name: string): string {
  return name.replace(/__/g, '.');
}

function parameterSchema(hint: string): Record<string, unknown> {
  const base = hint.replace(/\?$/, '');
  if (base === 'number') return { type: 'integer' };
  if (base === 'string[]') return { type: 'array', items: { type: 'string' } };
  // Anything else ("string", "YYYY-MM-DD", "friendly | firm") is a string with the hint as its description.
  return base === 'string' ? { type: 'string' } : { type: 'string', description: base };
}

export function toProviderTools(tools: readonly RelayTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: toProviderToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, hint]) => [key, parameterSchema(hint)]),
        ),
        required: Object.entries(tool.parameters)
          .filter(([, hint]) => !hint.endsWith('?'))
          .map(([key]) => key),
      },
    },
  }));
}

/**
 * Chat-completions messages. Each tool result must name the call it answers, so
 * calls are numbered in order and results are matched to them in order.
 */
export function toProviderMessages(messages: readonly RelayMessage[]): unknown[] {
  const output: unknown[] = [];
  const unanswered: string[] = [];
  let counter = 0;

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => {
        counter += 1;
        const id = `call_${counter}`;
        unanswered.push(id);
        return {
          id,
          type: 'function',
          function: { name: toProviderToolName(call.name), arguments: JSON.stringify(call.arguments ?? {}) },
        };
      });
      output.push({ role: 'assistant', content: message.content, tool_calls: calls });
    } else if (message.role === 'tool') {
      const id = unanswered.shift();
      // A tool result with no call to answer cannot be expressed; pass it as plain text.
      output.push(
        id
          ? { role: 'tool', tool_call_id: id, content: message.content }
          : { role: 'user', content: `Tool result (${message.name ?? 'unknown'}): ${message.content}` },
      );
    } else {
      output.push({ role: message.role, content: message.content });
    }
  }
  return output;
}

interface ProviderToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

export function fromProviderToolCalls(raw: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(raw)) return [];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  for (const entry of raw as ProviderToolCall[]) {
    const name = entry.function?.name;
    if (typeof name !== 'string' || name === '') continue;
    let parsed: unknown = {};
    const rawArguments = entry.function?.arguments;
    if (typeof rawArguments === 'string' && rawArguments.trim() !== '') {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        // Arguments that are not JSON are dropped; the tool then refuses the empty call.
        parsed = {};
      }
    } else if (rawArguments !== null && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }
    calls.push({ name: fromProviderToolName(name), arguments: parsed });
  }
  return calls;
}

export const DEFAULT_MODEL_API_URL = 'https://api.example.invalid/v1/chat/completions';

/**
 * Read a value from the platform bindings (Cloudflare Workers style) or from the
 * process environment (Node). `process` is absent on some edge runtimes, so it is
 * never touched unless it exists.
 */
function readBinding(env: RelayBindings | undefined, key: keyof RelayBindings): string | undefined {
  if (env?.[key] !== undefined) return env[key];
  if (typeof process !== 'undefined') return process.env[key];
  return undefined;
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
      messages: toProviderMessages(body.messages),
      ...(body.tools && body.tools.length > 0 ? { tools: toProviderTools(body.tools) } : {}),
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
    toolCalls: fromProviderToolCalls(reply.choices?.[0]?.message?.tool_calls),
  });
});

export default app;
