import { decimalToCents, centsToDecimal } from '../../../shared/contracts.js';
import { env } from '../../config/env.js';
import { safeEqualText } from '../../services/ids.js';
import { firstHeader, requestJson, type FetchLike } from '../http.js';
import { PesePayCrypto } from '../pesepay.js';
import { ProviderError, type PaymentAdapter, type PaymentOperation, type ProviderCallback, type ProviderHealth, type ProviderInitiation, type ProviderState, type ProviderStatus } from '../types.js';

const DOCS = 'https://developers.pesepay.com/getting-started/overview/';
const PRODUCTION = 'https://api.pesepay.com/api/payments-engine/v1/payments';
const SANDBOX = 'https://api.test.sandbox.pesepay.com/payments-engine/v1/payments';

function mapStatus(value: unknown): ProviderState {
  switch (String(value ?? '').toUpperCase()) {
    case 'SUCCESS': case 'PAID': return 'paid';
    case 'FAILED': return 'failed';
    case 'CANCELLED': case 'CANCELED': return 'cancelled';
    case 'REVERSED': case 'REFUNDED': return 'reversed';
    case 'PENDING': case 'PROCESSING': case 'PARTIALLY_PAID': return 'pending';
    default: return 'unknown';
  }
}

interface PesePayResult {
  referenceNumber?: string;
  redirectUrl?: string;
  pollUrl?: string;
  transactionStatus?: string;
  transactionStatusCode?: number;
  amountDetails?: { amount?: number | string; currencyCode?: string };
  [key: string]: unknown;
}

export class PesePayAdapter implements PaymentAdapter {
  readonly id = 'pesepay' as const;
  readonly name = 'PesePay';
  readonly docsUrl = DOCS;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  private get configured(): boolean {
    const c = env.providers.pesepay;
    return c.enabled && !!c.integrationKey && !!c.encryptionKey && c.encryptionKey.length === 32;
  }

  private get base(): string {
    return env.providers.pesepay.baseUrl || (env.providers.pesepay.sandbox ? SANDBOX : PRODUCTION);
  }

  private crypto(): PesePayCrypto {
    if (!this.configured) throw new ProviderError('PesePay is not available: enabled flag, integration key or a 32-byte encryption key is missing', 'provider_not_configured', 503);
    return new PesePayCrypto(env.providers.pesepay.encryptionKey);
  }

  health(): ProviderHealth {
    const c = env.providers.pesepay;
    let reason = 'Configured';
    if (!c.enabled) reason = 'PESEPAY_ENABLED=false; enable only after merchant approval';
    else if (!c.integrationKey || !c.encryptionKey) reason = 'PESEPAY_INTEGRATION_KEY and PESEPAY_ENCRYPTION_KEY are missing';
    else if (c.encryptionKey.length !== 32) reason = 'PESEPAY_ENCRYPTION_KEY must be exactly 32 characters';
    else if (c.sandbox) reason = 'Sandbox: PesePay test environment, no real money moves';
    return {
      id: this.id, name: this.name, configured: this.configured, sandbox: c.sandbox,
      enabledForRealMoney: this.configured && c.merchantApproved && !c.sandbox, reason,
      capabilities: ['deposit-redirect', 'encrypted-payload', 'server-status-lookup', 'result-callback'],
    };
  }

  async initiateDeposit(input: PaymentOperation): Promise<ProviderInitiation> {
    const codec = this.crypto();
    const c = env.providers.pesepay;
    const resultUrl = input.resultUrl ?? `${env.publicOrigin}/api/payments/webhook/pesepay`;
    const returnUrl = input.returnUrl ?? `${env.publicOrigin}/wallet?payment=return`;
    const body = {
      amountDetails: { amount: Number(centsToDecimal(input.amountCents)), currencyCode: 'USD' },
      reasonForPayment: 'Rookstone Arena wallet deposit',
      resultUrl, returnUrl,
      merchantReference: input.reference,
    };
    const response = await requestJson<{ payload?: string }>(this.fetchFn, `${this.base}/initiate`, {
      method: 'POST',
      headers: { authorization: c.integrationKey, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: codec.encrypt(body) }),
    });
    if (!response.payload) throw new ProviderError('PesePay initiate response did not contain an encrypted payload');
    const result = codec.decrypt<PesePayResult>(response.payload);
    if (!result.referenceNumber || !result.redirectUrl) throw new ProviderError('PesePay initiate response is missing referenceNumber or redirectUrl');
    return {
      providerReference: result.referenceNumber,
      redirectUrl: result.redirectUrl,
      instructions: 'Complete payment on the PesePay hosted page. The wallet is credited only after server-side status verification.',
      metadata: { pollUrl: result.pollUrl ?? null, resultUrl, returnUrl },
      sandbox: c.sandbox,
    };
  }

  async initiateWithdrawal(): Promise<ProviderInitiation> {
    throw new ProviderError('PesePay does not publish a merchant payout API for this integration', 'payout_unsupported', 503);
  }

  parseCallback(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderCallback {
    let body: PesePayResult = {};
    try { body = JSON.parse(rawBody) as PesePayResult; } catch { /* invalid JSON is still recorded */ }
    const supplied = firstHeader(headers, 'authorization') ?? '';
    const authenticated = !!env.providers.pesepay.integrationKey && safeEqualText(supplied, env.providers.pesepay.integrationKey);
    const reference = String(body.referenceNumber ?? '');
    return {
      eventId: `pesepay:${reference}:${body.transactionStatus ?? ''}:${body.transactionStatusCode ?? ''}`,
      authenticated,
      references: [reference].filter(Boolean),
      reason: authenticated ? undefined : 'PesePay callback Authorization header does not match the integration key',
      raw: body,
    };
  }

  async checkStatus(input: { reference: string; providerReference?: string | null; metadata?: Record<string, unknown> }): Promise<ProviderStatus> {
    const codec = this.crypto();
    const c = env.providers.pesepay;
    const referenceNumber = String(input.providerReference ?? input.metadata?.providerReference ?? input.reference);
    const url = new URL(`${this.base}/check-payment`);
    url.searchParams.set('referenceNumber', referenceNumber);
    const response = await requestJson<{ payload?: string }>(this.fetchFn, url.toString(), {
      headers: { authorization: c.integrationKey, 'content-type': 'application/json' },
    });
    if (!response.payload) return {
      state: 'unknown', amountCents: null, currency: 'USD', providerReference: referenceNumber,
      raw: response, authoritative: false,
    };
    const result = codec.decrypt<PesePayResult>(response.payload);
    let amountCents: number | null = null;
    try { amountCents = result.amountDetails?.amount !== undefined ? decimalToCents(result.amountDetails.amount) : null; } catch { amountCents = null; }
    return {
      state: mapStatus(result.transactionStatus), amountCents,
      currency: result.amountDetails?.currencyCode ?? 'USD',
      providerReference: result.referenceNumber ?? referenceNumber,
      raw: result, authoritative: true,
    };
  }
}
