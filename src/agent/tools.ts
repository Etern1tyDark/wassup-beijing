import type { Earmark } from '../domain/schemas';
import type { ActionService, ProposalPort } from '../actions/service';
import { lookupAction, type ActionName } from '../actions/registry';
import type { LedgerSnapshot } from '../ledger/engine';
import type { ForecastEngine } from '../forecast';
import type { PolicyExtractor, CoverageEngine } from '../policy';
import type { AgentTool, ToolContext, ToolDescriptor, ToolResult } from './types';

/**
 * The tools the model may call (PRD Section 7).
 *
 * T0 and T1 tools run directly: they read the ledger or produce text, and they
 * cannot change anything (ACT-2). T2 and T3 tools do not execute; they only ask
 * the tier engine for a pending proposal. There is no tool that approves or
 * executes, which is what keeps the model out of the approval path.
 */
export interface AgentToolDeps {
  /** The only part of the action service the agent ever receives. */
  proposals: ProposalPort;
  actions: Pick<ActionService, 'snapshot' | 'ledgerInput' | 'staleness'>;
  forecast: ForecastEngine;
  policy: PolicyExtractor;
  coverage: CoverageEngine;
}

export interface AgentTools {
  descriptors(): ToolDescriptor[];
  invoke(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

function describe(name: ActionName, parameters: Record<string, string>): ToolDescriptor {
  const definition = lookupAction(name);
  if (!definition) throw new Error(`${name} is not in the action registry`);
  return { name, tier: definition.tier, description: definition.description, parameters };
}

export function createAgentTools(deps: AgentToolDeps): AgentTools {
  const tools = new Map<ActionName, AgentTool>();

  const register = (
    name: ActionName,
    parameters: Record<string, string>,
    invoke: AgentTool['invoke'],
  ): void => {
    tools.set(name, { descriptor: describe(name, parameters), invoke });
  };

  register('get_summary', {}, async () => {
    const [snapshot, ledger, staleness] = await Promise.all([
      deps.actions.snapshot(),
      deps.actions.ledgerInput(),
      deps.actions.staleness(),
    ]);
    return {
      ok: true,
      tool: 'get_summary',
      data: summarise(
        snapshot,
        ledger.earmarks.filter((earmark) => earmark.active),
        staleness.stale,
      ),
    };
  });

  register('get_runway', {}, async () => {
    const [snapshot, ledger] = await Promise.all([deps.actions.snapshot(), deps.actions.ledgerInput()]);
    const runway = await deps.forecast.runway({
      asOf: snapshot.asOf,
      obligations: [],
      openInvoices: ledger.invoices
        .filter((invoice) => invoice.paidDate === null)
        .map((invoice) => ({
          id: invoice.id,
          client: invoice.client,
          amount: invoice.amount,
          dueDate: invoice.dueDate,
        })),
      startingBalance: snapshot.totalBalance,
      freeCash: snapshot.freeCash,
    });
    return { ok: true, tool: 'get_runway', data: runway };
  });

  register('run_scenario', { invoiceId: 'string', daysLate: 'number', extraExpense: 'number' }, () =>
    Promise.reject(
      new Error('FC-3 is not implemented yet: run_scenario returns nothing until the forecast engine lands'),
    ),
  );

  register('list_policies', {}, () =>
    Promise.resolve({ ok: true as const, tool: 'list_policies' as const, data: [] }),
  );

  register('get_coverage', { policyId: 'string', event: 'string' }, () =>
    Promise.reject(
      new Error('POL-2 is not implemented yet: get_coverage returns nothing until the coverage engine lands'),
    ),
  );

  register('compare_policies', { policyIds: 'string[]', criteria: 'string[]' }, () =>
    Promise.reject(
      new Error(
        'POL-4 is not implemented yet: compare_policies returns nothing until the coverage engine lands',
      ),
    ),
  );

  register('draft_reminder', { invoiceId: 'string', tone: 'string' }, async (args) => {
    const params = (args ?? {}) as { invoiceId?: unknown; tone?: unknown };
    const ledger = await deps.actions.ledgerInput();
    const invoice = ledger.invoices.find((candidate) => candidate.id === params.invoiceId);
    if (!invoice) return { ok: false, tool: 'draft_reminder', reason: 'no such invoice' };

    // T1: text only. Nothing is sent and nothing changes (ACT-2).
    const tone = typeof params.tone === 'string' ? params.tone : 'friendly';
    return {
      ok: true,
      tool: 'draft_reminder',
      data: {
        invoiceId: invoice.id,
        tone,
        draft: `Hi ${invoice.client}, a quick note about invoice ${invoice.id} for Rp ${invoice.amount}, due ${invoice.dueDate}. Could you let me know when it will be paid? Thank you.`,
        sent: false,
      },
    };
  });

  register('earmark.create', { label: 'string', amount: 'number', reviewDate: 'string' }, (args, context) =>
    propose('earmark.create', args, context),
  );

  register('earmark.delete', { earmarkId: 'string' }, (args, context) =>
    propose('earmark.delete', args, context),
  );

  register('undo', { auditEntryId: 'string' }, (args, context) => propose('undo', args, context));

  register(
    'transfer',
    { fromAccountId: 'string', toAccountId: 'string', amount: 'number' },
    (args, context) => propose('transfer', args, context),
  );

  async function propose(name: ActionName, args: unknown, context: ToolContext): Promise<ToolResult> {
    const result = await deps.proposals.propose({
      action: name,
      params: args,
      provenance: {
        requestedBy: context.requestedBy,
        untrustedInputs: context.untrustedInputs ?? [],
      },
      actor: 'agent',
    });

    if (result.kind === 'proposal') {
      // The agent gets the pending proposal, never a handle that could approve it.
      return { ok: true, tool: name, data: { status: 'pending-approval', proposal: result.proposal } };
    }
    return { ok: false, tool: name, reason: result.reason };
  }

  return {
    descriptors: () => [...tools.values()].map((tool) => tool.descriptor),
    invoke: async (name, args, context) => {
      if (!lookupAction(name)) {
        return {
          ok: false,
          tool: name as ActionName,
          reason: `"${name}" is not in the action registry (ACT-1)`,
        };
      }
      const tool = tools.get(name as ActionName);
      if (!tool) {
        return {
          ok: false,
          tool: name as ActionName,
          reason: `"${name}" is registered but not implemented yet`,
        };
      }
      return tool.invoke(args, context);
    },
  };
}

function summarise(
  snapshot: LedgerSnapshot,
  activeEarmarks: ReadonlyArray<Pick<Earmark, 'id' | 'label' | 'amount' | 'reviewDate'>>,
  stale: boolean,
): unknown {
  return {
    asOf: snapshot.asOf,
    totalBalance: snapshot.totalBalance,
    freeCash: snapshot.freeCash,
    safeToSpend: snapshot.safeToSpend,
    obligationsDueIn30Days: snapshot.obligationsDueIn30Days,
    activeEarmarkCount: snapshot.activeEarmarkCount,
    openInvoiceCount: snapshot.openInvoiceCount,
    activeEarmarks,
    dataIsStale: stale,
  };
}
