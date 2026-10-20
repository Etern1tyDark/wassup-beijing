import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { formatRupiah, parseRupiah, toMoney } from '../domain/money';
import { SeedDatasetSchema } from '../domain/seed';
import { loadSeedData } from '../storage/bootstrap';
import type {
  AuditEntry,
  Earmark,
  OutboundRequest,
  Proposal,
  ProposalDiff,
  Settings,
} from '../domain/schemas';
import type { LedgerSnapshot } from '../ledger/engine';
import type { StalenessReport } from '../actions/staleness';
import { useServices } from './services-context';
import { useAppStateContext } from './app-state-context';
import { formatTimestamp, shortHash } from './app-state';
import { groupByRisk } from '../actions/risk';
import { looksLikeInjection } from '../importers/injection';
import { ChatPanel } from './ChatPanel';
import { LanguageContext, useT, type StringKey } from './i18n';
import { PolicyPanel, RunwayPanel, StatementImportPanel } from './DashboardPanels';
import { Icon, type IconName } from './icons';
import { useTheme } from './theme';
import { CardTitle } from './ui-kit';
import seedFixture from '../../fixtures/seed/rina.json';
import './styles.css';

/* ------------------------------------------------------------------ helpers */

function moneyDelta(delta: { before: number; after: number } | undefined): string {
  if (!delta) return '—';
  const arrow = delta.after < delta.before ? '↓' : delta.after > delta.before ? '↑' : '=';
  return `${formatRupiah(toMoney(delta.before))} ${arrow} ${formatRupiah(toMoney(delta.after))}`;
}

type Delta = { before: number; after: number } | undefined;

function direction(delta: Delta): 'down' | 'up' | 'same' {
  if (!delta || delta.after === delta.before) return 'same';
  return delta.after < delta.before ? 'down' : 'up';
}

/** Before and after, side by side, so the effect of approving is read at a glance. */
function DiffTable({ diff }: { diff: ProposalDiff }) {
  const money = (value: number): string => formatRupiah(toMoney(value));
  const rows: Array<{ label: string; delta: Delta; format: (value: number) => string }> = [
    { label: 'Safe to spend', delta: diff.safeToSpend, format: money },
    { label: 'Free cash', delta: diff.freeCash, format: money },
    { label: 'Runway', delta: diff.runwayMonths, format: (value) => `${value} months` },
    { label: 'Active earmarks', delta: diff.activeEarmarks, format: String },
  ];
  return (
    <table className="diff diff-compare" data-testid="approval-diff">
      <thead>
        <tr>
          <th scope="col">
            <span className="visually-hidden">Measure</span>
          </th>
          <th scope="col">Now</th>
          <th scope="col">After approval</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            {row.delta ? (
              <>
                <td>{row.format(row.delta.before)}</td>
                <td className={`delta delta-${direction(row.delta)}`}>
                  <span aria-hidden="true" className="delta-arrow">
                    {direction(row.delta) === 'down' ? '↓' : direction(row.delta) === 'up' ? '↑' : '='}
                  </span>{' '}
                  {row.format(row.delta.after)}
                </td>
              </>
            ) : (
              <td colSpan={2} className="muted">
                —
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One plain sentence saying what approving the card will do. */
function describeProposal(
  proposal: Proposal,
  accountNames: Record<string, string>,
  audit: readonly AuditEntry[] = [],
): string {
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
    case 'undo': {
      const original = audit.find((entry) => entry.id === params['auditEntryId']);
      const what = original
        ? `“${original.detail}” (${original.action ?? 'action'})`
        : 'the action named below';
      return `Reverse ${what}. The original entry stays in the audit log.`;
    }
    default:
      return proposal.action;
  }
}

/* ----------------------------------------------------------- approval card */

/** Cards present when the page first renders are not "new", so they do not pull the page around. */
const PAGE_LOADED_AT = Date.now();

/**
 * A card made from the chat is added above it, out of view. Bring it into view
 * and move focus to it, so the before-and-after is what the user reads next.
 */
function useRevealWhenNew<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (Date.now() - PAGE_LOADED_AT < 1500) return;
    const element = ref.current;
    element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    element?.focus?.({ preventScroll: true });
  }, []);
  return ref;
}

