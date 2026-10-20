import { useMemo, useState, type ChangeEvent } from 'react';
import { formatRupiah, toMoney } from '../domain/money';
import type { LedgerSnapshot } from '../ledger/engine';
import { FORECAST_HORIZON_DAYS, type ForecastResult } from '../forecast';
import {
  EVENT_CATALOGUE,
  LOW_CONFIDENCE_THRESHOLD,
  assessCoverage,
  importPolicyFile,
  type Citation,
  type CoverageAssessment,
  type LoadedPolicy,
} from '../policy';
import { prepareStatementImport, type PreparedStatement } from '../importers/statement';
import type { ForecastView } from './app-state';
import { useT } from './i18n';
import { useServices } from './services-context';

/* ------------------------------------------------------------------ runway */

/** The 90-day free-cash line as an inline SVG. The numbers beside it carry the meaning. */
function ForecastChart({ forecast }: { forecast: ForecastResult }) {
  const width = 320;
  const height = 80;
  const values = forecast.points.map((point) => point.freeCash);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (index: number): number => (index / (forecast.points.length - 1)) * width;
  const y = (value: number): number => height - ((value - min) / span) * height;
  const path = forecast.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.freeCash).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      className="forecast-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Projected free cash for ${forecast.horizonDays} days: lowest ${formatRupiah(forecast.lowestFreeCash.amount)} on ${forecast.lowestFreeCash.date}`}
      data-testid="forecast-chart"
    >
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} className="forecast-zero" />
      <path d={path} className="forecast-line" />
    </svg>
  );
}

export function RunwayPanel({ view }: { view: ForecastView }) {
  const t = useT();
  const { forecast, runway, alerts } = view;
  const inputs = forecast.inputs;
  const counted = forecast.events.filter((event) => event.kind === 'invoice');

  return (
    <section className="card" data-testid="runway-panel">
      <h3>{t('runway.title')}</h3>
      <dl className="totals">
        <div>
          <dt>{t('runway.covered')}</dt>
          <dd data-testid="runway-days">
            {runway.capped ? `More than ${runway.runwayDays} days` : `${runway.runwayDays} days`}
          </dd>
        </div>
        <div>
          <dt>{t('runway.months')}</dt>
          <dd data-testid="runway-months">{runway.capped ? '24+' : runway.runwayMonths}</dd>
        </div>
      </dl>
      <p className="muted small" data-testid="runway-detail">
        {runway.depletionDate
          ? `Free cash is projected to run out on ${runway.depletionDate}.`
          : 'Free cash does not run out in the next two years on current numbers.'}{' '}
        Lowest point in the next {FORECAST_HORIZON_DAYS} days: {formatRupiah(forecast.lowestFreeCash.amount)}{' '}
        on {forecast.lowestFreeCash.date}.
      </p>

      <ForecastChart forecast={forecast} />

      {alerts.length > 0 ? (
        <ul className="alerts" data-testid="alerts">
          {alerts.map((alert) => (
            <li key={alert.id} className={`alert alert-${alert.severity}`}>
              <strong>{alert.severity === 'warning' ? 'Warning' : 'Note'}:</strong> {alert.message}
            </li>
          ))}
        </ul>
      ) : null}

      {/* FC-4: every forecast is labelled with its inputs and its as-of date. */}
      <details className="inputs" data-testid="forecast-inputs">
        <summary>{forecast.label} · what went into this</summary>
        <ul>
          <li>
            Free cash today: {formatRupiah(toMoney(inputs.startingBalance - inputs.activeEarmarkTotal))}
          </li>
          <li>Set aside in earmarks: {formatRupiah(inputs.activeEarmarkTotal)}</li>
          <li>
            Obligations:{' '}
            {inputs.obligations
              .map(
                (obligation) =>
                  `${obligation.label} ${formatRupiah(obligation.amount)} (${obligation.recurrence})`,
              )
              .join('; ') || 'none'}
          </li>
          <li>
            Invoices counted on their due date:{' '}
            {counted
              .map((event) => `${event.label} ${formatRupiah(event.amount)} on ${event.date}`)
              .join('; ') || 'none'}
          </li>
          <li>
            Overdue invoices left out:{' '}
            {forecast.excludedInvoices
              .map(
                (invoice) =>
                  `${invoice.client} ${invoice.id} ${formatRupiah(invoice.amount)}, due ${invoice.dueDate}`,
              )
              .join('; ') || 'none'}
          </li>
          <li>
            Day-to-day spending: {formatRupiah(inputs.variableSpend.total)} over the last{' '}
            {inputs.variableSpend.windowDays} days, spread evenly
          </li>
        </ul>
      </details>
    </section>
  );
}

