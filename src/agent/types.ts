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
  | { ok: false; tool: ActionName; reason: string };

export interface ToolContext {
  /** Who asked, for provenance. */
  requestedBy: string;
  /** Untrusted sources that fed this call, if any. */
  untrustedInputs?: Array<{ source: 'csv' | 'document' | 'chat'; ref: string; fields: string[] }>;
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
}

/**
 * Any hosted model with reliable tool calling fits this shape (decision D5).
 * The mock adapter in ./mock-model.ts implements it with no network calls.
 */
export interface ModelAdapter {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  readonly requirement: string;

  constructor(message: string, requirement: string) {
    super(`${message} (not implemented yet - see ${requirement})`);
    this.requirement = requirement;
  }
}
