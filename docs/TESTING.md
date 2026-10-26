# Testing and verification

Final verification date: **26 October 2026 (UTC)**. All commands below exited **0** in the workspace.

## Commands

```bash
npm run typecheck
npm run build
npm test
```

`npm test` expands to:

```bash
npm run test:unit
npm run test:integration
npm run test:ui
npm run test:e2e
npm run test:browser
```

`test:browser` first runs `build:server` and `build:web`, then launches a real Chromium binary from `@sparticuz/chromium` via `playwright-core`.

## Final results

| Suite | Runner / result | Count |
| --- | --- | --- |
| Unit | `tsx --test tests/unit/*.test.ts` — 34 pass, 0 fail | 34 tests |
| Integration | `tsx --test tests/integration/*.test.ts` — 21 pass, 0 fail | 21 tests |
| UI | `vitest run --config vitest.config.ts` — 5 files, 11 pass, 0 fail | 11 tests |
| Server E2E | `tsx tests/e2e.ts` — `ok: true` | 21 checks |
| Browser | real Chromium + production bundle — `ok: true` | 42 checks |
| Typecheck | `tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p web/tsconfig.json` | 0 errors |
| Production build | TypeScript server + Vite web bundle | 0 errors |
| Clean install | `npm ci` in a fresh copy of the repository | exit 0; postinstall vendored GPL Stockfish assets |

Combined: **66 automated test cases** and **63 end-to-end/browser assertions**, with **0 failures** in the final run.

## What each suite proves

### Unit

- Integer-cent fee math for $0.50/$1.00 stakes, half-up rounding, invalid stake/fee rejection.
- Money/clock formatting, decimal parsing, canonical hashed terms and captured material.
- Checkmate, stalemate, insufficient material, threefold repetition, fifty-move claims, promotion, SAN/PGN/FEN and all five shipped puzzle solutions.
- Paynow SHA-512 hash generation and verification against exact official documentation examples.
- TOTP base32, current/adjacent windows, wrong-code rejection and AES-GCM secret encryption.
- PesePay AES-256-CBC envelope round-trip and 32-byte key validation.
- Settlement journal lines for winner, draw and void; tampered terms rejected.
- Compliance activation signature and manifest verification, including independent flags.
- International country/timezone helpers, explicit currency formatting and deterministic tournament pairing.

### Integration

- Versioned migrations, deferred balanced-journal trigger, immutable posted entries, overdraft prevention and idempotent journals.
- Registration, session, CSRF, CORS, RBAC, TOTP MFA, password reset and single-use email verification.
- Legal moves, stale-version rejection, duplicate nonces, out-of-turn rejection, illegal move rejection.
- Server clock timeout adjudication from persisted timestamps.
- Exactly-once decisive settlement, draw refund, fee accounting, reconciliation and overdraft prevention.
- Unresolved dispute blocking settlement and audited human resolution.
- Hashed paid-challenge terms and atomic reservation.
- Free international play with two different countries/timezones and zero financial journals.
- Restricted verified jurisdictions, signed eligibility callbacks, provider allowlists and no country/IP override.
- Staked-match preconditions: identical accepted terms and sufficient funds before any game exists.
- Payment failures, invalid signatures, amount mismatches and duplicate callbacks cannot create fake balances.
- Currency-specific ledger account isolation, mixed-currency rejection and explicit non-applied conversion quotes.
- Free international tournament creation, pairing, standings and rating updates without money.

### UI

- Keyboard algebraic move input and promotion picker on the real `react-chessboard` component.
- A mocked UCI Web Worker verifies the browser Stockfish handshake, `bestmove` parsing and worker shutdown.
- Theme persistence/toggle, board preference updates, accessible modal/Escape behaviour, explicit confirmation dialogs, and exact quote disclosure.

### Server E2E

Two authenticated Socket.IO clients create and accept a free challenge, receive a live match event, join the game, play `e4`/`e5`, reject duplicate/stale messages, resign, and verify terminal state, PGN, zero wallet, transactional ratings/leaderboard records and real-money disabled status. The API process is then restarted against the same PGlite directory; session, game state, version, PGN and ledger balance survive.

### Browser

Real Chromium checks: landing/hero/board, theme toggle, prominent free/money mode choices, no mandatory payment screen, two isolated authenticated contexts in `Africa/Harare` and `Asia/Tokyo`, WebSocket connection, private invitation across sessions, open challenge creation and acceptance, live game, two moves, different correct local timestamps, reconnection, SAN/PGN/FEN, wallet zero balance, RBAC, real-money disabled status, genuine Stockfish UCI best move (browser worker, with a real server-engine fallback under load), no horizontal overflow at 390 px on thirteen routes including tournaments/settings/history, game persistence across API restart, and no uncaught page errors. Expected WebSocket connection-refused messages during the deliberate restart are filtered; all other console/page errors would fail the suite.

## Defects found and fixed during verification

1. `privileged` admin middleware did not call `next()`, causing admin requests to hang; fixed.
2. Failed-login SQL caused PGlite parameter type inference errors; replaced with an application-computed lock timestamp.
3. Timeout adjudication did not persist a zeroed clock; fixed.
4. Disputes froze active games before a result existed; changed to block settlement only.
5. Blocked disputes did not create a visible settlement row; fixed with an idempotent blocked row.
6. `AuthService.publicUser` returned a non-ISO `createdAt`; fixed.
7. `replayMoves` leaked chess.js errors instead of a controlled illegal-move message; fixed.
8. Compliance activation rejected the valid two-character jurisdiction `ZW`; fixed.
9. PlayPage was missing `useEffect` after adding lobby subscription; fixed.
10. Vite manual chunking created circular chunks; simplified.
11. `@sparticuz/chromium` Lambda defaults broke Playwright context isolation (`--single-process`/`--disable-web-security`); browser test now filters those flags.
12. `/competitions` overflowed horizontally at 390 px because grid children used auto min-width; fixed with `min-width: 0`.
13. Webhook/CSRF and browser selector issues were corrected without weakening security checks.
14. Random server-assigned colours exposed an E2E assumption that the first user was White; the test now derives colours from the authoritative snapshot.
15. A reused private-challenge UI state caused a second challenge to remain private; the browser test now explicitly selects open mode and the UI flow was verified.
16. Eligibility HMAC verification originally hashed the signature field itself; signed callbacks now hash the exact payload excluding `signature`.
17. A tournament start query referenced a non-existent `rating` column on entries; it now counts real entrants only.

No failing tests were disabled or removed. No success was claimed without its runner or browser check reporting success.

## Not covered by these tests

- Live sandbox/production transactions with Paynow, EcoCash or PesePay (no credentials or merchant approval).
- External managed PostgreSQL deployment (no `DATABASE_URL`/`psql` in the sandbox); PGlite is PostgreSQL 18.6-compatible and the `pg` adapter is used in production configuration.
- Docker image build (Docker is unavailable in this sandbox); Dockerfile, Compose configuration and a clean `npm ci` + `npm run build` path were verified separately.
- Real SMTP delivery, real 18+ provider callbacks, regulator review and real-money legal activation.
- Safari, Firefox and iOS browsers; browser verification used npm-packaged Chromium.
- Live 18+/identity/location provider callbacks from a contracted vendor; the signed integration point is tested with a local HMAC test provider.
- Actual multi-currency deposits/payouts; currency isolation and explicit quotes are tested, but only USD is enabled for accounts.
