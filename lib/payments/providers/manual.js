'use strict';

/**
 * Manual settlement providers: bank transfer and cash agents.
 *
 * These never touch an API. They create a pending transaction with a human
 * readable reference; an operator confirms it in /admin (or it auto-settles in
 * mock mode) which is exactly how cash top-ups work on the ground in ZW.
 */

function code(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

class BankProvider {
  constructor({
    id = 'bank',
    label = 'Bank transfer / Zimswitch',
    accountName = process.env.BANK_ACCOUNT_NAME || 'BetChess ZW (Pvt) Ltd',
    bankName = process.env.BANK_NAME || 'CBZ Bank',
    accountNumber = process.env.BANK_ACCOUNT_NUMBER || '0000000000',
    branch = process.env.BANK_BRANCH || 'Harare',
    minAmount = 1,
    maxAmount = 10000,
    settleDelayMs = parseInt(process.env.MOCK_SETTLEMENT_DELAY_MS || '2500', 10),
  } = {}) {
    Object.assign(this, { id, label, accountName, bankName, accountNumber, branch, minAmount, maxAmount, settleDelayMs });
    this.kind = 'bank';
    this.supports = { deposit: true, withdraw: true, status: false, webhook: false };
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
      details: {
        bank: this.bankName,
        accountName: this.accountName,
        accountNumber: this.accountNumber,
        branch: this.branch,
      },
      fields: [
        { name: 'account', label: 'Your bank / account name', placeholder: 'e.g. CBZ - T Moyo', required: true },
      ],
    };
  }

  async initiateDeposit({ reference, amount }) {
    return {
      status: 'pending',
      providerRef: null,
      requiresApproval: true,
      instructions: `Transfer $${amount} to ${this.bankName} · ${this.accountNumber} (${this.accountName}) and quote reference ${reference}.`,
      schedule: { settleInMs: this.settleDelayMs, fail: false },
      raw: { bank: this.bankName, account: this.accountNumber },
    };
  }

  async initiateWithdraw({ reference, amount, account }) {
    return {
      status: 'pending',
      providerRef: null,
      requiresApproval: true,
      instructions: `$${amount} will be transferred to ${account}. Admin approval required.`,
      schedule: { settleInMs: this.settleDelayMs, fail: false },
      raw: { account },
    };
  }

  async queryStatus({ providerRef }) {
    return { status: 'pending', providerRef };
  }

  verifyWebhook() {
    return false;
  }

  parseWebhook() {
    return { reference: null, status: null };
  }
}

class AgentProvider {
  constructor({
    id = 'agent',
    label = 'Cash agent / EcoCash agent',
    minAmount = 1,
    maxAmount = 500,
    settleDelayMs = parseInt(process.env.MOCK_SETTLEMENT_DELAY_MS || '2500', 10),
  } = {}) {
    Object.assign(this, { id, label, minAmount, maxAmount, settleDelayMs });
    this.kind = 'agent';
    this.supports = { deposit: true, withdraw: true, status: false, webhook: false };
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
      fields: [{ name: 'phone', label: 'Your phone number', placeholder: '0771234567', required: true }],
    };
  }

  async initiateDeposit({ reference, amount }) {
    const agentCode = code(6);
    return {
      status: 'pending',
      providerRef: agentCode,
      requiresApproval: true,
      instructions: `Pay $${amount} cash to any BetChess agent and give them code ${agentCode}.`,
      schedule: { settleInMs: this.settleDelayMs, fail: false },
      raw: { agentCode },
    };
  }

  async initiateWithdraw({ amount, phone }) {
    const agentCode = code(6);
    return {
      status: 'pending',
      providerRef: agentCode,
      requiresApproval: true,
      instructions: `Collect $${amount} cash from an agent using code ${agentCode} (${phone}).`,
      schedule: { settleInMs: this.settleDelayMs, fail: false },
      raw: { agentCode, phone },
    };
  }

  async queryStatus({ providerRef }) {
    return { status: 'pending', providerRef };
  }

  verifyWebhook() {
    return false;
  }

  parseWebhook() {
    return { reference: null, status: null };
  }
}

module.exports = { BankProvider, AgentProvider, code };
