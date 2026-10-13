import { randomId } from '../domain/ids';
import { OutboundRequestSchema, type OutboundRequest, type Redaction } from '../domain/schemas';
import type { AppDatabase } from '../storage/db';
import type { Repositories } from '../storage/repositories';
import type { Clock } from '../actions/clock';
import {
  EMPTY_REDACTOR_CONFIG,
  createRedactor,
  redactValue,
  type Redactor,
  type RedactorConfig,
} from './redactor';

/**
 * PRV-1 / PRV-2: every outbound request passes through `gate.send()`.
 *
 * send() runs the redactor, records the request for the privacy panel, honours a
 * block decision and only then calls the transport. The model adapter in
 * src/agent goes through this gate too, so there is no other way out.
 */
export interface OutboundMessage {
  purpose: string;
  payload: unknown;
  /** Identifiers to strip for this call, merged with the gate's own config. */
  redactorConfig?: Partial<RedactorConfig>;
}

export interface TransportRequest {
  purpose: string;
  payload: unknown;
}

export interface Transport {
  send(request: TransportRequest): Promise<unknown>;
}

export type BlockDecider = (request: TransportRequest) => { block: boolean; reason?: string };

export type GateResult =
  | { ok: true; requestId: string; payload: unknown; redactions: Redaction[]; response: unknown }
  | { ok: false; requestId: string; payload: unknown; redactions: Redaction[]; reason: string };

export interface OutboundGate {
  send(message: OutboundMessage): Promise<GateResult>;
  requests(): Promise<OutboundRequest[]>;
  setBlockDecider(decider: BlockDecider | null): void;
  setRedactorConfig(config: RedactorConfig): void;
  redactor: Redactor;
}

/** The default transport: it never reaches a network. */
export function createStubTransport(): Transport {
  return {
    send: (request) =>
      Promise.resolve({
        model: 'stub',
        content: `[stub transport] "${request.purpose}" was not sent; connect the relay to enable model calls.`,
      }),
  };
}

export interface OutboundGateDeps {
  db: AppDatabase;
  repos: Repositories;
  clock: Clock;
  transport?: Transport;
  redactorConfig?: RedactorConfig;
  blockDecider?: BlockDecider | null;
}

export function createOutboundGate(deps: OutboundGateDeps): OutboundGate {
  const { db, clock } = deps;
  const transport = deps.transport ?? createStubTransport();
  const redactor = createRedactor(deps.redactorConfig ?? EMPTY_REDACTOR_CONFIG);
  let blockDecider: BlockDecider | null = deps.blockDecider ?? null;

  async function record(request: OutboundRequest): Promise<void> {
    await db.outboundRequests.put(OutboundRequestSchema.parse(request));
  }

  return {
    redactor,

    setBlockDecider: (decider) => {
      blockDecider = decider;
    },

    setRedactorConfig: (config) => {
      redactor.setConfig(config);
    },

    requests: () => deps.repos.outboundRequests.all(),

    send: async (message) => {
      const id = randomId('req');
      const config: RedactorConfig = {
        names: [...(message.redactorConfig?.names ?? []), ...redactor.config().names],
        accountNumbers: [
          ...(message.redactorConfig?.accountNumbers ?? []),
          ...redactor.config().accountNumbers,
        ],
        policyNumbers: [...(message.redactorConfig?.policyNumbers ?? []), ...redactor.config().policyNumbers],
        addresses: [...(message.redactorConfig?.addresses ?? []), ...(redactor.config().addresses ?? [])],
      };

      const { value: payload, redactions } = redactValue(message.payload, config);
      const decision = blockDecider?.({ purpose: message.purpose, payload }) ?? { block: false };

      if (decision.block) {
        await record({
          id,
          time: clock.now().toISOString(),
          purpose: message.purpose,
          status: 'blocked',
          redactions,
          payload,
          blockReason: decision.reason ?? 'blocked by the user',
          response: null,
        });
        return {
          ok: false,
          requestId: id,
          payload,
          redactions,
          reason: decision.reason ?? 'blocked by the user',
        };
      }

      try {
        const response = await transport.send({ purpose: message.purpose, payload });
        await record({
          id,
          time: clock.now().toISOString(),
          purpose: message.purpose,
          status: 'sent',
          redactions,
          payload,
          blockReason: null,
          response,
        });
        return { ok: true, requestId: id, payload, redactions, response };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await record({
          id,
          time: clock.now().toISOString(),
          purpose: message.purpose,
          status: 'failed',
          redactions,
          payload,
          blockReason: null,
          response: { error: reason },
        });
        return { ok: false, requestId: id, payload, redactions, reason };
      }
    },
  };
}
