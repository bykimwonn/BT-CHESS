# ♔ BetChess ZW

Zimbabwe's real-money chess platform: bet against a **real Lichess Stockfish 18 engine**, or get
matched with another player staking the same amount. Wallet runs on **EcoCash** (plus InnBucks,
OneMoney, bank transfer and cash agents), with a sandbox mode so the whole flow is testable before
you have merchant credentials.

```
┌──────────────────────────────────────────────────────────────────┐
│  browser                │  server (Node)                         │
│  ─────────────────────  │  ─────────────────────────────────────  │
│  board + wallet UI      │  authoritative game state & clocks     │
│  Lichess SF18 (wasm) ───┼─► analysis only (eval bar / hints)     │
│     ↓ fallback          │  Lichess SF18 (wasm)  ← plays the game │
│  server analysis        │  Lichess cloud eval   ← GM-tier moves  │
│                         │  payments: EcoCash / InnBucks / ...    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
npm install          # also vendors chess.js + the Lichess engine into public/
npm start            # http://localhost:3000   (admin: /admin)
npm test             # 27 unit + client tests
npm run test:e2e     # plays a real game against the engine (server must be running)
```

No configuration is required. Out of the box:

* the **Lichess Stockfish 18** wasm engine runs in-process (no API key, no external service),
* **payments run in sandbox mode** — deposits and withdrawals settle automatically so you can
  click through the full flow,
* every new wallet starts with **$12.50** of play credit.

---

## What was broken, and what changed

| Before | Now |
| --- | --- |
| `public/app.js` had a **syntax error** (`'w':'b' : 'w'`) — the whole client never executed | fixed; a jsdom smoke test now boots the page on every `npm test` |
| `chess.js` 0.13.4 pinned, but code called the **1.x API** (`isGameOver()` etc.) — every move threw | upgraded to **chess.js 1.4.0** (ships CJS + ESM) and every call goes through a `safeMove()` helper, because 1.x *throws* on illegal moves |
| "engine" was a **1-ply material grabber** (`getServerEngineMove`) labelled Grandmaster 2850 | **Lichess Stockfish 18** (NNUE) plays every computer move |
| Stockfish was loaded as a 1.5 MB **main-thread** `<script>`, and `initStockfish()` was never called | engine runs in a **Web Worker**, with server-side analysis as fallback |
| client sent its own engine moves (`engineReply`) *and* the server generated one → duplicate/illegal moves | **server is authoritative**; clients never send engine moves (also removes the cheat vector) |
| `EcoCash` was a stub object; references like `DEP-<uuid>-<ts>` were split on `-` and lost the user id | real provider layer with references, lifecycle, idempotent settlement and signed webhooks |
| `handleEngineOver` was defined inside the socket scope and unreachable from the engine | hoisted to module scope |

---

## The engine

### Server (authoritative)

`lib/engine/` resolves every computer move through a ladder, degrading gracefully:

1. **Lichess cloud eval** — `GET https://lichess.org/api/cloud-eval` (no key required, cached,
   circuit-broken). Used for the full-strength tiers (Master, Grandmaster), the analysis panel and
   anti-cheat scoring. If lichess.org is unreachable it switches itself off — nothing breaks.
2. **Lichess Stockfish 18 wasm** — the engine behind lichess.org analysis
   (`@lichess-org/stockfish-web`), running in-process. ~700k nodes/second, mate-in-2 found in
   well under a second.
3. **Pure-JS fallback** — a small negamax + quiescence searcher with zero dependencies, so the
   app still plays even if wasm cannot start.
4. Random legal move (last resort).

Strength is shaped per tier with `Skill Level`, `UCI_LimitStrength`/`UCI_Elo`, depth caps and a
deliberate blunder rate, so every tier stays beatable:

| Tier | Elo | Payout | Engine settings |
| --- | --- | --- | --- |
| Easy | 800 | 1.6× | Skill 0, depth ≤ 4, 35 % off-book moves |
| Medium | 1250 | 2.5× | Skill 6, depth ≤ 8, 18 % off-book |
| Hard | 1800 | 4.2× | UCI_Elo 1800 |
| Master | 2400 | 8× | UCI_Elo 2400 + cloud eval |
| Grandmaster | 2850 | 15× | UCI_Elo 2850 + cloud eval + jackpot |

### Browser (analysis only)

`public/engine-worker.js` runs the same Lichess build in a Web Worker for the eval bar, hints and
the analysis tab. If the worker cannot start (old browser, blocked wasm) `public/js/engine-client.js`
quietly falls back to the server over the socket — the UI shows **Server engine ✓**.

```bash
npm run engine:bench    # strength + timing report for the whole ladder
```

---

## Payments

### Sandbox vs live

`PAYMENT_MODE=mock` (default) → every provider settles itself after
`MOCK_SETTLEMENT_DELAY_MS`, including failures if you set `MOCK_FAILURE_RATE`. The UI, wallet,
reference numbers, admin queue and webhooks all behave exactly as they will in production.

