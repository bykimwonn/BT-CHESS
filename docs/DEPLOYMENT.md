# Deployment

## Prerequisites

- Node.js >= 22.12 and npm >= 10.
- PostgreSQL 16+ for production. PGlite is supported for local development, tests and intentional single-node deployments.
- HTTPS termination with the exact public origin in `PUBLIC_ORIGIN` and `CORS_ORIGINS`.
- `SESSION_SECRET` with at least 32 random characters; generate with `openssl rand -hex 32`.
- SMTP server for verification and password-reset email.
- Environment secrets stored in the platform's secret manager, never in Git.

## Reproducible build

```bash
npm ci
npm run typecheck
npm run build
npm test
npm start
```

Build outputs:

- `dist-server/` — compiled Node ESM server and shared contracts.
- `dist/web/` — React bundle, GPL Stockfish WASM assets and original piece SVGs.
- `server/db/migrations/` — SQL migrations (`001_init.sql` and `002_international_modes.sql`) are read from the repository root at runtime. Keep this directory in the runtime image; migration 002 adds jurisdiction policies, currency columns/tables and tournaments.

Startup automatically runs checksummed migrations, recovers idle clocks, performs a Stockfish UCI health check, settles any unfinished funded games, and starts maintenance timers. Verify `/api/status` reports `ledgerBaseCurrency: "USD"` and the intended mode after deployment.

## Environment

Copy `.env.example` to `.env` for local use. Production must set at least:

```bash
NODE_ENV=production
SESSION_SECRET=<32+ random bytes>
PUBLIC_ORIGIN=https://chess.example.com
CORS_ORIGINS=https://chess.example.com
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/rookstone?sslmode=require
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465
EMAIL_FROM="Rookstone Arena <no-reply@example.com>"
OPERATING_MODE=free
```

Set `TRUST_PROXY` to the platform's proxy-hop count. Leave all provider `*_ENABLED` flags false until merchant approval is verified. Keep `ALLOW_EMBEDDED_DB=false` in production unless you intentionally accept single-node PGlite limitations.

## Docker

The included `Dockerfile` is multi-stage and builds both server and web bundles. Local production-like run with PostgreSQL:

```bash
docker compose up --build
```

`docker-compose.yml` requires `POSTGRES_PASSWORD`, `SESSION_SECRET` and `PUBLIC_ORIGIN` from your shell or `.env`. It mounts a named volume for PostgreSQL data and a PGlite-only app data volume for optional single-node use.

Bare Docker image:

```bash
docker build -t rookstone-arena .
docker run --rm -p 3001:3001 \
  -e DATABASE_URL='postgresql://...' \
  -e SESSION_SECRET='...' \
  -e PUBLIC_ORIGIN='https://chess.example.com' \
  -e NODE_ENV=production \
  rookstone-arena
```

## Render

`render.yaml` defines a Node web service with `npm ci && npm run build`, `npm start`, health check `/api/health`, and a managed PostgreSQL database. Set `DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `PUBLIC_ORIGIN`, `CORS_ORIGINS` and `EMAIL_FROM` as secret or explicit environment values in the Render dashboard. Do not use Render's expiring free PostgreSQL for financial data.

## Railway

`railway.toml` sets the build/start commands and health check. Create a Railway PostgreSQL service, copy its `DATABASE_URL` into the web service, and configure the same secrets. Enable a persistent volume only if using PGlite; managed PostgreSQL is preferred.

## Reverse proxy / WebSocket

The app uses same-origin `/api` and `/socket.io`. A reverse proxy must forward WebSocket upgrades and preserve cookies. Example Nginx location:

```nginx
location /socket.io/ {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /api/ { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; }
location / { proxy_pass http://127.0.0.1:3001; }
```

CSP allows same-origin scripts, WASM evaluation, Web Workers and WebSocket connections. If you add a separate CDN, update `script-src`, `worker-src` and `connect-src` deliberately.

## Bootstrap and smoke test

```bash
ADMIN_EMAIL='operator@example.com' ADMIN_USERNAME='OperatorOne' ADMIN_PASSWORD='...' npm run bootstrap:admin
npm run reconcile
curl -fsS https://chess.example.com/api/health
curl -fsS https://chess.example.com/api/status
```

Then enable MFA for the administrator, verify `/admin/overview`, run one free game between two accounts, and inspect `/admin/reconciliation`.

## Backups

Use managed PostgreSQL point-in-time recovery plus nightly `pg_dump`. Test restore into a separate database. Never delete or rewrite ledger rows to fix a discrepancy; use audited compensating journals. Back up the compliance signing key separately from application deployment credentials.

## Rollback

Because migrations are additive and checksummed, roll back application code to a previous image only if its expected schema version matches. Do not edit an applied migration. If a future migration is incompatible, add a forward-only corrective migration.
