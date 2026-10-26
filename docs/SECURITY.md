# Security model

## Authentication and sessions

- Passwords are hashed with Argon2id (`@node-rs/argon2`, 19,456 KiB, time cost 2, random salt).
- Sessions use a random 256-bit token stored only as a SHA-256 hash with `SESSION_SECRET` as pepper.
- Cookies: `rs_session` is HttpOnly; `rs_csrf` is readable for double-submit CSRF. Both use SameSite=Lax and Secure in production.
- Sessions can be listed and revoked; password reset and change revoke all sessions.
- Failed logins increment a counter and lock the account for 15 minutes after five failures.
- Optional TOTP MFA (RFC 6238, SHA-1, 6 digits, ±1 window) is encrypted at rest with AES-256-GCM. Production administrators must enable MFA before privileged controls.

## CSRF, CORS and origins

- State-changing HTTP requests require `X-CSRF-Token` equal to the `rs_csrf` cookie and its stored hash.
- `Origin` must match `PUBLIC_ORIGIN` or an explicitly configured CORS origin. Development additionally accepts Arena preview hosts.
- Socket.IO handshakes require an allowed `Origin` and a valid session cookie; no token is accepted from a query string.
- Webhook endpoints are exempt from CSRF but use provider-specific hash/HMAC/header verification.

## Dependencies

- All dependency versions are pinned exactly in `package.json` plus the committed lockfile; `npm ci` is used everywhere.
- `npm audit` reports **0 vulnerabilities** (0 critical, 0 high, 0 moderate) as of the current lockfile. This required patch updates to `express` (4.22.3), `react-router-dom` (7.18.4), `vite` (7.3.7), `vitest` (5.0.5), `concurrently` (9.2.5), `nodemailer` (10.2.1) and an override pinning `proxy-addr` to 2.0.8. The `proxy-addr` fix matters here: it corrects IP spoofing through IPv4-mapped IPv6 when a trust subnet is configured, which would otherwise undermine `TRUST_PROXY` and therefore rate limiting.
- Dev-only tooling is excluded from the runtime image (`npm prune --omit=dev`), so a test-runner advisory cannot reach production.
- The Stockfish WASM build is vendored from the pinned `stockfish@19.0.1` package by `scripts/vendor-engine.mjs`; its GPL-3.0-or-later text ships in `docs/licenses/`.
- No credential, secret or signed activation artifact is committed; `.gitignore` covers `.env*`, `config/compliance-activation.json` and `config/*.key`.

## Rate limiting and abuse controls

- Global, auth, financial and analysis rate limiters are applied at the HTTP layer.
- Socket move/chat handlers apply per-socket token buckets.
- Move nonces, game versions, out-of-turn checks and `chess.js` legality prevent replay, stale writes and invalid positions.
- Chat is limited to 300 characters, 3 messages/second and the last 50 messages per game; it is not persisted.
- Provider callbacks are deduplicated by provider/event ID.

## RBAC and privileged actions

- `requireAdmin` enforces `role=admin`.
- `privileged` middleware requires MFA when enabled and blocks production admins without MFA.
- High-impact admin actions require `confirm: true` and a documented reason, and are written to `admin_actions` and `audit_events`.
- User emails are masked in admin lists. Public profiles expose only non-sensitive statistics.

## Financial integrity

- Money is integer cents; no floating-point balances.
- Posted ledger entries are immutable by database trigger; corrections are separate balanced journals.
- Deferred constraint triggers reject unbalanced posted journals.
- Wallet accounts are locked in deterministic order to prevent concurrent overdrafts.
- Deposit credits require provider status verification, amount/currency match and an idempotency key.
- Settlements use a unique `game_id` row and unique ledger idempotency key.
- Open disputes block settlement; a human admin resolves them.
- Withdrawals reserve funds and complete only after provider confirmation.

## Data protection

- Structured logs redact cookies, authorization headers, passwords, tokens, secrets and API keys.
- Email addresses are unique case-insensitively and not exposed on public leaderboards/profiles.
- Provider callback payloads are stored for reconciliation; restrict database access and retention according to policy.
- Chat is ephemeral. Preference data is local to the browser.
- CSP allows same-origin scripts, WASM evaluation, same-origin workers, inline styles and WebSocket connections; `object-src` is none, `base-uri` is self, and `form-action` is self. HSTS is enabled in production. `frameguard` is intentionally not set to `DENY` so preview/embedding environments can display the app; restrict framing at the edge if not needed.

## Fair play

Engine analysis is advisory. A human reviewer must inspect game context and record a decision before any sanction. No hidden client-side fraud score is returned to players.

## Vulnerability reporting

Replace the operator support contact before launch. Do not publish security reports in game chat or public issues. Preserve logs, database snapshots and provider events for incident review.

## Security checklist before production

- [ ] Generate a unique 32+ byte `SESSION_SECRET`.
- [ ] Set secure cookies behind HTTPS and correct `TRUST_PROXY`.
- [ ] Enable MFA for every administrator.
- [ ] Configure SMTP, provider webhook secrets and age-verification HMAC secret.
- [ ] Restrict database network access and rotate credentials.
- [ ] Enable backups and test restore.
- [ ] Review CSP, CORS origins, rate-limit thresholds and log retention.
- [ ] Run `npm test`, `npm run build`, `npm run reconcile`.
- [ ] Perform penetration testing with an authorised third party.


## International eligibility and signed verification

Country, timezone and flag visibility are voluntary profile data. They are never proof of legal eligibility. Verified jurisdiction, 18+ status, identity and location are set only through `POST /api/auth/eligibility-verification` with an HMAC-SHA256 signature over the exact raw payload excluding the signature field. Invalid signatures are rejected and audited as provider errors.

`EligibilityService` reads `jurisdiction_policies` from the database on every decision. Admin policy changes require RBAC, MFA when enabled, explicit confirmation, a documented reason and immutable audit entries. Free play remains available where lawful even when all payment providers and real-money policies are disabled.
