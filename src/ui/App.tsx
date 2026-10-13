import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatRupiah, parseRupiah, toMoney } from '../domain/money';
import { SeedDatasetSchema } from '../domain/seed';
import { loadSeedData } from '../storage/bootstrap';
import type { Earmark, OutboundRequest, Proposal, ProposalDiff, Settings } from '../domain/schemas';
import type { LedgerSnapshot } from '../ledger/engine';
import type { StalenessReport } from '../actions/staleness';
import { useServices } from './services-context';
import { useAppStateContext } from './app-state-context';
import { formatTimestamp, shortHash } from './app-state';
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

/* ----------------------------------------------------------- approval card */

function ApprovalCard({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const services = useServices();
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
          Approval needed · {proposal.action}{' '}
          <span className={`tier tier-${proposal.tier.toLowerCase()}`}>{proposal.tier}</span>
        </h3>
        {proposal.tier === 'T3' ? <p className="simulation-label">SIMULATION - no real money moves</p> : null}
      </header>

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
          Approve
        </button>
        <button type="button" data-testid="reject" disabled={busy} onClick={() => void decide('reject')}>
          Reject
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

/* ------------------------------------------------------------- earmark form */

function EarmarkForm({ onChanged }: { onChanged: () => void }) {
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
      <h3>Propose an earmark</h3>
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
  return (
    <section className="card" data-testid="balances">
      <h3>Balances · as of {snapshot.asOf}</h3>
      {staleness?.stale ? (
        <p className="warning" data-testid="stale-banner" role="alert">
          Data is stale: {staleness.reason}
        </p>
      ) : null}
      <dl className="totals">
        <div>
          <dt>Safe to spend</dt>
          <dd data-testid="safe-to-spend">{formatRupiah(snapshot.safeToSpend)}</dd>
        </div>
        <div>
          <dt>Total balance</dt>
          <dd data-testid="total-balance">{formatRupiah(snapshot.totalBalance)}</dd>
        </div>
        <div>
          <dt>Free cash</dt>
          <dd data-testid="free-cash">{formatRupiah(snapshot.freeCash)}</dd>
        </div>
        <div>
          <dt>Obligations due in 30 days</dt>
          <dd data-testid="obligations-30">{formatRupiah(snapshot.obligationsDueIn30Days)}</dd>
        </div>
      </dl>
      <table className="accounts">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Type</th>
            <th scope="col">Balance</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(snapshot.balancesByAccount).map(([accountId, balance]) => (
            <tr key={accountId}>
              <td>{accountId}</td>
              <td>{accounts[accountId] ?? '—'}</td>
              <td>{formatRupiah(balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EarmarksPanel({
  earmarks,
  onRelease,
  notice,
}: {
  earmarks: Earmark[];
  onRelease: (earmarkId: string) => void;
  notice: string | null;
}) {
  return (
    <section className="card" data-testid="earmarks">
      <h3>Earmarks</h3>
      {notice ? (
        <p className="warning" role="status" data-testid="earmark-notice">
          {notice}
        </p>
      ) : null}
      {earmarks.length === 0 ? (
        <p className="muted" data-testid="no-earmarks">
          Nothing set aside yet.
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
              <tr key={earmark.id} data-testid={`earmark-${earmark.id}`}>
                <td>{earmark.label}</td>
                <td>{formatRupiah(earmark.amount)}</td>
                <td>{earmark.reviewDate}</td>
                <td>{earmark.active ? 'active' : 'released'}</td>
                <td>
                  {earmark.active ? (
                    <button type="button" onClick={() => onRelease(earmark.id)}>
                      Release
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AuditPanel({ onChanged }: { onChanged: () => void }) {
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
        <h3>Audit log</h3>
        <div className="actions">
          <button type="button" data-testid="undo" onClick={() => void undo()}>
            Undo last action
          </button>
          <button type="button" data-testid="verify-audit" onClick={() => void verify()}>
            Verify chain
          </button>
          <button type="button" data-testid="export-audit" onClick={() => void exportJson()}>
            Export JSON
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
      )}
    </section>
  );
}

function PrivacyPanel({ outbound, onChanged }: { outbound: OutboundRequest[]; onChanged: () => void }) {
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
        <h3>Privacy · outbound requests</h3>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={blocking}
              data-testid="block-outbound"
              onChange={(event) => setBlocking(event.target.checked)}
            />
            <span>Block outbound requests</span>
          </label>
          <button type="button" data-testid="probe-outbound" onClick={() => void probe()}>
            Send probe
          </button>
        </div>
      </header>
      {outbound.length === 0 ? (
        <p className="muted" data-testid="privacy-empty">
          Nothing has left this browser.
        </p>
      ) : (
        <ul className="outbound">
          {outbound.map((request) => (
            <li key={request.id}>
              <strong>{request.purpose}</strong> · {formatTimestamp(request.time)} ·{' '}
              <span className={`event event-${request.status}`}>{request.status}</span>
              {request.redactions.length > 0 ? (
                <div className="redactions">
                  redacted: {request.redactions.map((item) => item.kind).join(', ')}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SettingsPanel({ settings, onChanged }: { settings: Settings | null; onChanged: () => void }) {
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
      <h3>Settings (PIN required)</h3>
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
  const services = useServices();
  const { state, reload, loading } = useAppStateContext();
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const [earmarkNotice, setEarmarkNotice] = useState<string | null>(null);

  const loadSeed = async () => {
    setLoadNotice(null);
    try {
      const dataset = SeedDatasetSchema.parse(seedFixture);
      await loadSeedData(services.db, dataset);
      services.clock.anchorTo(dataset.asOf);
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
          <h1>Permissioned personal-finance agent</h1>
          <p className="muted">
            Local-first demo · every action needs approval · every action is logged · no real money moves
          </p>
        </div>
        <div className="actions">
          <button type="button" className="primary" data-testid="load-seed" onClick={() => void loadSeed()}>
            {state.loaded ? 'Reset to seed data' : 'Load seed data'}
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
          <h2>No ledger yet</h2>
          <p>Load the seeded data for the demo persona to see balances, earmarks and the audit log.</p>
        </section>
      ) : (
        <>
          {state.snapshot ? (
            <BalancesPanel
              snapshot={state.snapshot}
              staleness={state.staleness}
              accounts={state.accountTypes}
            />
          ) : null}

          <div className="grid">
            <EarmarkForm onChanged={reload} />
            <EarmarksPanel
              earmarks={state.earmarks}
              notice={earmarkNotice}
              onRelease={(id) => void releaseEarmark(id)}
            />
          </div>

          {state.pending.length > 0 ? (
            <div className="pending" data-testid="pending-list">
              {state.pending.map((proposal) => (
                <ApprovalCard key={proposal.proposalId} proposal={proposal} onChanged={reload} />
              ))}
            </div>
          ) : (
            <section className="card muted" data-testid="no-pending">
              No proposals are waiting for approval.
            </section>
          )}

          <AuditPanel onChanged={reload} />

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
