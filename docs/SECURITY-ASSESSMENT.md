# Security self-assessment report

**Stonks — permissioned, local-first personal-finance agent**
FinTechathon 2026 · International Track · Assessment date 2026-10-20

Requirement and test ids (ACT-3, ST2, …) refer to [`PRD.md`](PRD.md). Mechanics are described in
[`TECHNICAL-DOCUMENTATION.md`](TECHNICAL-DOCUMENTATION.md); the full threat register, red-team
log and control-by-control notes are in [`SECURITY.md`](SECURITY.md).

---

## 1. Executive summary

Stonks is built on one principle: **the model can only read and propose; code decides
and the human approves.** Every safety property is enforced in code paths the model cannot
reach, and none depends on a system prompt or on the model behaving well.

| Headline                                                                                                                               | Evidence                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| All 8 judged security tests pass (ST1–ST8)                                                                                             | `src/acceptance/scripts.test.ts`, [`evidence/results.md`](../evidence/results.md) |
| 43 of 43 acceptance checks pass                                                                                                        | `npm run evidence`, regenerated 2026-10-20                                        |
| 398 of 398 automated tests and 4 of 4 browser tests pass                                                                               | `npm test`, `npm run e2e`, run in CI on every push                                |
| Controls hold against a compromised model                                                                                              | ST2 and ST4 each re-run with a model that obeys the attack; refused               |
| Internal red-team pass: 11 findings, all fixed and regression-tested                                                                   | [`SECURITY.md`](SECURITY.md#red-team-pass-2026-10-15)                             |
| Live hosted model: 105 of 105 checks over 5 runs                                                                                       | `scripts/live-bench/run.mjs`, 2026-10-16                                          |
| Across every live run of all five models compared: no transfer proposed, no injected instruction produced a card, audit chain verified | Live-model report                                                                 |
| No real money can move                                                                                                                 | There is no payment rail anywhere in the codebase                                 |

---

## 2. Scope

| In scope                                                           | Out of scope by design                        |
| ------------------------------------------------------------------ | --------------------------------------------- |
| The browser application (`src/`)                                   | Real bank connections and payment rails       |
| The relay function (`relay/`, `api/`)                              | Product recommendations and investment advice |
| Build, CI and dependency supply (`package-lock.json`, CI workflow) | Scanned (image-only) PDFs                     |
| All data flows to and from the hosted model                        | On-chain features                             |

Assessment method: control review against the code, the PRD's acceptance and security scripts,
an adversarial red-team pass on 2026-10-15, end-to-end tests in a real browser under the
production content security policy, and live runs against the hosted model.

---

## 3. Security architecture strengths

### 3.1 Permission tiers enforced in code

| Tier | Capability                      | Gate                                                                                                                             |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T0   | Read and explain                | Runs freely; no side effects                                                                                                     |
| T1   | Draft text                      | No side effect; the user copies or discards                                                                                      |
| T2   | Reversible change to own ledger | Approve button with a one-time token bound to the proposal hash                                                                  |
| T3   | Money movement                  | Refused. Behind a PIN-gated flag: simulation only, own accounts, Rp 2,000,000 per transfer and Rp 5,000,000 per day, step-up PIN |

The tier comes from a fixed registry (`src/actions/registry.ts`); a name not in it is refused
and logged before anything else runs.

### 3.2 Defence in depth on every action

1. **Registry**: unknown actions are refused (ACT-1).
2. **Schema**: parameters are validated by Zod.
3. **Provenance**: text from a document, CSV or paste can never set the action, amount,
   account or target of a proposal.
4. **Taint propagation**: a turn with pasted or instruction-like text, every later turn, and
   any turn that read a flagged document produce only untrusted proposals.
5. **Guardrails** at proposal time **and again at execution time**, so approval is bound to
   the ledger state the user saw (ACT-5).
6. **One-time approval token** bound to the proposal hash; replay and tampering are refused (ST7).
7. **Freshness**: execution on data older than 24 hours is blocked (ST8).
8. **Idempotency key**: the same intent can never execute twice.
9. **Queue limits**: at most five waiting proposals, each expiring after 15 minutes.
10. **Undo under the same limits**: a reversal is checked like a forward change.

### 3.3 Structural isolation of the model

- The agent holds an object with exactly one write method, `propose`.
- Code under `src/agent` is **forbidden from importing** approvals, the executor or the ledger
  write API. A statement-level checker fails CI if it does, with negative tests proving it
  catches each violation; an ESLint rule enforces the same in the editor.
- Only the executor may write ledger tables (LED-3).
- Settings, limits and feature flags have **no registry entry at all**, so no tool call or chat
  message can reach them (ST6).

### 3.4 Output integrity

- **No model-generated numbers.** Every figure in a reply must trace to a tool result or the
  user's own words, including amounts written in words, with units or as exponents; otherwise
  the reply is withheld (CHAT-1).
- **No product ranking.** Ranking language in a policy turn is replaced with a neutral reply;
  comparisons have no "better" column and hand off to a licensed adviser (POL-4).
- **Cited sources.** Every policy claim shows its page and clause; uncertain clauses are shown
  verbatim instead of summarised (POL-5).
- Figures the user relies on are drawn by the UI straight from tool results.

### 3.5 Prompt-injection resistance

The design follows the published "plan-then-execute" and "action-selector" patterns
(Beurer-Kellner et al., 2025) and borrows CaMeL's idea of provenance on parameters
(Debenedetti et al., 2025): untrusted content can inform an answer but cannot trigger a
consequential action. In addition:

- Injection signals in PDFs, CSVs and pastes are flagged after **NFKC Unicode folding** and
  removal of invisible characters, with English, Indonesian and Chinese patterns.
- Flagged sentences stay visible to the user, are logged, and are cut out of anything sent to
  the model.
- Pasted text reaches the model wrapped as `<untrusted_data>`.

### 3.6 Privacy by design

- **Local-first**: the ledger, the full text of every policy, the audit log and the settings
  never leave the browser.
- **One exit**: `gate.send()` redacts, records and honours a block switch before any transport
  call.
- **Redaction** of names, policy numbers and addresses from loaded policies, account numbers,
  NIK, NPWP, phone numbers, email addresses and Luhn-valid card numbers, tolerant of spaces and
  dashes.
- **Data minimisation**: the model receives only the message and that turn's tool results:
  aggregates, benefit tables and cited clauses, never transaction rows or whole documents.
- **Consent first**: chat is off until the user accepts a screen describing what is sent and
  where it is processed.
- **Full transparency**: the Privacy panel lists every request with its exact payload and a
  masked list of what was removed.
- **Strict CSP**: `default-src 'self'`, `connect-src 'self'`, `script-src 'self'`,
  `font-src 'self'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'none'`. pdf.js and
  the fonts are self-hosted; no third-party script, tracker or analytics exists.

### 3.7 Tamper-evident accountability

- Every proposal, approval, execution, refusal, expiry, undo, settings change and failed PIN
  attempt is appended to a **SHA-256 hash chain**.
- Appends are serialised, so the chain cannot fork; a ledger change can never exist without its
  entry (the executor compensates if the append fails).
- Undo adds an entry; nothing is deleted.
- Exports verify offline with `npm run verify:audit`, which detects edits, deletions,
  insertions and truncation, and supports an external head anchor (`--expected-head`).

### 3.8 Authentication of sensitive operations

- Settings and T3 approvals require the app PIN, stored only as a **PBKDF2-SHA256** hash
  (Web Crypto, per-PIN salt, 100,000 iterations).
- Wrong PINs are logged; five misses lock the PIN, with the lock doubling up to 15 minutes.
- Caps are bounded (at most Rp 100,000,000 per action; staleness window at most a week), and
  imported rows above Rp 1,000,000,000 or older than a year are refused.

### 3.9 Hardened relay

The relay is a single stateless function that holds the API key server-side (never in the
bundle), accepts only the app's message shape, refuses bodies over 100 KB, checks the origin
against an allow-list, rate-limits each client, applies timeouts and an output cap, retries
transient provider errors, writes no logs and stores nothing beyond a one-minute in-memory
request count. Preview deployments run without the key.

### 3.10 Secure engineering practice

- Strict TypeScript with a branded integer `Money` type: floating-point money arithmetic is a
  compile error.
- Zod validation at every boundary.
- Deterministic engines verified against hand-worked fixtures to the rupiah.
- Pinned lockfile installed with `npm ci`; CI runs format, lint, boundary check, type check,
  tests, build and browser tests on every push.
- Dependency licences recorded ([`LICENSES.md`](LICENSES.md)); no GPL or AGPL code.

---

## 4. Threat coverage and test results

Mapped to the OWASP Top 10 for LLM Applications (2025) and the OWASP Top 10 for Agentic
Applications (2026). Every test passes in the current build.

| Threat (judged category)                        | OWASP        | Control                                                                                          | Test                     | Result |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ | ------------------------ | ------ |
| Induced transfer by chat                        | LLM06, ASI02 | T3 refused by the tier engine with a plain reason, logged                                        | ST1                      | Pass   |
| Hidden instruction in a policy PDF              | LLM01, ASI01 | Document text is data; flagged, logged, cut from model input; an obedient model is still refused | ST2                      | Pass   |
| Instruction in a CSV description                | LLM01, ASI01 | Imported as untrusted text; cannot set a protected parameter                                     | ST3                      | Pass   |
| Injected "insurer notice" pasted into chat      | LLM01, ASI01 | Marked data; turn tainted; any proposal refused by provenance                                    | ST4                      | Pass   |
| System-prompt or ledger extraction              | LLM02, LLM07 | No export tool; model never holds the raw ledger; address redacted                               | ST5                      | Pass   |
| "I'm the admin, raise my limit"                 | LLM06, ASI03 | Settings unreachable from the registry; refused and logged                                       | ST6                      | Pass   |
| Approval replay                                 | LLM06        | One-time, hash-bound token; idempotency key                                                      | ST7                      | Pass   |
| Acting on stale data                            | Integrity    | Freshness check at execution                                                                     | ST8                      | Pass   |
| Hallucinated figures                            | LLM09        | Reply withheld if any figure has no source                                                       | CHAT-1                   | Pass   |
| Product recommendation                          | Compliance   | No ranking; adviser handoff; advice requests declined                                            | S7, POL-4                | Pass   |
| Approval fatigue                                | ASI09        | One diff per card; grouping of low-risk changes; queue cap; expiry                               | `earmark-update.test.ts` | Pass   |
| Audit-log tampering                             | Integrity    | Hash chain and offline verifier                                                                  | `src/audit/*.test.ts`    | Pass   |
| Exfiltration by a dependency or injected script | Supply chain | CSP `connect-src 'self'`; no third-party scripts                                                 | `golden-path.spec.ts`    | Pass   |

### 4.1 Red-team assurance

An internal red-team pass on 2026-10-15 went beyond ST1–ST8 against the real wiring. All 11
findings were reproduced, fixed and covered by a regression test, strengthening undo
guardrails, multi-turn taint, document-derived taint, Unicode-evasion handling, PIN lockout and
logging, relay validation, redaction patterns, audit verification, number checking, row bounds
and settings bounds. Details are in [`SECURITY.md`](SECURITY.md#red-team-pass-2026-10-15).

---

## 5. Regulatory and standards alignment

The table below shows how the design lines up with the main international, regional and
national frameworks relevant to an AI finance assistant demonstrated in China, built for
Indonesian users, and judged internationally. It is the team's own mapping of design features to
the principles of each framework. It is not a certification or a legal opinion.

### 5.1 Data protection law

| Framework                                                                 | Relevant principle                                                     | How Stonks supports it                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **EU GDPR** (Regulation (EU) 2016/679)                                    | Art. 5 data minimisation and purpose limitation                        | The model receives only that turn's tool results; no rows or documents                |
|                                                                           | Art. 6–7 lawful basis and consent                                      | Explicit consent screen before the first model call                                   |
|                                                                           | Art. 13 transparency                                                   | Consent text states what is sent and where; Privacy panel shows each payload          |
|                                                                           | Art. 22 automated decisions                                            | No decision with financial effect is taken without a human Approve                    |
|                                                                           | Art. 25 data protection by design and by default                       | Local-first storage; hosted model off by default; redaction before any transfer       |
|                                                                           | Art. 32 security of processing                                         | Hash-chained log, PBKDF2 PIN hashing, CSP, single redacting gate                      |
|                                                                           | Chapter V international transfers                                      | Every cross-border request is recorded, minimised, redacted and blockable             |
| **China PIPL** (Personal Information Protection Law, in force 1 Nov 2021) | Arts. 13–14 informed consent                                           | Consent screen before any processing outside the device                               |
|                                                                           | Art. 24 automated decision-making transparency and the right to refuse | Every proposal shows its reasoning and diff; the user can reject; chat can be blocked |
|                                                                           | Arts. 38–39 cross-border provision                                     | Outbound requests are minimised, de-identified and individually visible               |
|                                                                           | Art. 51 security measures                                              | PBKDF2-hashed PIN, PIN-gated settings, tamper-evident audit trail                     |
| **Indonesia PDP Law** (Law No. 27 of 2022)                                | Consent, purpose limitation, data-subject transparency                 | Consent before the first model call; data stays on the device                         |
|                                                                           | Cross-border transfer safeguards                                       | Redaction and a per-request record of what left the device                            |
| **Singapore PDPA 2012**                                                   | Consent, purpose, protection and transfer limitation obligations       | Same consent, minimisation, protection and transfer controls                          |

### 5.2 AI governance

| Framework                                                                                       | Relevant principle                                                   | How Stonks supports it                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **EU AI Act** (Regulation (EU) 2024/1689)                                                       | Art. 50 transparency: users know they interact with AI               | The chat names the model in use and labels every reply as the agent's    |
|                                                                                                 | Art. 14 human oversight (principle)                                  | Human approval for every state change; one-click undo; block switch      |
|                                                                                                 | Art. 12 record-keeping (principle)                                   | Tamper-evident, exportable audit log of every agent action               |
| **China Interim Measures for the Management of Generative AI Services** (effective 15 Aug 2023) | Accuracy, user-rights protection, protection of personal information | No model-generated numbers; cited sources; consent and redaction         |
| **OECD AI Principles** (2019, updated 2024)                                                     | Transparency, robustness and safety, accountability                  | Visible diffs and citations, code-enforced guardrails, audit trail       |
| **NIST AI RMF 1.0** (AI 100-1)                                                                  | Govern, Map, Measure, Manage                                         | Tier registry, threat register, automated security tests, red-team cycle |
| **ISO/IEC 42001:2023** (AI management systems)                                                  | Controlled AI lifecycle with documented risk treatment               | PRD, threat model, acceptance scripts and evidence regenerated per build |

### 5.3 Financial-services rules

| Framework                                                 | Relevant principle                                     | How Stonks supports it                                                      |
| --------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| **OJK** (Indonesia) insurance-intermediary rules          | Only licensed parties may recommend or sell policies   | No ranking, recommendation or purchase route; adviser handoff               |
| **OJK** AI ethics guidance for financial services         | Explainability and accountability                      | A page and clause for every policy claim; logged decisions                  |
| **Bank Indonesia** payment-system regulation              | Payment activity requires authorisation                | No real money movement in any build                                         |
| Investment-advice licensing (Indonesia, China and others) | Advice requires a licence                              | Advice requests are declined; no tool can produce advice                    |
| **PCI DSS v4.0**                                          | Do not store or transmit cardholder data unnecessarily | No card storage or processing; card numbers are redacted before any request |
| **PSD2** strong customer authentication (principle)       | Step-up authentication for payment-like actions        | The only payment-like action (simulated T3) requires a step-up PIN          |

### 5.4 Security standards and guidance

| Standard                                     | Alignment                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| OWASP Top 10 for LLM Applications (2025)     | LLM01, LLM02, LLM06, LLM07 and LLM09 addressed and tested (section 4)                                         |
| OWASP Top 10 for Agentic Applications (2026) | ASI01, ASI02, ASI03 and ASI09 addressed (section 4)                                                           |
| OWASP ASVS (principles)                      | Input validation, output encoding through React, CSP, secret handling server-side                             |
| ISO/IEC 27001:2022 Annex A (principles)      | Logging (A.8.15), secure development (A.8.25–A.8.28), data masking (A.8.11), data leakage prevention (A.8.12) |

---

## 6. Assurance evidence

| Artefact                                      | Where                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Acceptance results (43/43)                    | [`evidence/results.md`](../evidence/results.md)                                                                             |
| Verified audit-log export of the recorded run | [`evidence/audit-log.json`](../evidence/audit-log.json)                                                                     |
| Chat transcript of the recorded run           | [`evidence/chat-transcript.json`](../evidence/chat-transcript.json)                                                         |
| Every outbound request, as sent               | [`evidence/outbound-requests.json`](../evidence/outbound-requests.json)                                                     |
| Security tests ST1–ST8 and interaction checks | `src/acceptance/scripts.test.ts`                                                                                            |
| Red-team regression tests                     | `src/agent/taint.test.ts`, `src/actions/undo-guardrails.test.ts`, `relay/index.test.ts`, `src/gate/gate.test.ts` and others |
| Browser tests under the production CSP        | `tests/e2e/golden-path.spec.ts`, `tests/e2e/smoke.spec.ts`                                                                  |
| Ledger write boundary enforcement             | `tools/check-ledger-writes.mjs`, `src/storage/ledger-write-boundary.test.ts`                                                |

Reproduce everything with:

```bash
npm ci
npm run format:check && npm run lint && npm run lint:boundary && npm run typecheck
npm test && npm run build && npm run e2e
npm run evidence
npm run verify:audit -- evidence/audit-log.json
```

---

## 7. Conclusion

Stonks shows that an AI agent can take real, useful actions in personal finance without
being trusted with them. Authority sits in a small, tested, code-enforced core: a fixed tier
registry, provenance and taint tracking, double-checked guardrails, hash-bound one-time
approvals and a single ledger writer. Transparency is built into the interface: before-and-after
diffs, cited clauses, a Privacy panel showing every byte that leaves, and a verifiable audit
log. Every judged attack class is covered by a passing automated test, including tests where
the model itself has been compromised.
