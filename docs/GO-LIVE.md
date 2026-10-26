# Turning on real money

This document is the operator's path from the default deployment (`OPERATING_MODE=free`) to accepting real USD deposits and running real-money chess competitions.

**Read this first:** the application deliberately refuses to accept real money on the strength of a configuration flag alone. Real mode requires evidence that software cannot produce: a legal opinion, an operator licence or written permission, written payment-provider approval for the wagering use case, a contracted 18+ identity provider, and a signed activation manifest. If any of those is missing, `/api/status` keeps `realMoneyEnabled: false`, deposits return 503 and withdrawals are refused. That is by design, not a bug, and no environment variable overrides it.

## 1. Check the current state

```bash
npm run preflight                # configuration only, no network
npm run preflight -- --smtp      # also opens a real SMTP session
npm run preflight -- --db        # also checks admin MFA and the ZW jurisdiction policy
npm run preflight -- --network   # also reaches PUBLIC_ORIGIN and provider API hosts
npm run preflight -- --smtp --db --network   # full go-live check
```

Every `[FAIL]` line is a blocker with the exact variable to set. The same information appears at `GET /api/status` (`realMoneyBlockers`) and in **Admin → Compliance**.

## 2. Hosting, domain and database

| Requirement | Why |
| --- | --- |
| Public HTTPS origin | Paynow, EcoCash and PesePay POST results to `/api/payments/webhook/<provider>`. A `localhost` origin can never receive them. |
| Managed PostgreSQL | Real money needs point-in-time recovery and a database that survives redeploys. `ALLOW_EMBEDDED_DB` is intended for single-node evaluation only. |
| `SESSION_SECRET` ≥ 32 chars | Sessions and one-time tokens are signed with it. |
| Automatic backups | Provider callbacks can arrive minutes after a restart; losing the database loses pending deposits. |

```bash
NODE_ENV=production
PUBLIC_ORIGIN=https://chess.yourdomain.co.zw
CORS_ORIGINS=https://chess.yourdomain.co.zw
TRUST_PROXY=1
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/rookstone?sslmode=require
SESSION_SECRET=<openssl rand -hex 32>
```

## 3. Email

Password reset and email verification must work before real money is accepted. Follow [EMAIL.md](EMAIL.md). Gmail needs an App Password, and `EMAIL_FROM` must match `SMTP_USER`:

```bash
EMAIL_PROVIDER=gmail
SMTP_USER=your.address@gmail.com
SMTP_PASS=<16-character App Password>
EMAIL_FROM="Rookstone Arena <your.address@gmail.com>"
```

Verify with `npm run email:test -- your.address@gmail.com`, then check the spam folder and the message headers.

## 4. Legal and regulatory

These steps need professional advice; this repository is software, not legal advice.

1. **Structure the product.** Paid head-to-head chess with entry fees and cash prizes can fall inside Zimbabwe's gambling regime depending on how it is structured, marketed and paid out. The Lotteries and Gaming Act [Chapter 10:26] and the [Lotteries and Gaming Board](https://lgb.co.zw/) are the starting points. Confirm the current law, any remote/online regime in force and whether skill-based chess is treated differently. Get a written opinion for *your* format.
2. **Obtain the licence or written permission** that covers online paid chess competitions in every jurisdiction you will accept players from. Record the reference and validity dates.
3. **Set up the operating entity**: registered company, bank account in the entity's name (providers will require this), tax registration and a named AML/compliance officer.
4. **Write the player-facing documents**: terms of service, competition rules, payout policy, privacy notice, complaints/escalation policy and responsible-play policy. Counsel should review them.

Record the results:

```bash
LEGAL_AUTHORISATION_VERIFIED=true
# used by the activation draft:
COMPLIANCE_JURISDICTION=ZW
COMPLIANCE_LEGAL_OPINION_REF="<firm, date, matter reference>"
COMPLIANCE_LICENCE_REF="<licence or permission reference, expiry>"
COMPLIANCE_AML_OFFICER_REF="<name and role>"
COMPLIANCE_APPROVED_BY="<human who approved activation>"
COMPLIANCE_EXPIRES_AT="<ISO timestamp, max 12 months out>"
```

`LEGAL_AUTHORISATION_VERIFIED=true` is an assertion by a human with the evidence in hand. Nothing in the code can check that the licence is real.

## 5. Payment providers

Apply for a merchant account as the registered business. Approval covers the *use case*: state clearly that the money is entry fees and prize payouts for chess competitions. An approval limited to retail payments does not cover wagering.

### Paynow (deposits, USD and ZWG rails)

1. Create a merchant account at <https://paynow.co.zw>. Paynow typically asks for incorporation documents, director IDs, proof of the bank account and a description of the service; confirm the current list with Paynow.
2. In the Paynow dashboard, open **Integration** and copy the **Integration ID** and **Integration Key**.
3. Ask Paynow, in writing, to approve the paid-competition use case and to enable the production account.
4. Configure:

