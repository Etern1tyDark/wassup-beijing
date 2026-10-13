# Architecture

A local-first personal-finance agent with permission tiers. Everything runs in the browser;
one stateless relay function holds the model API key and forwards already-redacted requests.

Requirement ids (ING-1, ACT-3, LED-2, …) refer to `docs/PRD.md`.

## Module map

| Path            | Responsibility                                                                            | Requirement     |
| --------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `src/domain`    | Types, Zod schemas for the ten entities, integer-rupiah money helpers, ISO date helpers   | PRD §8, NFR-1   |
| `src/storage`   | Dexie database, read-only repositories, the restricted ledger write API, the seed loader  | ING-5, LED-3    |
| `src/ledger`    | Pure functions: balance per account, free cash, safe-to-spend                             | LED-1, LED-2    |
| `src/importers` | Statement CSV parser with line-numbered errors, untrusted marking, injection heuristics   | ING-1, ING-2    |
| `src/actions`   | Action registry, tier engine, guardrails, provenance, approval tokens, executor, settings | ACT-1 … ACT-7   |
| `src/audit`     | Append-only SHA-256 hash chain, JSON export, verify function and CLI                      | AUD-1 … AUD-3   |
| `src/gate`      | Redactor and outbound gate; every model request passes through it                         | PRV-1, PRV-2    |
| `src/agent`     | Tool interfaces, deterministic mock model adapter, orchestrator (stub)                    | CHAT-1 … CHAT-4 |
| `src/forecast`  | Typed stub for the 90-day projection and runway                                           | FC-1 … FC-4     |
| `src/policy`    | Typed stub for policy extraction, coverage and comparison                                 | POL-1 … POL-5   |
| `src/ui`        | One page: balances, earmarks, approval card, audit log, privacy panel, settings           | DASH-1, PRV-1   |
| `scripts/seed`  | Deterministic synthetic data generator and the fixture-writing CLI                        | PRD §8          |
| `relay`         | One Hono function that adds the API key and forwards the request                          | PRD §9          |
| `tools`         | The ledger write boundary checker shared by CI and the test suite                         | LED-3           |
| `fixtures`      | CSV, adversarial, ledger and edge fixtures                                                | PRD §8          |

## The action flow

```
model / UI form / chat
        │  (only ever a proposal)
        ▼
  propose(action, params, provenance)
        │
        ├─ 1. registry lookup          unknown action  → refused, logged      (ACT-1)
        ├─ 2. tier                     T0/T1           → refused, no side effect (ACT-2)
        ├─ 3. param schema             invalid params  → refused, logged
        ├─ 4. provenance               untrusted text setting action/amount/
        │                              target account  → refused, logged      (PRD §6)
        ├─ 5. feature flag             T3 with SIM_T3 off → refused, logged   (ACT-4)
        ├─ 6. guardrails               any rule fails  → refused, logged      (ACT-5)
        ▼
   pending proposal  ── hash covers action, tier, params, provenance, diff,
        │                guardrails, expiry, idempotency key, createdAt
        │
        │  UI renders the approval card, which asks for a one-time token
        │  bound to proposalHash
        ▼
   approve(proposalId, token, pin?)
        ├─ proposal must be pending
        ├─ proposal must not be expired
        ├─ T3 requires the step-up PIN (checked before the token is spent)
        └─ token must be unused, match the proposal and match the hash
        ▼
   execute(proposalId)
        ├─ status must be 'approved'  → nothing changes before approval (ACT-3)
        ├─ params re-validated        → blocked if the stored params are unusable
        ├─ guardrails re-checked      → blocked, logged if the ledger moved (ACT-5)
        ├─ staleness check            → blocked, logged                     (ST8)
        ├─ idempotency key            → blocked if that intent already ran
        └─ apply the effect through the ONLY ledger writer
        ▼
   audit entry 'executed'  →  ledger change is visible
```

Undo is the same flow with `action: "undo"`: it proposes, needs approval, and writes a new
audit entry (`event: "undone"`). Nothing is ever deleted from the audit log (AUD-2).

Guardrails run twice on purpose: once when the proposal is built, and again immediately before
the effect is applied. An approval is for a specific state of the ledger, so if the ledger moved
between approval and execution (another earmark was executed, a transfer used up the daily cap)
the proposal is refused and logged instead of being applied on stale arithmetic.

### Why the model cannot approve

- `src/agent` receives a `ProposalPort` with exactly one method, `propose`.
- `src/agent` is forbidden from importing `actions/approvals`, `actions/executor` or
  `storage/ledger-writes`; `tools/check-ledger-writes.mjs` fails the build if it does.
- An approval token is issued only by the UI component that renders the approval card, and
  it is bound to the proposal hash, so a changed proposal cannot be approved with an old token.

## Ledger write boundary (LED-3)

`src/storage/ledger-writes.ts` is the only module that writes the ledger tables
(`accounts`, `transactions`, `invoices`, `obligations`, `earmarks`). Two importers are
allowed:

1. `src/actions/executor.ts` - every ledger change made at runtime.
2. `src/storage/bootstrap.ts` - the one-off "Load seed data" load, used by the demo and tests.

Anything else fails `npm run lint:boundary` and `src/storage/ledger-write-boundary.test.ts`,
and the ESLint `no-restricted-imports` rule blocks it in the editor too.

## Consistency between the ledger and the audit log

The executor writes the ledger first and then appends the audit entry. If the append fails it
compensates (releases the new earmark, restores the released one, or removes the two
simulated transfer rows) and rethrows, so a ledger change can never exist without an audit
entry.

The audit chain is serialised in-process, so concurrent appends cannot fork it. Two hashes are
computed per entry: `payloadHash` covers the business payload, and `hash` covers the entry
itself plus `prevHash`.

## Money

`Money` is a branded integer type (`src/domain/money.ts`). A plain `number` is not assignable
where money is expected, and `z.number().int()` rejects both floats and unsafe integers, so
floating-point arithmetic on an amount is a type error rather than a review comment. All
arithmetic goes through `addMoney`, `subMoney`, `sumMoney`, `minMoney` and friends.

## Determinism

- All dates are read in UTC (`src/domain/time.ts`).
- The seed generator is a seeded PRNG with no clock and no platform randomness.
  `npm run seed` is byte-for-byte reproducible and the manifest records the dataset hash.
- Services take an injected `Clock`. The demo anchors that clock to the seed's as-of date so
  the numbers on screen are reproducible and the seeded ledger is never stale.
- The mock model adapter is rule-based, not a language model.

## Privacy

`gate.send()` is the only way out of the browser. It redacts names, account and policy
numbers, NIK, phone numbers and email addresses, records the request (payload after
redaction, and a **masked** form of each removed value) for the privacy panel, honours a block
decision, and only then calls the transport. The relay stores and logs nothing, and the
service worker never caches `/api/` responses.

## Deliberate additions to the PRD

Recorded here because they are the only places the code goes beyond the letter of the PRD:

| Addition                                                | Why                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `Transaction.source` accepts `'action'`                 | Simulated transfers need to be distinguishable from CSV and chat rows |
| `AuditEntry` gains `seq`, `action`, `detail` and `hash` | Chain ordering, refusal reasons and execution evidence                |
| `Settings.id` is the literal `'app'`                    | Dexie needs a primary key for the single settings row                 |
| `Proposal` gains `createdAt`                            | Ordering and evidence; `status` is excluded from the hash             |
| Transfer guardrail `amount <= source account balance`   | A simulated transfer must not overdraw the source account             |
| Settings and privacy panels in the UI                   | ST6 needs a PIN-protected settings screen; PRV-1 is a Must            |
