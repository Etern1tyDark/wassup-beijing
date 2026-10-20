# Technical documentation

**Stonks — a permissioned, local-first personal-finance agent**
FinTechathon 2026 · International Track · Topic A (Personal Finance Assistant), with policy
coverage (Topic D) and the late-invoice scenario (Topic E) as supporting features.

Version as of 2026-10-20 · Requirement ids (ACT-3, LED-2, …) refer to [`PRD.md`](PRD.md).
The companion documents are [`SECURITY-ASSESSMENT.md`](SECURITY-ASSESSMENT.md) (security and
compliance), [`ARCHITECTURE.md`](ARCHITECTURE.md) (design notes) and [`DEPLOY.md`](DEPLOY.md).

---

## 1. Summary

Stonks is an AI agent that can **act** on a person's money picture, but only inside
limits the person sets, in the open, and with undo. It answers "how long can I cover my
costs?", "does my policy cover a hospital stay?" and "what if my client pays late?", and when a
change is useful it **proposes** it as a card showing the exact before and after. Nothing
changes until the user presses Approve. Every proposal, approval, execution, refusal and undo
is written to a tamper-evident, hash-chained audit log.

| Property                  | How it is achieved                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| The model cannot act      | Its only write capability is `propose`; tiers and guardrails are decided by code                 |
| Every number is computed  | Pure, deterministic engines in integer rupiah; a reply with an unsourced number is withheld      |
| Data stays on the device  | Ledger, policies and log live in the browser (IndexedDB); one redacting gate is the only way out |
| Everything is explainable | Before/after diff on every card, page-and-clause citation on every policy claim                  |
| Everything is reversible  | Every ledger change has an undo, which is itself approved and logged                             |
| No real money moves       | There is no payment rail anywhere in the codebase                                                |

**Primary user.** Rina, a freelance designer paid late by several clients, with a health policy
she has never read closely. She needs to know her runway, whether a late invoice or a hospital
stay would break her budget, and to set money aside safely.

---

## 2. System at a glance

```
┌───────────────────────────── Browser (all user data lives here) ─────────────────────────────┐
│                                                                                               │
│  Statement CSV ─┐                                                                             │
│  Policy PDF ────┼─► importers (CSV parser, pdf.js) ─► IndexedDB: ledger · policies · audit    │
│  Chat message ──┘          injection flagging                      │                          │
│                                                                    ▼                          │
│                          Pure engines: ledger · forecast · policy coverage                    │
│                                                                    │                          │
│        ┌──────────── UI (React) ◄──────── approval card ◄──── tier engine ◄── propose() ◄──┐  │
│        │  Approve (one-time token)              registry · guardrails · provenance          │  │
│        ▼                                                                                    │  │
│     executor ── the ONLY ledger writer ──► audit log (SHA-256 hash chain)                   │  │
│                                                                                             │  │
│                     agent orchestrator ── tools (read + propose only) ──────────────────────┘  │
│                            │                                                                  │
│                            ▼                                                                  │
│                 gate.send(): redact ─► record ─► block? ─► transport                          │
└────────────────────────────┼──────────────────────────────────────────────────────────────────┘
                             │ default build: local stub, nothing leaves the browser
                             ▼ VITE_MODEL=relay
                  /api/model (stateless relay, same origin) ─► hosted model (glm-5.3-flash)
```

The application is a static single-page app plus one optional, stateless serverless function.
With the default build it runs fully offline, with no account, API key or network.

---

## 3. Technology stack

