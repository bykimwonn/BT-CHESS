# Cash-agent vouchers

The voucher rail lets a person hand cash to a trusted agent and receive balance
in the app without a payment gateway, a merchant account or a company
registration for the gateway. It is the "shop cash" model used by licensed
Zimbabwean retail bookmakers: the teller takes the money, prints a short code,
and the player redeems that code online.

Nothing about this rail changes the legal position. It removes the *payment
provider* dependency, not the *gaming licence* dependency. Real-money staking
still requires everything in [COMPLIANCE.md](COMPLIANCE.md) and
[GO-LIVE.md](GO-LIVE.md); the rail refuses to pay cash out until the platform is
in authorised real mode.

## The two directions

| Direction | Who starts | Steps |
| --- | --- | --- |
| Cash in (deposit) | Agent | 1. Player hands cash to the agent. 2. Agent opens `/agent`, enters the amount and optionally the player's username, and hands over the eight-character code. 3. Player opens Wallet → *Cash at an agent*, enters the code. 4. The code is redeemed once; the agent's float is debited and the player's balance credited in one journal. |
| Cash out (withdrawal) | Player | 1. Player requests a payout in Wallet, choosing the agent code. 2. The amount is reserved immediately and a code is shown. 3. Player presents the code and their ID at the counter. 4. Agent settles the code after checking the ID; the reservation is released to the agent's float. 5. Player is paid the cash. |

Every code is bearer cash until it is used, so the same rules as a physical
receipt apply:

- Cash-in codes expire after 60 minutes by default (5–1440 allowed).
- Payout codes expire after 72 hours; expiry returns the money to the player's
  available balance automatically.
- Only a hash of the code is stored. A database dump cannot be used to redeem
  anything. Lost codes are cancelled and reissued, never "looked up".
- A code issued to one username cannot be redeemed by another account.

## Gating

The rail fails closed. `CASH_AGENTS_ENABLED` must be `true` **and** the
compliance state must allow the requested direction:

| `OPERATING_MODE` | Cash in | Cash out |
| --- | --- | --- |
| `free` (default) | refused — 403 quoting the compliance blockers | refused |
| `test` | sandbox vouchers; credits are labelled *no cash value* | refused — test credits cannot be withdrawn |
| `real` (signed activation) | real voucher credits | allowed |

`CASH_AGENTS_ENABLED` defaults to `false`; `render.yaml` ships it as `"false"`.
Set it to `true` only after the operator has decided to run a counter at all.

A voucher issued in one operating mode cannot be redeemed in another, so a
sandbox code can never become real money.

## Limits

| Limit | Default | Where |
| --- | --- | --- |
| Smallest cash-in | $1.00 | service constant |
| Smallest cash-out | $5.00 | service constant |
| Per-voucher limit | $1,000.00 | `cash_agents.voucher_limit_cents` |
| Agent daily cash-in | $5,000.00 | `cash_agents.daily_deposit_limit_cents` |
| Agent daily cash-out | $5,000.00 | `cash_agents.daily_payout_limit_cents` |
| Player daily cash-in redemption | $5,000.00 | service constant |

Limits are recomputed from the voucher table inside the same transaction as the
issue, so two tellers issuing at the same moment cannot both squeeze past the
daily cap.

## Counter rules

These are the operating instructions for an agent. An agent is a person the
platform has promoted with an admin action; they are not an administrator and
cannot touch wallets directly.

1. **Take the cash first.** Never issue a code before the notes are in hand and
   counted. The code is the receipt.
2. **One code per deposit.** Never issue a second code for the same money, and
   never write a code from a previous day's book.
3. **Check ID for every payout.** Compare the name on the player's ID with the
   account, and only settle after the cash is counted out.
4. **Never credit a wallet from a personal EcoCash wallet.** There is no manual
   "I received a transfer, add balance" button and there must not be one. That
   path is unrecorded, unreconcilable and outside the rail's audit trail.
5. **Record a reason on every cancellation.** Cancellations are audited with
   the reason and the actor.
6. **Remit cash.** Hand physical cash to the operator (or bank it) and ask the
   administrator to record a remittance in Admin → Agents. Cash on hand in the
   console must match the notes in the drawer.
7. **Stop when suspended.** A suspended agent can still view the console, but
   cannot issue or settle. Open codes must be settled or cancelled before the
   agent can be closed.

## What the agent sees

`/agent` shows:

- cash on hand (the inverse of the float balance), today's cash-in and cash-out,
  the number of open codes and the three limits;
- an *issue cash-in code* form (amount, optional player, reference);
- a *settle cash-out code* form (code, optional ID reference);
- the recent voucher list with cancel buttons for open codes.

## What the administrator sees

Admin → **Agents** lists every agent with cash on hand, today's in/out, open
codes, and buttons to change status or record a remittance. The same tab lists
recent vouchers across all agents with a cancel action, and a code lookup card
that finds an agent by code (the code itself is not a secret — it is the shop's
public identifier).

