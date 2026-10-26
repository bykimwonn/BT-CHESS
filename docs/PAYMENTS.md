# Payment provider interfaces

All money is integer USD cents. Provider adapters are server-side only; browser code never receives integration keys, encryption keys, merchant PINs or webhook secrets. No customer mobile-money PIN is collected or stored. `ECOCASH_MERCHANT_API_PIN` is a merchant API credential issued by the provider, not a customer PIN.

Official documentation used during implementation:

- Paynow: <https://developers.paynow.co.zw/docs/paynow/initiate_transaction/>, <https://developers.paynow.co.zw/docs/paynow/generating_hash/>, <https://developers.paynow.co.zw/docs/paynow/validating_hash/>, <https://developers.paynow.co.zw/docs/paynow/polling_status/>
- EcoCash: <https://developers.ecocash.co.zw/docs>, <https://developers.ecocash.co.zw/docs/online-payments>, <https://developers.ecocash.co.zw/docs/merchant-to-subscriber>, <https://developers.ecocash.co.zw/docs/transaction-lookup>
- PesePay: <https://developers.pesepay.com/getting-started/overview/>, <https://developers.pesepay.com/api/initiate-transaction/>, <https://developers.pesepay.com/api/check-payment-status/>, <https://developers.pesepay.com/webhooks/verifying-callbacks/>

## Common rules

1. A deposit row is inserted as `pending` before any provider call.
2. The provider response is never treated as a completed deposit.
3. A callback must pass the provider-specific authenticity check.
4. The server performs a second server-to-server status lookup and compares amount/currency.
5. Only then does it post a balanced deposit journal and set the deposit `confirmed`.
6. Provider event IDs are deduplicated in `payment_provider_events`.
7. Browser return URLs are informational only.
8. Sandbox results post `test_deposit_credit` journals labelled as having no cash value.
9. Failed withdrawals release the reservation with a compensating journal.
10. Withdrawals are disabled unless authorised real-money mode is active.

## Paynow

- Initiation: `POST https://www.paynow.co.zw/interface/initiatetransaction`, form URL-encoded, with `id`, `reference`, `amount`, `returnurl`, `resulturl`, `status=Message`, optional `merchanttrace`, and an uppercase SHA-512 `hash`.
- The adapter verifies the `hash` on the initiate response before using `browserurl` or storing `pollurl`.
- Status update: Paynow posts a URL-encoded body. The adapter validates the SHA-512 hash computed from URL-decoded values in message order plus the integration key.
- Server verification: empty `POST` to the stored `pollurl`, or `POST /interface/trace` with `merchanttrace`. Only `Paid`, `Awaiting Delivery` or `Delivered` are treated as paid; `Refunded` triggers reversal; `Disputed` remains pending.
- Payouts: not implemented because Paynow does not publish a merchant payout API for this integration. Use an approved payout provider.
- Test coverage: the unit test reproduces the exact hashes from Paynow's official documentation.

## EcoCash

Two distinct EcoCash APIs are used:

- **Instant Payments (deposits/refunds):** HTTP Basic authentication against the sandbox base `https://developers.ecocash.co.zw/sandbox/payment/v1`. The official portal documents the lookup URL `/{endUserId}/transactions/amount/{clientCorrelator}` and refund URL `/transactions/refund/`; the adapter uses the `POST /transactions/amount/` charge path shown in EcoCash integration examples. Verify the assigned charge path, merchant code, terminal ID, API PIN and whitelist with EcoCash before go-live. The customer approves on their phone via USSD; Rookstone never asks for a customer PIN.
- **EPG Merchant-to-Subscriber (withdrawals):** `POST /api/serviceRequest` with `serviceType=MERCHTOSUBV2`, `channelCode=800004`, `walletId=12`, a numeric `externalReference`, client credential headers and the encrypted channel password generated on the EcoCash credentials page. The adapter does not invent the channel-password encryption algorithm; it requires `ECOCASH_EPG_ENCRYPTED_PASSWORD`.
- Transaction lookup uses `EXTERNALTRANSACTIONLOOKUP` with client credentials only.
- Sandbox transactions are simulated; no real money moves. Production endpoints are issued by EcoCash after go-live and must be set in configuration.
- Refunds use `tranType=REF` with a fresh client correlator and the original EcoCash reference.

## PesePay

- Initiation: `POST /payments-engine/v1/payments/initiate` with `authorization: <integration key>` and `{ payload: <AES-256-CBC base64> }`.
- Encryption key must be exactly 32 characters; the IV is the first 16 characters, as documented. The adapter decrypts the response payload and stores `referenceNumber`, `redirectUrl` and `pollUrl`.
- Result callback: PesePay sends plain JSON with the integration key in `Authorization`. The adapter rejects a mismatched header, then ignores the callback's status and calls Check Payment Status.
- Check Payment Status: `GET /payments-engine/v1/payments/check-payment?referenceNumber=...`, decrypt the response payload and compare `amountDetails.amount`/`currencyCode` with the pending deposit.
- Sandbox and production base URLs are distinct. Do not point production at the sandbox.
- Payouts: not implemented because no supported merchant payout endpoint is documented for this integration.

## OneMoney

The direct adapter is disabled. No verified public direct merchant API contract was available during implementation; the official site provides merchant onboarding information rather than a complete public payments API specification. OneMoney may be reachable through an approved aggregator such as Paynow once the merchant account is approved. The UI does not imply a working direct integration.

## Adding another provider

1. Implement `PaymentAdapter` in `server/payments/adapters/`.
2. Add the provider ID to `shared/validation.ts` and the registry.
3. Provide `health()`, `initiateDeposit`, `initiateWithdrawal` (or a precise unsupported error), `parseCallback`, `checkStatus`, and optional `refund`.
4. Add signed/hash-verified callback tests, status-verification tests, amount mismatch tests and replay tests.
5. Document the exact official endpoints, sandbox/production URLs, authentication, webhook signature, payout/refund support, currencies, fees, merchant terms and wagering restrictions.
6. Do not enable the adapter until legal and merchant approvals are verified.


## Regional availability and currency isolation

`jurisdiction_policies.allowed_providers` controls which provider IDs may be used for a verified jurisdiction. `PaymentService.assertProviderAllowed` calls `EligibilityService.assertPaymentProviderAllowed`; a frontend provider selection cannot bypass it. A jurisdiction that allows free chess may still have an empty provider list and no real-money capability.

Deposits and withdrawals store an explicit currency. `ledger_transactions` and `ledger_entries` also store the currency, and a trigger rejects a journal whose transaction, entry or wallet account currencies differ. `LedgerService.systemAccountId` creates currency-specific system accounts on demand. USD remains the only active account currency; other currencies are an architecture path, not an unverified live feature.

Exchange rates are explicit database records with a source and evidence reference. `POST /admin/currencies/quotes` stores a conversion quote with `applied=false`; it never changes a wallet. Introducing another currency requires a reviewed migration, provider capability verification, separate accounts, reconciliation tests and an audited conversion journal.
