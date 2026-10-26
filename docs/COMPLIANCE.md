# Compliance and activation policy

This repository is software, not legal advice. Real-money competitions are disabled by default and must remain disabled until an operator completes the steps below with independent professional advice and regulator/provider approval.

## Why a flag is not enough

`OPERATING_MODE=real` is necessary but not sufficient. `server/config/compliance.ts` requires all of the following:

- `LEGAL_AUTHORISATION_VERIFIED=true`
- `PROVIDER_MERCHANT_APPROVAL_VERIFIED=true`
- `AGE_VERIFICATION_PROVIDER=<approved provider>`
- `COMPLIANCE_SIGNING_KEY` with at least 32 characters, stored separately from deployment credentials
- A valid HMAC-SHA256 activation manifest at `COMPLIANCE_ACTIVATION_PATH`
- Configured providers with production credentials and per-provider merchant approval flags
- Active account, verified email and provider-verified 18+ status for every real-money player

If any check fails, real-money competitions and withdrawals remain disabled. Free chess remains available.

## Legal and regulatory prerequisites

Obtain and record:

1. A written legal opinion for the exact head-to-head chess competition format, target jurisdictions, online delivery, prize model, tax treatment and marketing.
2. Verification of current Zimbabwe gaming law and regulator requirements. Starting points are the [Lotteries and Gaming Board](https://lgb.co.zw/) and the [Lotteries and Gaming Act [Chapter 10:26]](https://www.law.co.zw/download/1762/), including amendments and any remote/skill-game regime in force at activation time.
3. Operator licence or written permission from the competent authority, with a licence reference and validity dates.
4. Payment-provider approval explicitly allowing the competition/wagering use case, with separate sandbox and production merchant credentials.
5. An approved 18+ identity/age verification provider and a signed webhook integration.
6. AML/KYC policy, sanctions screening, beneficial-ownership checks, record retention, tax/withholding treatment and a named AML officer.
7. Responsible-play policy: deposit/stake limits, self-exclusion, cooling-off, affordability intervention, complaint escalation and support resources.
8. Consumer terms, privacy notice, cookie notice, dispute policy and fair-play policy reviewed by counsel.
9. Data-processing agreements, breach notification procedure and operator/contact details.

## Activation manifest

1. Copy the template:

```bash
cp config/compliance-activation.template.json config/compliance-activation.draft.json
```

2. Replace every `REPLACE_...` placeholder with real, independently verified references and ISO timestamps.
3. Have a human compliance officer approve the draft and store evidence out of band.
4. Sign with a key that is **not** stored with the application deployment secrets:

```bash
COMPLIANCE_SIGNING_KEY='<outside-secret-store>' \
  node scripts/sign-activation.ts \
  config/compliance-activation.draft.json \
  config/compliance-activation.json
```

The script writes a file with mode `0600` and prints a digest. The signed file and draft are gitignored. The server verifies the signature at startup; changing any material field invalidates activation.

## Production environment

Example (never commit real secrets):

```bash
OPERATING_MODE=real
LEGAL_AUTHORISATION_VERIFIED=true
PROVIDER_MERCHANT_APPROVAL_VERIFIED=true
AGE_VERIFICATION_PROVIDER=Approved18Plus
AGE_VERIFICATION_WEBHOOK_SECRET=<hmac secret>
COMPLIANCE_SIGNING_KEY=<separate signing key>
COMPLIANCE_ACTIVATION_PATH=/run/secrets/rookstone-activation.json
PAYNOW_ENABLED=true
PAYNOW_LIVE=true
PAYNOW_MERCHANT_APPROVED=true
```

Repeat per-provider production settings only for approved providers. Sandbox providers are rejected in real mode.

## Age verification integration

`POST /api/auth/age-verification` accepts `{ userId, providerReference, verified, signature }`. The signature must be an HMAC-SHA256 over the exact raw JSON payload using `AGE_VERIFICATION_WEBHOOK_SECRET`. The provider must perform real identity/age verification; the application does not treat a self-declared birth date as verification. `users.age_verified` can only be set through this signed integration (or an audited database migration).

## Tax and withholding

Some jurisdictions require withholding on winnings or operator reporting. This application does not implement jurisdiction-specific tax withholding. The operator must configure tax rules, ledger accounts and reporting before enabling real money. Do not assume the 5% platform commission covers tax.

## Responsible play

Real-money players must be 18+, email-verified and active. The server enforces daily deposit/stake limits, self-exclusion, available-funds checks and audited session revocation. Operators should add affordability checks and intervention procedures required by their licence. Self-exclusion should not be reversible by the player during the cooling-off period.

## Fair play

Engine similarity is a signal, not proof. `AnalysisService` stores a conservative aggregate score and creates a `match_reviews` item for human review. No automatic ban, confiscation or rating penalty follows from engine similarity alone. Any sanction requires a reviewer, decision, notes and audit log.

## Pre-launch gate

Do not enable production keys or accept real deposits until all of these are true:

- [ ] Legal opinion and current-law review recorded.
- [ ] Licence/permission reference recorded and valid.
- [ ] Provider approvals recorded for each enabled provider.
- [ ] Age verification and AML/KYC providers tested end-to-end.
- [ ] Signed activation manifest verified by `/api/status` and `/admin/compliance`.
- [ ] Production PostgreSQL backup/restore tested.
- [ ] SMTP, rate limits, CSP, TLS, session cookie flags and monitoring verified.
- [ ] Sandbox webhook, refund, reversal, chargeback, dispute, settlement and restart tests passed.
- [ ] Administrator MFA enabled for every admin.
- [ ] Responsible-play limits and self-exclusion tested.
- [ ] Finance reconciliation and commission account verified.

If any box is unchecked, keep `OPERATING_MODE=free` or `test`.


## Jurisdiction policies and international release

Migration `002_international_modes.sql` creates server-side `jurisdiction_policies` for `*`, `ZZ` (undisclosed), `ZW`, `US` and `GB`. Free play is allowed by default; real money is disabled for every seeded jurisdiction. Administrators can update policies only with MFA, explicit confirmation, a documented reason and immutable audit records.

A player's country of residence is voluntary and used only for free-play/test policy and optional flag display. Real-money eligibility requires `eligibility_jurisdiction`, `eligibility_verified_at`, `location_verified_at`, `identity_verified`, `age_verified` and `email_verified`, plus a policy that permits `real` competitions and an approved provider. A selected country or IP address cannot override this.

`POST /api/auth/eligibility-verification` accepts an HMAC-SHA256 signature over the exact JSON payload excluding `signature`, using `AGE_VERIFICATION_WEBHOOK_SECRET`. Replace the placeholder provider with a contracted 18+/identity/location provider before enabling real money.

The active ledger is USD-cent denominated. Additional currencies require separate accounts, explicit rates with evidence, stored conversion quotes and a separately audited journal; the platform never silently converts USD, ZWG, ZAR, GBP or EUR.
