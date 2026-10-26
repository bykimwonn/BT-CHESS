import { decimalToCents, centsToDecimal } from '../../../shared/contracts.js';
import { env } from '../../config/env.js';
import { safeEqualText } from '../../services/ids.js';
import { firstHeader, requestText, type FetchLike } from '../http.js';
import { centsToPaynowAmount, paynowHash, verifyPaynowHash } from '../paynow.js';
import { ProviderError, type PaymentAdapter, type PaymentOperation, type ProviderCallback, type ProviderHealth, type ProviderInitiation, type ProviderState, type ProviderStatus } from '../types.js';

const DOCS = 'https://developers.paynow.co.zw/docs/paynow/initiate_transaction/';

function mapStatus(status: string | undefined): ProviderState {
  switch ((status ?? '').toLowerCase()) {
    case 'paid': case 'awaiting delivery': case 'delivered': return 'paid';
    case 'cancelled': return 'cancelled';
    case 'refunded': return 'reversed';
    case 'disputed': return 'processing';
    case 'created': case 'sent': return 'pending';
    case 'error': case 'failed': return 'failed';
    default: return 'unknown';
  }
}

export class PaynowAdapter implements PaymentAdapter {
  readonly id = 'paynow' as const;
  readonly name = 'Paynow';
  readonly docsUrl = DOCS;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  private get configured(): boolean {
    return env.providers.paynow.enabled && !!env.providers.paynow.id && !!env.providers.paynow.key;
  }

  private reason(): string {
    if (!env.providers.paynow.enabled) return 'PAYNOW_ENABLED=false; enable only after merchant approval';
    if (!env.providers.paynow.id || !env.providers.paynow.key) return 'PAYNOW_INTEGRATION_ID and PAYNOW_INTEGRATION_KEY are missing';
    return env.providers.paynow.sandbox ? 'Sandbox integration credentials; no live funds can be accepted' : 'Configured';
  }

  health(): ProviderHealth {
    return {
      id: this.id, name: this.name, configured: this.configured,
      sandbox: env.providers.paynow.sandbox,
      enabledForRealMoney: this.configured && env.providers.paynow.merchantApproved && !env.providers.paynow.sandbox,
      reason: this.reason(),
      capabilities: ['deposit-redirect', 'signed-status-hash', 'poll-status', 'merchant-trace', 'refund-status'],
    };
  }

  private assertConfigured(): void {
    if (!this.configured) throw new ProviderError(`Paynow is not available: ${this.reason()}`, 'provider_not_configured', 503);
  }

  async initiateDeposit(input: PaymentOperation): Promise<ProviderInitiation> {
    this.assertConfigured();
    const config = env.providers.paynow;
    const resultUrl = input.resultUrl ?? `${env.publicOrigin}/api/payments/webhook/paynow`;
    const returnUrl = input.returnUrl ?? `${env.publicOrigin}/wallet?payment=return`;
    const merchantTrace = input.reference.replace(/-/g, '').slice(0, 32);
    const fields: [string, string][] = [
      ['id', config.id],
      ['reference', input.reference],
      ['amount', centsToPaynowAmount(input.amountCents)],
      ['additionalinfo', 'Rookstone Arena wallet deposit'],
      ['returnurl', returnUrl],
      ['resulturl', resultUrl],
      ['status', 'Message'],
      ['merchanttrace', merchantTrace],
    ];
    if (input.email) fields.splice(5, 0, ['authemail', input.email]);
    const hash = paynowHash(fields, config.key);
    const body = new URLSearchParams([...fields, ['hash', hash]]).toString();
    const raw = await requestText(this.fetchFn, `${config.baseUrl.replace(/\/$/, '')}/interface/initiatetransaction`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    const verified = verifyPaynowHash(raw, config.key);
    if (!verified.valid) throw new ProviderError('Paynow initiate response hash was invalid', 'invalid_provider_hash');
    const status = verified.fields.get('status');
    if (status?.toLowerCase() !== 'ok') {
      throw new ProviderError(`Paynow initiate failed: ${verified.fields.get('error') ?? status ?? 'unknown'}`, 'provider_initiate_failed');
    }
    const pollUrl = verified.fields.get('pollurl');
    const browserUrl = verified.fields.get('browserurl');
    if (!browserUrl || !pollUrl) throw new ProviderError('Paynow initiate response is missing browserurl or pollurl');
    return {
      providerReference: verified.fields.get('paynowreference') ?? input.reference,
      redirectUrl: browserUrl,
      instructions: 'You will be redirected to Paynow. Funds are credited only after server-side status verification.',
      metadata: { pollUrl, merchantTrace, resultUrl, returnUrl, initiationVerified: true },
      sandbox: config.sandbox,
    };
  }

  async initiateWithdrawal(): Promise<ProviderInitiation> {
    throw new ProviderError('Paynow does not publish a merchant payout API for this integration; withdrawals require an approved payout provider', 'payout_unsupported', 503);
  }

  parseCallback(rawBody: string, _headers: Record<string, string | string[] | undefined>): ProviderCallback {
    const config = env.providers.paynow;
    const verified = verifyPaynowHash(rawBody, config.key);
    const fields = verified.fields.lower();
    const reference = fields.reference ?? fields.merchanttrace ?? '';
    const eventId = `paynow:${reference}:${fields.paynowreference ?? ''}:${fields.status ?? ''}:${fields.hash ?? ''}`;
    return {
      eventId, authenticated: verified.valid,
      references: [reference, fields.merchanttrace ?? '', fields.paynowreference ?? ''].filter(Boolean),
      reason: verified.valid ? undefined : 'Paynow SHA-512 status hash did not verify',
      raw: fields,
    };
  }

  async checkStatus(input: { reference: string; providerReference?: string | null; metadata?: Record<string, unknown> }): Promise<ProviderStatus> {
    this.assertConfigured();
    const config = env.providers.paynow;
    const pollUrl = String(input.metadata?.pollUrl ?? '');
    let raw: string;
    if (pollUrl) {
      // Documented empty POST to the pollurl returned at initiation.
      raw = await requestText(this.fetchFn, pollUrl, { method: 'POST' });
    } else {
      // Documented merchant-trace fallback when the pollurl was lost.
      const traceFields: [string, string][] = [
        ['id', config.id], ['merchanttrace', String(input.metadata?.merchantTrace ?? input.reference.replace(/-/g, '').slice(0, 32))],
        ['status', 'Message'],
      ];
      const hash = paynowHash(traceFields, config.key);
      raw = await requestText(this.fetchFn, `${config.baseUrl.replace(/\/$/, '')}/interface/trace`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([...traceFields, ['hash', hash]]).toString(),
      });
    }
    const verified = verifyPaynowHash(raw, config.key);
    const fields = verified.fields.lower();
    if (!verified.valid) {
      return { state: 'unknown', amountCents: null, currency: 'USD', providerReference: fields.paynowreference ?? '', raw: fields, authoritative: false };
    }
    let amountCents: number | null = null;
    try { amountCents = fields.amount ? decimalToCents(fields.amount) : null; } catch { amountCents = null; }
    return {
      state: mapStatus(fields.status), amountCents, currency: 'USD',
      providerReference: fields.paynowreference ?? input.providerReference ?? '',
      raw: fields, authoritative: true,
    };
  }
}
