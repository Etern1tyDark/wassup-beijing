import { useCallback, useEffect, useState } from 'react';
import { useServices } from './services-context';
import { buildForecastInputs, computeRunway, projectForecast, spendingAlerts } from '../forecast';
import { EMPTY_STATE, type AppState } from './app-state';

/**
 * Reads the whole visible state from IndexedDB. `reload()` is called after any
 * action so the screen always reflects what the executor actually did.
 *
 * There is exactly one instance of this hook, in AppStateProvider, so every
 * panel sees the same snapshot of the world.
 */
export function useAppState(): { state: AppState; reload: () => void; loading: boolean } {
  const services = useServices();
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [accounts, settings, earmarks] = await Promise.all([
          services.repos.accounts.all(),
          services.repos.settings.get(),
          services.repos.earmarks.all(),
        ]);

        if (accounts.length === 0) {
          if (!cancelled) setState({ ...EMPTY_STATE, checked: true, settings: settings ?? null });
          return;
        }

        const [snapshot, ledger, pending, audit, staleness, outbound, policies] = await Promise.all([
          services.actions.snapshot(),
          services.actions.ledgerInput(),
          services.actions.pending(),
          services.repos.audit.all(),
          services.actions.staleness(),
          services.repos.outboundRequests.all(),
          services.policies.all(),
        ]);

        // Names and policy numbers from stored policies are stripped from
        // anything sent to the model, including after a page reload.
        services.gate.setRedactorConfig(await services.policies.redactorConfig());

        const inputs = buildForecastInputs(ledger, snapshot);
        const forecast = projectForecast(inputs);
        const runway = computeRunway(inputs);

        if (cancelled) return;
        setState({
          checked: true,
          loaded: true,
          snapshot,
          earmarks,
          accountTypes: Object.fromEntries(accounts.map((account) => [account.id, account.type])),
          accountNames: Object.fromEntries(accounts.map((account) => [account.id, account.name])),
          forecast: { forecast, runway, alerts: spendingAlerts({ snapshot, forecast, runway, earmarks }) },
          policies,
          pending,
          audit,
          staleness,
          settings: settings ?? null,
          outbound,
        });
      } catch (error) {
        // A closed database during teardown must not surface as a crash.
        if (!cancelled) console.warn('could not read the ledger', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [services, version]);

  return { state, reload, loading: !state.checked };
}
