# API summary

All endpoints are under `/api`. Cookies are first-party and state-changing requests require the `X-CSRF-Token` header equal to the `rs_csrf` cookie and an allowed `Origin`. Admin endpoints additionally require `role=admin`; if the admin has MFA enabled, send `X-MFA-Code`.

## Public

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Database and process health |
| GET | `/status` | Platform mode, fee, compliance blockers, provider and engine health |
| GET | `/payments/providers` | Provider health and official documentation links |
| POST | `/payments/webhook/:provider` | Raw provider callback; signature/hash validated by adapter |
| POST | `/auth/register`, `/auth/login`, `/auth/forgot`, `/auth/reset`, `/auth/verify-email` | Account lifecycle |
| POST | `/auth/age-verification` | Signed 18+ provider integration point |
| GET | `/games/:id`, `/games/:id/pgn` | Public replay snapshot and PGN download |
| GET | `/games/:id/analysis` | Authenticated, rate-limited server post-game analysis |
| POST | `/analysis` | Authenticated FEN/PGN position analysis |
| GET | `/leaderboard` | Real ratings from persisted games |
| GET | `/users/:username/profile`, `/users/:username/games` | Public profile and game history |
| GET | `/puzzles`, `/challenges`, `/invites/:token` | Public training and lobby data |
| POST | `/competitions/quote`, `/competitions/fee-preview` | Server-generated hashed terms and fee math |

## Authenticated

| Area | Endpoints |
| --- | --- |
| Session | `GET /auth/session`, `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/revoke-sessions`, `POST /auth/change-password`, `POST /auth/email-verification/send` |
| MFA | `POST /auth/mfa/setup`, `/auth/mfa/verify`, `/auth/mfa/disable` |
| Account | `GET/PATCH /me`, `GET/POST /notifications`, `/notifications/:id/read`, `/notifications/read-all` |
| Wallet | `GET /wallet`, `/wallet/transactions`, `/wallet/statement.csv`, `/wallet/receipt/:id`, `/wallet/deposits`, `/wallet/withdrawals`, `POST /wallet/deposit`, `/wallet/withdraw`, `/wallet/test-credits`, `/wallet/deposits/:id/confirm`, `/wallet/withdrawals/:id/confirm` |
| Games | `GET /games`, `POST /games/:id/moves`, `/games/:id/resign`, `/games/:id/draw-offer`, `/games/:id/draw-answer`, `/games/:id/claim-draw`, `/games/:id/dispute` |
| Competitions | `POST /challenges`, `/challenges/:id/accept`, `/challenges/:id/invite`, `DELETE /challenges/:id`, `POST /matchmaking`, `DELETE /matchmaking` |
| Responsible play | `GET /responsible-play/restrictions`, `POST /responsible-play/limits`, `POST /responsible-play/self-exclude` |

## Administrator

`/admin/overview`, `/admin/users`, `/admin/users/:id/status`, `/admin/games`, `/admin/games/:id`, `/admin/disputes`, `/admin/disputes/:id/resolve`, `/admin/fair-play/:gameId/review`, `/admin/reviews`, `/admin/reviews/:id/close`, `/admin/ledger`, `/admin/reconciliation`, `/admin/commission`, `/admin/settlements`, `/admin/settlements/reconcile`, `/admin/deposits`, `/admin/withdrawals`, `/admin/provider-events`, `/admin/providers`, `/admin/system-health`, `/admin/security-events`, `/admin/audit-logs`, `/admin/actions`, `/admin/compliance`, `/admin/config`, `/admin/config/commission`, `/admin/responsible-play`.

High-impact admin POSTs require `{ confirm: true, reason: "..." }` and are recorded in `admin_actions` and `audit_events`.

## Socket.IO events

Client → server: `game:join`, `game:leave`, `game:move`, `game:resign`, `game:draw-offer`, `game:draw-answer`, `game:claim-draw`, `game:chat`, `challenge:subscribe`.

Server → client: `game:state`, `game:terminal`, `game:chat`, `challenge:created`, `challenge:updated`, `matchmaking:found`, `notification:new`, `server:error`.

Move payload:

```json
{
  "gameId": "uuid",
  "version": 3,
  "from": "e2",
  "to": "e4",
  "promotion": "q",
  "nonce": "unique-client-nonce"
}
```

`promotion` is optional. Stale versions, duplicate nonces, illegal moves and out-of-turn moves are rejected.


## International modes and eligibility

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/eligibility` | Optional-auth eligibility view: voluntary country, verified jurisdiction, policy, free-play and money-match availability |
| GET | `/me/international` | Authenticated international profile and server eligibility state |
| PATCH | `/me/international` | Update voluntary country, country sharing, IANA timezone, timezone sharing and account-currency display preference |
| POST | `/auth/age-verification` | Signed age callback; may also set identity/location and verified jurisdiction |
| POST | `/auth/eligibility-verification` | Signed 18+/identity/location/jurisdiction integration point |
| GET | `/tournaments` | Real free tournaments only; no fabricated events |
| GET | `/tournaments/:id` | Tournament detail, standings and pairings |
| POST | `/tournaments` | Create a free international tournament |
| POST | `/tournaments/:id/join` | Join with an authenticated account |
| POST | `/tournaments/:id/start` | Director/start first round and pair real entrants |
| POST | `/tournaments/:id/pair` | Pair the next round after all games finish |
| GET | `/admin/jurisdictions` | Server-side jurisdiction policies |
| POST | `/admin/jurisdictions` | Audited policy update (MFA + confirm + reason) |
| GET | `/admin/currencies/rates` | Explicit exchange-rate records |
| POST | `/admin/currencies/rates` | Record an explicit rate with source/evidence |
| GET | `/admin/currencies/quotes` | Stored conversion quotes (never balance-changing) |
| POST | `/admin/currencies/quotes` | Create a quote from an explicit rate |

`GET /status` now includes `ledgerBaseCurrency` and `freePlayGlobal`. `GET /leaderboard` and `GET /games/:id` include voluntary country/timezone fields only when the player opted in. All internal timestamps are UTC; the UI formats local times with `Intl.DateTimeFormat`.

`POST /competitions/quote` considers the signed-in viewer's server eligibility. A quote is `allowed: false` with blockers when the user, jurisdiction or platform cannot enter that mode. Client-provided eligibility is never accepted.
