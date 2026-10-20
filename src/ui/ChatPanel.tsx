import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatRupiah } from '../domain/money';
import type { Proposal } from '../domain/schemas';
import type {
  CoverageAssessment,
  PolicyComparison,
  PolicySummary,
  ReminderData,
  RunwayData,
  ScenarioData,
  SpendingData,
  SummaryData,
} from '../agent/tools';
import type { ToolResult } from '../agent/types';
import { CoverageView } from './DashboardPanels';
import { useT } from './i18n';
import { useServices } from './services-context';

/**
 * Chat (CHAT-1 to CHAT-4). The reply text is short; the numbers live in the
 * cards under it, which are drawn straight from the tool results. The model
 * never formats a table, so it cannot put a number in one.
 */
interface ChatEntry {
  id: number;
  role: 'user' | 'agent';
  text: string;
  pasted?: string;
  notices: string[];
  options: string[];
  toolResults: ToolResult[];
}

const SUGGESTIONS = [
  'How long can I cover my costs?',
  'Does my health policy cover a hospital stay?',
  'Set aside money for medical costs',
  'Draft a reminder for the overdue invoice',
  'Undo that',
];

const CONSENT_KEY = 'model-consent-v1';

function readConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

function runwayText(days: number, months: number, capped: boolean): string {
  return capped ? `more than ${days} days` : `${days} days (${months} months)`;
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <table className="diff">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReminderCard({ data }: { data: ReminderData }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.draft);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div data-testid="card-reminder">
      <p className="small muted">
        Draft only ({data.tone}). Nothing has been sent, and this app cannot send it.
      </p>
      <textarea readOnly value={data.draft} rows={4} aria-label="Reminder draft" />
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy text'}
        </button>
      </div>
    </div>
  );
}

/** A refusal in plain words: no "refused:" prefix, no requirement IDs. Both stay in the audit log. */
function plainRefusal(reason: string): string {
  const text = reason
    .replace(/^refused(?: by guardrails)?:\s*/i, '')
    .replace(/\s*\((?:[A-Z]{2,5}-\d+(?:,\s*)?)+\)/g, '')
    .trim();
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : reason;
}

