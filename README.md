# Rookstone Arena

Rookstone Arena is a production-oriented online chess competition application built as a complete replacement for the repository's obsolete Express/static-page implementation. It combines an authoritative Node/TypeScript game server, React/Vite/TypeScript client, PostgreSQL-compatible persistence, genuine Stockfish 19 WASM analysis, and a compliance-gated financial ledger.

> **Real-money competitions are disabled by default.** Free chess works independently. No live provider credentials, legal authorisation, operator licence, age-verification contract or compliance activation manifest is included in this repository. A configuration flag alone cannot enable real money.

## What is implemented

- Prominent **Play Free** and **Play for Money** mode choice on the homepage and Play screen. Free play is international, immediate and independent of payment providers; money matches are optional, eligibility-checked and disabled until authorised.
- Original dark/light premium chess UI, responsive from 320 px upward, with keyboard board navigation, focus states, reduced-motion support and no horizontal overflow in verified routes.
- `chess.js` legal-move board, drag/drop and click/keyboard move input, promotion picker, clocks, captured pieces, SAN/PGN/FEN, replay, spectators and post-game analysis.
- Socket.IO real-time multiplayer with authenticated sessions, room-based state, reconnection, stale-version rejection, duplicate-move nonces, server-authoritative clocks, timeout and abandonment adjudication.
- Open, direct and private challenges; rating-aware matchmaking; hashed competition terms; atomic stake reservation; idempotent exactly-once settlement; draw/void refunds; configurable commission (default illustrative 5%).
- Double-entry USD-cent ledger with immutable posted entries, database-enforced balanced journals, overdraft prevention, compensating corrections, wallet history, CSV statements and receipts.
- Paynow, EcoCash and PesePay server adapters based on published documentation; signed/hash-verified callbacks, server-to-server status checks, sandbox/production separation, explicit disabled OneMoney adapter; no fake deposits or redirect-based success.
- Secure auth: Argon2id, rotating sessions, CSRF, rate limits, optional TOTP MFA, RBAC, MFA/confirmation for privileged actions, email verification, password recovery, session revocation, security/audit logs.
- Genuine GPL-3.0 Stockfish 19 Lite WASM UCI engine in browser and Node, with health checks, cancellation, concurrency limits, move-quality summaries and human-review-only fair-play signals.
- Free international tournaments with real entrants, deterministic Swiss-style pairing, standings and no financial transactions.
- Voluntary country flags, IANA timezone preferences, UTC storage/local-time display, jurisdiction policies, signed age/identity/location verification integration, account-currency separation and explicit multi-currency rate/quote design.
- Puzzles, lessons, leaderboard, profiles, history, settings, help, legal policies, notifications, disputes, responsible-play controls and a full admin dashboard.
- Versioned PostgreSQL migrations, PGlite embedded PostgreSQL for zero-service local/test use, structured logging, graceful shutdown, restart recovery and reconciliation jobs.

## Quick start (local)

Requirements: Node.js **>= 22.12**, npm >= 10. No PostgreSQL service is required for local development because PGlite provides embedded PostgreSQL.

```bash
cp .env.example .env
npm install
npm run dev
```

- React/Vite dev server: `http://localhost:5173`
- API + Socket.IO: `http://localhost:3001`
- The API runs migrations automatically at startup. `npm run migrate` can run them separately.
- Local data is stored in `./data/pglite` (gitignored). Delete it only if you intentionally want a fresh local database.

For a production-like single process:

```bash
npm run build
npm start
```

`npm start` serves `dist/web` and `dist-server/server/index.js`. Run it from the repository root so migration paths and static assets resolve correctly. The server binds `PORT` before migrations and engine checks, so platform port scans and health checks succeed even on a cold start. `postinstall` compiles the application during dependency installation, so a host whose build command is still the default `npm install` produces `dist-server/` and `dist/web/` anyway. A `server.js` compatibility entrypoint also exists for hosts whose dashboard still runs the older `node server.js` command; it launches the same compiled server and prints actionable guidance if the build is missing. It never builds at runtime.

Create an initial administrator (set strong values in your shell, not in Git):

```bash
ADMIN_EMAIL='operator@example.com' \
ADMIN_USERNAME='OperatorOne' \
ADMIN_PASSWORD='a-strong-unique-password-123' \
npm run bootstrap:admin
```

Then sign in, enable MFA in Settings → Security, and use `/admin`.

## Verification

Run the full verification suite:

```bash
npm run typecheck
npm run build
npm test
```

Go-live checks (configuration, optional live SMTP handshake, optional database checks):

```bash
npm run preflight
npm run preflight -- --smtp
npm run preflight -- --smtp --db
npm run email:test -- you@gmail.com
```

`npm test` executes:

| Suite | Command | Coverage |
| --- | --- | --- |
| Unit | `npm run test:unit` | money math, chess rules, country/timezone helpers, tournament pairing, Paynow hashes, TOTP, PesePay crypto, settlement math, compliance signing, email transport/preflight rules |
| Integration | `npm run test:integration` | migrations, ledger/currency invariants, auth/CSRF/RBAC/MFA, games, clocks, settlement, disputes, jurisdiction policies, payment failures, tournaments, terms |
| UI | `npm run test:ui` | React component tests in jsdom, keyboard board, promotion, theme, dialogs, quote disclosure |
| Server E2E | `npm run test:e2e` | two authenticated Socket.IO clients, duplicate/stale moves, PGN, ratings, wallet, persistence across restart |
| Browser | `npm run test:browser` | real npm-packaged Chromium: free/money mode choice, two users in different timezones, private invitations, reconnection, engine WASM, RBAC, wallet, mobile overflow, restart |
| Deployment | `npm run test:deploy` | port bound inside the platform scan window, stale `node server.js` command, health gating, clean shutdown, missing-build guidance, fail-closed configuration, platform origin, install-phase build guards, pinned Node runtime |