| Layer        | Choice                                                | Why                                                        |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------- |
| Language     | TypeScript 5.9 (strict)                               | Branded types make money and ids impossible to mix up      |
| UI           | React 19, Vite 8, hand-written CSS design system      | Small bundle, no CSS framework, works under a strict CSP   |
| Storage      | IndexedDB through Dexie 4                             | Durable, browser-local, survives reloads                   |
| Validation   | Zod 4 schemas for every entity                        | One source of truth for shape and range checks             |
| PDF reading  | pdf.js 6 (bundled, same origin)                       | Text layer read in the browser; no upload                  |
| Crypto       | Web Crypto (SHA-256, PBKDF2-SHA256)                   | Platform primitive; no crypto dependency                   |
| Relay        | Hono 4 on Vercel serverless                           | One small function; holds the key, stores nothing          |
| Hosted model | `glm-5.3-flash` via an OpenAI-compatible API, temp 0  | Chosen after a five-model comparison (105/105 live checks) |
| Fonts        | Inter and Manrope, self-hosted (`@fontsource`)        | Keeps the CSP at `font-src 'self'`                         |
| Testing      | Vitest 5, Testing Library, fake-indexeddb, Playwright | Unit to end-to-end, in CI on every push                    |
| Offline      | Service worker (same-origin app shell), PWA manifest  | Installable; never caches `/api/` responses                |

The production bundle ships only React, Dexie, Zod and pdf.js as third-party code. There are
no analytics, trackers or third-party scripts. Every dependency and its licence is listed in
[`LICENSES.md`](LICENSES.md); none is GPL or AGPL.

---

## 4. Module map

| Path             | Responsibility                                                                          |
| ---------------- | --------------------------------------------------------------------------------------- |
| `src/domain`     | Zod schemas, integer-rupiah `Money` type and helpers, UTC date helpers                  |
| `src/storage`    | Dexie database, read-only repositories, the restricted ledger write API, seed loader    |
| `src/ledger`     | Pure functions: balance per account, free cash, safe-to-spend                           |
| `src/forecast`   | Pure functions: 90-day projection, runway, what-if scenarios, spending alerts           |
| `src/importers`  | CSV parser with line-numbered errors, PDF text reader, categoriser, injection flagger   |
| `src/policy`     | Rule-based clause extractor, coverage and comparison engine, policy store               |
| `src/actions`    | Registry, tier engine, guardrails, provenance, approval tokens, executor, settings, PIN |
| `src/audit`      | Append-only SHA-256 hash chain, JSON export, verifier and CLI                           |
| `src/gate`       | Redactor and outbound gate; every model request passes through it                       |
| `src/agent`      | Tools, the tool-calling loop, reply verification, rule-based model, relay adapter       |
| `src/ui`         | App shell, dashboard panels, chat, approvals, audit, privacy, settings, i18n, theme     |
| `src/acceptance` | The PRD's task scripts, interaction checks and security tests                           |
| `relay`          | The Hono relay: validation, origin allow-list, rate limit, provider translation         |
| `scripts`        | Deterministic seed generator, evidence writer, live-model benchmark                     |
| `tools`          | The ledger write boundary checker used by CI and the test suite                         |

---

## 5. The permission model

### 5.1 Tiers

| Tier | What the agent may do                    | Approval                                                                             | Actions                                                                                                          |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| T0   | Read and explain                         | None                                                                                 | `get_summary`, `get_runway`, `run_scenario`, `get_spending`, `list_policies`, `get_coverage`, `compare_policies` |
| T1   | Draft text with no side effect           | None; the user copies or discards it                                                 | `draft_reminder`                                                                                                 |
| T2   | Change the user's own ledger, reversibly | Approve button with a one-time, hash-bound token                                     | `earmark.create`, `earmark.update`, `earmark.delete`, `statement.import`, `transaction.add`, `undo`              |
| T3   | Move money                               | Refused. Behind a PIN-gated flag: simulation only, own accounts, capped, step-up PIN | `transfer`                                                                                                       |

The registry in `src/actions/registry.ts` is the complete list. Any other name is refused and
logged before anything else happens.

### 5.2 The action flow

