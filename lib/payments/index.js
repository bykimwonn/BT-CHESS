'use strict';

const { TransactionStore } = require('./store');
const { MockProvider } = require('./providers/mock');
const { HttpWalletProvider } = require('./providers/wallet-http');
const { BankProvider, AgentProvider } = require('./providers/manual');

/**
 * Payment service.
 *
 * One wallet, several ways in and out (EcoCash primarily, plus InnBucks,
 * OneMoney, bank and cash agents). Every provider is env-driven and runs in
 * sandbox mode until its merchant credentials are set, so the app is
 * demoable end-to-end today and goes live by flipping PAYMENT_MODE=live.
 *
 * The service never touches balances directly - it calls the hooks the server
 * gives it (credit/debit/emit) so all money movement stays in one place.
 */

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

function envNum(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function walletFromEnv(id, label, prefix, defaults = {}) {
  return new HttpWalletProvider({
    id,
    label,
    kind: 'mobile_money',
    baseUrl: process.env[`${prefix}_BASE_URL`] || defaults.baseUrl || '',
    merchantCode: process.env[`${prefix}_MERCHANT_CODE`] || process.env.ECOCASH_MERCHANT_CODE || '',
    apiKey: process.env[`${prefix}_API_KEY`] || '',
    clientId: process.env[`${prefix}_CLIENT_ID`] || '',
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || '',
    authMode: process.env[`${prefix}_AUTH_MODE`] || defaults.authMode || 'oauth2',
    apiKeyHeader: process.env[`${prefix}_API_KEY_HEADER`] || 'X-API-KEY',
    tokenPath: process.env[`${prefix}_TOKEN_PATH`] || defaults.tokenPath || '/api/v1/oauth/token',
    c2bPath: process.env[`${prefix}_C2B_PATH`] || defaults.c2bPath || '/api/v1/payments/c2b',
    b2cPath: process.env[`${prefix}_B2C_PATH`] || defaults.b2cPath || '/api/v1/payments/b2c',
    statusPath: process.env[`${prefix}_STATUS_PATH`] || defaults.statusPath || '/api/v1/payments/status',
    webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] || '',
    signatureHeader: process.env[`${prefix}_SIGNATURE_HEADER`] || 'x-signature',
    callbackUrl: process.env[`${prefix}_CALLBACK_URL`] || `${process.env.BASE_URL || ''}/api/payments/webhook/${id}`,
    currency: process.env[`${prefix}_CURRENCY`] || 'USD',
    timeoutMs: envNum(`${prefix}_TIMEOUT_MS`, 15000),
    settleDelayMs: envNum('MOCK_SETTLEMENT_DELAY_MS', 2500),
    minAmount: envNum(`${prefix}_MIN_AMOUNT`, 0.5),
    maxAmount: envNum(`${prefix}_MAX_AMOUNT`, 2000),
    enabled: envBool(`${prefix}_ENABLED`, id === 'ecocash'),
    sandbox: process.env.PAYMENT_MODE !== 'live',
    log: defaults.log,
  });
}

class PaymentService {
  constructor({ hooks = {}, store, log } = {}) {
    this.hooks = hooks;
    this.store = store || new TransactionStore();
    this.log = log || (() => {});
    this.mode = process.env.PAYMENT_MODE === 'live' ? 'live' : 'mock';

    this.providers = new Map();
    const mock = new MockProvider();
    this.providers.set('mock', mock);

    this.providers.set(
      'ecocash',
      walletFromEnv('ecocash', 'EcoCash', 'ECOCASH', {
        baseUrl: 'https://developers.ecocash.co.zw',
        log: this.log,
      })
    );
    this.providers.set(
      'innbucks',
      walletFromEnv('innbucks', 'InnBucks', 'INNBUCKS', {
        baseUrl: 'https://api.innbucks.co.zw/v1',
        log: this.log,
      })
    );
    this.providers.set(
      'onemoney',
      walletFromEnv('onemoney', 'OneMoney', 'ONEMONEY', {
        baseUrl: 'https://api.onemoney.net.zw/v1',
        log: this.log,
      })
    );
    this.providers.set('bank', new BankProvider());
    this.providers.set('agent', new AgentProvider());

    this.stats = { deposits: 0, depositVolume: 0, withdrawals: 0, withdrawVolume: 0, failed: 0 };
    this._pollTimer = null;
  }

  getProvider(id) {
    return this.providers.get(id) || this.providers.get('mock');
  }

  listProviders() {
    return [...this.providers.entries()]
      .filter(([id]) => id !== 'mock' || this.mode === 'mock')
      .map(([, p]) => p.describe());
  }

  _emit(userId, event, payload) {
    try {
      this.hooks.emit && this.hooks.emit(userId, event, payload);
    } catch (e) {
      this.log(`[payments] emit failed: ${e.message}`);
    }
  }

