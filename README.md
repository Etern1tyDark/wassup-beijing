# wassup-beijing

A local-first personal-finance agent with permission tiers, built for the FinTechathon 2026
International Track (Topic A, with the coverage check and the late-invoice scenario as
supporting features).

The agent can act on your money picture, but only inside limits you set, in the open, with
undo. The ledger never leaves the browser. Every action is classified into a tier, checked
against guardrails, approved by a button press and written to an append-only hash-chained log.
**No real money moves anywhere in this codebase.**

- Full requirements: [`docs/PRD.md`](docs/PRD.md)
- How it is put together: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Dependency licences: [`docs/LICENSES.md`](docs/LICENSES.md)

## Setup

```bash
npm install && npm run dev
```

Then open <http://localhost:5173> and press **Load seed data**. That writes the deterministic
synthetic dataset for the demo persona (Rina) into IndexedDB and anchors the demo clock to its
as-of date. No API key, no network and no account are needed.

**Load seed data / Reset to seed data replaces the whole local database**, including the audit
log. It is the only bootstrap path, it is not an action, and nothing the model can call can
reach it.

Node 22.6 or newer is required (the seed and verify scripts use Node's TypeScript stripping).

### The golden path in the browser

1. **Load seed data** - six months of history, 3 to 5 clients paid 0 to 45 days late, one
   invoice still overdue.
2. Read **safe to spend** and the per-account balances.
3. **Propose an earmark** from the form (the default is Rp 3,000,000 for a medical reserve).
   Nothing changes yet: the ledger and safe-to-spend stay exactly as they were.
4. The **approval card** shows the before/after diff, every guardrail with its result, the
   proposal hash and the expiry. Press **Approve**.
5. Safe-to-spend drops by the earmarked amount, and the **audit log** gains a proposed, an
   approved and an executed entry.
6. Press **Undo last action**, then **Approve** on the new card. Safe-to-spend returns to the
   exact previous value and the log gains an `undone` entry.
7. Try an amount larger than free cash: the proposal is refused with the failing guardrail
   named, and the refusal is logged.
8. The **privacy panel** lists every outbound request and the redactions applied. The switch
   blocks requests outright.

The demo PIN for the settings panel is `123456` (seeded, demo-only).

## Commands

| Command                          | What it does                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                    | Vite dev server on <http://localhost:5173>                           |
| `npm run build`                  | Typecheck, then build the static site into `dist/`                   |
| `npm run preview`                | Serve the production build on <http://localhost:4173>                |
| `npm test`                       | Vitest unit, integration and UI tests                                |
| `npm run test:watch`             | Vitest in watch mode                                                 |
| `npm run e2e`                    | Playwright smoke test against the production build                   |
| `npm run lint`                   | ESLint                                                               |
| `npm run lint:boundary`          | Fails if anything outside the executor writes the ledger (LED-3)     |
| `npm run typecheck`              | `tsc --noEmit`                                                       |
| `npm run format`                 | Prettier                                                             |
| `npm run seed`                   | Regenerate `fixtures/seed` and the CSV/edge fixtures (deterministic) |
| `npm run verify:audit -- <file>` | Verify an exported audit log                                         |
| `npm run relay:dev`              | Run the relay locally (needs `MODEL_API_KEY`)                        |

Run the same checks CI runs:

```bash
npm run format:check && npm run lint && npm run lint:boundary && npm run typecheck && npm test && npm run build && npm run e2e
```

## Tests

180 unit, integration and UI tests plus one end-to-end smoke test.

| Area             | File(s)                                                 | Covers                                                            |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| Money            | `src/domain/money.test.ts`                              | Floats and unsafe integers are rejected; no float arithmetic      |
| Ledger           | `src/ledger/engine.test.ts`                             | Hand-worked fixture: balances, free cash, safe-to-spend           |
| CSV import       | `src/importers/csv.test.ts`                             | Valid fixture loads; bad rows get a line number and a reason      |
| Audit log        | `src/audit/log.test.ts`, `src/audit/verify-cli.test.ts` | Chain verifies; tampering, deletion and insertion all fail        |
| Tier engine      | `src/actions/service.test.ts`                           | Approval lifecycle, tokens, guardrails, provenance, T3, staleness |
| Edge fixtures    | `src/actions/edge-fixtures.test.ts`                     | Earmark over free cash, stale data, malformed CSVs                |
| Write boundary   | `src/storage/ledger-write-boundary.test.ts`             | LED-3                                                             |
| Outbound gate    | `src/gate/gate.test.ts`                                 | Redactor removes every identifier type; block decisions honoured  |
| Agent            | `src/agent/agent.test.ts`                               | Tools propose but never approve; T1 has no side effects           |
| Seed determinism | `scripts/seed/generator.test.ts`                        | Same seed, same hash; PRD shape checks                            |
| UI               | `src/ui/App.test.tsx`                                   | Seed load, propose, approve, undo, refusal, settings, privacy     |
| Relay            | `relay/index.test.ts`                                   | Adds the key, forwards the redacted body, stores nothing          |
| End to end       | `tests/e2e/smoke.spec.ts`                               | App loads, seed shows, earmark approve and undo work              |

## Architecture in one paragraph

`src/domain` holds the frozen schemas and integer-rupiah money helpers. `src/storage` holds the
Dexie database, read-only repositories and a write API that only the action executor (and the
one-off seed loader) may import. `src/actions` is the tier engine: a fixed registry maps every
action name to a tier, guardrails and provenance are checked in code, a one-time token bound to
the proposal hash gates approval, and the executor is the only module that changes the ledger.
`src/audit` chains every proposal, approval, execution, refusal and undo into a SHA-256 hash
chain that exports to JSON and verifies with `npm run verify:audit`. `src/gate` redacts and
records every outbound request. The model can only propose; the model adapter goes through the
gate; the relay adds the API key and logs nothing. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full flow.

## What is stubbed

- `src/forecast` - FC-1 to FC-4 throw `NotImplementedError` with their requirement ids.
- `src/policy` - POL-1 to POL-5 are typed stubs.
- `src/agent/orchestrator.ts` - the tool loop is real; CHAT-1 to CHAT-4 are TODOs.
- The model adapter is rule-based (`src/agent/mock-model.ts`); it makes no network calls.
- `relay/` returns 503 until `MODEL_API_KEY` is set.

## Deployment

Static site plus one function, deployed from `main`:

- **Site**: `npm run build` produces `dist/`. Host it on any static host (Vercel, Netlify,
  Cloudflare Pages, GitHub Pages). It is an installable PWA with a same-origin app-shell
  service worker.
- **Relay**: deploy `relay/index.ts` as a single serverless function and set `MODEL_API_KEY`,
  `MODEL_API_URL` and `MODEL_ID`. Route `/api/*` to it. It keeps no logs and stores nothing.

## Data and privacy

All ledger data lives in IndexedDB in your browser. There are no analytics, no trackers and no
third-party scripts. The only outbound path is `gate.send()`, which redacts names, account and
policy numbers, NIK, phone numbers and email addresses before anything leaves, and records
every request for the privacy panel. All demo data is synthetic.