```
propose(action, params, provenance)
  ├─ 1. registry lookup     unknown action          → refused, logged      (ACT-1)
  ├─ 2. tier                T0/T1 are never proposed                       (ACT-2)
  ├─ 3. parameter schema    invalid params          → refused, logged
  ├─ 4. provenance          untrusted text sets a protected field → refused (PRD §6)
  ├─ 5. feature flag        T3 with simulation off  → refused, logged      (ACT-4)
  ├─ 6. guardrails          any rule fails          → refused, logged      (ACT-5)
  └─ 7. approval queue      five already waiting    → refused, logged
        ▼
  pending proposal — SHA-256 hash over action, tier, params, provenance, diff,
                     guardrails, expiry, idempotency key and creation time
        ▼
  approve(proposalId, token, pin?)
  ├─ pending and not expired (15-minute lifetime)
  ├─ T3: step-up PIN checked before the token is spent
  └─ token unused, bound to this proposal and to its hash
        ▼
  execute(proposalId)
  ├─ status must be 'approved'                    (ACT-3)
  ├─ parameters re-validated, guardrails re-run   (ACT-5)
  ├─ data freshness check (24 hours)              (ST8)
  ├─ idempotency key check                        (ST7)
  └─ effect applied through the only ledger writer → 'executed' audit entry
```

Guardrails run **twice**: when the proposal is built and immediately before execution. An
approval is for a specific ledger state, so if the ledger moved in between, the proposal is
refused rather than applied on stale arithmetic.

### 5.3 The actions

| Action             | Tier | Effect when approved                                    | Undo                                         |
| ------------------ | ---- | ------------------------------------------------------- | -------------------------------------------- |
| `earmark.create`   | T2   | Sets money aside under a label, with a review date      | Releases it                                  |
| `earmark.update`   | T2   | Changes the label, amount or review date                | Restores the previous values                 |
| `earmark.delete`   | T2   | Releases an earmark                                     | Restores it                                  |
| `statement.import` | T2   | Adds the rows of a statement CSV                        | Removes exactly those rows                   |
| `transaction.add`  | T2   | Adds one transaction typed in chat                      | Removes it                                   |
| `undo`             | T2   | Reverses a named executed action, under the same limits | Logged as `undone`; the original entry stays |
| `transfer`         | T3   | Simulated move between two of the user's own accounts   | A reversing pair of rows                     |

### 5.4 Structural separation

- The agent receives a `ProposalPort` with exactly one method, `propose`.
- Nothing under `src/agent` may import approvals, the executor or the ledger write API.
  `tools/check-ledger-writes.mjs` enforces this at statement level in CI and in the test suite,
  and an ESLint `no-restricted-imports` rule enforces it in the editor.
- Only `src/actions/executor.ts` (and the one-off seed loader) may write a ledger table (LED-3).
- Approval tokens are issued only by the UI component that renders the card.

---

## 6. Core algorithms

All engines are pure functions over plain data in **integer rupiah**. The model never runs
them and never does arithmetic; it only reads their results.

### 6.1 Money

`Money` is a branded integer type. A plain `number` cannot be passed where money is expected,
and the schema rejects floats and unsafe integers, so floating-point money arithmetic is a
compile-time error. All arithmetic goes through `addMoney`, `subMoney`, `sumMoney` and friends.

### 6.2 Ledger (`src/ledger/engine.ts`)

```
balance(account) = openingBalance + Σ transactions(account)
free cash        = Σ balances − Σ active earmarks
safe to spend    = free cash − Σ obligations due within 30 days
```

Recurring obligations repeat from their original due date, so the day of the month never
drifts (a bill due on the 31st falls on 28 February, then 31 March).

### 6.3 Forecast and runway (`src/forecast/index.ts`)

For each day `d = 0 … 90`:

```
balance(d)   = starting balance
             + invoices expected on or before d
             − obligation occurrences on or before d
             − floor(typical spend × d / 90)
             − scenario expense dated on or before d
free cash(d) = balance(d) − active earmarks
```

- **Conservative by design.** An overdue invoice has no known payment date, so it is never
  counted as incoming money; it is listed as "left out" on screen and in every reply.
- **Typical spend** is the day-to-day outflow of the last 90 days, excluding income, modelled
  obligations, one-offs and own-account transfers, spread with `floor` so totals stay exact.
