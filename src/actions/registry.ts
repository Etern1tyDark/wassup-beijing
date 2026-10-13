import type { ProposalTier } from '../domain/schemas';

/**
 * ACT-1: the fixed action registry.
 *
 * Every action the agent or the UI can name is listed here with its tier. An
 * action name that is not in this table is rejected before anything else
 * happens. The names come from the tool list in PRD Section 7 and the approval
 * object in PRD Section 6.
 */
export interface ActionDefinition {
  readonly tier: ProposalTier;
  readonly description: string;
  /** PRD requirement id this action implements. */
  readonly prdRef: string;
  /** True when an executed effect can be reverted by the `undo` action. */
  readonly reversible: boolean;
}

export const ACTION_REGISTRY = {
  get_summary: {
    tier: 'T0',
    description: 'Balances, free cash, safe-to-spend and earmark aggregates',
    prdRef: 'CHAT-1',
    reversible: false,
  },
  get_runway: {
    tier: 'T0',
    description: 'Runway in days and months with the inputs used',
    prdRef: 'FC-2',
    reversible: false,
  },
  run_scenario: {
    tier: 'T0',
    description: 'Invoice paid N days late, or a one-off expense',
    prdRef: 'FC-3',
    reversible: false,
  },
  get_spending: {
    tier: 'T0',
    description: 'Money in and out for a period, by category',
    prdRef: 'CHAT-3',
    reversible: false,
  },
  list_policies: {
    tier: 'T0',
    description: 'Policy ids and display names',
    prdRef: 'POL-1',
    reversible: false,
  },
  get_coverage: {
    tier: 'T0',
    description: 'Coverage items with clause references and worst-case out-of-pocket',
    prdRef: 'POL-2',
    reversible: false,
  },
  compare_policies: {
    tier: 'T0',
    description: 'Side-by-side comparison on user-chosen criteria, no ranking',
    prdRef: 'POL-4',
    reversible: false,
  },
  draft_reminder: {
    tier: 'T1',
    description: 'Draft an invoice reminder; nothing is sent and nothing changes',
    prdRef: 'ACT-2',
    reversible: false,
  },
  'earmark.create': {
    tier: 'T2',
    description: 'Set money aside inside the ledger, with a review date',
    prdRef: 'ACT-5',
    reversible: true,
  },
  'earmark.update': {
    tier: 'T2',
    description: 'Change the label, amount or review date of an active earmark',
    prdRef: 'ACT-5',
    reversible: true,
  },
  'earmark.delete': {
    tier: 'T2',
    description: 'Release a previously created earmark',
    prdRef: 'ACT-5',
    reversible: true,
  },
  'statement.import': {
    tier: 'T2',
    description: 'Add the rows of a statement CSV to the ledger',
    prdRef: 'ING-1',
    reversible: true,
  },
  'transaction.add': {
    tier: 'T2',
    description: 'Add one transaction typed in chat, after a confirmation card',
    prdRef: 'ING-4',
    reversible: true,
  },
  undo: {
    tier: 'T2',
    description: 'Revert the last reversible executed action, recorded as a new entry',
    prdRef: 'AUD-2',
    reversible: false,
  },
  transfer: {
    tier: 'T3',
    description: 'Move money between the user\u2019s own accounts (simulated only, behind SIM_T3)',
    prdRef: 'ACT-4',
    reversible: true,
  },
} as const satisfies Record<string, ActionDefinition>;

export type ActionName = keyof typeof ACTION_REGISTRY;

export const ACTION_NAMES = Object.keys(ACTION_REGISTRY) as ActionName[];

export function isActionName(value: string): value is ActionName {
  return Object.hasOwn(ACTION_REGISTRY, value);
}

export function lookupAction(value: string): ActionDefinition | undefined {
  return isActionName(value) ? ACTION_REGISTRY[value] : undefined;
}

/** T2 and T3 always need an explicit approval event; T0 and T1 never do. */
export function requiresApproval(tier: ProposalTier): boolean {
  return tier === 'T2' || tier === 'T3';
}
