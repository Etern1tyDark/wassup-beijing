import seedFixture from '../../fixtures/seed/rina.json';
import { createAgentTools, type AgentTools } from '../agent/tools';
import { createMockModelAdapter } from '../agent/mock-model';
import { createOrchestrator, untrustedTurnAuditEntry, type AgentOrchestrator } from '../agent/orchestrator';
import type { ModelAdapter } from '../agent/types';
import type { ExecuteResult } from '../actions/service';
import { SeedDatasetSchema, type SeedDataset } from '../domain/seed';
import { createOutboundGate, type OutboundGate, type Transport } from '../gate/gate';
import { extractPdfText } from '../importers/pdf';
import { createPolicyStore, importPolicyFile, type ImportPolicyOutcome, type PolicyStore } from '../policy';
import { createTestWorld, type TestWorld, type TestWorldOptions } from './harness';
import { nodePdfJs, policyFixtureBytes } from './policies';

/**
 * The whole application wired the way src/ui/services.ts wires it, on
 * fake-indexeddb: real action service, real audit log, real gate, real tools,
 * the rule-based model. The acceptance scripts run against this.
 */
export interface AgentWorld extends TestWorld {
  gate: OutboundGate;
  policies: PolicyStore;
  tools: AgentTools;
  agent: AgentOrchestrator;
  /** Upload one of the synthetic policy PDFs, through the real PDF reader. */
  loadPolicy(fileName: string): Promise<ImportPolicyOutcome>;
  /** Press Approve on the card: issue a token, approve, execute. */
  approveAndExecute(proposalId: string, pin?: string): Promise<ExecuteResult>;
}

export const SEED_DATASET: SeedDataset = SeedDatasetSchema.parse(seedFixture);

export interface AgentWorldOptions extends TestWorldOptions {
  /** Start from the seeded persona instead of the small default ledger. */
  seed?: boolean;
  /** Replace the rule-based model, to test what the orchestrator does with any reply. */
  model?: (gate: OutboundGate) => ModelAdapter;
  /** Replace the gate's stub transport, to test the path to a hosted model. */
  transport?: Transport;
}

export async function createAgentWorld(options: AgentWorldOptions = {}): Promise<AgentWorld> {
  const world = await createTestWorld(
    options.seed
      ? {
          asOf: SEED_DATASET.asOf,
          accounts: SEED_DATASET.accounts,
          transactions: SEED_DATASET.transactions,
          invoices: SEED_DATASET.invoices,
          obligations: SEED_DATASET.obligations,
          earmarks: SEED_DATASET.earmarks,
          ...options,
        }
      : options,
  );

  const gate = createOutboundGate({
    db: world.db,
    repos: world.repos,
    clock: world.clock,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  const policies = createPolicyStore({ db: world.db, repos: world.repos, now: () => world.clock.now() });
  const tools = createAgentTools({
    proposals: { propose: world.actions.propose.bind(world.actions) },
    actions: {
      snapshot: () => world.actions.snapshot(),
      ledgerInput: () => world.actions.ledgerInput(),
      staleness: () => world.actions.staleness(),
    },
    policies: { all: () => policies.all() },
    auditEntries: () => world.repos.audit.all(),
  });
  const agent = createOrchestrator({
    model: options.model ? options.model(gate) : createMockModelAdapter({ gate }),
    tools,
    onUntrustedTurn: async (turn) => {
      await world.audit.append(untrustedTurnAuditEntry(turn));
    },
  });

  return {
    ...world,
    gate,
    policies,
    tools,
    agent,
    loadPolicy: (fileName) =>
      importPolicyFile(
        { readPdf: (bytes) => extractPdfText(nodePdfJs, bytes), store: policies, gate, audit: world.audit },
        { name: fileName, bytes: policyFixtureBytes(fileName) },
      ),
    approveAndExecute: async (proposalId, pin) => {
      const issued = await world.issueToken(proposalId);
      const approved = await world.actions.approve({
        proposalId,
        token: issued.token,
        ...(pin ? { pin } : {}),
      });
      if (approved.kind !== 'approved') {
        return { kind: 'blocked', reason: approved.reason, auditEntryId: null };
      }
      return world.actions.execute(proposalId);
    },
  };
}