function ApprovalCard({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const t = useT();
  const services = useServices();
  const { state } = useAppStateContext();
  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cardRef = useRevealWhenNew<HTMLElement>();
  const flaggedRows =
    proposal.action === 'statement.import' && Array.isArray(proposal.params['rows'])
      ? (proposal.params['rows'] as Array<{ line: number; description: string }>).filter((row) =>
          looksLikeInjection(row.description),
        )
      : [];

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
    <article className="card approval" data-testid="approval-card" ref={cardRef} tabIndex={-1}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden="true">
          <Icon name="shield" />
        </span>
        <div className="approval-title">
          <span className="eyebrow">{t('approval.needed')}</span>
          <h3>
            <code className="action-name">{proposal.action}</code>{' '}
            <span className={`tier tier-${proposal.tier.toLowerCase()}`}>{proposal.tier}</span>
          </h3>
        </div>
        {proposal.tier === 'T3' ? <p className="simulation-label">SIMULATION - no real money moves</p> : null}
      </header>

      <p className="approval-summary" data-testid="approval-summary">
        {describeProposal(proposal, state.accountNames, state.audit)}
      </p>

      {flaggedRows.length > 0 ? (
        <p className="warning" role="alert" data-testid="approval-untrusted">
          Line {flaggedRows.map((row) => row.line).join(', ')} of this file reads like an instruction (“
          {flaggedRows[0]!.description}”). It will be stored as text only and cannot change this action, the
          amount or the account. Read the rows before you approve.
        </p>
      ) : null}

      <DiffTable diff={proposal.diff} />

      <ul className="guardrails" data-testid="approval-guardrails">
        {proposal.guardrails.map((rule) => (
          <li key={rule.rule} className={rule.pass ? 'pass' : 'fail'}>
            <span className="guardrail-mark" aria-hidden="true">
              <Icon name={rule.pass ? 'check' : 'x'} size={14} />
            </span>
            <span>
              <code>{rule.rule}</code> — {rule.detail}
            </span>
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

      <div className="actions approval-actions">
        <button
          type="button"
          className="primary"
          data-testid="approve"
          disabled={busy || !token}
          onClick={() => void decide('approve')}
        >
          <Icon name="check" size={16} />
          {t('approval.approve')}
        </button>
        <button
          type="button"
          className="ghost-danger"
          data-testid="reject"
          disabled={busy}
          onClick={() => void decide('reject')}
        >
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
      <header className="approval-head">
        <span className="approval-icon" aria-hidden="true">
          <Icon name="check" />
        </span>
        <div className="approval-title">
          <span className="eyebrow">Grouped</span>
          <h3>
            {proposals.length} low-risk changes <span className="tier tier-t2">T2</span>
          </h3>
        </div>
      </header>
      <p className="muted small">
        None of these lowers what you can spend. Each is still approved, checked and logged on its own.
      </p>
      <table className="group-table">
        <thead>
          <tr>
            <th scope="col">Change</th>
            <th scope="col">Safe to spend</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((proposal) => (
            <tr key={proposal.proposalId} data-testid="approval-group-item">
              <td>{describeProposal(proposal, state.accountNames, state.audit)}</td>
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
      <CardTitle icon="plus" title={t('earmarks.propose')} sub="Money set aside stays in your account." />
      <div className="field-row">
        <label className="field">
          <span>Label</span>
          <input
            value={label}
            data-testid="earmark-label"
            onChange={(event) => setLabel(event.target.value)}
          />
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
      </div>
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

/** The four headline figures as tiles. Safe to spend leads: it is the number the rest explain. */
function BalancesPanel({
  snapshot,
  staleness,
}: {
  snapshot: LedgerSnapshot;
  staleness: StalenessReport | null;
}) {
  const t = useT();
  const share = (part: number): number =>
    snapshot.totalBalance > 0
      ? Math.max(0, Math.min(100, Math.round((part / snapshot.totalBalance) * 100)))
      : 0;
  const tiles: Array<{
    key: string;
    label: string;
    value: number;
    testId: string;
    icon: IconName;
    note: string;
  }> = [
    {
      key: 'total',
      label: t('balances.total'),
      value: snapshot.totalBalance,
      testId: 'total-balance',
      icon: 'wallet',
      note: `${Object.keys(snapshot.balancesByAccount).length} account(s)`,
    },
    {
      key: 'free',
      label: t('balances.freeCash'),
      value: snapshot.freeCash,
      testId: 'free-cash',
      icon: 'sparkle',
      note: `${share(snapshot.freeCash)}% of the total is not set aside`,
    },
    {
      key: 'obligations',
      label: t('balances.obligations'),
      value: snapshot.obligationsDueIn30Days,
      testId: 'obligations-30',
      icon: 'log',
      note: 'Bills and recurring costs',
    },
  ];
  return (
    <section className="balances" data-testid="balances" aria-labelledby="balances-title">
      <h3 id="balances-title" className="visually-hidden">
        {t('balances.title')} {snapshot.asOf}
      </h3>
      {staleness?.stale ? (
        <p className="warning" data-testid="stale-banner" role="alert">
          <Icon name="alert" size={16} /> Data is stale: {staleness.reason}
        </p>
      ) : null}
      <dl className="kpis">
        <div className="kpi kpi-hero">
          <dt>
            <Icon name="shield" size={16} /> {t('balances.safeToSpend')}
          </dt>
          <dd data-testid="safe-to-spend">{formatRupiah(snapshot.safeToSpend)}</dd>
          <p className="kpi-note">After earmarks and what is due in the next 30 days</p>
          <div className="kpi-meter" aria-hidden="true">
            <span style={{ width: `${share(snapshot.safeToSpend)}%` }} />
          </div>
        </div>
        {tiles.map((tile) => (
          <div className="kpi" key={tile.key}>
            <dt>
              <Icon name={tile.icon} size={16} /> {tile.label}
            </dt>
            <dd data-testid={tile.testId}>{formatRupiah(toMoney(tile.value))}</dd>
            <p className="kpi-note">{tile.note}</p>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AccountsPanel({
  snapshot,
  accounts,
}: {
  snapshot: LedgerSnapshot;
  accounts: Record<string, string>;
}) {
  const t = useT();
  const { state } = useAppStateContext();
  const entries = Object.entries(snapshot.balancesByAccount);
  const largest = Math.max(1, ...entries.map(([, balance]) => Math.abs(balance)));
  return (
    <section className="card" data-testid="accounts">
      <CardTitle icon="wallet" title={t('accounts.title')} sub={`${t('app.asOf')} ${snapshot.asOf}`} />
      <table className="accounts">
        <thead>
          <tr>
            <th scope="col">{t('balances.account')}</th>
            <th scope="col">{t('balances.type')}</th>
            <th scope="col" className="num">
              {t('balances.balance')}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([accountId, balance]) => (
            <tr key={accountId}>
              <td>
                <span className="account-name">{state.accountNames[accountId] ?? accountId}</span>
                <span className="bar" aria-hidden="true">
                  <span
                    className={balance < 0 ? 'bar-negative' : undefined}
                    style={{ width: `${Math.round((Math.abs(balance) / largest) * 100)}%` }}
                  />
                </span>
              </td>
              <td>
                <span className="pill">{accounts[accountId] ?? '—'}</span>
              </td>
              <td className="num">{formatRupiah(balance)}</td>
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
        <td className="strong">{earmark.label}</td>
        <td className="num">{formatRupiah(earmark.amount)}</td>
        <td>{earmark.reviewDate}</td>
        <td>
          <span className={`pill ${earmark.active ? 'pill-good' : ''}`}>
            {earmark.active ? 'active' : 'released'}
          </span>
        </td>
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
            <form className="actions inline-form" onSubmit={(event) => void propose(event)}>
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
      <CardTitle
        icon="wallet"
        title={t('earmarks.title')}
        sub={`${earmarks.filter((earmark) => earmark.active).length} active`}
      />
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
              <th scope="col" className="num">
                Amount
              </th>
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
      <CardTitle icon="log" title={t('audit.title')} sub={`${state.audit.length} entries, hash-chained`}>
        <button type="button" data-testid="undo" onClick={() => void undo()}>
          <Icon name="undo" size={16} />
          {t('audit.undo')}
        </button>
        <button type="button" data-testid="verify-audit" onClick={() => void verify()}>
          <Icon name="link" size={16} />
          {t('audit.verify')}
        </button>
        <button type="button" data-testid="export-audit" onClick={() => void exportJson()}>
          <Icon name="download" size={16} />
          {t('audit.export')}
        </button>
      </CardTitle>

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
        <div className="scroll scroll-tall">
          <table className="audit-table">
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
                  <td className="num muted">{entry.seq}</td>
                  <td className="nowrap muted">{formatTimestamp(entry.time)}</td>
                  <td>{entry.actor}</td>
                  <td>
                    <span className={`event event-${entry.event}`}>{entry.event}</span>
                  </td>
                  <td>{entry.action ? <code>{entry.action}</code> : '—'}</td>
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
      <CardTitle icon="eye" title={t('privacy.title')} sub={`${outbound.length} request(s) logged`}>
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
      </CardTitle>
      {outbound.length === 0 ? (
        <p className="muted" data-testid="privacy-empty">
          {t('privacy.empty')}
        </p>
      ) : (
        <ul className="outbound scroll">
          {outbound.map((request) => (
            <li key={request.id} data-testid="outbound-request">
              <div className="outbound-head">
                <code className="strong">{request.purpose}</code>
                <span className={`event event-${request.status}`}>{request.status}</span>
                <span className="muted small">{formatTimestamp(request.time)}</span>
              </div>
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
      <CardTitle
        icon="settings"
        title={t('settings.title')}
        sub="Limits and feature flags change only here. No action, tool call or chat message can reach them (ST6)."
      />
      <div className="settings-flags">
        <span className="muted small">Per-action cap</span>
        <strong>{settings ? formatRupiah(settings.perActionCap) : '—'}</strong>
        <span className="muted small">Simulated T3</span>
        <span className={`pill ${settings?.featureFlags.simT3 ? 'pill-warn' : ''}`}>
          {settings?.featureFlags.simT3 ? 'on' : 'off'}
        </span>
      </div>
      <form onSubmit={(event) => void save(event)}>
        <div className="field-row">
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
        </div>
        <div className="actions">
          <button type="submit" className="primary" data-testid="settings-save">
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

type SectionId = 'overview' | 'assistant' | 'coverage' | 'money' | 'trust';

const SECTIONS: Array<{ id: SectionId; icon: IconName; label: StringKey; sub: StringKey }> = [
  { id: 'overview', icon: 'overview', label: 'nav.overview', sub: 'section.overviewSub' },
  { id: 'assistant', icon: 'chat', label: 'nav.assistant', sub: 'section.assistantSub' },
  { id: 'coverage', icon: 'shield', label: 'nav.coverage', sub: 'section.coverageSub' },
  { id: 'money', icon: 'wallet', label: 'nav.money', sub: 'section.moneySub' },
  { id: 'trust', icon: 'lock', label: 'nav.trust', sub: 'section.trustSub' },
];

/** The section nearest the top of the viewport, for the sidebar highlight. */
function useActiveSection(enabled: boolean): SectionId {
  const [active, setActive] = useState<SectionId>('overview');
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id as SectionId);
      },
      { rootMargin: '-20% 0px -65% 0px' },
    );
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [enabled]);
  return active;
}

function Brand() {
  const t = useT();
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        W
      </span>
      <span className="brand-text">
        <strong>{t('app.brand')}</strong>
        <span>{t('app.brandSub')}</span>
      </span>
    </div>
  );
}

function Sidebar({ active, badges }: { active: SectionId; badges: Partial<Record<SectionId, number>> }) {
  const t = useT();
  return (
    <aside className="sidebar">
      <Brand />
      <nav aria-label={t('nav.label')}>
        <ul className="nav">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className={active === section.id ? 'nav-link is-active' : 'nav-link'}
                aria-current={active === section.id ? 'location' : undefined}
              >
                <Icon name={section.icon} />
                <span>{t(section.label)}</span>
                {badges[section.id] ? (
                  <span className="nav-badge" aria-label={`${badges[section.id]} ${t('approval.waiting')}`}>
                    {badges[section.id]}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar-foot">
        <p>
          <Icon name="lock" size={14} /> {t('app.localFirst')}
        </p>
        <p>
          <Icon name="shield" size={14} /> {t('app.noRealMoney')}
        </p>
      </div>
    </aside>
  );
}

function Topbar({ onLoadSeed }: { onLoadSeed: () => void }) {
  const t = useT();
  const { state } = useAppStateContext();
  const { language, setLanguage } = useContext(LanguageContext);
  const { theme, toggle } = useTheme();
  const themeLabel = theme === 'dark' ? t('app.themeLight') : t('app.themeDark');
  return (
    <header className="topbar">
      <div className="topbar-left">
        {state.loaded ? null : <Brand />}
        {state.snapshot ? (
          <span className="chip-status">
            <span className="dot" aria-hidden="true" />
            {t('app.asOf')} {state.snapshot.asOf}
          </span>
        ) : null}
        <span className="topbar-tagline muted small">{t('app.tagline')}</span>
      </div>
      <div className="actions">
        <button
          type="button"
          className="icon-button"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={toggle}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button
          type="button"
          data-testid="language-toggle"
          onClick={() => setLanguage(language === 'en' ? 'id' : 'en')}
        >
          <Icon name="globe" size={16} />
          <span className="btn-label">{t('app.language')}</span>
        </button>
        <button type="button" className="primary" data-testid="load-seed" onClick={onLoadSeed}>
          <Icon name={state.loaded ? 'refresh' : 'sparkle'} size={16} />
          <span className="btn-label">{state.loaded ? t('app.resetSeed') : t('app.loadSeed')}</span>
        </button>
      </div>
    </header>
  );
}

const PROMISES: Array<{ icon: IconName; title: StringKey; body: StringKey }> = [
  { icon: 'lock', title: 'landing.p1Title', body: 'landing.p1Body' },
  { icon: 'shield', title: 'landing.p2Title', body: 'landing.p2Body' },
  { icon: 'log', title: 'landing.p3Title', body: 'landing.p3Body' },
];

const TIERS: Array<{ tier: string; text: StringKey }> = [
  { tier: 'T1', text: 'landing.t1' },
  { tier: 'T2', text: 'landing.t2' },
  { tier: 'T3', text: 'landing.t3' },
];

function Landing({ onLoadSeed }: { onLoadSeed: () => void }) {
  const t = useT();
  return (
    <section className="landing" data-testid="empty-state">
      <div className="landing-hero">
        <p className="eyebrow">{t('landing.eyebrow')}</p>
        <p className="landing-title">{t('landing.title')}</p>
        <h2>{t('app.emptyTitle')}</h2>
        <p className="landing-body">{t('app.emptyBody')}</p>
        <div className="actions">
          <button type="button" className="primary large" data-testid="load-seed-hero" onClick={onLoadSeed}>
            <Icon name="sparkle" size={18} />
            {t('landing.cta')}
          </button>
        </div>
        <p className="muted small">{t('landing.ctaNote')}</p>
      </div>
      <ul className="promises">
        {PROMISES.map((promise) => (
          <li key={promise.title} className="card promise">
            <span className="card-icon" aria-hidden="true">
              <Icon name={promise.icon} />
            </span>
            <strong>{t(promise.title)}</strong>
            <p className="muted small">{t(promise.body)}</p>
          </li>
        ))}
      </ul>
      <div className="card tiers">
        <strong>{t('landing.tiersTitle')}</strong>
        <ol>
          {TIERS.map((item) => (
            <li key={item.tier}>
              <span className={`tier tier-${item.tier.toLowerCase()}`}>{item.tier}</span> {t(item.text)}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const t = useT();
  const section = SECTIONS.find((candidate) => candidate.id === id)!;
  return (
    <section id={id} className="section" aria-labelledby={`${id}-heading`}>
      <header className="section-head">
        <h2 id={`${id}-heading`}>{t(section.label)}</h2>
        <p className="muted">{t(section.sub)}</p>
      </header>
      {children}
    </section>
  );
}

export function App() {
  const t = useT();
  const services = useServices();
  const { state, reload, loading } = useAppStateContext();
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const [earmarkNotice, setEarmarkNotice] = useState<string | null>(null);
  const [conversation, setConversation] = useState(0);
  const pendingGroups = groupByRisk(state.pending);
  const active = useActiveSection(state.loaded);

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
    <div className={state.loaded ? 'shell' : 'shell shell-landing'}>
      {state.loaded ? (
        <Sidebar
          active={active}
          badges={{ assistant: state.pending.length, coverage: state.policies.length }}
        />
      ) : null}

      <div className="main">
        <Topbar onLoadSeed={() => void loadSeed()} />
        <main className="app">
          <h1 className="visually-hidden">{t('app.title')}</h1>

          {loadNotice ? (
            <p className="warning" role="alert" data-testid="load-notice">
              {loadNotice}
            </p>
          ) : null}

          {!state.loaded ? (
            <Landing onLoadSeed={() => void loadSeed()} />
          ) : (
            <>
              {/* DASH-1: runway, policy coverage and the audit log on one page. */}
              <Section id="overview">
                {state.snapshot ? (
                  <BalancesPanel snapshot={state.snapshot} staleness={state.staleness} />
                ) : null}
                <div className="split split-wide">
                  {state.forecast ? <RunwayPanel view={state.forecast} /> : null}
                  {state.snapshot ? (
                    <AccountsPanel snapshot={state.snapshot} accounts={state.accountTypes} />
                  ) : null}
                </div>
              </Section>

              <Section id="assistant">
                <div className="split split-chat">
                  <ChatPanel key={conversation} onChanged={reload} />
                  {/* Approvals sit beside the chat (above it on a phone), so a new card is never out of sight. */}
                  <section
                    id="approvals"
                    className="approvals"
                    data-testid="approvals"
                    aria-label="Approvals"
                  >
                    <div className="approvals-head">
                      <h3>{t('approval.queue')}</h3>
                      <span className={state.pending.length > 0 ? 'pill pill-warn' : 'pill'}>
                        {state.pending.length} {t('approval.waiting')}
                      </span>
                    </div>
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
                      <div className="card empty-card muted" data-testid="no-pending">
                        <Icon name="check" size={22} />
                        <span>{t('approval.none')}</span>
                      </div>
                    )}
                  </section>
                </div>
              </Section>

              <Section id="coverage">
                {state.snapshot ? (
                  <PolicyPanel policies={state.policies} snapshot={state.snapshot} onChanged={reload} />
                ) : null}
              </Section>

              <Section id="money">
                <div className="grid">
                  <StatementImportPanel onChanged={reload} />
                  <EarmarkForm onChanged={reload} />
                </div>
                <EarmarksPanel
                  earmarks={state.earmarks}
                  notice={earmarkNotice}
                  onNotice={(message) => {
                    setEarmarkNotice(message);
                    reload();
                  }}
                  onRelease={(id) => void releaseEarmark(id)}
                />
              </Section>

              <Section id="trust">
                <AuditPanel onChanged={reload} />
                <div className="grid">
                  <PrivacyPanel outbound={state.outbound} onChanged={reload} />
                  <SettingsPanel settings={state.settings} onChanged={reload} />
                </div>
              </Section>
            </>
          )}

          {loading ? <p className="muted">Loading…</p> : null}
        </main>
      </div>
    </div>
  );
}
