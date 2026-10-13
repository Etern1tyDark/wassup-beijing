import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { formatRupiah, parseRupiah, toMoney } from '../domain/money';
import { SeedDatasetSchema } from '../domain/seed';
import { loadSeedData } from '../storage/bootstrap';
import type { Earmark, OutboundRequest, Proposal, ProposalDiff, Settings } from '../domain/schemas';
import type { LedgerSnapshot } from '../ledger/engine';
import type { StalenessReport } from '../actions/staleness';
import { useServices } from './services-context';
import { useAppStateContext } from './app-state-context';
import { formatTimestamp, shortHash } from './app-state';
import { groupByRisk } from '../actions/risk';
import { ChatPanel } from './ChatPanel';
import { LanguageContext, useT } from './i18n';
import { PolicyPanel, RunwayPanel, StatementImportPanel } from './DashboardPanels';
import seedFixture from '../../fixtures/seed/rina.json';
import './styles.css';

/* ------------------------------------------------------------------ helpers */

function moneyDelta(delta: { before: number; after: number } | undefined): string {
  if (!delta) return '—';
  const arrow = delta.after < delta.before ? '↓' : delta.after > delta.before ? '↑' : '=';
  return `${formatRupiah(toMoney(delta.before))} ${arrow} ${formatRupiah(toMoney(delta.after))}`;
}