- **Runway** is the first day free cash falls below zero, searched up to 730 days.
- **Scenarios** shift named invoices and/or add a one-off expense. Each also reports the
  **pinch**: the lowest free cash before the late money arrives, so a delay that leaves the
  runway unchanged still shows how much tighter the coming weeks get.
- **Alerts**: negative safe-to-spend, projected shortfall, overdue invoices left out, spending
  above safe-to-spend, earmarks past their review date.
- Every result is labelled with its scenario, inputs and as-of date (FC-4).

The engine is verified to the rupiah against a hand-worked fixture
(`fixtures/forecast/hand-worked.json`).

### 6.4 Policy extraction (`src/policy/extractor.ts`)

pdf.js returns the text of each page; the extractor then:

1. reads the header (name, insurer, type, policy number, insured, address) and hands the
   personal fields to the redactor;
2. splits each page into clauses at `Clause N.`, keeping page, number, title and text;
3. treats "We pay…" clauses as benefits and reads the limit, co-payment, waiting period and
   clause-level exclusions;
4. scores confidence; anything below 0.7 is shown as the raw clause, never summarised (POL-5);
5. records instruction-like sentences as injection signals; they stay visible to the user and
   are cut from anything sent to a model.

The extractor is rule-based: the same file always yields the same items, offline, and no
policy figure ever comes from a model.

### 6.5 Coverage (`src/policy/coverage.ts`)

```
cost              = user's estimate, or a stated reference cost for the event
in waiting        = waiting days > 0 and as-of < start + waiting days
policy pays       = in waiting ? 0 : min(limit, max(0, cost − co-payment))
out of pocket     = cost − policy pays                               (POL-2)
shortfall         = max(0, out of pocket − free cash)                (POL-3)
suggested reserve = the co-payment — the part that is certain
```

Every figure is shown with the page and clause it came from. With no matching benefit the
answer is "I can't confirm", with the nearest text. Comparisons (POL-4) lay the same fields
side by side with no ranking column, and point to a licensed adviser.

---

## 7. The agent

### 7.1 Loop

```
user message (+ optional pasted text)
  ├─ pasted or instruction-like?  → wrapped as <untrusted_data>; the turn and every later
  │                                  turn are tainted, so any proposal they make is refused
  ▼
model.complete(history, tools) — always through gate.send()
  ├─ T0/T1 tool → runs, returns data
  ├─ T2/T3 tool → propose() → pending card or a plain-language refusal
  └─ unknown    → propose() refuses and logs it
     (at most 6 rounds per turn)
  ▼
reply verification (src/agent/verify.ts)
  ├─ every number must appear in a tool result or the user's own words, else withheld (CHAT-1)
  └─ ranking language in a policy turn → replaced with a neutral reply             (POL-4)
```

The reply is short text. The tables and figures the user sees are rendered by the UI directly
from tool results, so the model never formats a number the user relies on.

### 7.2 Two interchangeable model adapters

| Adapter                   | Use                                             | Network                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------ |
| `mock-model.ts` (default) | Rule-based stand-in for tests and offline demos | None; the gate's transport is a stub |
| `relay-model.ts`          | Hosted model through `/api/model`               | Redacted payload, same origin        |

The orchestrator, tools and checks are identical for both, so safety never depends on which
model is behind the chat. The hosted path was benchmarked live: **105 of 105 checks over five
runs** on 2026-10-16 (median reply 2.9 s), with five candidate models compared first.

### 7.3 Interaction quality

- **Clarification**: "Check my policy" with two policies loaded asks which one (I1).
- **Correction**: "No, I meant last month" recomputes without restarting (I2).
- **Honest fallback**: an unknown benefit gets "I can't confirm" plus the nearest clause (I3);
  an unknown client is reported with the clients that do have open invoices (CHAT-4).
- **Graceful degradation**: if the model is blocked or unreachable, chat says so and every
  other panel keeps working.

---

## 8. Privacy architecture

`gate.send()` is the single exit from the browser. For every request it:

