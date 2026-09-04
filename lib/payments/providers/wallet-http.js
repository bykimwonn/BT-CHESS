'use strict';

const crypto = require('crypto');

/**
 * Generic mobile-money wallet provider (EcoCash, InnBucks, OneMoney, ...).
 *
 * All three Zimbabwean wallets speak roughly the same language - OAuth2 or an
 * API key, then a C2B (customer pays merchant) and a B2C (merchant pays
 * customer) endpoint - but the exact paths and field names differ per merchant
 * agreement. Everything is therefore env-driven:
 *
 *   <PREFIX>_BASE_URL, <PREFIX>_MERCHANT_CODE, <PREFIX>_API_KEY,
 *   <PREFIX>_CLIENT_ID, <PREFIX>_CLIENT_SECRET, <PREFIX>_AUTH_MODE,
 *   <PREFIX>_TOKEN_PATH, <PREFIX>_C2B_PATH, <PREFIX>_B2C_PATH,
 *   <PREFIX>_STATUS_PATH, <PREFIX>_WEBHOOK_SECRET, <PREFIX>_ENABLED
 *
 * When credentials are missing the provider still exists and still creates
 * real transaction records - it just settles through the mock path, so the app
 * is fully demoable before the merchant account is approved.
 */

const STATUS_MAP = {
  COMPLETED: 'completed',
  SUCCESS: 'completed',
  SUCCESSFUL: 'completed',
  PAID: 'completed',
  CONFIRMED: 'completed',
  PENDING: 'pending',
  INITIATED: 'processing',
  PROCESSING: 'processing',
  FAILED: 'failed',
  REJECTED: 'failed',
  DECLINED: 'failed',
  CANCELLED: 'failed',
  EXPIRED: 'expired',
  TIMEOUT: 'expired',
};

function normalizePhone(phone, defaultCountryCode = '263') {
  if (!phone) return '';
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = defaultCountryCode + p.slice(1);
  return p;
}

class HttpWalletProvider {
  constructor({
    id,
    label,
    kind = 'mobile_money',
    baseUrl,
    merchantCode = '',
    apiKey = '',
    clientId = '',
    clientSecret = '',
    authMode = 'oauth2', // oauth2 | apikey | bearer | none
    apiKeyHeader = 'X-API-KEY',
    tokenPath = '/api/v1/oauth/token',
    c2bPath = '/api/v1/payments/c2b',
    b2cPath = '/api/v1/payments/b2c',
    statusPath = '/api/v1/payments/status',
    webhookSecret = '',
    signatureHeader = 'x-signature',
    currency = 'USD',
    callbackUrl = '',
    timeoutMs = 15000,
    settleDelayMs = 2500,
    minAmount = 0.5,
    maxAmount = 5000,
    enabled = false,
    sandbox = true,
    fetchImpl = globalThis.fetch,
    log = () => {},
  }) {
    Object.assign(this, {
      id, label, kind, baseUrl, merchantCode, apiKey, clientId, clientSecret,
      authMode, apiKeyHeader, tokenPath, c2bPath, b2cPath, statusPath,
      webhookSecret, signatureHeader, currency, callbackUrl, timeoutMs,
      minAmount, maxAmount, enabled, sandbox, fetchImpl, log,
    });
    this.supports = { deposit: true, withdraw: true, status: true, webhook: true };
    this.settleDelayMs = settleDelayMs;
    this._token = null;
    this._tokenExpiry = 0;
  }

