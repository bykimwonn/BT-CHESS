import crypto from 'node:crypto';
import { centsToDecimal } from '../../../shared/contracts.js';
import { env } from '../../config/env.js';
import { firstHeader, requestJson, type FetchLike } from '../http.js';
import { ProviderError, type PaymentAdapter, type PaymentOperation, type ProviderCallback, type ProviderHealth, type ProviderInitiation, type ProviderState, type ProviderStatus } from '../types.js';

const DOCS = 'https://developers.ecocash.co.zw/docs/online-payments';

function normalizeMsisdn(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('263') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `263${digits.slice(1)}`;
  if (digits.length === 9) return `263${digits}`;
  throw new ProviderError('Use a Zimbabwe mobile number in 263XXXXXXXXX or 07XXXXXXXX format', 'invalid_msisdn', 400);
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function mapEipStatus(body: Record<string, unknown>): ProviderState {
  const status = String(body.status ?? body.transactionStatus ?? body.transactionOperationStatus ?? '').toUpperCase();
  if (['SUCCESS', 'CHARGED', 'COMPLETED'].includes(status)) return 'paid';
  if (['FAILED', 'DECLINED', 'REJECTED'].includes(status)) return 'failed';
  if (['REFUNDED', 'REVERSED'].includes(status)) return 'reversed';
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'cancelled';
  if (['PENDING', 'PROCESSING'].includes(status)) return 'pending';
  return 'unknown';
}

export class EcoCashAdapter implements PaymentAdapter {
  readonly id = 'ecocash' as const;
  readonly name = 'EcoCash';
  readonly docsUrl = DOCS;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  private get eipConfigured(): boolean {
    const c = env.providers.ecocash;
    return !!(c.eipUsername && c.eipPassword && c.merchantCode && c.merchantApiPin
      && c.merchantNumber && c.terminalId && c.merchantName && c.superMerchantName);
  }

  private get epgConfigured(): boolean {
    const c = env.providers.ecocash;
    return !!(c.clientId && c.clientSecret && c.username && c.encryptedPassword);
  }

  private get configured(): boolean { return env.providers.ecocash.enabled && this.eipConfigured; }

  health(): ProviderHealth {
    const c = env.providers.ecocash;
    const missing: string[] = [];
    if (!c.enabled) missing.push('ECOCASH_ENABLED=false');
    if (!this.eipConfigured) missing.push('Instant Payments merchant/API credentials are incomplete');
    if (!this.epgConfigured) missing.push('EPG payout credentials are incomplete (withdrawals unavailable)');
    return {
      id: this.id, name: this.name, configured: this.configured, sandbox: c.sandbox,
      enabledForRealMoney: this.configured && this.epgConfigured && c.merchantApproved && !c.sandbox,
      reason: missing.length ? missing.join('; ') : c.sandbox
        ? 'Sandbox: EcoCash simulates transactions and no real money moves'
        : 'Configured; production endpoints must be issued by EcoCash on go-live',
      capabilities: this.eipConfigured
        ? ['deposit-charge', 'server-status-lookup', 'refund', ...(this.epgConfigured ? ['merchant-payout'] : [])]
        : [],
    };
  }

  private assertEip(): void {
    if (!this.configured) throw new ProviderError(`EcoCash deposits unavailable: ${this.health().reason}`, 'provider_not_configured', 503);
  }

  private assertEpg(): void {
    if (!this.epgConfigured) throw new ProviderError('EcoCash EPG payouts unavailable: encrypted channel password and client credentials are missing', 'provider_not_configured', 503);
  }

  async initiateDeposit(input: PaymentOperation): Promise<ProviderInitiation> {
    this.assertEip();
    if (!input.phone) throw new ProviderError('An EcoCash mobile number is required to trigger the PIN prompt', 'phone_required', 400);
    const c = env.providers.ecocash;
    const msisdn = normalizeMsisdn(input.phone);
    const clientCorrelator = input.reference;
    const body = {
      clientCorrelator,
      notifyUrl: `${env.publicOrigin}/api/payments/webhook/ecocash`,
      referenceCode: `RS-${clientCorrelator.slice(0, 18)}`,
      tranType: 'MER',
      endUserId: msisdn,
      remarks: 'Rookstone Arena wallet deposit',
      transactionOperationStatus: 'Charged',
      paymentAmount: {
        charginginformation: {
          amount: centsToDecimal(input.amountCents), currency: 'USD',
          description: 'Rookstone Arena wallet deposit',
        },
        chargeMetaData: { channel: 'WEB' },
      },
      merchantCode: c.merchantCode,
      merchantPin: c.merchantApiPin,
      merchantNumber: c.merchantNumber,
      countryCode: 'ZW',
      terminalID: c.terminalId,
      location: 'Harare',
      superMerchantName: c.superMerchantName,
      merchantName: c.merchantName,
    };
    const response = await requestJson<Record<string, unknown>>(this.fetchFn,
      `${c.eipBaseUrl.replace(/\/$/, '')}/transactions/amount/`, {
        method: 'POST',
        headers: { authorization: basicAuth(c.eipUsername, c.eipPassword), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const providerReference = String(response.ecocashReference ?? response.transactionId ?? clientCorrelator);
    return {
      providerReference,
      redirectUrl: null,
      instructions: 'Approve the EcoCash PIN prompt on your phone. Never share your PIN. The wallet is credited only after EcoCash confirms the charge.',
      metadata: {
        kind: 'deposit', phone: msisdn, clientCorrelator,
        eipResponseStatus: response.transactionOperationStatus ?? response.status ?? null,
      },
      sandbox: c.sandbox,
    };
  }

  async initiateWithdrawal(input: PaymentOperation): Promise<ProviderInitiation> {
    this.assertEpg();
    const c = env.providers.ecocash;
    if (!input.metadata?.phone) throw new ProviderError('A payout mobile number is required', 'phone_required', 400);
    const msisdn = normalizeMsisdn(String(input.metadata.phone));
    // Merchant-to-Subscriber requires a numeric externalReference.
    const externalReference = Number(`${Date.now()}${crypto.randomInt(100, 999)}`);
    const body = {
      serviceType: 'MERCHTOSUBV2',
      externalReference,
      amount: centsToDecimal(input.amountCents),
      currency: 'USD',
      msisdn,
      username: c.username,
      password: c.encryptedPassword,
      channelCode: '800004',
      transferReference: input.reference,
      walletId: '12',
    };
    const response = await requestJson<Record<string, unknown>>(this.fetchFn, c.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Client-Id': c.clientId,
        'X-Client-Secret': c.clientSecret,
      },
      body: JSON.stringify(body),
    });
    if (String(response.responseCode ?? '') !== '00') {
      throw new ProviderError(`EcoCash payout was not accepted: ${response.responseMessage ?? response.statusMessage ?? 'unknown'}`, 'payout_rejected');
    }
    return {
      providerReference: String(response.transactionId ?? externalReference),
      redirectUrl: null,
      instructions: 'Payout submitted to EcoCash. It remains pending until server-side transaction lookup confirms success.',
      metadata: { kind: 'payout', phone: msisdn, externalReference, transferReference: input.reference },
      sandbox: c.sandbox,
    };
  }

  parseCallback(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderCallback {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { body = { raw: rawBody.slice(0, 500) }; }
    const reference = String(body.clientCorrelator ?? body.externalReference ?? body.referenceCode ?? '');
    const providerReference = String(body.ecocashReference ?? body.transactionId ?? '');
    const signature = firstHeader(headers, 'x-signature');
    const secret = env.providers.ecocash.webhookSecret;
    let authenticated = false;
    if (signature && secret) {
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      authenticated = /^[0-9a-f]{64}$/i.test(signature) &&
        crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    }
    return {
      eventId: `ecocash:${reference}:${providerReference}:${String(body.status ?? body.transactionOperationStatus ?? '')}`,
      authenticated,
      references: [reference, providerReference].filter(Boolean),
      reason: authenticated ? undefined : 'EcoCash callbacks are not trusted as proof of payment; server-side lookup is required',
      allowUnauthenticatedLookup: true,
      raw: body,
    };
  }

  async checkStatus(input: { reference: string; providerReference?: string | null; metadata?: Record<string, unknown> }): Promise<ProviderStatus> {
    const c = env.providers.ecocash;
    const kind = String(input.metadata?.kind ?? 'deposit');
    if (kind === 'payout') {
      this.assertEpg();
      const externalTransactionId = String(input.metadata?.externalReference ?? input.providerReference ?? input.reference);
      const lookupReference = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
      const response = await requestJson<Record<string, unknown>>(this.fetchFn, c.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Client-Id': c.clientId,
          'X-Client-Secret': c.clientSecret,
        },
        body: JSON.stringify({
          serviceType: 'EXTERNALTRANSACTIONLOOKUP',
          externalReference: lookupReference,
          externalTransactionId,
          currency: 'USD',
          msisdn: normalizeMsisdn(String(input.metadata?.phone ?? '263770000000')),
        }),
      });
      const code = String(response.responseCode ?? '');
      const state: ProviderState = code === '00' && String(response.statusCode ?? '') === 'TS' ? 'completed'
        : code === '888803' ? 'pending' : 'unknown';
      return {
        state, amountCents: null, currency: 'USD',
        providerReference: String(response.transactionId ?? input.providerReference ?? ''),
        raw: response, authoritative: true,
      };
    }
    this.assertEip();
    const phone = normalizeMsisdn(String(input.metadata?.phone ?? '263770000000'));
    const correlator = String(input.metadata?.clientCorrelator ?? input.reference);
    const response = await requestJson<Record<string, unknown>>(this.fetchFn,
      `${c.eipBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(phone)}/transactions/amount/${encodeURIComponent(correlator)}`, {
        headers: { authorization: basicAuth(c.eipUsername, c.eipPassword) },
      });
    return {
      state: mapEipStatus(response), amountCents: null, currency: 'USD',
      providerReference: String(response.ecocashReference ?? input.providerReference ?? ''),
      raw: response, authoritative: true,
    };
  }

  async refund(input: { reference: string; providerReference: string; amountCents: number; reason: string; phone?: string }): Promise<ProviderStatus> {
    this.assertEip();
    const c = env.providers.ecocash;
    const response = await requestJson<Record<string, unknown>>(this.fetchFn,
      `${c.eipBaseUrl.replace(/\/$/, '')}/transactions/refund/`, {
        method: 'POST',
        headers: { authorization: basicAuth(c.eipUsername, c.eipPassword), 'content-type': 'application/json' },
        body: JSON.stringify({
          clientCorrelator: crypto.randomUUID(),
          referenceCode: `REFUND-${input.reference}`,
          tranType: 'REF',
          endUserId: input.phone ? normalizeMsisdn(input.phone) : '',
          originalEcocashReference: input.providerReference,
          paymentAmount: {
            charginginformation: { amount: centsToDecimal(input.amountCents), currency: 'USD', description: 'Rookstone refund' },
            chargeMetaData: { channel: 'WEB' },
          },
          merchantCode: c.merchantCode,
          merchantPin: c.merchantApiPin,
          merchantNumber: c.merchantNumber,
          countryCode: 'ZW', terminalID: c.terminalId, location: 'Harare',
          superMerchantName: c.superMerchantName, merchantName: c.merchantName,
        }),
      });
    return {
      state: mapEipStatus(response), amountCents: null, currency: 'USD',
      providerReference: String(response.ecocashReference ?? input.providerReference),
      raw: response, authoritative: true,
    };
  }
}
