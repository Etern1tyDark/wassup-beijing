import type { AppDatabase } from '../storage/db';
import { createAppDatabase } from '../storage/db';
import { createRepositories, type Repositories } from '../storage/repositories';
import { createAuditLog, type AuditLog } from '../audit/log';
import { createApprovalService, type ApprovalService } from '../actions/approvals';
import { createActionService, type ActionService } from '../actions/service';
import { createSettingsService, type SettingsService } from '../actions/settings';
import { createOutboundGate, type OutboundGate } from '../gate/gate';
import { createAgentTools, type AgentTools } from '../agent/tools';
import { createOrchestrator, type AgentOrchestrator } from '../agent/orchestrator';
import { createMockModelAdapter } from '../agent/mock-model';
import { createForecastEngine } from '../forecast';
import { createCoverageEngine, createPolicyExtractor } from '../policy';
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
  tools: AgentTools;
  orchestrator: AgentOrchestrator;
  clock: DemoClock;
}

export interface AppServicesOptions {
  /** Overridden by tests so each one gets a clean IndexedDB. */
  databaseName?: string;
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const db = createAppDatabase(options.databaseName);
  const repos = createRepositories(db);
  const clock = createDemoClock();
  const audit = createAuditLog(db, () => clock.now());
  const approvals = createApprovalService();
  const actions = createActionService({ db, repos, audit, approvals, clock });
  const settings = createSettingsService(db);
  const gate = createOutboundGate({ db, repos, clock });

  const tools = createAgentTools({
    // The agent gets propose() and nothing else.
    proposals: { propose: actions.propose.bind(actions) },
    actions,
    forecast: createForecastEngine(),
    policy: createPolicyExtractor(),
    coverage: createCoverageEngine(),
  });

  const orchestrator = createOrchestrator({ model: createMockModelAdapter({ gate }), tools });

  return { db, repos, audit, approvals, actions, settings, gate, tools, orchestrator, clock };
}
