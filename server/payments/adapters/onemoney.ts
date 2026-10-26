import { ProviderError, type PaymentAdapter, type ProviderHealth } from '../types.js';

const DOCS = 'https://paynow.co.zw/blog/onemoney-is-back-on-paynow-now-supporting-both-usd-and-zig-payments/';

/**
 * OneMoney currently has no verified, generally available public direct payment
 * API specification for this integration. It is available as a payment method
 * through approved aggregators such as Paynow. We deliberately do not invent a
 * OneMoney endpoint: this adapter is disabled until an official merchant API
 * contract is supplied and approved.
 */
export class OneMoneyAdapter implements PaymentAdapter {
  readonly id = 'onemoney' as const;
  readonly name = 'OneMoney';
  readonly docsUrl = DOCS;

  health(): ProviderHealth {
    return {
      id: this.id, name: this.name, configured: false, sandbox: true,
      enabledForRealMoney: false,
      reason: 'No verified public direct merchant API contract exists in the reviewed documentation; use an approved aggregator (for example Paynow) after merchant approval.',
      capabilities: [],
    };
  }

  private unsupported(): never {
    throw new ProviderError('Direct OneMoney API integration is not enabled: no verified public API contract or merchant approval is available', 'provider_unavailable', 503);
  }

  async initiateDeposit() { return this.unsupported(); }
  async initiateWithdrawal() { return this.unsupported(); }
  parseCallback() { return this.unsupported(); }
  async checkStatus() { return this.unsupported(); }
}