function DiffTable({ diff }: { diff: ProposalDiff }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Safe to spend', value: moneyDelta(diff.safeToSpend) },
    { label: 'Free cash', value: moneyDelta(diff.freeCash) },
    {
      label: 'Runway',
      value: diff.runwayMonths ? `${diff.runwayMonths.before} → ${diff.runwayMonths.after} months` : '—',
    },
    {
      label: 'Active earmarks',
      value: diff.activeEarmarks ? `${diff.activeEarmarks.before} → ${diff.activeEarmarks.after}` : '—',
    },
  ];
  return (
    <table className="diff" data-testid="approval-diff">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One plain sentence saying what approving the card will do. */
function describeProposal(proposal: Proposal, accountNames: Record<string, string>): string {
  const params = proposal.params;
  const amount = typeof params['amount'] === 'number' ? formatRupiah(toMoney(params['amount'])) : '';
  const account = (id: unknown): string => (typeof id === 'string' ? (accountNames[id] ?? id) : '');

  switch (proposal.action) {
    case 'earmark.create':
      return `Set aside ${amount} as “${String(params['label'])}”, to be reviewed on ${String(params['reviewDate'])}. The money stays in your account.`;
    case 'earmark.update': {
      const previous = params['previous'] as
        { label: string; amount: number; reviewDate: string } | undefined;
      const changes = [
        ...(typeof params['label'] === 'string' ? [`label to “${params['label']}”`] : []),
        ...(amount ? [`amount to ${amount}`] : []),
        ...(typeof params['reviewDate'] === 'string' ? [`review date to ${params['reviewDate']}`] : []),
      ];
      return `Change the ${changes.join(' and the ')}${previous ? ` on “${previous.label}” (now ${formatRupiah(toMoney(previous.amount))}, review ${previous.reviewDate})` : ''}.`;
    }
    case 'earmark.delete':
      return 'Release this earmark, so the money counts as free cash again.';
    case 'statement.import': {
      const rows = Array.isArray(params['rows']) ? (params['rows'] as Array<{ amount: number }>) : [];
      const net = rows.reduce((total, row) => total + row.amount, 0);
      return `Add ${rows.length} row(s) from ${String(params['fileName'])} to the ledger, net ${formatRupiah(toMoney(net))}.`;
    }
    case 'transaction.add':
      return `Add “${String(params['merchant'])}”, ${amount} on ${String(params['date'])}, to ${account(params['accountId'])}.`;
    case 'transfer':
      return `Simulate moving ${amount} from ${account(params['fromAccountId'])} to ${account(params['toAccountId'])}.`;
    case 'undo':
      return 'Reverse the action named below. The original entry stays in the audit log.';
    default:
      return proposal.action;
  }
}

/* ----------------------------------------------------------- approval card */

function ApprovalCard({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const { state } = useAppStateContext();
  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const issued = await services.actions.issueApprovalToken(proposal.proposalId);
      if (!cancelled) setToken(issued.token);
    })();
    return () => {
      cancelled = true;
    };
  }, [services, proposal.proposalId, proposal.proposalHash]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      setBusy(true);
      setMessage(null);
      try {
        if (decision === 'reject') {
          const result = await services.actions.reject(proposal.proposalId);
          setMessage(result.reason);
          onChanged();
          return;
        }
        if (!token) {
          setMessage('The approval token is not ready yet.');
          return;
        }
        const approved = await services.actions.approve({
          proposalId: proposal.proposalId,
          token,
          ...(pin ? { pin } : {}),
        });
        if (approved.kind !== 'approved') {
          setMessage(approved.reason);
          return;
        }
        const executed = await services.actions.execute(proposal.proposalId);
        setMessage(executed.kind === 'executed' ? executed.detail : executed.reason);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [services, proposal.proposalId, token, pin, onChanged],
  );

  return (
    <article className="card approval" data-testid="approval-card">
      <header className="card-header">
        <h3>
          {t('approval.needed')} · {proposal.action}{' '}
          <span className={`tier tier-${proposal.tier.toLowerCase()}`}>{proposal.tier}</span>
        </h3>
        {proposal.tier === 'T3' ? <p className="simulation-label">SIMULATION - no real money moves</p> : null}
      </header>

      <p data-testid="approval-summary">{describeProposal(proposal, state.accountNames)}</p>

      <DiffTable diff={proposal.diff} />

      <ul className="guardrails" data-testid="approval-guardrails">
        {proposal.guardrails.map((rule) => (
          <li key={rule.rule} className={rule.pass ? 'pass' : 'fail'}>
            <span aria-hidden="true">{rule.pass ? '✓' : '✕'}</span> {rule.rule} — {rule.detail}
          </li>
        ))}
      </ul>

      <dl className="meta">
        <dt>Expires</dt>
        <dd>{formatTimestamp(proposal.expiresAt)}</dd>
        <dt>Proposal hash</dt>
        <dd>
          <code>{shortHash(proposal.proposalHash)}</code>
        </dd>
        <dt>Requested by</dt>
        <dd>{proposal.provenance.requestedBy}</dd>
        {proposal.provenance.untrustedInputs.length > 0 ? (
          <>
            <dt>Untrusted inputs</dt>
            <dd>
              {proposal.provenance.untrustedInputs
                .map((input) => `${input.source}:${input.ref} (${input.fields.join(', ')})`)
                .join('; ')}
            </dd>
          </>
        ) : null}
      </dl>

      {proposal.tier === 'T3' ? (
        <label className="field">
          <span>Step-up PIN</span>
          <input
            type="password"
            value={pin}
            inputMode="numeric"
            autoComplete="off"
            data-testid="approval-pin"
            onChange={(event) => setPin(event.target.value)}
          />
        </label>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="approve"
          disabled={busy || !token}
          onClick={() => void decide('approve')}
        >
          {t('approval.approve')}
        </button>
        <button type="button" data-testid="reject" disabled={busy} onClick={() => void decide('reject')}>
          {t('approval.reject')}
        </button>
      </div>

      {message ? (
        <p className="message" role="status" data-testid="approval-message">
          {message}
        </p>
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------ grouped approvals */

/**
 * Low-risk proposals share one card (PRD Section 10, approval fatigue). "Approve
 * all" presses Approve on each in turn: every one still gets its own token, its
 * own guardrail re-check and its own audit entries, and one that is refused does
 * not stop the report on the others.
 */
function LowRiskGroupCard({ proposals, onChanged }: { proposals: Proposal[]; onChanged: () => void }) {
  const services = useServices();
  const { state } = useAppStateContext();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [separate, setSeparate] = useState(false);

  if (separate) {
    return (
      <>
        {proposals.map((proposal) => (
          <ApprovalCard key={proposal.proposalId} proposal={proposal} onChanged={onChanged} />
        ))}
      </>
    );
  }

  const decideAll = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    const outcomes: string[] = [];
    try {
      for (const proposal of proposals) {
        if (decision === 'reject') {
          await services.actions.reject(proposal.proposalId);
          continue;
        }
        const issued = await services.actions.issueApprovalToken(proposal.proposalId);
        const approved = await services.actions.approve({
          proposalId: proposal.proposalId,
          token: issued.token,
        });
        if (approved.kind !== 'approved') {
          outcomes.push(`${proposal.action}: ${approved.reason}`);
          continue;
        }
        const executed = await services.actions.execute(proposal.proposalId);
        if (executed.kind !== 'executed') outcomes.push(`${proposal.action}: ${executed.reason}`);
      }
      setMessage(outcomes.length > 0 ? `Not done: ${outcomes.join('; ')}` : null);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <article className="card approval" data-testid="approval-group">
      <header className="card-header">
        <h3>
          {proposals.length} low-risk changes <span className="tier tier-t2">T2</span>
        </h3>
      </header>
      <p className="muted small">
        None of these lowers what you can spend. Each is still approved, checked and logged on its own.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Change</th>
            <th scope="col">Safe to spend</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((proposal) => (
            <tr key={proposal.proposalId} data-testid="approval-group-item">
              <td>{describeProposal(proposal, state.accountNames)}</td>
              <td>{moneyDelta(proposal.diff.safeToSpend)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="approve-group"
          disabled={busy}
          onClick={() => void decideAll('approve')}
        >
          Approve all {proposals.length}
        </button>
        <button
          type="button"
          data-testid="reject-group"
          disabled={busy}
          onClick={() => void decideAll('reject')}
        >
          Reject all
        </button>
        <button type="button" data-testid="separate-group" disabled={busy} onClick={() => setSeparate(true)}>
          Review one by one
        </button>
      </div>
      {message ? (
        <p className="warning" role="status" data-testid="approval-group-message">
          {message}
        </p>
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------- earmark form */

function EarmarkForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const [label, setLabel] = useState('Medical reserve');
  const [amount, setAmount] = useState('3000000');
  const [reviewDate, setReviewDate] = useState('2027-01-13');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const parsed = parseRupiah(amount);
      if (!parsed.ok) {
        setMessage(parsed.reason);
        return;
      }
      const result = await services.actions.propose({
        action: 'earmark.create',
        params: { label, amount: parsed.value, reviewDate },
        provenance: { requestedBy: 'ui_earmark_form', untrustedInputs: [] },
        actor: 'user',
      });
      setMessage(
        result.kind === 'proposal' ? 'Proposal created. Approve it to change the ledger.' : result.reason,
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(event) => void submit(event)} data-testid="earmark-form">
      <h3>{t('earmarks.propose')}</h3>
      <label className="field">
        <span>Label</span>
        <input value={label} data-testid="earmark-label" onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label className="field">
        <span>Amount (integer rupiah)</span>
        <input
          value={amount}
          inputMode="numeric"
          data-testid="earmark-amount"
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Review date</span>
        <input
          value={reviewDate}
          data-testid="earmark-review-date"
          onChange={(event) => setReviewDate(event.target.value)}
        />
      </label>
      <div className="actions">
        <button type="submit" className="primary" data-testid="earmark-submit" disabled={busy}>
          Propose earmark
        </button>
      </div>
      {message ? (
        <p className="message" role="status" data-testid="earmark-message">
          {message}
        </p>
      ) : null}
    </form>
  );
}

/* -------------------------------------------------------------------- panels */

function BalancesPanel({
  snapshot,
  staleness,
  accounts,
}: {
  snapshot: LedgerSnapshot;
  staleness: StalenessReport | null;
  accounts: Record<string, string>;
}) {
  const t = useT();
  const { state } = useAppStateContext();
  return (
    <section className="card" data-testid="balances">
      <h3>
        {t('balances.title')} {snapshot.asOf}
      </h3>
      {staleness?.stale ? (
        <p className="warning" data-testid="stale-banner" role="alert">
          Data is stale: {staleness.reason}
        </p>
      ) : null}
      <dl className="totals">
        <div>
          <dt>{t('balances.safeToSpend')}</dt>
          <dd data-testid="safe-to-spend">{formatRupiah(snapshot.safeToSpend)}</dd>
        </div>
        <div>
          <dt>{t('balances.total')}</dt>
          <dd data-testid="total-balance">{formatRupiah(snapshot.totalBalance)}</dd>
        </div>
        <div>
          <dt>{t('balances.freeCash')}</dt>
          <dd data-testid="free-cash">{formatRupiah(snapshot.freeCash)}</dd>
        </div>
        <div>
          <dt>{t('balances.obligations')}</dt>
          <dd data-testid="obligations-30">{formatRupiah(snapshot.obligationsDueIn30Days)}</dd>
        </div>
      </dl>
      <table className="accounts">
        <thead>
          <tr>
            <th scope="col">{t('balances.account')}</th>
            <th scope="col">{t('balances.type')}</th>
            <th scope="col">{t('balances.balance')}</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(snapshot.balancesByAccount).map(([accountId, balance]) => (
            <tr key={accountId}>
              <td>{state.accountNames[accountId] ?? accountId}</td>
              <td>{accounts[accountId] ?? '—'}</td>
              <td>{formatRupiah(balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EarmarkRow({
  earmark,
  onRelease,
  onChanged,
}: {
  earmark: Earmark;
  onRelease: () => void;
  onChanged: (message: string | null) => void;
}) {
  const services = useServices();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(earmark.amount));
  const [reviewDate, setReviewDate] = useState(earmark.reviewDate);

  const propose = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRupiah(amount);
    if (!parsed.ok) {
      onChanged(parsed.reason);
      return;
    }
    const changes = {
      ...(parsed.value !== earmark.amount ? { amount: parsed.value } : {}),
      ...(reviewDate !== earmark.reviewDate ? { reviewDate } : {}),
    };
    if (Object.keys(changes).length === 0) {
      onChanged('Nothing was changed.');
      return;
    }
    const result = await services.actions.propose({
      action: 'earmark.update',
      params: { earmarkId: earmark.id, ...changes },
      provenance: { requestedBy: 'ui_earmark_list', untrustedInputs: [] },
      actor: 'user',
    });
    setEditing(false);
    onChanged(result.kind === 'refused' ? result.reason : null);
  };

  return (
    <>
      <tr data-testid={`earmark-${earmark.id}`}>
        <td>{earmark.label}</td>
        <td>{formatRupiah(earmark.amount)}</td>
        <td>{earmark.reviewDate}</td>
        <td>{earmark.active ? 'active' : 'released'}</td>
        <td>
          {earmark.active ? (
            <div className="actions">
              <button
                type="button"
                data-testid="earmark-edit"
                onClick={() => setEditing((current) => !current)}
              >
                {editing ? 'Cancel' : 'Edit'}
              </button>
              <button type="button" onClick={onRelease}>
                Release
              </button>
            </div>
          ) : null}
        </td>
      </tr>
      {editing ? (
        <tr>
          <td colSpan={5}>
            <form className="actions" onSubmit={(event) => void propose(event)}>
              <label className="field">
                <span>New amount (integer rupiah)</span>
                <input
                  value={amount}
                  inputMode="numeric"
                  data-testid="earmark-edit-amount"
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <label className="field">
                <span>New review date</span>
                <input
                  value={reviewDate}
                  data-testid="earmark-edit-review-date"
                  onChange={(event) => setReviewDate(event.target.value)}
                />
              </label>
              <button type="submit" className="primary" data-testid="earmark-edit-submit">
                Propose change
              </button>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EarmarksPanel({
  earmarks,
  onRelease,
  onNotice,
  notice,
}: {
  earmarks: Earmark[];
  onRelease: (earmarkId: string) => void;
  onNotice: (message: string | null) => void;
  notice: string | null;
}) {
  const t = useT();
  return (
    <section className="card" data-testid="earmarks">
      <h3>{t('earmarks.title')}</h3>
      {notice ? (
        <p className="warning" role="status" data-testid="earmark-notice">
          {notice}
        </p>
      ) : null}
      {earmarks.length === 0 ? (
        <p className="muted" data-testid="no-earmarks">
          {t('earmarks.none')}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Amount</th>
              <th scope="col">Review</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {earmarks.map((earmark) => (
              <EarmarkRow
                key={`${earmark.id}-${earmark.amount}-${earmark.reviewDate}`}
                earmark={earmark}
                onRelease={() => onRelease(earmark.id)}
                onChanged={onNotice}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AuditPanel({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const { state } = useAppStateContext();
  const [verification, setVerification] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const undo = async () => {
    setNotice(null);
    const result = await services.actions.undoLast('user');
    if (result.kind === 'refused') setNotice(result.reason);
    onChanged();
  };

  const exportJson = async () => {
    const exported = await services.audit.exportJson();
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `audit-export-${state.snapshot?.asOf ?? 'ledger'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const verify = async () => {
    const result = await services.audit.verify();
    setVerification(
      result.ok
        ? `Chain OK — ${result.checked} entries verified.`
        : `Chain FAILED — ${result.errors.join('; ')}`,
    );
  };

  return (
    <section className="card" data-testid="audit-log">
      <header className="card-header">
        <h3>{t('audit.title')}</h3>
        <div className="actions">
          <button type="button" data-testid="undo" onClick={() => void undo()}>
            {t('audit.undo')}
          </button>
          <button type="button" data-testid="verify-audit" onClick={() => void verify()}>
            {t('audit.verify')}
          </button>
          <button type="button" data-testid="export-audit" onClick={() => void exportJson()}>
            {t('audit.export')}
          </button>
        </div>
      </header>

      {verification ? (
        <p className="message" role="status" data-testid="audit-verification">
          {verification}
        </p>
      ) : null}

      {notice ? (
        <p className="warning" role="status" data-testid="audit-notice">
          {notice}
        </p>
      ) : null}

      {state.audit.length === 0 ? (
        <p className="muted" data-testid="audit-empty">
          No entries yet.
        </p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Event</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {state.audit.map((entry) => (
                <tr key={entry.id} data-testid={`audit-${entry.event}`}>
                  <td>{entry.seq}</td>
                  <td>{formatTimestamp(entry.time)}</td>
                  <td>{entry.actor}</td>
                  <td>
                    <span className={`event event-${entry.event}`}>{entry.event}</span>
                  </td>
                  <td>{entry.action ?? '—'}</td>
                  <td>{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PrivacyPanel({ outbound, onChanged }: { outbound: OutboundRequest[]; onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    services.gate.setBlockDecider(
      blocking ? () => ({ block: true, reason: 'the user turned outbound requests off' }) : null,
    );
  }, [services, blocking]);

  const probe = async () => {
    await services.gate.send({
      purpose: 'privacy.probe',
      payload: { note: 'manual probe from the privacy panel' },
    });
    onChanged();
  };

  return (
    <section className="card" data-testid="privacy-panel">
      <header className="card-header">
        <h3>{t('privacy.title')}</h3>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={blocking}
              data-testid="block-outbound"
              onChange={(event) => setBlocking(event.target.checked)}
            />
            <span>{t('privacy.block')}</span>
          </label>
          <button type="button" data-testid="probe-outbound" onClick={() => void probe()}>
            Send probe
          </button>
        </div>
      </header>
      {outbound.length === 0 ? (
        <p className="muted" data-testid="privacy-empty">
          {t('privacy.empty')}
        </p>
      ) : (
        <ul className="outbound scroll">
          {outbound.map((request) => (
            <li key={request.id} data-testid="outbound-request">
              <strong>{request.purpose}</strong> · {formatTimestamp(request.time)} ·{' '}
              <span className={`event event-${request.status}`}>{request.status}</span>
              {request.blockReason ? <span className="muted"> · {request.blockReason}</span> : null}
              {request.redactions.length > 0 ? (
                <div className="redactions" data-testid="outbound-redactions">
                  removed before sending:{' '}
                  {request.redactions.map((item) => `${item.kind} (${item.value})`).join(', ')}
                </div>
              ) : null}
              {/* PRV-1: the payload exactly as it left the browser, after redaction. */}
              <details>
                <summary>What was sent</summary>
                <pre className="payload" data-testid="outbound-payload">
                  {JSON.stringify(request.payload, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SettingsPanel({ settings, onChanged }: { settings: Settings | null; onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const [pin, setPin] = useState('');
  const [cap, setCap] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    const parsed = parseRupiah(cap);
    if (!parsed.ok) {
      setMessage(parsed.reason);
      return;
    }
    const result = await services.settings.update({ perActionCap: parsed.value }, pin);
    setMessage(result.ok ? 'Limits updated.' : result.reason);
    onChanged();
  };

  const toggleSimulation = async () => {
    const next = !(settings?.featureFlags.simT3 ?? false);
    const result = await services.settings.update({ featureFlags: { simT3: next } }, pin);
    setMessage(result.ok ? `Simulated transfers ${next ? 'enabled' : 'disabled'}.` : result.reason);
    onChanged();
  };

  return (
    <section className="card" data-testid="settings-panel">
      <h3>{t('settings.title')}</h3>
      <p className="muted">
        Limits and feature flags change only here. No action, tool call or chat message can reach them (ST6).
      </p>
      <form onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>App PIN</span>
          <input
            type="password"
            value={pin}
            inputMode="numeric"
            autoComplete="off"
            data-testid="settings-pin"
            onChange={(event) => setPin(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Per-action cap</span>
          <input
            value={cap}
            inputMode="numeric"
            placeholder={String(settings?.perActionCap ?? '')}
            data-testid="settings-cap"
            onChange={(event) => setCap(event.target.value)}
          />
        </label>
        <div className="actions">
          <button type="submit" data-testid="settings-save">
            Save limits
          </button>
          <button type="button" data-testid="settings-toggle-simt3" onClick={() => void toggleSimulation()}>
            {settings?.featureFlags.simT3 ? 'Disable' : 'Enable'} simulated T3
          </button>
        </div>
      </form>
      {message ? (
        <p className="message" role="status" data-testid="settings-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- app shell */

export function App() {
  const t = useT();
  const services = useServices();
  const { state, reload, loading } = useAppStateContext();
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const [earmarkNotice, setEarmarkNotice] = useState<string | null>(null);
  const [conversation, setConversation] = useState(0);
  const pendingGroups = groupByRisk(state.pending);
  const { language, setLanguage } = useContext(LanguageContext);

  const loadSeed = async () => {
    setLoadNotice(null);
    try {
      const dataset = SeedDatasetSchema.parse(seedFixture);
      await loadSeedData(services.db, dataset);
      services.clock.anchorTo(dataset.asOf);
      // A reset wipes the ledger, so the conversation about it is dropped too.
      services.orchestrator.reset();
      services.gate.setRedactorConfig({ names: [], accountNumbers: [], policyNumbers: [] });
      setConversation((current) => current + 1);
      reload();
    } catch (error) {
      setLoadNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const releaseEarmark = async (earmarkId: string) => {
    setEarmarkNotice(null);
    const result = await services.actions.propose({
      action: 'earmark.delete',
      params: { earmarkId },
      provenance: { requestedBy: 'ui_earmark_list', untrustedInputs: [] },
      actor: 'user',
    });
    if (result.kind === 'refused') setEarmarkNotice(result.reason);
    reload();
  };

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t('app.title')}</h1>
          <p className="muted">{t('app.tagline')}</p>
        </div>
        <div className="actions">
          <button type="button" className="primary" data-testid="load-seed" onClick={() => void loadSeed()}>
            {state.loaded ? t('app.resetSeed') : t('app.loadSeed')}
          </button>
          <button
            type="button"
            data-testid="language-toggle"
            onClick={() => setLanguage(language === 'en' ? 'id' : 'en')}
          >
            {t('app.language')}
          </button>
        </div>
      </header>

      {loadNotice ? (
        <p className="warning" role="alert" data-testid="load-notice">
          {loadNotice}
        </p>
      ) : null}

      {!state.loaded ? (
        <section className="card empty-state" data-testid="empty-state">
          <h2>{t('app.emptyTitle')}</h2>
          <p>{t('app.emptyBody')}</p>
        </section>
      ) : (
        <>
          {/* DASH-1: runway, policy coverage and the audit log on one screen. */}
          <div className="dashboard">
            <div className="column">
              {state.snapshot ? (
                <BalancesPanel
                  snapshot={state.snapshot}
                  staleness={state.staleness}
                  accounts={state.accountTypes}
                />
              ) : null}
              {state.forecast ? <RunwayPanel view={state.forecast} /> : null}
            </div>

            <div className="column">
              {/* Approvals sit above the chat, so a new card is never below the fold. */}
              <section data-testid="approvals" aria-label="Approvals">
                {state.pending.length > 0 ? (
                  <div className="pending" data-testid="pending-list">
                    {pendingGroups.individual.map((proposal) => (
                      <ApprovalCard key={proposal.proposalId} proposal={proposal} onChanged={reload} />
                    ))}
                    {pendingGroups.lowRisk.length > 0 ? (
                      <LowRiskGroupCard
                        key={pendingGroups.lowRisk.map((proposal) => proposal.proposalId).join('+')}
                        proposals={pendingGroups.lowRisk}
                        onChanged={reload}
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="card muted" data-testid="no-pending">
                    {t('approval.none')}
                  </div>
                )}
              </section>
              <ChatPanel key={conversation} onChanged={reload} />
            </div>

            <div className="column">
              {state.snapshot ? (
                <PolicyPanel policies={state.policies} snapshot={state.snapshot} onChanged={reload} />
              ) : null}
              <AuditPanel onChanged={reload} />
            </div>
          </div>

          <div className="grid">
            <StatementImportPanel onChanged={reload} />
            <EarmarkForm onChanged={reload} />
            <EarmarksPanel
              earmarks={state.earmarks}
              notice={earmarkNotice}
              onNotice={(message) => {
                setEarmarkNotice(message);
                reload();
              }}
              onRelease={(id) => void releaseEarmark(id)}
            />
          </div>

          <div className="grid">
            <PrivacyPanel outbound={state.outbound} onChanged={reload} />
            <SettingsPanel settings={state.settings} onChanged={reload} />
          </div>
        </>
      )}

      {loading ? <p className="muted">Loading…</p> : null}
    </main>
  );
}