The browser suite builds the production bundle, starts the compiled server with a fresh PGlite database, launches a real Chromium binary from `@sparticuz/chromium` via `playwright-core`, and does not require an external browser download in this environment.

## Architecture

```
web/                    React 19 + Vite + TypeScript client
  src/app/              providers, router, layout
  src/features/chess/   board, game state, sidebar, clocks, replay
  src/features/engine/  browser Stockfish UCI worker hook and panel
  src/pages/            landing, play, competitions, game, puzzles, learn, analysis, wallet, admin, legal…
  public/engine/        vendored GPL-3.0 Stockfish 19 lite-single WASM distribution
  public/pieces/        original hand-authored chess piece SVGs
server/                 Express 4 + Socket.IO authoritative API
  db/migrations/        versioned PostgreSQL schema
  auth/                 sessions, Argon2id, TOTP, CSRF, password recovery
  games/                chess rules, clocks, state machine, realtime events
  competition/          challenges, matchmaking, terms, reservations
  finance/              double-entry ledger, settlement, reconciliation
  payments/             provider adapters, callbacks, verification, reconciliation
  engine/               Node Stockfish UCI process pool, move-quality analysis
  admin/                dashboard, disputes, reviews, audit, compliance
shared/                 pure contracts and validation shared by client/server
tests/                  unit, integration, UI, E2E and real-browser tests
docs/                   architecture, deployment, operations, payments, compliance, security, costs, API
```

The browser never supplies balances, results, clocks, ratings or settlements. Financial and game state transitions are committed in PostgreSQL transactions.

## Competition modes

| Mode | Meaning | Real money |
| --- | --- | --- |
| `free` | Default. Free chess only. | Disabled |
| `test` | Isolated internal test credits, clearly labelled and non-withdrawable. | Disabled |
| `real` | Requires all legal/provider/age/AML prerequisites **and** a signed activation manifest. | Only when fully authorised |

`OPERATING_MODE=real` alone is insufficient. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

## Payment provider status

Adapters exist for:

- **Paynow** — redirect initiation, SHA-512 hash verification, status polling and merchant trace.
- **EcoCash** — Instant Payments charge/lookup/refund and EPG Merchant-to-Subscriber payout/lookup.
- **PesePay** — AES-256-CBC payloads, redirect initiation, result callback header check and server-side status lookup.
- **OneMoney** — deliberately disabled direct adapter; no verified public direct merchant API contract was available. Use an approved aggregator (for example Paynow) after merchant approval.

All adapters are unconfigured until credentials and merchant approval are supplied. See [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [International architecture](docs/INTERNATIONAL.md)
- [API](docs/API.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Payments](docs/PAYMENTS.md)
- [Email delivery](docs/EMAIL.md)
- [Turning on real money](docs/GO-LIVE.md)
- [Compliance & activation](docs/COMPLIANCE.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Hosting costs](docs/COSTS.md)
- [Acceptance report](docs/ACCEPTANCE.md)
- [Third-party licences](docs/THIRD_PARTY_LICENSES.md)

## Two-mode and international behaviour

- `OPERATING_MODE=free` keeps free chess fully functional with all payment providers disabled.
- `OPERATING_MODE=test` allows isolated, clearly labelled test-credit competitions where a jurisdiction policy permits `test` competitions. They are not real money and cannot be withdrawn.
- `OPERATING_MODE=real` still requires the signed compliance manifest, legal/provider flags, verified 18+/identity/location status and a jurisdiction policy permitting `real` competitions.
- `/api/eligibility` returns the server's decision for the signed-in player. Country of residence is voluntary and never sufficient for real-money eligibility.
- The financial ledger remains USD-cent based. Other currencies have separate account namespaces and explicit non-applied conversion quotes; no silent conversion occurs.

## Important limitations

- No real-money launch is authorised by this repository. Legal opinion, licence, provider approval, 18+ verification, AML/KYC, tax/withholding treatment and a signed activation manifest are outstanding. [docs/GO-LIVE.md](docs/GO-LIVE.md) lists every step and the exact blockers; `npm run preflight` reports the current state.
- Real-money deposits need a payout path. Paynow and PesePay do not publish merchant payout APIs for this integration, so withdrawals require approved EcoCash EPG credentials or another approved disbursement provider.
- SMTP must be configured for production email delivery (Gmail needs an App Password). The server never pretends an undelivered email was sent. See [docs/EMAIL.md](docs/EMAIL.md).
- MFA is available for every account and required for privileged admin controls in production; enforce it for all administrators before launch.
- Provider sandbox credentials must never be used in real-money mode. Sandbox credits are test credits only.
- Engine similarity creates a review signal; it never triggers an automatic ban, confiscation or rating penalty.
- Operator identity, support contact, privacy contact and jurisdiction placeholders must be replaced before public launch.

## Licence

Original application code is provided under the repository's MIT licence, except vendored third-party assets. Stockfish 19 Lite WASM is **GPL-3.0-or-later**; the full licence text is in `docs/licenses/stockfish-GPL-3.0.txt` and attribution/source links are in [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md). Redistribution of the GPL engine must comply with that licence.