  _pushTx(userId, tx) {
    this._emit(userId, 'paymentUpdate', tx);
    try {
      this.hooks.onTransaction && this.hooks.onTransaction(tx);
    } catch (e) {
      /* ignore */
    }
  }

  /** Start background status polling for live providers (webhook safety net). */
  startPolling(intervalMs = parseInt(process.env.PAYMENT_POLL_INTERVAL_MS || '30000', 10)) {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollPending().catch((e) => this.log(`[payments] poll error: ${e.message}`)), intervalMs);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  async pollPending() {
    for (const tx of this.store.pending()) {
      const provider = this.getProvider(tx.provider);
      if (!provider || !provider.supports.status || !provider.live) continue;
      if (!tx.providerRef) continue;
      try {
        const res = await provider.queryStatus(tx);
        if (res && (res.status === 'completed' || res.status === 'failed' || res.status === 'expired')) {
          this.store.update(tx.reference, { providerStatus: res.providerStatus || res.status });
          await this.settle(tx.reference, res.status, { source: 'poll', raw: res.raw });
        } else if (res && res.status === 'processing') {
          this.store.update(tx.reference, { status: 'processing' });
        }
      } catch (e) {
        this.log(`[payments] status query failed for ${tx.reference}: ${e.message}`);
      }
    }
  }

  async requestDeposit({ userId, providerId = 'ecocash', amount, phone, account }) {
    const provider = this.getProvider(providerId);
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < provider.minAmount) {
      throw new Error(`Minimum deposit for ${provider.label} is $${provider.minAmount.toFixed(2)}`);
    }
    if (amount > provider.maxAmount) throw new Error(`Maximum deposit is $${provider.maxAmount.toFixed(2)}`);

    const user = this.hooks.getUser ? this.hooks.getUser(userId) : null;
    const tx = this.store.create({
      type: 'deposit',
      userId,
      username: user?.username || '',
      provider: provider.id,
      amount,
      phone: phone || '',
      account: account || '',
    });
    this._pushTx(userId, tx);

    try {
      const res = await provider.initiateDeposit({
        reference: tx.reference,
        amount,
        phone: phone || user?.phone || '',
        account,
        userId,
      });
      this.store.update(tx.reference, {
        status: res.status || 'pending',
        providerRef: res.providerRef || null,
        providerStatus: res.status || 'pending',
        instructions: res.instructions || '',
        requiresApproval: !!res.requiresApproval,
        raw: res.raw || null,
      });

      // Sandbox providers settle themselves after a short delay; live ones wait
      // for the callback (with polling as a safety net).
      if (res.schedule) this._scheduleSettlement(tx.reference, res.schedule);
      else if (res.status === 'completed') await this.settle(tx.reference, 'completed', { source: 'provider' });
      else if (res.status === 'failed') await this.settle(tx.reference, 'failed', { source: 'provider' });
    } catch (err) {
      this.store.update(tx.reference, { status: 'failed', failureReason: err.message });
      this._pushTx(userId, this.store.get(tx.reference));
      throw err;
    }

