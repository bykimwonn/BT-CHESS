# Architecture

## Trust boundary

The browser is an untrusted presentation layer. It can request moves, challenges, deposits and withdrawals, but it cannot assert a balance, clock, result, rating or settlement. Every state transition is validated and committed by the server.

## Ratings

`shared/rating.ts` is the single implementation of the FIDE Rating Regulations
(Handbook B.02, in force from 1 March 2024, with the 400-point amendment of
1 October 2025): the K-factor brackets (40 while new and until 30 games, 20
under 2400, 10 once a published rating has reached 2400, 40 for juniors under
2300 until the year of their 18th birthday), the 400-point difference cap below
2650, the K × n ≤ 700 ceiling per calendar month, rounding to the nearest point
with .5 away from zero, and the 1400 floor.

`GameService.updateRatings` runs inside the same transaction that finishes the
game. It reads each seat's rating, games played, peak rating and optional year
of birth, counts the games already finished that month, applies
`fideRatingChange` and writes both the new rating and a `rating_history` row
whose `reason` records the K-factor (`game:white:k40`). `profiles.peak_rating`
is what makes K = 10 permanent after a player has once reached 2400.

```
Browser (React/Vite)
  │ HTTPS JSON + Socket.IO
  ▼
Express API / Socket.IO gateway
  │ CSRF, session, RBAC, validation, rate limits
  ▼
Domain services
  ├── GameService       chess.js, clocks, versioned moves, terminal results
  ├── CompetitionService quotes, hashed terms, reservations, matchmaking
  ├── LedgerService     balanced immutable journals, wallet accounts
  ├── SettlementService idempotent payout/refund, recovery
  ├── PaymentService    provider verification, deposits, withdrawals
  ├── AnalysisService   Stockfish UCI, move quality, human-review signals
  └── AdminService      disputes, audit, compliance, reconciliation
  ▼
PostgreSQL (production) / PGlite (local + tests)
```

## Persistence

`server/db/migrations/001_init.sql` creates users, profiles, sessions, games, moves, challenges, agreements, wallets, ledger transactions/entries, deposits, withdrawals, settlements, corrections, disputes, notifications, restrictions, audit events, admin actions, reviews, puzzles and provider events.

Important database invariants:

- `ledger_entries` cannot be updated or deleted when the parent transaction is `posted`.
- A deferred constraint trigger verifies that every posted ledger transaction sums to zero.
- Wallet balances cannot go negative except for the explicit `external` contra account.
- Unique constraints protect session tokens, one-time tokens, move nonces, settlement game IDs, provider references and provider event IDs.
- Migrations are checksummed; an applied migration cannot be silently edited.

## Game state machine

A game is created from a challenge or matchmaking ticket. Each accepted move:

1. Locks the game row.
2. Rejects duplicate `(game_id, user_id, nonce)` messages.
3. Checks the expected `version`.
4. Replays persisted UCI moves with `chess.js`.
5. Verifies the player's turn and move legality.
6. Computes elapsed time from the persisted `turn_started_at`.
7. Inserts the move and advances the version atomically.
8. Detects terminal conditions and settles funded games in the same transaction.

Threefold repetition and fifty-move positions are claimable. Checkmate, stalemate, insufficient material, timeout, resignation, agreed draw and abandonment are server-adjudicated.

## Clocks and restart

Clocks are stored in integer milliseconds. On graceful shutdown, active clocks are paused using the elapsed server time. On startup, games idle for more than 60 seconds are paused after charging at most 60 seconds; they resume when both players reconnect. Timeout adjudication uses the database/server clock, never a client timestamp.

## Money

All money is integer USD cents. A journal is a set of signed account deltas summing to zero:

- Deposit: `external -amount`, user available `+amount`.
- Stake reservation: each user available `-stake`, reserved `+stake`.
- Decisive settlement: both reserved `-stake`, winner available `+payout`, platform fee `+fee`.
- Draw/void: both reserved `-stake`, both available `+stake`, no fee.
- Withdrawal hold: available `-amount`, reserved `+amount`.
- Completed withdrawal: reserved `-amount`, external `+amount`.

A posted payout is never edited. A void after payout uses a separate audited compensating journal and a `settlement_corrections` record.

## Real-time communication

Socket.IO authenticates each handshake with the same session cookie as HTTP and verifies the origin. Users join `user:<id>` and `game:<id>` rooms; the lobby room receives challenge updates. The server emits authoritative `game:state` snapshots after moves, presence changes and terminal results. REST move endpoints are available as a fallback and use the same `GameService`.

## Engine

Both browser and server use the same Stockfish 19 Lite WASM distribution. The
browser uses it twice: the analysis board (full strength, MultiPV) and the
practice board (`web/src/features/engine/levels.ts`), which sets the UCI `Skill
Level` option plus a depth/think-time budget and, at the three lowest levels, a
seeded chance of a random legal move so the opponent is beatable. Practice state
lives only in the component; nothing is sent to the server. The browser creates a classic Web Worker from `/engine/stockfish-19-lite-single.js`; the Node service spawns the same UCI engine file as a child process. Both perform a real `uci`/`isready` handshake, parse `info`/`bestmove` output, support cancellation and never fabricate an evaluation or best move.

## Compliance gating

`evaluateCompliance()` requires environment flags, provider approval, age-verification configuration and a separately signed activation manifest. `OPERATING_MODE=real` alone cannot enable real money. Free chess does not depend on the compliance subsystem.


## International modes and jurisdiction policies

`EligibilityService` separates voluntary country of residence from a provider-verified eligibility jurisdiction, account-currency preference, supported providers, permitted competition types, limits and age/identity requirements. Policies live in `jurisdiction_policies` and are read server-side. A signed provider callback is the only path that sets `eligibility_jurisdiction`; an IP address or selected country is never enough for real money.

`TournamentService` creates free international tournaments with real entrants, pairs score groups deterministically, creates ordinary authoritative `GameService` games, and updates standings transactionally when those games finish. Tournaments never create ledger entries.

`LedgerService` now stores an explicit currency on every transaction and entry. A database trigger rejects mixed-currency journals, and system accounts are created per currency. `currency_exchange_rates` and `currency_conversion_quotes` provide an auditable path for future currencies without silent conversion or balance mutation.