/* ---------------------------------------------------------------- policies */

export function CitationBlock({
  citation,
  label,
  collapsed = false,
}: {
  citation: Citation;
  label?: string;
  /** Show only the reference until it is opened; used where space is tight. */
  collapsed?: boolean;
}) {
  const reference = `${label ?? 'Source'}: ${citation.clauseRef}, page ${citation.page} · ${citation.title}`;
  const text = citation.text || 'The clause has no further text.';
  if (collapsed) {
    return (
      <details className="citation" data-testid="citation">
        <summary>{reference}</summary>
        <blockquote>{text}</blockquote>
      </details>
    );
  }
  return (
    <figure className="citation" data-testid="citation">
      <figcaption>{reference}</figcaption>
      <blockquote>{text}</blockquote>
    </figure>
  );
}

export function CoverageView({ result, compact = false }: { result: CoverageAssessment; compact?: boolean }) {
  if (result.kind === 'not-found') {
    return (
      <div data-testid="coverage-not-found">
        <p className="warning">{result.note}</p>
        {result.nearest ? <CitationBlock citation={result.nearest} label="Closest text" /> : null}
      </div>
    );
  }
  if (result.kind === 'low-confidence') {
    return (
      <div data-testid="coverage-low-confidence">
        <p className="warning">{result.note}</p>
        <CitationBlock citation={result.citation} label="Clause as written" />
      </div>
    );
  }

  const waiting =
    result.waitingPeriodDays === 0
      ? 'None'
      : `${result.waitingPeriodDays} days${result.waitingEndsOn ? `, until ${result.waitingEndsOn}` : ''}${result.inWaitingPeriod ? ' (still running)' : ' (over)'}`;
  const working: Array<[string, string]> = [
    ['Benefit', result.benefit],
    ['Waiting period', waiting],
    ['Assumed cost', `${formatRupiah(result.estimatedCost)} (${result.costAssumption})`],
    ['Policy pays', formatRupiah(result.insurerPays)],
    ['Your free cash', formatRupiah(result.freeCash)],
  ];

  return (
    <div data-testid="coverage-covered">
      <table className="diff">
        <tbody>
          <tr>
            <th scope="row">Limit</th>
            <td>{formatRupiah(result.limit)}</td>
          </tr>
          <tr>
            <th scope="row">Co-payment</th>
            <td>{formatRupiah(result.deductible)}</td>
          </tr>
          {compact
            ? null
            : working.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                </tr>
              ))}
          <tr>
            <th scope="row">Worst case, you pay</th>
            <td data-testid="coverage-out-of-pocket">{formatRupiah(result.worstCaseOutOfPocket)}</td>
          </tr>
          <tr>
            <th scope="row">Shortfall</th>
            <td data-testid="coverage-shortfall">
              {result.shortfall > 0 ? `${formatRupiah(result.shortfall)} short` : 'None: free cash covers it'}
            </td>
          </tr>
        </tbody>
      </table>
      {result.inWaitingPeriod ? (
        <p className="warning">The waiting period is still running, so the policy would pay nothing yet.</p>
      ) : null}
      {compact ? (
        <details>
          <summary>How this was worked out</summary>
          <table className="diff">
            <tbody>
              {working.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {result.exclusions.length > 0 && !compact ? (
        <p className="small">Not covered under this clause: {result.exclusions.join('; ')}.</p>
      ) : null}
      {result.citations.map((citation) => (
        <CitationBlock key={citation.clauseRef} citation={citation} collapsed={compact} />
      ))}
      <p className="muted small">Please check with your insurer before relying on this.</p>
    </div>
  );
}

function PolicyCard({
  loaded,
  snapshot,
  onRemove,
}: {
  loaded: LoadedPolicy;
  snapshot: LedgerSnapshot;
  onRemove: () => void;
}) {
  const { policy, document, items } = loaded;
  const defaultEvent = policy.type === 'health' ? 'hospital stay' : 'trip cancellation';
  const [event, setEvent] = useState(defaultEvent);

  // POL-2 / POL-3: computed by the coverage engine in the browser, with no model involved.
  const assessment = useMemo(
    () =>
      assessCoverage({
        policy,
        document,
        items,
        event,
        freeCash: snapshot.freeCash,
        asOf: snapshot.asOf,
      }),
    [policy, document, items, event, snapshot.freeCash, snapshot.asOf],
  );

  const flagged = document.clauses.filter((clause) => clause.injectionSignals.length > 0);

  return (
    <article className="policy" data-testid={`policy-${policy.type}`}>
      <header className="card-header">
        <div>
          <strong>{policy.displayName}</strong>
          {flagged.length > 0 ? (
            <span className="badge-danger" data-testid="policy-tampered-badge">
              Hidden instruction found
            </span>
          ) : null}
          <div className="muted small">
            {policy.insurer} · {policy.type} · {document.pageCount} page(s) ·{' '}
            {policy.startDate ? `cover from ${policy.startDate}` : 'start date not stated'}
          </div>
        </div>
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </header>

      {flagged.length > 0 ? (
        <p className="warning" role="alert" data-testid="policy-injection-flag">
          Flagged: {flagged.map((clause) => `${clause.clauseRef} (page ${clause.page})`).join(', ')} contains
          text that reads like an instruction. It was treated as data, not followed, and is never sent to the
          model.
          {flagged
            .flatMap((clause) => clause.injectionSignals)
            .map((signal) => (
              <q key={signal} className="flagged-quote">
                {signal}
              </q>
            ))}
        </p>
      ) : null}

      <label className="field">
        <span>Check this policy against</span>
        <select
          value={event}
          data-testid={`policy-event-${policy.type}`}
          onChange={(change: ChangeEvent<HTMLSelectElement>) => setEvent(change.target.value)}
        >
          {EVENT_CATALOGUE.map((definition) => (
            <option key={definition.key} value={definition.label}>
              {definition.label}
            </option>
          ))}
        </select>
      </label>
      <CoverageView result={assessment} compact />

      <details>
        <summary>All benefits in this policy ({items.length})</summary>
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
            {items.map((item) =>
              item.confidence < LOW_CONFIDENCE_THRESHOLD ? (
                <tr key={item.id} data-testid="benefit-low-confidence">
                  <td>{item.benefit}</td>
                  <td colSpan={3}>
                    Could not be read with confidence. As written: “
                    {document.clauses.find((clause) => clause.clauseRef === item.clauseRef)?.text ?? ''}”
                  </td>
                  <td>
                    {item.clauseRef}, p. {item.page}
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td>{item.benefit}</td>
                  <td>{formatRupiah(item.limit)}</td>
                  <td>{formatRupiah(item.deductible)}</td>
                  <td>{item.waitingPeriodDays === 0 ? 'None' : `${item.waitingPeriodDays} days`}</td>
                  <td>
                    {item.clauseRef}, p. {item.page}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </details>
    </article>
  );
}

const SAMPLE_POLICIES = [
  { file: 'health-policy.pdf', label: 'Sample health policy', testId: 'sample-policy-health' },
  { file: 'travel-policy.pdf', label: 'Sample travel policy', testId: 'sample-policy-travel' },
  {
    file: 'health-policy-tampered.pdf',
    label: 'Tampered policy (attack demo)',
    testId: 'sample-policy-tampered',
  },
] as const;

export function PolicyPanel({
  policies,
  snapshot,
  onChanged,
}: {
  policies: LoadedPolicy[];
  snapshot: LedgerSnapshot;
  onChanged: () => void;
}) {
  const services = useServices();
  const t = useT();
  const [message, setMessage] = useState<string | null>(null);
  const [flaggedOnLoad, setFlaggedOnLoad] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (name: string, read: () => Promise<Uint8Array>) => {
    setBusy(true);
    setMessage(null);
    setFlaggedOnLoad(false);
    try {
      const result = await importPolicyFile(
        { readPdf: services.readPdf, store: services.policies, gate: services.gate, audit: services.audit },
        { name, bytes: await read() },
      );
      if (!result.ok) {
        setMessage(`${name} was not loaded: ${result.reason}.`);
        return;
      }
      const { extraction } = result;
      setFlaggedOnLoad(extraction.injectionSignals.length > 0);
      setMessage(
        `Loaded ${extraction.policy.displayName}: ${extraction.items.length} benefit clause(s), each linked to its page and clause.` +
          (extraction.lowConfidence.length > 0
            ? ` ${extraction.lowConfidence.length} could not be read with confidence and are shown as written.`
            : '') +
          (extraction.injectionSignals.length > 0
            ? ` Warning: ${extraction.injectionSignals.length} hidden instruction(s) were found and ignored, for example “${extraction.injectionSignals[0]!.text}”. Nothing was proposed and the refusal is in the audit log.`
            : ''),
      );
      onChanged();
    } catch (error) {
      setMessage(`${name} was not loaded: ${error instanceof Error ? error.message : String(error)}.`);
    } finally {
      setBusy(false);
    }
  };

  const upload = (change: ChangeEvent<HTMLInputElement>) => {
    const file = change.target.files?.[0];
    change.target.value = '';
    if (file) void load(file.name, async () => new Uint8Array(await file.arrayBuffer()));
  };

  const loadSample = (file: string) =>
    load(file, async () => {
      const response = await fetch(`/samples/${file}`);
      if (!response.ok) throw new Error(`the sample could not be fetched (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    });

  const remove = async (policyId: string) => {
    await services.policies.remove(policyId);
    services.gate.setRedactorConfig(await services.policies.redactorConfig());
    onChanged();
  };

  return (
    <section className="card" data-testid="policy-panel">
      <h3>{t('policy.title')}</h3>
      <div className="actions upload-row">
        <label className="file-button">
          <span>{t('policy.upload')}</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            data-testid="policy-upload"
            disabled={busy}
            onChange={upload}
          />
        </label>
        {SAMPLE_POLICIES.map((sample) => (
          <button
            key={sample.file}
            type="button"
            data-testid={sample.testId}
            disabled={busy}
            onClick={() => void loadSample(sample.file)}
          >
            {sample.label}
          </button>
        ))}
      </div>
      <p className="muted small">
        Text-based PDFs up to 20 pages. The text is read in this browser; it is compared, never used to
        recommend a product.
      </p>

      {message ? (
        <p
          className={flaggedOnLoad ? 'warning' : 'message'}
          role={flaggedOnLoad ? 'alert' : 'status'}
          data-testid="policy-message"
        >
          {message}
        </p>
      ) : null}

      {policies.length === 0 ? (
        <p className="muted" data-testid="no-policies">
          {t('policy.none')}
        </p>
      ) : (
        policies.map((loaded) => (
          <PolicyCard
            key={loaded.policy.id}
            loaded={loaded}
            snapshot={snapshot}
            onRemove={() => void remove(loaded.policy.id)}
          />
        ))
      )}
    </section>
  );
}

/* --------------------------------------------------------- statement import */

const SAMPLE_STATEMENTS = [
  { file: 'statement-october.csv', label: 'Sample statement', testId: 'sample-statement' },
  {
    file: 'statement-tampered.csv',
    label: 'Tampered statement (attack demo)',
    testId: 'sample-statement-tampered',
  },
] as const;

export function StatementImportPanel({ onChanged }: { onChanged: () => void }) {
  const services = useServices();
  const t = useT();
  const [prepared, setPrepared] = useState<PreparedStatement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (name: string, read: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    setPrepared(null);
    try {
      const result = await prepareStatementImport(name, await read());
      setPrepared(result);
      if (!result.ok) return;

      const proposed = await services.actions.propose(result.proposal);
      setMessage(
        proposed.kind === 'proposal'
          ? `${result.rowCount} row(s) read from ${name}. Nothing is in the ledger yet: approve the card to import them.`
          : proposed.reason,
      );
      onChanged();
    } catch (error) {
      setMessage(`${name} was not read: ${error instanceof Error ? error.message : String(error)}.`);
    } finally {
      setBusy(false);
    }
  };

  const upload = (change: ChangeEvent<HTMLInputElement>) => {
    const file = change.target.files?.[0];
    change.target.value = '';
    if (file) void load(file.name, () => file.text());
  };

  const loadSample = (file: string) =>
    load(file, async () => {
      const response = await fetch(`/samples/${file}`);
      if (!response.ok) throw new Error(`the sample could not be fetched (${response.status})`);
      return response.text();
    });

  return (
    <section className="card" data-testid="statement-panel">
      <h3>{t('statement.title')}</h3>
      <div className="actions upload-row">
        <label className="file-button">
          <span>{t('statement.upload')}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            data-testid="statement-upload"
            disabled={busy}
            onChange={upload}
          />
        </label>
        {SAMPLE_STATEMENTS.map((sample) => (
          <button
            key={sample.file}
            type="button"
            data-testid={sample.testId}
            disabled={busy}
            onClick={() => void loadSample(sample.file)}
          >
            {sample.label}
          </button>
        ))}
      </div>
      <p className="muted small">
        Columns: <code>date,description,amount,balance,account</code>. A file with any bad row is rejected
        whole; nothing is guessed.
      </p>

      {prepared && !prepared.ok ? (
        <div className="warning" role="alert" data-testid="statement-errors">
          {prepared.fileName} was rejected. Nothing was imported.
          <ul>
            {prepared.errors.map((error) => (
              <li key={`${error.line}-${error.reason}`}>
                Line {error.line}: {error.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prepared?.ok && prepared.flagged.length > 0 ? (
        <div className="warning" role="alert" data-testid="statement-injection-flag">
          Flagged: {prepared.flagged.length} description(s) read like an instruction. They are imported as
          text only and are never followed.
          <ul>
            {prepared.flagged.map((row) => (
              <li key={row.line}>
                Line {row.line}: “{row.description}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p className="message" role="status" data-testid="statement-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
