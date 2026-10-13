import type { AppDatabase } from '../storage/db';
import { createAppDatabase } from '../storage/db';
import { createRepositories, type Repositories } from '../storage/repositories';
import { createAuditLog, type AuditLog } from '../audit/log';
import { createApprovalService, type ApprovalService } from '../actions/approvals';
import { createActionService, type ActionService } from '../actions/service';
import { createSettingsService, type SettingsService } from '../actions/settings';
import { createOutboundGate, type OutboundGate } from '../gate/gate';
import { createAgentTools, type AgentTools } from '../agent/tools';
import { createOrchestrator, untrustedTurnAuditEntry, type AgentOrchestrator } from '../agent/orchestrator';
import { createMockModelAdapter } from '../agent/mock-model';
import { createRelayModelAdapter, createRelayTransport } from '../agent/relay-model';
import { createPolicyStore, type PolicyStore } from '../policy';
import type { PdfTextResult } from '../importers/pdf';
import { createDemoClock, type DemoClock } from './demo-clock';

/**
 * Application wiring.
 *
 * The UI receives the full action service, because the UI is what issues
 * approval tokens and presses Approve. The agent receives only `propose`, so
 * there is no code path from the model to an approval.
 */
export interface AppServices {
  db: AppDatabase;
  repos: Repositories;
  audit: AuditLog;
  approvals: ApprovalService;
  actions: ActionService;
  settings: SettingsService;
  gate: OutboundGate;
  policies: PolicyStore;
  /** Reads the text of a policy PDF. pdf.js is loaded on first use. */
  readPdf: (bytes: Uint8Array) => Promise<PdfTextResult>;
  tools: AgentTools;
  orchestrator: AgentOrchestrator;
  clock: DemoClock;
  /** Which model answers the chat; shown in the interface so it is never ambiguous. */
  modelKind: 'mock' | 'relay';
}

export interface AppServicesOptions {
  /** Overridden by tests so each one gets a clean IndexedDB. */
  databaseName?: string;
  /** Tests turn this off so one test's clock anchor cannot leak into the next. */
  persistClock?: boolean;
  /**
   * 'mock' is the rule-based model that needs no key and sends nothing; 'relay'
   * is a hosted model behind the relay. Defaults to the VITE_MODEL build
   * setting, and to 'mock' when that is unset.
   */
  model?: 'mock' | 'relay';
  /** Tests pass the Node build of pdf.js; the browser loads its own with a worker. */
  readPdf?: (bytes: Uint8Array) => Promise<PdfTextResult>;
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const db = createAppDatabase(options.databaseName);
  const repos = createRepositories(db);
  const clock = createDemoClock({ persist: options.persistClock ?? true });
  const audit = createAuditLog(db, () => clock.now());
  const approvals = createApprovalService();
  const actions = createActionService({ db, repos, audit, approvals, clock });
  const settings = createSettingsService(db);
  const modelKind = options.model ?? (import.meta.env?.['VITE_MODEL'] === 'relay' ? 'relay' : 'mock');
  // With the rule-based model the gate keeps its stub transport: requests are
  // redacted and recorded for the privacy panel, and nothing leaves the browser.
  const gate = createOutboundGate({
    db,
    repos,
    clock,
    ...(modelKind === 'relay' ? { transport: createRelayTransport() } : {}),
  });
  const policies = createPolicyStore({ db, repos, now: () => clock.now() });

  const tools = createAgentTools({
    // The agent gets a narrowed surface: it can propose and read, and the object
    // it holds has no approve or execute method at all (not just in the types).
    proposals: { propose: actions.propose.bind(actions) },
    actions: {
      snapshot: () => actions.snapshot(),
      ledgerInput: () => actions.ledgerInput(),
      staleness: () => actions.staleness(),
    },
    policies: { all: () => policies.all() },
    auditEntries: () => repos.audit.all(),
  });

  const orchestrator = createOrchestrator({
    model: modelKind === 'relay' ? createRelayModelAdapter({ gate }) : createMockModelAdapter({ gate }),
    tools,
    onUntrustedTurn: async (turn) => {
      await audit.append(untrustedTurnAuditEntry(turn));
    },
  });

  const readPdf =
    options.readPdf ??
    (async (bytes: Uint8Array) => (await import('../importers/pdf-browser')).readPdfFile(bytes));

  return {
    db,
    repos,
    audit,
    approvals,
    actions,
    settings,
    gate,
    policies,
    readPdf,
    tools,
    orchestrator,
    clock,
    modelKind,
  };
}