```bash
PAYNOW_ENABLED=true
PAYNOW_LIVE=true
PAYNOW_MERCHANT_APPROVED=true
PAYNOW_INTEGRATION_ID=<integration id>
PAYNOW_INTEGRATION_KEY=<integration key>
PAYNOW_BASE_URL=https://www.paynow.co.zw
```

Paynow posts the result to `${PUBLIC_ORIGIN}/api/payments/webhook/paynow` and the browser returns to the wallet. The adapter verifies the SHA-512 hash on both the initiate response and every callback, then performs a server-to-server poll before crediting. A browser return is never treated as payment.

Paynow has **no merchant payout API** for this integration, so Paynow alone cannot pay winnings out. See step 6.

### EcoCash (deposits and EPG payouts)

EcoCash onboarding is through Econet's merchant team; sandbox access and credentials are issued at <https://developers.ecocash.co.zw>. Two separate credential sets are needed:

- **Instant Payments** (deposit charge + lookup + refund): `ECOCASH_EIP_USERNAME`, `ECOCASH_EIP_PASSWORD`, `ECOCASH_MERCHANT_CODE`, `ECOCASH_MERCHANT_API_PIN`, `ECOCASH_MERCHANT_NUMBER`, `ECOCASH_TERMINAL_ID`, `ECOCASH_MERCHANT_NAME`, `ECOCASH_SUPER_MERCHANT_NAME`.
- **EPG Merchant-to-Subscriber** (withdrawals): `ECOCASH_CLIENT_ID`, `ECOCASH_CLIENT_SECRET`, `ECOCASH_API_USERNAME`, `ECOCASH_EPG_ENCRYPTED_PASSWORD`. The encrypted channel password is generated on the EcoCash credentials page; the encryption algorithm is not published, so the platform requires the already-encrypted value.

The customer approves each debit on their own handset. Never ask for or store a customer PIN — the platform does not.

### PesePay (deposits)

Merchant account and integration key from <https://pesepay.com>. `PESEPAY_ENCRYPTION_KEY` must be exactly 32 characters (AES-256-CBC, IV = first 16 characters, as documented). Result callbacks carry the integration key in `Authorization`; the adapter then re-checks the payment server-side before crediting. PesePay does not publish a merchant payout API for this integration.

### OneMoney

There is no verified public direct merchant API. Use Paynow after approval; OneMoney is reachable there as a payment method. The direct adapter stays disabled.

### Testing the rails before approval

Paynow issues **test integration credentials** at sign-up, before the merchant account is approved for live payments. They run against the same host with a test integration ID/key and move no money. That is the correct way to exercise the integration end to end before the licence exists:

```bash
OPERATING_MODE=test
PAYNOW_ENABLED=true
PAYNOW_LIVE=false            # test credentials
PAYNOW_MERCHANT_APPROVED=false
PAYNOW_INTEGRATION_ID=<test integration id>
PAYNOW_INTEGRATION_KEY=<test integration key>
```

The server rejects production credentials in test mode and test credentials in real mode, so the two cannot be confused. Test-mode deposits post `test_deposit_credit` journals, are labelled sandbox and cannot be withdrawn.

### Turning providers on

Only after written approval:

```bash
PROVIDER_MERCHANT_APPROVAL_VERIFIED=true
<PROVIDER>_ENABLED=true
<PROVIDER>_LIVE=true            # Paynow: PAYNOW_LIVE; PesePay: PESEPAY_SANDBOX=false
<PROVIDER>_MERCHANT_APPROVED=true
```

Real mode rejects sandbox credentials, and test mode rejects production credentials. Mixing them fails closed.

## 6. A payout path is mandatory

Players can deposit without withdrawals, but that traps their money and will breach most licensing conditions. Before go-live you need at least one provider whose `capabilities` include `merchant-payout`. Today that is **EcoCash EPG only**. The preflight fails while no payout path exists:

```bash
ECOCASH_ENABLED=true
ECOCASH_SANDBOX=false
ECOCASH_MERCHANT_APPROVED=true
ECOCASH_CLIENT_ID=...
ECOCASH_CLIENT_SECRET=...
ECOCASH_API_USERNAME=...
ECOCASH_EPG_ENCRYPTED_PASSWORD=...
```

EcoCash can be enabled for **payouts only**: leave the Instant Payments credentials empty and configure only the EPG set. Deposits then continue through Paynow while withdrawals go out through EcoCash, and preflight still passes because each capability is evaluated separately. Deposit attempts on EcoCash are refused with a clear reason while its Instant Payments credentials are missing.

If EcoCash EPG cannot be obtained, integrate an approved payout provider (bank transfer or mobile-money disbursement) as a new `PaymentAdapter` with a `merchant-payout` capability before accepting deposits.