## Double-entry

The account on the far side of every player credit is the agent's float. Cash in
an agent's hands is a negative float balance, exactly like the `external`
counter-account for gateway money.

| Event | Journal | Type |
| --- | --- | --- |
| Player redeems a cash-in code | agent float −amount → player available +amount | `voucher_credit` (or `test_voucher_credit`) |
| Player requests cash out | player available −amount → player reserved +amount | `withdrawal_hold` |
| Agent settles a payout | player reserved −amount → agent float +amount | `withdrawal_cash_paid` |
| Code expires or is cancelled | player reserved −amount → player available +amount | `withdrawal_release` |
| Agent hands cash to the operator | agent float +amount → platform bank −amount | `cash_agent_remittance` |

A payout request also writes a `withdrawals` row with `provider='cash_agent'`,
`destination='agent:<CODE>'` and `metadata.method='cash_voucher'`, so it appears
in the same reporting as gateway withdrawals.

Idempotency keys are derived from the voucher or withdrawal id, so retries
cannot double-credit. Cash on hand for an agent is `-SUM(float balance)`; it
must equal the sum of redeemable cash-in vouchers minus settled payouts minus
remittances.

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/wallet/vouchers/redeem` | player | redeem a cash-in code |
| `GET` | `/api/wallet/vouchers` | player | codes issued to the player |
| `POST` | `/api/wallet/cash-out` | player | request cash and receive a code |
| `GET` | `/api/cash/agent` | agent | dashboard, limits, recent vouchers |
| `POST` | `/api/cash/agent/vouchers` | agent | issue a cash-in code |
| `POST` | `/api/cash/agent/payouts/settle` | agent | pay a cash-out code |
| `POST` | `/api/cash/agent/vouchers/:id/cancel` | agent | cancel an open code |
| `GET` | `/api/admin/cash-agents` | admin | list agents |
| `POST` | `/api/admin/cash-agents` | admin | register an agent and its code |
| `POST` | `/api/admin/cash-agents/:id/status` | admin | activate, suspend or close |
| `POST` | `/api/admin/cash-agents/:id/remit` | admin | record cash handed in |
| `GET` | `/api/admin/cash-vouchers` | admin | recent vouchers, all agents |
| `POST` | `/api/admin/cash-vouchers/:id/cancel` | admin | cancel any open code |

Admin actions require confirmation, a reason and — in production — MFA.
Player money routes go through the financial rate limiter.

## Reconciliation

`npm run reconcile` and Admin → Ledger already compare every cached account
balance with the posted journal lines, including the new float and platform-bank
accounts. To reconcile the counter itself, compare:

```sql
-- cash the platform believes each agent is holding
SELECT a.code, a.name, -w.available_cents AS cash_held_cents
FROM cash_agents a JOIN wallet_accounts w ON w.id = a.float_account_id
ORDER BY a.code;

-- open cash-in codes that can still be redeemed
SELECT a.code, COUNT(*) AS open_codes, SUM(v.amount_cents) AS open_cents
FROM cash_vouchers v JOIN cash_agents a ON a.id = v.agent_id
WHERE v.kind = 'deposit' AND v.status = 'issued' AND v.expires_at > now()
GROUP BY a.code;
```

`cash held` must be greater than or equal to `open cents` for each agent: the
difference is the agent's own settled takings, which is what a remittance
clears. A negative difference means too many deposits were redeemed for codes
that were never issued — stop the agent and investigate the audit trail
(`cash.voucher_issued`, `cash.voucher_redeemed`, `cash.payout_settled`).

Once a day, an operator records the physical remittance. The journal moves the
same amount from the agent's float to the platform bank account, so the float
returns toward zero as the cash reaches the bank.

## Turning it on

1. Decide the counter network: who is an agent, what their code is, where the
   cash is kept and who remits it.
2. Register agents in Admin → Agents with a code (3–12 letters or digits,
   unique), limits and location. The account is promoted from `player` to
   `agent` in the same transaction.
3. `CASH_AGENTS_ENABLED=true` in the environment and restart.
4. In `test` mode, run a full rehearsal with staff accounts: issue, redeem,
   cancel, expire, remit. Verify the Ledger tab reports zero discrepancies.
5. Only when real mode is authorised (signed activation manifest, provider
   approval, age/identity verification) do cash payouts become available.

## What this rail does not do

- It does not make staking legal. Free chess stays available in every mode; a
  staked game still needs the compliance state to permit it.
- It does not accept mobile-money transfers into a personal wallet. Only the
  code path credits a player, and only after an agent's float is debited.
- It does not bypass KYC. Cash-out requires verified email, age and identity.
- It does not replace provider deposits for players who never visit a counter;
  gateways remain the online path once merchant approval exists.
