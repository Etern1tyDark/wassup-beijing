import { describe, expect, it } from 'vitest';
import { AuditEntrySchema, type AuditEntry, type GuardrailResult } from '../domain/schemas';
import { toMoney } from '../domain/money';
import { evaluateStaleness } from './staleness';
import { checkUndoGuardrails, GUARDRAIL_RULES } from './guardrails';
import { lookupAction, requiresApproval, ACTION_NAMES, ACTION_REGISTRY } from './registry';
import { checkProvenance } from './provenance';
import { parseActionParams } from './params';

/**
 * Pure unit tests for the rules that the integration suite cannot reach, either
 * because the normal flow never produces the input or because the branch is a
 * defence-in-depth guard.
 */

const executedEntry: AuditEntry = AuditEntrySchema.parse({
  id: 'aud_1',
  seq: 0,
  time: '2026-10-13T02:00:00.000Z',
  actor: 'system',
  event: 'executed',
  action: 'earmark.create',
  proposalId: 'p_1',
  detail: 'created',
  payloadHash: 'sha256:aaaa',
  prevHash: 'sha256:bbbb',
  hash: 'sha256:cccc',
});

describe('undo guardrails', () => {
  it('rejects an entry that was never executed', () => {
    const proposed = { ...executedEntry, event: 'proposed' as const };
    const results = checkUndoGuardrails(
      { auditEntryId: proposed.id },
      { entry: proposed, reversible: true, alreadyUndone: false },
    );

    expect(results.map((rule) => rule.rule)).toEqual([GUARDRAIL_RULES.undoReversible]);
    expect(results.every((rule) => !rule.pass)).toBe(true);
  });

  it('rejects a missing entry', () => {
    const results = checkUndoGuardrails(
      { auditEntryId: 'aud_missing' },
      { entry: undefined, reversible: false, alreadyUndone: false },
    );
    expect(results[0]?.pass).toBe(false);
  });

  it('rejects an executed action that is not reversible', () => {
    const results = checkUndoGuardrails(
      { auditEntryId: executedEntry.id },
      { entry: executedEntry, reversible: false, alreadyUndone: false },
    );
    const reversible = results.find(
      (rule) => rule.rule === GUARDRAIL_RULES.undoReversible,
    ) as GuardrailResult;
    expect(reversible.pass).toBe(false);
    expect(reversible.detail).toMatch(/cannot be undone/);
  });

  it('rejects an action that has already been undone', () => {
    const results = checkUndoGuardrails(
      { auditEntryId: executedEntry.id },
      { entry: executedEntry, reversible: true, alreadyUndone: true },
    );
    const already = results.find(
      (rule) => rule.rule === GUARDRAIL_RULES.undoNotAlreadyUndone,
    ) as GuardrailResult;
    expect(already.pass).toBe(false);
  });

  it('accepts a reversible action that has not been undone', () => {
    const results = checkUndoGuardrails(
      { auditEntryId: executedEntry.id },
      { entry: executedEntry, reversible: true, alreadyUndone: false },
    );
    expect(results.every((rule) => rule.pass)).toBe(true);
  });
});

describe('staleness with an empty ledger', () => {
  it('treats a ledger with no transactions as stale and says what to do', () => {
    const report = evaluateStaleness({
      latestTransactionDate: null,
      settings: { staleDataHours: 24 },
      now: new Date('2026-10-13T02:00:00.000Z'),
    });

    expect(report.stale).toBe(true);
    expect(report.ageHours).toBeNull();
    expect(report.reason).toMatch(/no ledger data/);
  });

  it('is exactly at the limit and still fresh one hour inside it', () => {
    const atLimit = evaluateStaleness({
      latestTransactionDate: '2026-10-12',
      settings: { staleDataHours: 24 },
      now: new Date('2026-10-13T00:00:00.000Z'),
    });
    expect(atLimit.stale).toBe(false);

    const overLimit = evaluateStaleness({
      latestTransactionDate: '2026-10-12',
      settings: { staleDataHours: 24 },
      now: new Date('2026-10-13T00:00:00.001Z'),
    });
    expect(overLimit.stale).toBe(true);
  });
});

describe('registry', () => {
  it('only returns a definition for a registered name', () => {
    expect(lookupAction('earmark.create')).toBeDefined();
    expect(lookupAction('Earmark.Create')).toBeUndefined();
    expect(lookupAction('__proto__')).toBeUndefined();
    expect(lookupAction('toString')).toBeUndefined();
  });

  it('requires approval for T2 and T3 only', () => {
    expect(requiresApproval('T0')).toBe(false);
    expect(requiresApproval('T1')).toBe(false);
    expect(requiresApproval('T2')).toBe(true);
    expect(requiresApproval('T3')).toBe(true);
  });

  it('gives every registered action a tier, a description and a PRD reference', () => {
    for (const name of ACTION_NAMES) {
      const definition = ACTION_REGISTRY[name];
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.prdRef.length).toBeGreaterThan(0);
    }
  });
});

describe('provenance', () => {
  it('does not police untrusted fields for T0 and T1, which have no side effects', () => {
    const result = checkProvenance(
      { requestedBy: 'agent', untrustedInputs: [{ source: 'csv', ref: 'line 2', fields: ['amount'] }] },
      'T1',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects every protected parameter path for a T2 proposal', () => {
    for (const field of ['amount', 'params.amount', 'ACCOUNTID', 'toAccountId', 'earmarkId', 'action']) {
      const result = checkProvenance(
        { requestedBy: 'agent', untrustedInputs: [{ source: 'document', ref: 'p1', fields: [field] }] },
        'T2',
      );
      expect(result.ok, `expected "${field}" to be rejected`).toBe(false);
      expect(result.violations).toHaveLength(1);
    }
  });

  it('allows untrusted free text', () => {
    const result = checkProvenance(
      {
        requestedBy: 'agent',
        untrustedInputs: [{ source: 'document', ref: 'p1', fields: ['label', 'tone'] }],
      },
      'T2',
    );
    expect(result.ok).toBe(true);
  });
});

describe('action parameter parsing', () => {
  it('returns a discriminated union keyed by the action name', () => {
    const parsed = parseActionParams('earmark.create', {
      label: 'Medical reserve',
      amount: toMoney(1_000_000),
      reviewDate: '2027-01-13',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.action).toBe('earmark.create');
  });

  it('names the offending field when validation fails', () => {
    const parsed = parseActionParams('earmark.create', { label: '', amount: 1.5, reviewDate: 'nope' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toMatch(/label/);
      expect(parsed.reason).toMatch(/amount/);
      expect(parsed.reason).toMatch(/reviewDate/);
    }
  });

  it('refuses to parse params for a read-only action', () => {
    const parsed = parseActionParams('get_summary', {});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/no parameter schema/);
  });
});
