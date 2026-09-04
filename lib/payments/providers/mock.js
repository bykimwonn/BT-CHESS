'use strict';

/**
 * Mock provider - the sandbox the app runs in until real merchant credentials
 * are configured.
 *
 * It mimics the real flow (initiate -> customer approves on handset -> callback)
 * including the delay, so the UI, the wallet and the admin approval queue all
 * behave exactly as they will in production.
 */

class MockProvider {
  constructor({
    id = 'mock',
    label = 'Mock Wallet (sandbox)',
    settlementDelayMs = parseInt(process.env.MOCK_SETTLEMENT_DELAY_MS || '2500', 10),
    failureRate = parseFloat(process.env.MOCK_FAILURE_RATE || '0'),
  } = {}) {
    this.id = id;
    this.label = label;
    this.kind = 'mock';
    this.settlementDelayMs = settlementDelayMs;
    this.failureRate = failureRate;
    this.supports = { deposit: true, withdraw: true, status: true, webhook: true };
    this.minAmount = 0.5;
    this.maxAmount = 5000;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      minAmount: this.minAmount,
      maxAmount: this.maxAmount,
      supports: this.supports,
      sandbox: true,
      fields: [{ name: 'phone', label: 'Phone number', placeholder: '0771234567', required: true }],
    };
  }

  async initiate({ reference, amount, phone, type }) {
    const ref = `MOCK-${reference.slice(-8)}`;
    return {
      status: 'pending',
      providerRef: ref,
      instructions:
        type === 'withdraw'
          ? `Mock: $${amount} will be sent to ${phone} after approval.`
          : `Mock: approve the $${amount} prompt on ${phone}.`,
      // The settlement is driven by PaymentService so it also works without HTTP.
      schedule: {
        settleInMs: this.settlementDelayMs,
        fail: Math.random() < this.failureRate,
      },
      raw: { mock: true, phone, amount, type },
    };
  }

  async initiateDeposit(params) {
    return this.initiate({ ...params, type: 'deposit' });
  }

  async initiateWithdraw(params) {
    return this.initiate({ ...params, type: 'withdraw' });
  }

  async queryStatus({ providerRef }) {
    return { status: 'pending', providerRef, raw: { mock: true } };
  }

  verifyWebhook() {
    return true;
  }

  parseWebhook({ body }) {
    return {
      reference: body?.reference || null,
      status: body?.status || null,
      providerRef: body?.transactionId || body?.providerRef || null,
      amount: body?.amount,
    };
  }
}

module.exports = { MockProvider };
