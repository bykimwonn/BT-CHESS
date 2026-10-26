# Acceptance report

Date: **26 October 2026 (UTC)**. This report intentionally separates verified results from incomplete work and external blockers.

## Verified

| Requirement | Verification |
| --- | --- |
| Production build and tests | `npm run typecheck`, `npm run build`, `npm test`: exit 0. 66 test cases + 68 E2E/browser/deployment checks, 0 failures. A clean `npm ci` also exited 0 and vendored the GPL engine. See [TESTING.md](TESTING.md). |
| Obsolete product replaced | Root `server.js`, legacy `public/`, `lib/` and old tests removed; new `server/`, `web/`, `shared/`, migrations, tests and docs added. |
| Responsive actual UI | Real Chromium at 1440×900 and 390×844; ten routes had no horizontal overflow at 390 px; dark/light theme, focus-visible CSS, keyboard board and reduced-motion support implemented. |
| Legal chess and terminal results | `chess.js` unit/integration tests, checkmate/stalemate/insufficient material/threefold/fifty-move/promotion, server-authoritative timeout/resignation/draw and browser game verified. |
| Genuine Stockfish | Server UCI handshake reports `Stockfish 19 Lite WASM`; browser worker produced a real UCI best move; no evaluation is hardcoded. GPL licence and sources included. |
| Two authenticated users playing online | Node Socket.IO E2E and two isolated real Chromium contexts played `e4`/`e5`; stale versions and duplicate nonces were rejected. |
| Persistence after restart | Both E2E suites restarted the compiled API process against the same PGlite directory; session, game, PGN, version, clocks and ledger balance survived. |
| Auth, RBAC, challenges, lobby, admin, audit | Integration/UI/browser tests cover registration, login, CSRF, CORS, MFA, password reset, RBAC denial, challenge creation/acceptance, admin routes, audit/admin-action tables. |
| Balanced ledger, overdraft and double-payout prevention | Database triggers, reconciliation, overdraft tests and duplicate settlement tests passed. |
| Settlement/refund math | $1+$1 → $2 pot, $0.10 fee, $1.90 winner; $0.50+$0.50 → $1 pot, $0.05 fee, $0.95 winner; draw/void full refund, no fee. Verified in unit/integration. |
| Provider interfaces documented | [PAYMENTS.md](PAYMENTS.md) documents Paynow, EcoCash, PesePay and disabled OneMoney with official links, sandbox/production separation and callback verification. |
| Unresolved disputes | Open disputes create a blocked settlement; human admin resolution is required before posting. Integration test passed. |
| Deployment/operations docs | [DEPLOYMENT.md](DEPLOYMENT.md), [OPERATIONS.md](OPERATIONS.md), Dockerfile, Compose, Render, Railway, `.env.example`, bootstrap/reconcile/activation scripts. |
| Real money disabled | `/api/status` and UI show free mode by default; compliance gates require a signed manifest and multiple independent flags. |
| Two explicit modes | Homepage and Play screen show prominent `Play Free` and `Play for Money` cards. Browser test verifies free play opens with no payment dialog and money entry is disabled by server eligibility. |
| Free international play | Two browser sessions with different countries/timezones register and play with every payment provider unconfigured; zero financial journals are created. |
| Money-match preconditions | Integration tests verify both players must accept identical hashed stakes and have verified available funds before a game or reservation exists. |
| Restricted jurisdictions | Server-side `jurisdiction_policies` block real money; a permissive selected country cannot override a restrictive verified jurisdiction. Signed eligibility callback and provider allowlist tests passed. |
| Payment failures | Fake provider tests verify failed status, invalid signature, amount mismatch and duplicate callback cannot create fake balances or duplicate credits. |
| Currency safety | Explicit `formatMoney`, currency columns/triggers, isolated EUR/USD wallets, mixed-currency rejection and non-applied conversion quotes verified. |
| International tournaments | Free tournament API/UI creates events with real entrants, pairs actual games, updates standings/ratings and creates no ledger entries. |
| Timezones and invitations | Two Chromium contexts in `Africa/Harare` and `Asia/Tokyo` show different correct local timestamps; a private invitation generated in one session opens in another. |
| Reconnection and ratings | Browser reload and server restart restore authoritative state; leaderboard and rating history remain consistent. |

