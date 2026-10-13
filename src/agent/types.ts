import type { ActionName } from '../actions/registry';
import type { ProposalTier } from '../domain/schemas';

/**
 * Agent and model interfaces (PRD Section 7).
 *
 * The agent orchestrator reads tool results and writes explanations. It never
 * holds the ledger, never computes a number and never approves an action: it can
 * only propose, and the proposal goes through the tier engine.
 */
export interface ToolDescriptor {
  name: ActionName;
  tier: ProposalTier;
  description: string;
  /** Parameter names and types, for the model's tool-calling payload. */
  parameters: Record<string, string>;
}

export type ToolResult =
  | { ok: true; tool: ActionName; data: unknown }
  /** `tool` is the name the model asked for, which may not be a registered action. */
  | { ok: false; tool: string; reason: string };

export interface ToolContext {
  /** Who asked, for provenance. */
  requestedBy: string;
  /** Untrusted sources that fed this call, if any. */
  untrustedInputs?: Array<{ source: 'csv' | 'document' | 'chat'; ref: string; fields: string[] }>;
  /** Text pasted from somewhere else (a notice, a document). Always treated as data. */
  pastedText?: string;
}

export interface AgentTool {
  descriptor: ToolDescriptor;
  invoke(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelRole;
  content: string;
  /** Set on tool results. */
  name?: string;
  /** Set on assistant messages that asked for tools. */
  toolCalls?: ModelToolCall[];
  /** Set on assistant messages that asked the user to choose (CHAT-2). */
  options?: string[];
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolDescriptor[];
}

export interface ModelToolCall {
  name: string;
  arguments: unknown;
}

export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  /** Choices to offer as buttons when the model asks a clarifying question (CHAT-2). */
  options?: string[];
  /** True when the model could not be reached and `content` is the adapter's own notice. */
  unavailable?: boolean;
}

/**
 * Any hosted model with reliable tool calling fits this shape (decision D5).
 * The mock adapter in ./mock-model.ts implements it with no network calls.
 */
export interface ModelAdapter {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
