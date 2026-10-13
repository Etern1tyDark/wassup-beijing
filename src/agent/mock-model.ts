import { parseRupiah } from '../domain/money';
import { findInjectionSignals } from '../importers/injection';
import type { OutboundGate } from '../gate/gate';
import type { ModelAdapter, ModelRequest, ModelResponse, ModelToolCall } from './types';

/**
 * Mock model adapter: deterministic, offline, and routed through the outbound
 * gate so the privacy panel records every call (PRV-1).
 *
 * It stands in for a hosted model with tool calling (decision D5). It is a
 * rule-based stand-in, not a language model: it exists so the whole flow can be
 * demonstrated and tested without an API key. It never executes anything, it
 * only asks for tools.
 */
export interface MockModelOptions {
  gate: OutboundGate;
  id?: string;
}

/** Pull the first rupiah-looking amount out of a sentence. */
export function extractAmount(text: string): number | null {
  const match = /(\d[\d.]*)/.exec(text);
  if (!match) return null;
  const digits = match[1]!.replace(/\./g, '');
  const parsed = parseRupiah(digits);
  return parsed.ok ? parsed.value : null;
}

export function extractReviewDate(text: string): string | null {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  return match ? match[1]! : null;
}

function lastUserMessage(request: ModelRequest): string {
  const reversed = [...request.messages].reverse();
  return reversed.find((message) => message.role === 'user')?.content ?? '';
}

export function createMockModelAdapter(options: MockModelOptions): ModelAdapter {
  const id = options.id ?? 'mock-rule-based';

  return {
    id,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const text = lastUserMessage(request);
      const signal = findInjectionSignals(text);
      if (signal.length > 0) {
        return {
          content: `I treated that text as data, not as an instruction. It contains what looks like an instruction ("${signal[0]}"), so I have not acted on it.`,
          toolCalls: [],
        };
      }

      const toolCalls: ModelToolCall[] = [];
      let content = '';

      if (/\b(undo|revert|roll back)\b/i.test(text)) {
        toolCalls.push({ name: 'undo', arguments: {} });
        content = 'I can prepare that undo. It needs your approval before anything changes.';
      } else if (/\b(transfer|move money|send funds)\b/i.test(text)) {
        const amount = extractAmount(text) ?? 0;
        toolCalls.push({
          name: 'transfer',
          arguments: { fromAccountId: 'acc_bank', toAccountId: 'acc_sandbox', amount },
        });
        content = 'Let me check whether that transfer is allowed.';
      } else if (/\b(earmark|set aside|reserve|put aside)\b/i.test(text)) {
        const amount = extractAmount(text) ?? 0;
        toolCalls.push({
          name: 'earmark.create',
          arguments: {
            label: 'Reserve from chat',
            amount,
            reviewDate: extractReviewDate(text) ?? '2027-01-13',
          },
        });
        content = 'Here is a proposal to set that money aside.';
      } else if (/\b(summary|balance|safe to spend|how much)\b/i.test(text)) {
        toolCalls.push({ name: 'get_summary', arguments: {} });
        content = 'Let me pull your numbers.';
      } else if (/\b(runway|how long)\b/i.test(text)) {
        toolCalls.push({ name: 'get_runway', arguments: {} });
        content = 'Let me check your runway.';
      } else if (/\b(remind|reminder|chase)\b/i.test(text)) {
        toolCalls.push({ name: 'draft_reminder', arguments: { invoiceId: 'inv_open', tone: 'friendly' } });
        content = 'Here is a draft reminder. Nothing has been sent.';
      } else {
        content =
          'I can read your numbers, draft text, or propose a reversible ledger change. I cannot move money or change limits.';
      }

      // Every outbound request passes through the gate (PRV-1).
      const gated = await options.gate.send({
        purpose: 'agent.complete',
        payload: { messages: request.messages, tools: request.tools.map((tool) => tool.name) },
      });

      if (!gated.ok) {
        return {
          content: `I could not reach the model: ${gated.reason}. Your ledger, earmarks and audit log keep working.`,
          toolCalls: [],
        };
      }

      return { content, toolCalls };
    },
  };
}