1. **redacts** names, policy numbers and addresses seen in loaded policies, account-like
   numbers, NIK, NPWP, phone numbers, email addresses, and Luhn-valid card numbers, using
   separator-tolerant patterns;
2. **records** the payload exactly as it will leave, plus a masked list of what was removed;
3. **honours** a user block switch;
4. only then calls the transport.

The model can receive only the user's message and that turn's tool results (aggregates,
benefit tables, cited clauses). It never receives transaction rows or a whole document. Chat
stays off until the user accepts a consent screen explaining what is sent and where. The
Privacy panel lists every request with its exact payload.

The relay holds the API key server-side, validates the message shape and size, checks the
origin, rate-limits per client, writes no logs and stores nothing beyond a one-minute in-memory
request count.

---

## 9. Audit log (`src/audit`)

- Every proposal, approval, execution, refusal, expiry, undo, settings change and failed PIN
  attempt is an entry.
- Each entry carries `payloadHash` (the business payload) and `hash` (the entry plus
  `prevHash`), forming a SHA-256 chain. Appends are serialised, so the chain cannot fork.
- The executor writes the ledger, then the audit entry; if the append fails it compensates, so
  a ledger change can never exist without its log entry.
- Undo adds an entry; nothing is ever deleted (AUD-2).
- The log exports to JSON and verifies offline with `npm run verify:audit -- <file>`, which
  also checks the stated length and head, and accepts `--expected-head` for an externally kept
  anchor.

---

## 10. Data model

IndexedDB (Dexie) tables:

| Table                                          | Contents                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `accounts`                                     | Bank, e-wallet and savings accounts with opening balances        |
| `transactions`                                 | Dated rows with category and source (`csv`, `chat`, `action`, …) |
| `invoices`                                     | Client, amount, due date, paid date                              |
| `obligations`                                  | Bills and recurring costs with recurrence                        |
| `earmarks`                                     | Money set aside: label, amount, review date, active flag         |
| `policies`, `coverageItems`, `policyDocuments` | Extracted policy, benefits and the clause text with pages        |
| `proposals`                                    | Pending, approved, executed, rejected and expired proposals      |
| `auditEntries`                                 | The hash-chained log                                             |
| `settings`                                     | Caps, flags, staleness window, PIN hash (PBKDF2-SHA256)          |
| `outboundRequests`                             | Every gate request as recorded for the Privacy panel             |

All demo data is synthetic and generated deterministically by `npm run seed` (seeded PRNG, no
clock, byte-for-byte reproducible, with a dataset hash in the manifest). The sample policy
PDFs are written by a dependency-free PDF writer, so they are reproducible too.

---

## 11. User interface

The interface is designed so that the safety model is visible, not just enforced.

- **App shell**: a sidebar with scroll-tracking navigation across five sections (Overview,
  Assistant, Insurance, Cash moves, Trust & control) and a live badge for waiting approvals; a
  top bar with the as-of date, theme toggle, language toggle and reset.
- **Home page** (`#/`): a full product page with a hero and a live-looking preview of an
  approval card, the recorded results (43/43 acceptance checks, 8/8 judged attack tests),
  features, a three-step "how it works", the security model and the four permission tiers, and
  a call to action. "Launch demo" (or "Open your dashboard" once data exists) opens the app.
- **Routing**: hash routes (`#/` home, `#/demo` app, `#/demo/<section>` deep links) need no
  server rewrite, survive a reload and work with the browser's Back button. The logo, a Home
  link in the top bar and a "Back to home" item in the sidebar always lead back. The demo's
  empty state offers "Load the demo data" and the way home.
- **Overview**: KPI tiles led by Safe to spend; a 90-day free-cash area chart with axis labels,
  a lowest-point marker and hover readout; account balances with proportional bars.
- **Assistant**: chat bubbles with suggestion chips and a composer, next to the approvals queue.
  Each approval card shows Now and After approval side by side with direction arrows, the
  guardrail checklist, expiry, proposal hash and provenance. Low-risk proposals share one card;
  "Approve all" still approves, checks and logs each one individually.