function ToolCard({ result }: { result: ToolResult }) {
  if (!result.ok) {
    return (
      <div className="tool-card refused" data-testid="card-refused" role="status">
        <strong>
          <span aria-hidden="true">🔒 </span>Refused · logged
        </strong>{' '}
        {plainRefusal(result.reason)}
      </div>
    );
  }

  const proposal = (result.data as { status?: string; proposal?: Proposal } | null)?.proposal;
  if (proposal) {
    return (
      <div className="tool-card" data-testid="card-proposal">
        <strong>Waiting for your approval</strong> · {proposal.action} ({proposal.tier}). Nothing has changed.
        The <a href="#approvals">approval card</a> shows the before and after.
      </div>
    );
  }

  switch (result.tool) {
    case 'get_summary': {
      const data = result.data as SummaryData;
      return (
        <div className="tool-card" data-testid="card-summary">
          <Rows
            rows={[
              ['Safe to spend', formatRupiah(data.safeToSpend)],
              ['Total balance', formatRupiah(data.totalBalance)],
              ['Free cash', formatRupiah(data.freeCash)],
              ['Obligations due in 30 days', formatRupiah(data.obligationsDueIn30Days)],
              ['As of', data.asOf],
            ]}
          />
        </div>
      );
    }
    case 'get_runway': {
      const data = result.data as RunwayData;
      return (
        <div className="tool-card" data-testid="card-runway">
          <Rows
            rows={[
              ['Runway', runwayText(data.runwayDays, data.runwayMonths, data.capped)],
              ['Free cash runs out', data.depletionDate ?? 'not within two years'],
              ['Free cash today', formatRupiah(data.inputs.freeCash)],
              ['Invoices counted', formatRupiah(data.inputs.countedInvoiceTotal)],
              ['Overdue invoices left out', formatRupiah(data.inputs.excludedInvoiceTotal)],
              [
                'Day-to-day spending',
                `${formatRupiah(data.inputs.variableSpend.total)} per ${data.inputs.variableSpend.windowDays} days`,
              ],
            ]}
          />
          <p className="small muted">{data.label}</p>
        </div>
      );
    }
    case 'run_scenario': {
      const data = result.data as ScenarioData;
      return (
        <div className="tool-card" data-testid="card-scenario">
          <table>
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">Base case</th>
                <th scope="col">Scenario</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Runway</th>
                <td>{runwayText(data.base.runwayDays, data.base.runwayMonths, data.base.capped)}</td>
                <td>
                  {runwayText(data.scenario.runwayDays, data.scenario.runwayMonths, data.scenario.capped)}
                </td>
              </tr>
              <tr>
                <th scope="row">Free cash runs out</th>
                <td>{data.base.depletionDate ?? '—'}</td>
                <td>{data.scenario.depletionDate ?? '—'}</td>
              </tr>
              <tr>
                <th scope="row">Lowest free cash until {data.pinch.until}</th>
                <td>{formatRupiah(data.pinch.base.amount)}</td>
                <td>{formatRupiah(data.pinch.scenario.amount)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small muted">{data.label}</p>
        </div>
      );
    }
    case 'get_spending': {
      const data = result.data as SpendingData;
      return (
        <div className="tool-card" data-testid="card-spending">
          <Rows
            rows={[
              ['Period', `${data.from} to ${data.to}`],
              ['Money in', formatRupiah(data.moneyIn)],
              ['Money out', formatRupiah(data.moneyOut)],
              ...data.byCategory.map((row): [string, string] => [
                `· ${row.category}`,
                formatRupiah(row.total),
              ]),
            ]}
          />
        </div>
      );
    }
    case 'list_policies': {
      const data = result.data as PolicySummary[];
      if (data.length === 0) return null;
      return (
        <div className="tool-card" data-testid="card-policies">
          {data.map((policy) => (
            <details key={policy.policyId}>
              <summary>
                {policy.displayName} · {policy.type}
              </summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Benefit</th>
                    <th scope="col">Limit</th>
                    <th scope="col">Co-payment</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {policy.benefits.map((benefit) => (
                    <tr key={benefit.clauseRef}>
                      <td>{benefit.benefit}</td>
                      {benefit.lowConfidence ? (
                        <td colSpan={3}>Could not be read with confidence</td>
                      ) : (
                        <>
                          <td>{formatRupiah(benefit.limit)}</td>
                          <td>{formatRupiah(benefit.deductible)}</td>
                          <td>
                            {benefit.waitingPeriodDays === 0 ? 'None' : `${benefit.waitingPeriodDays} days`}
                          </td>
                        </>
                      )}
                      <td>
                        {benefit.clauseRef}, p. {benefit.page}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      );
    }
    case 'get_coverage':
      return (
        <div className="tool-card" data-testid="card-coverage">
          <CoverageView result={result.data as CoverageAssessment} />
        </div>
      );
    case 'compare_policies': {
      const data = result.data as PolicyComparison;
      return (
        <div className="tool-card" data-testid="card-comparison">
          <table>
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                {data.columns.map((column) => (
                  <th scope="col" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.criterion}>
                  <th scope="row">{row.criterion}</th>
                  {row.values.map((value, index) => (
                    <td key={`${row.criterion}-${data.columns[index]}`}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{data.handoff}</p>
        </div>
      );
    }
    case 'draft_reminder':
      return (
        <div className="tool-card">
          <ReminderCard data={result.data as ReminderData} />
        </div>
      );
    default:
      return null;
  }
}

export function ChatPanel({ onChanged }: { onChanged: () => void }) {
  const services = useServices();
  const t = useT();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(readConsent);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const agree = () => {
    try {
      globalThis.localStorage?.setItem(CONSENT_KEY, 'yes');
    } catch {
      // Without storage the consent lasts until the page is reloaded.
    }
    setConsent(true);
  };

  const send = async (text: string) => {
    const message = text.trim();
    const paste = pasted.trim();
    if ((message === '' && paste === '') || busy) return;

    setBusy(true);
    setDraft('');
    setPasted('');
    const userEntry: ChatEntry = {
      id: nextId.current++,
      role: 'user',
      text: message || '(pasted text only)',
      ...(paste ? { pasted: paste } : {}),
      notices: [],
      options: [],
      toolResults: [],
    };
    setEntries((current) => [...current, userEntry]);

    try {
      const turn = await services.orchestrator.send(message, paste ? { pastedText: paste } : {});
      setEntries((current) => [
        ...current,
        {
          id: nextId.current++,
          role: 'agent',
          text: turn.reply,
          notices: turn.notices,
          options: turn.options,
          toolResults: turn.toolResults,
        },
      ]);
    } catch (error) {
      setEntries((current) => [
        ...current,
        {
          id: nextId.current++,
          role: 'agent',
          text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
          notices: [],
          options: [],
          toolResults: [],
        },
      ]);
    } finally {
      setBusy(false);
      // A turn can create a proposal, a refusal in the audit log and outbound requests.
      onChanged();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };

  if (!consent) {
    return (
      <section className="card" data-testid="chat-panel">
        <h3>{t('chat.title')}</h3>
        <div data-testid="consent">
          <p>{t('chat.consentIntro')}</p>
          <p>{t('chat.consentPanel')}</p>
          <div className="actions">
            <button type="button" className="primary" data-testid="consent-agree" onClick={agree}>
              {t('chat.consentAgree')}
            </button>
          </div>
          <p className="muted small">
            Everything else on this page (balances, runway, policies, earmarks, audit log) works without the
            model.
          </p>
        </div>
      </section>
    );
  }

  const lastAgent = [...entries].reverse().find((entry) => entry.role === 'agent');

  return (
    <section className="card" data-testid="chat-panel">
      <h3>{t('chat.title')}</h3>
      <p className="muted small" data-testid="model-kind">
        {services.modelKind === 'relay'
          ? 'Model: hosted, through the relay. Redacted text leaves this browser; see the Privacy panel.'
          : 'Model: built-in rule-based stand-in. It runs in this browser and nothing is sent anywhere.'}
      </p>

      {t('chat.repliesInEnglish') ? <p className="muted small">{t('chat.repliesInEnglish')}</p> : null}

      <div className="chat-log" ref={logRef} data-testid="chat-log" aria-live="polite">
        {entries.length === 0 ? (
          <p className="muted">
            The agent reads your numbers, drafts text and proposes reversible changes. It cannot move money,
            change limits or approve anything.
          </p>
        ) : null}
        {entries.map((entry) => (
          <div key={entry.id} className={`chat-entry chat-${entry.role}`} data-testid={`chat-${entry.role}`}>
            <div className="chat-who">{entry.role === 'user' ? 'You' : 'Agent'}</div>
            <p className="chat-text">{entry.text}</p>
            {entry.pasted ? (
              <blockquote className="pasted">
                <span className="small muted">Pasted text, treated as data:</span> {entry.pasted}
              </blockquote>
            ) : null}
            {entry.notices.map((notice) => (
              <p key={notice} className="warning" role="alert" data-testid="chat-notice">
                {notice}
              </p>
            ))}
            {entry.toolResults.map((result, index) => (
              <ToolCard key={`${entry.id}-${result.tool}-${index}`} result={result} />
            ))}
          </div>
        ))}
        {busy ? <p className="muted">Working…</p> : null}
      </div>

      {lastAgent && lastAgent.options.length > 0 && !busy ? (
        <div className="actions" data-testid="chat-options">
          {lastAgent.options.map((option) => (
            <button key={option} type="button" onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}

      <form onSubmit={submit} className="chat-form">
        <label className="field">
          <span>{t('chat.message')}</span>
          <input
            value={draft}
            data-testid="chat-input"
            placeholder="How long can I cover my costs?"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <details>
          <summary>Paste text from a letter, email or document</summary>
          <label className="field">
            <span>Pasted text is treated as data. The agent will not follow instructions in it.</span>
            <textarea
              value={pasted}
              rows={3}
              data-testid="chat-paste"
              disabled={busy}
              onChange={(event) => setPasted(event.target.value)}
            />
          </label>
        </details>
        <div className="actions">
          <button type="submit" className="primary" data-testid="chat-send" disabled={busy}>
            {t('chat.send')}
          </button>
          <button
            type="button"
            data-testid="chat-reset"
            disabled={busy}
            onClick={() => {
              services.orchestrator.reset();
              setEntries([]);
            }}
          >
            {t('chat.new')}
          </button>
        </div>
      </form>

      <div className="suggestions" data-testid="chat-suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => void send(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}