`PAYMENT_MODE=live` → real HTTP calls. A provider only goes live when its credentials are present;
anything unset stays in sandbox. **Live webhooks are rejected unless the provider's
`*_WEBHOOK_SECRET` is set** (HMAC-SHA256 over the raw body, compared in constant time).

### Providers

| id | Method | Deposit | Withdraw | Settled by |
| --- | --- | --- | --- | --- |
| `ecocash` | EcoCash (Econet/Cassava) | C2B prompt on handset | B2C payout | callback + status poll |
| `innbucks` | InnBucks | C2B | B2C | callback + status poll |
| `onemoney` | OneMoney (NetOne) | C2B | B2C | callback + status poll |
| `bank` | Bank / Zimswitch | transfer with reference | transfer | admin approval in `/admin` |
| `agent` | Cash agent | 6-character code | code | admin approval in `/admin` |

All three mobile wallets share one configurable HTTP client
(`lib/payments/providers/wallet-http.js`): base URL, auth mode (`oauth2` / `apikey` / `bearer` /
`none`) and every endpoint path are env-driven, because the exact contract depends on your
merchant agreement — check them against the docs you were issued with.

### Transaction lifecycle

```
pending ──► processing ──► completed
   │            │
   └────────────┴──────► failed / expired / rejected   (withdrawals are refunded)
```

* every transaction gets a reference (`DEP-…` / `WD-…`) — **settlement is idempotent**, so a
  replayed webhook can never credit the same deposit twice (covered by a test),
* withdrawals hold the funds immediately and refund automatically if they fail,
* `POST /api/payments/webhook/:provider` verifies the signature against the **raw** body,
* `/admin` lists every transaction with Approve / Reject buttons plus engine status.

### API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/payments/providers` | methods, limits, live/sandbox flags |
| `GET` | `/api/payments/status` | mode, volumes, pending count |
| `POST` | `/api/payments/deposit` | `{userId, provider, amount, phone, account}` |
| `POST` | `/api/payments/withdraw` | `{userId, provider, amount, phone, account}` |
| `GET` | `/api/payments/:reference` | poll one transaction |
| `POST` | `/api/payments/webhook/:provider` | provider callback (raw body, signed) |
| `POST` | `/api/admin/payments/approve` | `{password, reference, reject}` |
| `GET` | `/api/engine/status` | engine + cloud-eval health |
| `POST` | `/api/engine/analyse` | `{fen, movetimeMs, multiPv}` |

The old `/api/ecocash/*` routes still work and now map onto the same service.

---

## Configuration

Copy `.env.example` to `.env`. Only four things matter to get going:

```bash
PORT=3000
ADMIN_PASSWORD=change-me
BASE_URL=https://yourdomain.com   # public HTTPS origin - wallets call back here
PAYMENT_MODE=mock                 # flip to live once merchant credentials are in
```

Then the EcoCash block:

```bash
ECOCASH_BASE_URL=https://developers.ecocash.co.zw
ECOCASH_MERCHANT_CODE=12345
ECOCASH_API_KEY=…
ECOCASH_WEBHOOK_SECRET=…          # required in live mode, callbacks fail closed without it
```

EcoCash needs a **public HTTPS callback URL** (`${BASE_URL}/api/payments/webhook/ecocash`). While
developing locally, point `BASE_URL` at a tunnel (`cloudflared tunnel --url http://localhost:3000`)
so you can receive real callbacks before you own a domain.

---

## Deployment

Everything a PaaS needs is in the repo:

| File | Use |
| --- | --- |
| `Procfile` | Heroku / Fly / Dokku / most buildpacks |
| `Dockerfile` | any container host (`docker build -t betchess-zw .`) |
| `render.yaml` | Render blueprint (secrets marked `sync: false`) |
| `railway.toml` | Railway |

```bash
docker build -t betchess-zw .
docker run -p 3000:3000 --env-file .env -v betchess-data:/app/data betchess-zw
```

Notes:

* `npm ci` runs `scripts/vendor-assets.mjs` (postinstall), which copies chess.js and the
  Lichess wasm into `public/` — the app has **no CDN dependency**.
* the JSON database lives in `data/`; mount a volume so balances survive a restart.
* one engine process is enough for a small deployment — searches are queued with priority
  (game moves > analysis > anti-cheat).

---

## Tests

```bash
npm test          # 27 tests: engine, payments, client boot (jsdom)
npm run test:e2e  # end-to-end against a running server
```

`npm test` covers: the engine loads and finds mates, every tier returns legal moves, invalid FENs,
deposit/withdraw lifecycles, double-credit protection, refunds, admin approval, webhook signature
verification, phone normalisation, and that the page boots and renders 64 squares.

---

## Legal

Real-money gaming in Zimbabwe requires the appropriate licensing and age/KYC controls. This
codebase ships with an 18+ disclaimer, phone-verified wallets (OTP) and server-side anti-cheat,
but **compliance, licensing and ZIMRA obligations are yours**. Keep `PAYMENT_MODE=mock` until you
have the paperwork.