- **Insurance and Cash moves**: drop-zone uploads, sample files (attack demos clearly marked),
  policy cards with cited clauses, earmark management.
- **Trust & control**: the audit log with undo, chain verification and export; the Privacy
  panel with every outbound payload and a block switch; PIN-protected settings.
- **Accessibility and reach**: light and dark themes (following the system, with a stored
  override), English and Bahasa Indonesia labels, keyboard focus rings, `prefers-reduced-motion`
  support, ARIA labelling, and a responsive layout down to 390 px with no horizontal scroll.
- New approval cards scroll into view and take focus, so the before-and-after is what the
  user reads next.

---

## 12. Quality engineering

| Gate                              | Command                 | Status (2026-10-20) |
| --------------------------------- | ----------------------- | ------------------- |
| Formatting                        | `npm run format:check`  | Pass                |
| Lint                              | `npm run lint`          | Pass                |
| Ledger write boundary (LED-3)     | `npm run lint:boundary` | Pass (97 files)     |
| Type check (strict)               | `npm run typecheck`     | Pass                |
| Unit, integration, acceptance, UI | `npm test`              | **398 / 398 pass**  |
| Production build                  | `npm run build`         | Pass                |
| End-to-end in Chromium            | `npm run e2e`           | **4 / 4 pass**      |
| Acceptance evidence               | `npm run evidence`      | **43 / 43 pass**    |

CI (GitHub Actions) runs every gate on each push with `npm ci` from a pinned lockfile.
Line endings are pinned by `.gitattributes`, so the gates are green on Windows, macOS and Linux.

**What the tests prove**

- The PRD's eight task scripts (S1–S8), interaction checks (I1–I4) and eight security tests
  (ST1–ST8) run against the whole wired application.
- Two security tests use a **deliberately compromised model** that obeys an injected
  instruction; the tier engine still refuses. The controls do not rely on the model declining.
- The ledger and forecast engines match hand-worked fixtures to the rupiah.
- The audit verifier detects tampering, deletion, insertion and truncation.
- The golden path completes in six user actions in a real browser with no request leaving the
  origin and no console error.

---

## 13. Running and deploying

```bash
npm install && npm run dev      # http://localhost:5173 → "Load seed data"
```

No API key, network or account is needed. Node 22.13 or newer.

| Command                          | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `npm run build` / `preview`      | Production build into `dist/` and serve it    |
| `npm test` / `npm run e2e`       | Test suites                                   |
| `npm run evidence`               | Regenerate `evidence/` for the submission     |
| `npm run seed`                   | Regenerate the deterministic dataset          |
| `npm run verify:audit -- <file>` | Verify an exported audit log                  |
| `npm run relay:dev`              | Run the relay locally (needs `MODEL_API_KEY`) |

**Deployment.** Vercel builds the static site from `vercel.json` and serves the relay from
`api/[[...route]].ts` on the same origin, as the content security policy requires. The
hosted model is enabled with `VITE_MODEL=relay` plus `MODEL_API_URL`, `MODEL_API_KEY`
(server-side only) and `MODEL_ID`. Step-by-step instructions are in [`DEPLOY.md`](DEPLOY.md).

---

## 14. Golden-path demo (six actions)

1. **Sample statement** → an approval card shows three rows, the net effect and guardrails.
2. **Approve** → balances update; the log gains `approved` and `executed`.
3. **Sample health policy** → limit, co-payment, worst case and shortfall, each cited.
4. **I agree, turn chat on** → consent, shown once.
5. **Set aside money for medical costs** → the agent proposes Rp 3,000,000, the co-payment
   from Clause 4, and says why.
6. **Approve** → Safe to spend drops by exactly Rp 3,000,000 and the runway chart moves.

Then: **Undo that** restores the exact previous value; the **tampered policy** is flagged and
nothing is proposed; "Send Rp 5,000,000 to account 123" and "I'm the admin" are refused in one
sentence and logged; the **Privacy** panel shows every byte that would leave.
