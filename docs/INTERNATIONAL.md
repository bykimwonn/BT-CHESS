# International architecture and release criteria

Rookstone Arena is designed for worldwide free chess from the start. Real-money competition is a separate, optional, server-gated mode.

## Two explicit modes

| Mode | Entry | Funding | Eligibility | Failure isolation |
| --- | --- | --- | --- | --- |
| **Play Free** | Prominent homepage and Play-screen card | None. No deposit, entry fee, stake or payment method | Global free-play policy, active account | Fully functional with every payment provider disabled |
| **Play for Money** | Separate prominent card; disabled by default | Optional US$0.50+ per player, integer USD cents | Signed compliance activation + verified jurisdiction + 18+/identity/location + provider approval | Payment outage cannot change chess rules or create a game without reserved funds |

Free play is never converted into a money match. The mode is part of the challenge/quote/game state and the server rejects staked games in free mode. No modal pressures free players to deposit.

## Global player experience

- Registration accepts an optional country of residence and an IANA timezone. Country flags and opponent timezone labels are shown only when the player opts in.
- The timezone is read from the browser. Some mobile browsers and older Android WebViews return identifiers `Intl` itself rejects (for example `GMT+02:00`). Signup never fails because of that: an unusable value is stored as `UTC`, and the player can pick a real zone in Settings. Explicit timezone edits in Settings are still validated strictly, because there the choice is deliberate.
- All timestamps are stored in UTC/TIMESTAMPTZ. The UI renders `Intl.DateTimeFormat` local times; the browser test runs two Chromium contexts in `Africa/Harare` and `Asia/Tokyo` and verifies different correct local timestamps.
- Open challenges, direct username challenges, private shareable invitation links, rating-aware matchmaking and tournaments are available internationally. Free chess does not require a shared country, currency or payment provider.
- Games use server-authoritative state, clocks, legal moves, results and ratings. Reconnection reloads the persisted snapshot; browser and server E2E suites verify this.
- Global leaderboards, match history and profiles are computed only from persisted games. No bots, placeholder accounts or synthetic activity are inserted.
- The interface uses standard `Intl` formatting and has a single content layer, ready for future locale/translation and regional formatting work.

## Separate eligibility concepts

`server/db/migrations/002_international_modes.sql` adds:

- `users.country` — voluntary country of residence.
- `users.country_shared` — whether a flag may be shown publicly.
- `users.eligibility_jurisdiction`, `eligibility_verified_at`, `eligibility_provider_ref`, `location_verified_at` — set only by a signed age/identity/location provider callback; never inferred from IP or a selected country.
- `users.account_currency` — display preference, currently USD only.
- `users.timezone`, `timezone_shared` — local-time display preferences.
- `jurisdiction_policies` — server-side free-play, real-money, age/identity, permitted competition types, approved payment providers, and deposit/withdrawal limits per jurisdiction.
- `currency_exchange_rates` and `currency_conversion_quotes` — explicit rates and stored quotes that never mutate balances.
- `ledger_transactions.currency`, `ledger_entries.currency`, `settlements.currency` and a database trigger rejecting mixed-currency journals.
- `tournaments`, `tournament_entries`, `tournament_pairings` and `games.tournament_id` — free international tournaments with real entrants.

`EligibilityService` is the only authority for these checks. `GET /api/eligibility` and `GET /api/me/international` expose a read-only view; `PATCH /api/me/international` changes voluntary preferences only. A frontend setting cannot override a jurisdiction restriction.

## Multi-currency design

The active financial ledger is denominated in USD cents. The schema and `LedgerService` support currency-specific wallet accounts and require every journal line, transaction and account to have the same currency. A database trigger enforces this again.

To add another currency later:

1. Add a reviewed migration and allow the code in `shared/validation.ts`.
2. Create separate system accounts per currency using `LedgerService.systemAccountId`.
3. Record an explicit `currency_exchange_rates` row with source/evidence reference.
4. Use `quoteConversion` to create a stored, non-applied `currency_conversion_quotes` row.
5. Only a deliberate, separately audited multi-currency journal may move funds; conversion quotes never change a balance.

USD, ZWG, ZAR, GBP and EUR balances are never silently converted. Every amount in the UI includes its ISO currency code via `formatMoney`.

## International payments

Provider adapters remain independent of the chess engine. A jurisdiction policy lists `allowedProviders`; `PaymentService` rejects a provider not approved for that jurisdiction. Sandbox transactions are labelled and cannot be represented as real money. Free chess, tournaments, analysis and matchmaking do not call payment providers.

See [PAYMENTS.md](PAYMENTS.md) for official documentation links, adapter capabilities and disabled OneMoney direct integration.

## Performance and global infrastructure

- Authoritative game and financial state live in PostgreSQL/PGlite, not in browser memory.
- Socket.IO emits full state only on actual state changes and targeted game rooms; duplicate/stale messages are rejected with nonces and versions.
- WebSockets use the same secure session cookie and allowed origin as HTTPS requests. Reconnection restores persisted state; clock downtime is paused after a short recovery window.
- Structured logs include HTTP method/path/status/duration and game/provider events. `/api/health` and `/admin/system-health` provide liveness and database/engine/reconciliation status.
- The included maintenance timers assume one API process. Before horizontal scaling, move them to a single worker protected by a database advisory lock; unique move nonces and settlement idempotency keys already prevent duplicate work.
- No worldwide latency promise is made. Measure real user RTT and WebSocket round-trip time before adding regional infrastructure.

## Release criteria status

Verified by the final suite:

1. Two users in different authenticated browser sessions completed an online match.
2. Players in `Africa/Harare` and `Asia/Tokyo` saw different correct local timestamps.
3. A private invitation generated in one browser session opened in a different authenticated session/device context.
4. Reload/reconnection restored authoritative game state.
5. Ratings and game records remained consistent after resignation and restart.
6. Free chess worked with every payment provider unconfigured.
7. A permissive selected country could not override a restrictive verified jurisdiction.
8. International payment provider eligibility was checked server-side; an unapproved provider was rejected.
9. Currency calculations remained integer-cent, currency-labelled, isolated and auditable.
10. Global matchmaking, tournaments and Stockfish operated independently of provider availability.

Still externally blocked: live provider sandbox/production transactions, legal/operator licensing, real age/identity/location provider contracts, SMTP delivery, external managed PostgreSQL deployment, and Safari/Firefox/iOS browser coverage. See [ACCEPTANCE.md](ACCEPTANCE.md).