  get live() {
    return !!(this.enabled && this.baseUrl && (this.apiKey || (this.clientId && this.clientSecret) || this.authMode === 'none'));
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      minAmount: this.minAmount,
      maxAmount: this.maxAmount,
      supports: this.supports,
      live: this.live,
      sandbox: !this.live,
      fields: [{ name: 'phone', label: `${this.label} number`, placeholder: '0771234567', required: true }],
    };
  }

  async _request(path, { method = 'POST', body, auth = true, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(auth ? await this._authHeaders() : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = null;
      }
      if (!res.ok) {
        const err = new Error(`${this.id} ${method} ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async _authHeaders() {
    if (this.authMode === 'none') return {};
    if (this.authMode === 'apikey') return { [this.apiKeyHeader]: this.apiKey };
    if (this.authMode === 'bearer') return { Authorization: `Bearer ${this.apiKey}` };
    // oauth2 (default)
    const token = await this._getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async _getToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    if (!this.clientId || !this.clientSecret) return this.apiKey || null;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const data = await this._request(this.tokenPath, {
      method: 'POST',
      auth: false,
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: undefined,
    });
    // Some gateways want form-encoded credentials instead of a JSON body.
    const token = data?.access_token || data?.token || data?.accessToken;
    if (token) {
      this._token = token;
      this._tokenExpiry = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
    }
    return this._token;
  }

  _payload({ reference, amount, phone, account, type, description }) {
    const msisdn = normalizePhone(phone || account);
    return {
      merchantCode: this.merchantCode,
      customerMsisdn: msisdn,
      phoneNumber: msisdn,
      amount: Number(amount).toFixed(2),
      currency: this.currency,
      reference,
      transactionReference: reference,
      description: description || `BetChess ZW ${type} ${reference}`,
      callbackUrl: this.callbackUrl || undefined,
    };
  }

  async initiateDeposit({ reference, amount, phone, account, userId }) {
    const description = `BetChess ZW deposit ${reference}`;
    if (!this.live) {
      return {
        status: 'pending',
        providerRef: null,
        instructions: `${this.label} sandbox: a $${amount} prompt would be sent to ${phone || account}.`,
        schedule: { settleInMs: this.settleDelayMs, fail: false },
        raw: { sandbox: true, userId },
      };
    }
    const data = await this._request(this.c2bPath, {
      body: this._payload({ reference, amount, phone, account, type: 'deposit', description }),
    });
    return {
      status: STATUS_MAP[String(data?.status || 'PENDING').toUpperCase()] || 'pending',
      providerRef: data?.transactionReference || data?.transactionId || data?.reference || null,
      instructions: data?.message || `Approve the ${this.label} prompt on ${phone}.`,
      raw: data,
    };
  }

  async initiateWithdraw({ reference, amount, phone, account, userId }) {
    const description = `BetChess ZW payout ${reference}`;
    if (!this.live) {
      return {
        status: 'processing',
        providerRef: null,
        instructions: `${this.label} sandbox: $${amount} payout to ${phone || account} queued for approval.`,
        schedule: { settleInMs: this.settleDelayMs, fail: false },
        raw: { sandbox: true, userId },
      };
    }
    const data = await this._request(this.b2cPath, {
      body: this._payload({ reference, amount, phone, account, type: 'withdraw', description }),
    });
    return {
      status: STATUS_MAP[String(data?.status || 'PENDING').toUpperCase()] || 'processing',
      providerRef: data?.transactionReference || data?.transactionId || data?.reference || null,
      instructions: data?.message || `Payout to ${phone} submitted.`,
      raw: data,
    };
  }

  async queryStatus({ reference, providerRef }) {
    if (!this.live) return { status: 'pending', providerRef, raw: { sandbox: true } };
    const data = await this._request(this.statusPath, {
      body: { reference, transactionReference: providerRef, merchantCode: this.merchantCode },
    });
    return {
      status: STATUS_MAP[String(data?.status || 'PENDING').toUpperCase()] || 'pending',
      providerRef: data?.transactionReference || providerRef || null,
      raw: data,
    };
  }

  /** HMAC-SHA256 over the raw body. Fails closed when no secret is configured. */
  verifyWebhook({ headers, rawBody }) {
    if (!this.webhookSecret) return false;
    const supplied =
      headers?.[this.signatureHeader] ||
      headers?.[this.signatureHeader.toLowerCase()] ||
      headers?.['x-ecocash-signature'] ||
      '';
    if (!supplied) return false;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody || '').digest('hex');
    const a = Buffer.from(String(supplied).replace(/^sha256=/, ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhook({ body }) {
    const status = STATUS_MAP[String(body?.status || body?.transactionStatus || '').toUpperCase()] || null;
    return {
      reference: body?.reference || body?.transactionReference || body?.merchantReference || null,
      status,
      providerRef: body?.transactionId || body?.transactionReference || null,
      amount: body?.amount,
      phone: body?.customerMsisdn || body?.phoneNumber || body?.msisdn || null,
    };
  }
}

module.exports = { HttpWalletProvider, normalizePhone, STATUS_MAP };
