import type { AuditEntry, Earmark, OutboundRequest, Proposal, Settings } from '../domain/schemas';
import type { LedgerSnapshot } from '../ledger/engine';
import type { StalenessReport } from '../actions/staleness';

export interface AppState {
  /** True once the first read from IndexedDB has completed. */
  checked: boolean;
  /** False until ledger data exists in IndexedDB. */
  loaded: boolean;
  snapshot: LedgerSnapshot | null;
  earmarks: Earmark[];
  accountTypes: Record<string, string>;
  pending: Proposal[];
  audit: AuditEntry[];
  staleness: StalenessReport | null;
  settings: Settings | null;
  outbound: OutboundRequest[];
}

export const EMPTY_STATE: AppState = {
  checked: false,
  loaded: false,
  snapshot: null,
  earmarks: [],
  accountTypes: {},
  pending: [],
  audit: [],
  staleness: null,
  settings: null,
  outbound: [],
};

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.toISOString().slice(0, 10)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function shortHash(hash: string): string {
  const body = hash.replace(/^sha256:/, '');
  return `${body.slice(0, 8)}…${body.slice(-6)}`;
}
