# Operations manual

## Daily checks

```bash
npm run reconcile
curl -fsS "$PUBLIC_ORIGIN/api/health"
curl -fsS "$PUBLIC_ORIGIN/api/status"
```

In the admin dashboard check:

1. Overview → active games, open disputes, pending settlements.
2. Ledger → reconciliation must report zero discrepancies and zero unbalanced posted transactions.
3. Commission → fee account balance equals the sum of posted settlement fees.
4. Providers → each configured provider is healthy and in the correct sandbox/production environment.
5. Security → recent admin actions and security events.

## Scheduled jobs inside the API process

| Interval | Job |
| --- | --- |
| 1 s | Timeout adjudication and abandonment review; broadcasts terminal state |
| 30 s | Expire challenges and matchmaking tickets |
| 60 s | Settle any finished funded game whose journal did not post |
| 5 min | Reconcile pending deposits and withdrawals with provider status APIs |

For multi-instance deployments, move these jobs to a single scheduled worker or add a database advisory lock; the current single-process timers assume one API instance.

## Settlement recovery

`POST /api/admin/settlements/reconcile` or `npm run reconcile` calls `settlePending()`. It only posts games with locked terms and no posted settlement. Games with an open dispute are skipped and reported as blocked. Idempotency keys prevent double payout.

## Disputes

1. Player opens a dispute from a game.
2. Settlement is blocked; an administrator inspects game state, clocks, moves, provider events and audit logs.
3. Administrator chooses `reject` (settle authoritative result), `void` (refund/correction), or `review` (keep blocked).
4. A posted payout correction creates a separate `settlement_corrections` row and balanced compensating journal.
5. All decisions require a reason, confirmation and MFA in production.

## Fair-play reviews

`POST /api/admin/fair-play/:gameId/review` runs genuine Stockfish analysis and stores an `engine_similarity` signal per player. It creates a `match_reviews` item for human review when the signal is elevated. It does not ban, confiscate funds or change ratings automatically. Close the review with a documented decision.

## Provider incidents

- **Callback flood / invalid signatures:** provider events are deduplicated by `(provider,event_id)`; invalid signatures are recorded but never credited.
- **Provider API unavailable:** pending operations stay pending. Reconciliation retries server-to-server verification; no browser redirect or callback body is trusted.
- **Deposit reversal after the user spent funds:** the reversal is blocked and recorded for manual review. Do not silently overdraw the user.
- **Duplicate payout suspicion:** query `ledger_transactions` for `type='competition_settlement'` and `game_id`; there must be at most one posted journal per game.

## Restart and recovery

SIGTERM triggers graceful shutdown: active clocks are paused, Socket.IO and HTTP stop accepting connections, and the database closes. After restart, `recoverClocks()` pauses games idle for over 60 seconds, `settlePending()` completes funded games, and clients resync from `/api/games/:id`.

## Monitoring

Structured JSON logs include request method/path/status/duration and service events. Alert on:

- `/api/health` failures.
- Any ledger reconciliation discrepancy.
- `settlement recovery failed` or `payment reconciliation failed` warnings.
- Repeated `login_failed`, `callback_rejected`, `deposit.amount_mismatch`, `deposit.reversal_blocked`.
- Engine health `available:false` for more than five minutes.
- WebSocket `connect_error` spikes.

Log redaction removes cookies, authorization headers, passwords, tokens, secrets and API keys. Do not log full provider callback payloads in production unless legally reviewed.

## Incident response

1. Freeze deployments and preserve logs/database snapshot.
2. Set `OPERATING_MODE=free` if a financial or provider incident is active; free chess remains available.
3. Revoke affected sessions and disable affected provider flags.
4. Run reconciliation and export the relevant audit/ledger rows.
5. Apply forward-only corrections with human approval; never edit posted entries.
6. Publish a post-incident report and update runbooks.

## Useful SQL

```sql
-- Balanced ledgers only
SELECT lt.id, lt.reference, SUM(le.amount_cents) total
FROM ledger_transactions lt JOIN ledger_entries le ON le.transaction_id = lt.id
WHERE lt.status = 'posted' GROUP BY lt.id HAVING SUM(le.amount_cents) <> 0;

-- One settlement journal per funded game
SELECT game_id, COUNT(*) FROM ledger_transactions
WHERE type = 'competition_settlement' AND status = 'posted'
GROUP BY game_id HAVING COUNT(*) > 1;

-- Commission account consistency
SELECT (SELECT available_cents FROM wallet_accounts WHERE id = '00000000-0000-4000-8000-000000000002') fee_account,
       (SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries WHERE wallet_account_id = '00000000-0000-4000-8000-000000000002') ledger_fee;
```


## International mode operations

- Review `/admin/jurisdictions` after every legal/provider change. `realMoneyAllowed` must remain false until legal opinion, licence, provider approval, age/identity/location verification and tax/AML controls are recorded.
- Check `/api/eligibility` for a sample player in each jurisdiction. A permissive selected country must not bypass a restrictive verified jurisdiction.
- Review `/admin/currencies/rates` and `/admin/currencies/quotes`; quotes must remain `applied=false` unless a separately reviewed multi-currency journal is implemented.
- Tournament standings and game records should be reconciled against `games.tournament_id` and `tournament_pairings` after a restart.
- Free chess and tournaments must continue to pass smoke tests with every `*_ENABLED` provider flag set to false.