    const updated = this.store.get(tx.reference);
    this._pushTx(userId, updated);
    return updated;
  }

  async requestWithdraw({ userId, providerId = 'ecocash', amount, phone, account }) {
    const provider = this.getProvider(providerId);
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < provider.minAmount) {
      throw new Error(`Minimum withdrawal is $${provider.minAmount.toFixed(2)}`);
    }
    if (amount > provider.maxAmount) throw new Error(`Maximum withdrawal is $${provider.maxAmount.toFixed(2)}`);

    const user = this.hooks.getUser ? this.hooks.getUser(userId) : null;
    if (!user) throw new Error('Unknown user');
    if (Number(user.balance) < amount) throw new Error('Insufficient balance');

    // Hold the funds straight away so they cannot be played away while pending.
    if (this.hooks.debit) this.hooks.debit(userId, amount, { type: 'withdraw', provider: provider.id });

    const tx = this.store.create({
      type: 'withdraw',
      userId,
      username: user.username || '',
      provider: provider.id,
      amount,
      phone: phone || user.phone || '',
      account: account || '',
    });
    this._pushTx(userId, tx);

    try {
      const res = await provider.initiateWithdraw({
        reference: tx.reference,
        amount,
        phone: phone || user.phone || '',
        account,
        userId,
      });
      this.store.update(tx.reference, {
        status: res.status || 'pending',
        providerRef: res.providerRef || null,
        providerStatus: res.status || 'pending',
        instructions: res.instructions || '',
        requiresApproval: !!res.requiresApproval || !provider.live,
        raw: res.raw || null,
      });

      if (res.schedule && !res.requiresApproval) this._scheduleSettlement(tx.reference, res.schedule);
      else if (res.status === 'completed') await this.settle(tx.reference, 'completed', { source: 'provider' });
      else if (res.status === 'failed') await this.settle(tx.reference, 'failed', { source: 'provider' });
    } catch (err) {
      this.store.update(tx.reference, { status: 'failed', failureReason: err.message });
      await this.settle(tx.reference, 'failed', { source: 'error', reason: err.message });
      throw err;
    }

    const updated = this.store.get(tx.reference);
    this._pushTx(userId, updated);
    return updated;
  }

  _scheduleSettlement(reference, schedule) {
    const timer = setTimeout(async () => {
      try {
        await this.settle(reference, schedule.fail ? 'failed' : 'completed', {
          source: 'sandbox',
          reason: schedule.fail ? 'Simulated failure' : null,
        });
      } catch (e) {
        this.log(`[payments] settlement failed: ${e.message}`);
      }
    }, schedule.settleInMs || 2000);
    if (timer.unref) timer.unref();
  }

  /** Admin approval for bank / agent / manual payouts. */
  async approve(reference, { by = 'admin', reject = false } = {}) {
    const tx = this.store.get(reference);
    if (!tx) throw new Error('Transaction not found');
    if (this.store.isTerminal(reference)) throw new Error(`Transaction already ${tx.status}`);

    if (reject) {
      return this.settle(reference, 'rejected', { by, source: 'admin' });
    }

    const provider = this.getProvider(tx.provider);
    this.store.update(reference, { approvedBy: by, status: 'processing' });
    this._pushTx(tx.userId, this.store.get(reference));

    if (provider.live && tx.type === 'withdraw') {
      const res = await provider.initiateWithdraw({
        reference,
        amount: tx.amount,
        phone: tx.phone,
        account: tx.account,
        userId: tx.userId,
      });
      this.store.update(reference, { providerRef: res.providerRef || null, raw: res.raw || null });
      if (res.status === 'completed') return this.settle(reference, 'completed', { by, source: 'admin' });
      return this.store.get(reference);
    }

    return this.settle(reference, 'completed', { by, source: 'admin' });
  }

  /** Idempotent settlement - the only place balances move. */
  async settle(reference, status, meta = {}) {
    const tx = this.store.get(reference);
    if (!tx) return null;
    const before = tx.status;
    const ok = this.store.markSettled(reference, status, {
      failureReason: status === 'completed' ? null : meta.reason || tx.failureReason,
      raw: meta.raw || tx.raw,
    });
    if (!ok) return this.store.get(reference);

    const settled = this.store.get(reference);

    if (status === 'completed') {
      if (tx.type === 'deposit') {
        if (this.hooks.credit) this.hooks.credit(tx.userId, tx.amount, { type: 'deposit', provider: tx.provider, reference });
        this.stats.deposits++;
        this.stats.depositVolume += tx.amount;
      } else {
        this.stats.withdrawals++;
        this.stats.withdrawVolume += tx.amount;
      }
    } else {
      this.stats.failed++;
      // Refund a failed/cancelled withdrawal - the funds were held on request.
      if (tx.type === 'withdraw' && before !== 'completed' && this.hooks.credit) {
        this.hooks.credit(tx.userId, tx.amount, {
          type: 'refund',
          provider: tx.provider,
          reference,
          details: `Withdrawal ${status} - refunded`,
        });
      }
    }

    this.log(`[payments] ${tx.type} ${reference} ${before} -> ${status} ($${tx.amount}, ${tx.provider}, ${meta.source || 'system'})`);
    this._pushTx(tx.userId, settled);
    try {
      this.hooks.onSettled && this.hooks.onSettled(settled);
    } catch (e) {
      /* ignore */
    }
    return settled;
  }

  /** Provider callback (EcoCash and friends). */
  async handleWebhook(providerId, { headers = {}, rawBody = '', body = {} }) {
    const provider = this.getProvider(providerId);
    if (!provider) return { ok: false, error: 'unknown provider' };

    if (provider.live && !provider.verifyWebhook({ headers, rawBody })) {
      return { ok: false, error: 'bad signature', status: 401 };
    }

    const parsed = provider.parseWebhook({ body: body || safeParse(rawBody) }) || {};
    const tx = parsed.reference ? this.store.get(parsed.reference) : null;
    if (!tx) return { ok: false, error: 'unknown reference', status: 404 };
    if (this.store.isTerminal(tx.reference)) return { ok: true, ignored: true, status: tx.status };

    if (parsed.providerRef) this.store.update(tx.reference, { providerRef: parsed.providerRef, raw: body });
    if (parsed.status) await this.settle(tx.reference, parsed.status, { source: 'webhook', raw: body });
    return { ok: true, reference: tx.reference, status: tx.status };
  }

  status() {
    return {
      mode: this.mode,
      providers: this.listProviders().map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        live: !!p.live,
        sandbox: !!p.sandbox,
        minAmount: p.minAmount,
        maxAmount: p.maxAmount,
      })),
      stats: this.stats,
      pendingCount: this.store.pending().length,
    };
  }
}

function safeParse(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

module.exports = { PaymentService, TransactionStore, MockProvider, HttpWalletProvider, BankProvider, AgentProvider };
