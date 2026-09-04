'use strict';

const { randomUUID } = require('crypto');

/**
 * Transaction store.
 *
 * Every deposit / withdrawal / bet settlement lives here with a real lifecycle
 * (pending -> processing -> completed | failed | expired) so the wallet can
 * never double-credit: settling is idempotent on `reference`.
 */

const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled', 'rejected']);

class TransactionStore {
  constructor() {
    this.byReference = new Map();
    this.order = [];
  }

  create({ type, userId, username, provider, amount, phone, account, method, meta }) {
    const reference = `${type === 'withdraw' ? 'WD' : 'DEP'}-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const tx = {
      id: randomUUID(),
      reference,
      type, // 'deposit' | 'withdraw'
      userId,
      username: username || '',
      provider, // 'ecocash' | 'innbucks' | 'onemoney' | 'bank' | 'agent' | 'mock'
      method: method || provider,
      amount: Number(amount) || 0,
      currency: 'USD',
      phone: phone || '',
      account: account || '',
      status: 'pending', // pending|processing|completed|failed|expired|cancelled|rejected
      providerRef: null,
      providerStatus: null,
      instructions: '',
      failureReason: null,
      requiresApproval: false,
      approvedBy: null,
      raw: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settledAt: null,
      meta: meta || {},
    };
    this.byReference.set(reference, tx);
    this.order.push(reference);
    if (this.order.length > 5000) {
      const dropped = this.order.splice(0, this.order.length - 5000);
      for (const ref of dropped) this.byReference.delete(ref);
    }
    return tx;
  }

  get(reference) {
    return this.byReference.get(reference) || null;
  }

  update(reference, patch) {
    const tx = this.get(reference);
    if (!tx) return null;
    Object.assign(tx, patch, { updatedAt: new Date().toISOString() });
    return tx;
  }

  /**
   * Returns false when the transaction was already settled - this is the
   * idempotency guard that stops a replayed webhook or a double click from
   * crediting the same deposit twice.
   */
  markSettled(reference, status, patch = {}) {
    const tx = this.get(reference);
    if (!tx) return false;
    if (TERMINAL.has(tx.status)) return false;
    Object.assign(tx, patch, {
      status,
      updatedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    });
    return true;
  }

  isTerminal(reference) {
    const tx = this.get(reference);
    return !tx || TERMINAL.has(tx.status);
  }

  byUser(userId, limit = 50) {
    return this.order
      .map((ref) => this.byReference.get(ref))
      .filter((tx) => tx && tx.userId === userId)
      .slice(-limit)
      .reverse();
  }

  pending() {
    return this.order
      .map((ref) => this.byReference.get(ref))
      .filter((tx) => tx && (tx.status === 'pending' || tx.status === 'processing'));
  }

  recent(limit = 200) {
    return this.order.slice(-limit).map((ref) => this.byReference.get(ref)).filter(Boolean).reverse();
  }

  toJSON() {
    return this.order.map((ref) => this.byReference.get(ref)).filter(Boolean);
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || !row.reference || this.byReference.has(row.reference)) continue;
      this.byReference.set(row.reference, row);
      this.order.push(row.reference);
    }
  }
}

module.exports = { TransactionStore, TERMINAL };