## 7. Age, identity and location verification

Every real-money player needs `email_verified`, `age_verified` (provider-verified 18+), `identity_verified` and `location_verified_at`, and a jurisdiction policy that permits `real`. Self-declared birth dates are not accepted.

1. Contract a KYC/identity provider that covers Zimbabwe (for example Smile Identity or a local bureau — confirm coverage, document types and pricing). Verify Zimbabwean national IDs and passports.
2. Agree an HMAC-SHA256 secret. The provider calls `POST /api/auth/age-verification` with `{ userId, providerReference, verified, signature }`, where the signature covers the exact raw JSON payload. `POST /api/auth/eligibility-verification` does the same for identity/location/eligibility.
3. Configure:

```bash
AGE_VERIFICATION_PROVIDER=<provider name>
AGE_VERIFICATION_WEBHOOK_SECRET=<32+ random characters>
```

Test both callbacks with a sandbox identity before go-live, including a rejected verification and a replayed signature.

## 8. Sign the activation manifest

The manifest ties the legal evidence to the deployment. Generate a draft from the variables recorded in step 4:

```bash
npm run compliance:draft
```

Review `config/compliance-activation.draft.json` with the compliance officer. Then sign it with a key that is **not** stored alongside the application's deployment credentials:

```bash
COMPLIANCE_SIGNING_KEY='<separate 32+ character key>' \
  npm run compliance:sign -- \
  config/compliance-activation.draft.json \
  config/compliance-activation.json
```

Point `COMPLIANCE_ACTIVATION_PATH` at the signed file and set `COMPLIANCE_SIGNING_KEY` in the deployment secret store. Changing any field invalidates the signature; the server re-checks it at every start. An expired manifest disables real money at the next restart, so diarise re-review.

The signed manifest and draft are gitignored. Keep the evidence pack (opinion, licence, approvals) outside the repository.

## 9. Enable the ZW jurisdiction policy

Jurisdiction policies decide who may play for money, independently of the global flags. After migrations, an administrator sets the Zimbabwe policy to allow real-money competitions **and** lists the approved providers:

```text
Admin → Compliance → Jurisdictions → ZW
  real money allowed: yes
  permitted competition types: free, real
  allowed providers: paynow, ecocash (only the ones approved in writing)
MFA + documented reason + confirmation required
```

Do this only after the licence is in hand. `npm run preflight -- --db` fails while ZW forbids real money.

## 10. Administration and operations

- Enrol **every** administrator in TOTP MFA. Production blocks privileged routes otherwise.
- Replace placeholder operator identity, support contacts and legal notices.
- Configure uptime monitoring on `/api/health` and `/api/status`; alert on `realMoneyEnabled` flipping to false.
- Test a database restore from backup before accepting money.
- Agree a refund/chargeback procedure. Paynow refunds are executed in the Paynow dashboard; the platform records the resulting `Refunded` status as a reversal during status polling.
- Keep the reconciliation job (`npm run reconcile`) on a schedule and investigate every discrepancy.

## 11. Flip the mode and test with real money

```bash
OPERATING_MODE=real
LEGAL_AUTHORISATION_VERIFIED=true
PROVIDER_MERCHANT_APPROVAL_VERIFIED=true
AGE_VERIFICATION_PROVIDER=<approved provider>
AGE_VERIFICATION_WEBHOOK_SECRET=<32+ chars>
COMPLIANCE_SIGNING_KEY=<separate key>
COMPLIANCE_ACTIVATION_PATH=/run/secrets/rookstone-activation.json
```

Then:

1. `npm run preflight -- --smtp --db --network` → no blockers.
2. Redeploy and confirm `GET /api/status` returns `mode: "real"`, `realMoneyEnabled: true` and an empty `realMoneyBlockers` array.
3. Register a test player, complete email verification and the 18+/identity verification.
4. Deposit a small real amount (for example USD 1) through each enabled provider. Confirm the ledger shows a balanced deposit, not a browser-return credit.
5. Verify a pending deposit by polling, and confirm a cancelled payment never credits.
6. Submit a small withdrawal and confirm the payout on the handset plus the reservation release.
7. Run the reconciliation report and confirm zero discrepancies.
8. Only then announce the paid competitions.

If any step fails, set `OPERATING_MODE=free` again. Free chess stays available; the platform fails closed rather than guessing.

## What the platform will refuse

- Accept real money with `OPERATING_MODE` not `real`, or without the signed manifest.
- Use sandbox credentials in real mode, or live credentials in test mode.
- Credit a deposit from a browser redirect or an unauthenticated callback.
- Pay out through a provider with no documented payout workflow.
- Let a player deposit before the jurisdiction policy, age, identity and location checks pass.
- Override the deposit limits, self-exclusion or session revocation through the UI.