## Incomplete but implemented

These features exist in code and are tested with fakes/local adapters, but require external resources for production verification:

- Paynow, EcoCash and PesePay adapters: hash/HMAC/AES logic and callback deduplication are unit-tested; live sandbox/production HTTP calls were not made.
- Withdrawal workflows: hold/release/complete journals are implemented and tested locally; no real payout provider was called.
- Age-verification webhook: HMAC integration point implemented; no approved provider contract or live callback.
- Password/verification email: token lifecycle implemented; SMTP delivery not configured, so local development returns a clearly labelled development token.
- PostgreSQL `pg` production driver: code compiles and uses the same SQL; external PostgreSQL was not available in the sandbox. PGlite (PostgreSQL 18.6-compatible) was used for migrations/tests.
- Multi-instance deployment: current maintenance timers assume one API process. [DEPLOYMENT.md](DEPLOYMENT.md) and [OPERATIONS.md](OPERATIONS.md) instruct moving them to a single locked worker before horizontal scaling.
- Multi-currency production deposits/payouts: schema, triggers, isolated accounts and non-applied quotes are implemented and tested, but `accountCurrency` remains USD-only until reviewed provider/legal support is added.
- Docker/Render/Railway configurations: supplied but not deployed here because no container runtime or hosting account is available.
- Browser coverage: Chromium only; no Safari, Firefox or iOS test run.

## Blocked by external prerequisites

| Blocker | Why it blocks | Remaining activation steps |
| --- | --- | --- |
| Legal authorisation / operator licence | Real-money competitions cannot lawfully launch from software alone. | Written legal opinion, current-law review, licence/permission, tax/withholding advice. |
| Payment-provider merchant approval | Provider credentials alone do not authorise wagering/competition use. | Written approval for the exact product, production credentials, sandbox tests, webhook secrets and reconciliation test. |
| 18+ identity and AML/KYC provider | Self-declared age is not verification. | Approved provider contract, signed callback, sanctions/AML procedures, named officer. |
| Signed compliance activation manifest | Server deliberately rejects real mode without it. | Human officer completes and signs `config/compliance-activation.template.json` using `scripts/sign-activation.ts`. |
| SMTP provider | Password recovery and verification emails cannot be delivered. | Configure `SMTP_URL` and `EMAIL_FROM`; test delivery and token consumption. |
| OneMoney direct API contract | No verified public direct merchant API specification was available. | Obtain official merchant API docs/approval or use an approved aggregator. |
| Live financial testing | No credentials, no legal approval, no real users or funds may be used. | Use provider sandboxes after merchant approval; perform signed webhook, refund, reversal, chargeback and restart tests. |
| Contracted 18+/identity/location provider | The signed integration point is tested with a local HMAC provider, not a real vendor. | Contract and configure an approved provider; verify jurisdiction evidence, retention and appeal workflow. |
| Additional currencies | Only USD is enabled for accounts. No live EUR/ZAR/ZWG/GBP provider capability is approved. | Review provider capabilities and law, add migration, separate accounts, explicit rates and audited multi-currency journals. |
| Regional production infrastructure | No measured international latency or demand data exists. | Measure RTT/WebSocket round trips and add regional workers only when justified; keep settlement/move idempotency intact. |
| Production hosting | No hosting account/credentials in this sandbox. | Provision managed PostgreSQL, secrets, backups, domain/TLS, monitoring; run deployment docs. |
| Independent security/penetration test | Not performed here. | Commission authorised third-party test before real-money launch. |

## Honest non-claims

- No real deposit, withdrawal, balance, transaction, opponent, prize pool, statistic or engine evaluation was fabricated.
- No client redirect was treated as payment success.
- No unsigned webhook was accepted.
- No automatic ban or confiscation was implemented from engine similarity.
- No test or browser check is reported as passed unless its runner/browser actually reported success.
- No real-money competition was enabled.
- No selected country or IP address was treated as sufficient legal eligibility.
- No silent currency conversion or balance mutation was performed by an exchange-rate quote.
- No fake tournament entrant, pairing, timezone or payment provider was inserted.
