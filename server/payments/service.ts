import { env } from '../config/env.js';
import type { ComplianceState } from '../config/compliance.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { formatMoney, LEDGER_BASE_CURRENCY, type ProviderHealth } from '../../shared/contracts.js';
import { depositSchema, withdrawalSchema } from '../../shared/validation.js';
import type { AuthService } from '../auth/service.js';
import { audit, notify } from '../services/audit.js';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../services/errors.js';
import { uuid, sha256 } from '../services/ids.js';
import type { AppLogger } from '../services/logger.js';
import { LedgerService } from '../finance/ledger.js';
import type { EligibilityService } from '../eligibility/service.js';
import { ProviderError, type PaymentAdapter, type ProviderId, type ProviderStatus } from './types.js';

export interface PaymentSummary {
  id: string;
  provider: string;
  providerReference: string | null;
  amountCents: number;
  currency: string;
  status: string;
  sandbox: boolean;
  redirectUrl: string | null;
  instructions: string;
  createdAt: string;
  confirmedAt: string | null;
}

export class PaymentService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly auth: AuthService,
    private readonly eligibility: EligibilityService,
    private readonly compliance: ComplianceState,
    private readonly adapters: Record<ProviderId, PaymentAdapter>,
    private readonly log: AppLogger,
  ) {}

  health(): ProviderHealth[] {
    return Object.values(this.adapters).map((adapter) => {
      const base = adapter.health();
      const legalBlocked = !this.compliance.realMoneyEnabled;
      return {
        ...base,
        enabledForRealMoney: base.enabledForRealMoney && this.compliance.realMoneyEnabled,
        reason: legalBlocked && base.enabledForRealMoney
          ? `${base.reason}. Real-money mode is disabled: ${this.compliance.blockers.join('; ')}`
          : base.reason,
      };
    });
  }

  docs(): Array<{ id: ProviderId; name: string; docsUrl: string }> {
    return Object.values(this.adapters).map((a) => ({ id: a.id, name: a.name, docsUrl: a.docsUrl }));
  }

  private adapter(id: ProviderId): PaymentAdapter {
    const adapter = this.adapters[id];
    if (!adapter) throw badRequest('Unknown payment provider');
    return adapter;
  }

  private async assertProviderAllowed(userId: string, adapter: PaymentAdapter, action: 'deposit' | 'withdrawal'): Promise<void> {
    const health = adapter.health();
    if (!health.configured) throw unavailable(`${health.name} is not available: ${health.reason}`);
    await this.eligibility.assertPaymentProviderAllowed(userId, adapter.id);
    if (action === 'withdrawal') {
      if (!this.compliance.realMoneyEnabled) {
        throw forbidden(`Withdrawals are disabled: ${this.compliance.blockers.join('; ')}. Test credits have no cash value.`);
      }
      if (health.sandbox) throw forbidden('Sandbox provider credentials cannot be used for real-money withdrawals');
      if (!health.enabledForRealMoney) throw forbidden('This provider is not approved for real-money withdrawals');
      if (!health.capabilities.includes('merchant-payout')) {
        throw unavailable(`${health.name} does not publish a supported payout workflow for this integration`);
      }
      return;
    }
    if (this.compliance.realMoneyEnabled) {
      if (health.sandbox) throw forbidden('Sandbox provider credentials cannot be used in authorised real-money mode');
      if (!health.enabledForRealMoney) throw forbidden('This provider has no verified merchant approval for real-money deposits');
    } else if (this.compliance.testMode) {
      if (!health.sandbox) throw forbidden('Production provider credentials cannot be used in internal test mode');
    } else {
      throw unavailable(`Deposits are disabled: ${this.compliance.blockers.join('; ')}`);
    }
  }

  private async assertDepositLimits(userId: string, amountCents: number): Promise<void> {
    await this.auth.assertNotRestricted(userId, 0);
    await this.eligibility.assertAmountWithinPolicy(userId, amountCents, 'deposit');
    const restrictions = await this.db.query<Row>(`
      SELECT type, value_cents FROM responsible_play_restrictions
      WHERE user_id = $1 AND active = TRUE AND (expires_at IS NULL OR expires_at > now())`, [userId]);
    const limit = restrictions.rows.find((r) => r.type === 'daily_deposit_limit');
    if (!limit) return;
    const spent = await this.db.query<Row>(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM deposits
      WHERE user_id = $1 AND status IN ('pending','confirmed')
        AND initiated_at >= date_trunc('day', now())`, [userId]);
    if (Number(spent.rows[0]?.total ?? 0) + amountCents > Number(limit.value_cents)) {
      throw forbidden('Your daily deposit limit would be exceeded');
    }
  }

  private safeReturnUrl(input?: string): string {
    const fallback = `${env.publicOrigin}/wallet?payment=return`;
    if (!input) return fallback;
    try {
      const url = new URL(input);
      const allowed = [env.publicOrigin, ...env.corsOrigins].some((origin) => {
        try { return new URL(origin).origin === url.origin; } catch { return false; }
      });
      return allowed ? url.toString() : fallback;
    } catch { return fallback; }
  }

  async initiateDeposit(userId: string, input: unknown): Promise<PaymentSummary> {
    const data = depositSchema.parse(input);
    const adapter = this.adapter(data.provider);
    await this.assertProviderAllowed(userId, adapter, 'deposit');
    await this.assertDepositLimits(userId, data.amountCents);
    const currency = await this.eligibility.userCurrency(userId);
    const user = await this.db.query<Row>('SELECT email FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) throw notFound('Account not found');
    const depositId = uuid();
    const health = adapter.health();
    await this.db.query(
      `INSERT INTO deposits (id, user_id, provider, amount_cents, currency, status, sandbox, destination)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
      [depositId, userId, data.provider, data.amountCents, currency, health.sandbox, data.phone ?? null],
    );
    try {
      const initiation = await adapter.initiateDeposit({
        reference: depositId, amountCents: data.amountCents, currency,
        userId, phone: data.phone, email: String(user.rows[0].email),
        returnUrl: this.safeReturnUrl(data.returnUrl),
        resultUrl: `${env.publicOrigin}/api/payments/webhook/${data.provider}`,
      });
      await this.db.query(
        `UPDATE deposits SET provider_reference = $2, metadata = $3::jsonb WHERE id = $1`,
        [depositId, initiation.providerReference, JSON.stringify(initiation.metadata)],
      );
      await audit(this.db, 'deposit.initiated', 'deposit', depositId, {
        provider: data.provider, amountCents: data.amountCents, sandbox: initiation.sandbox,
      }, { type: 'user', id: userId });
      return {
        id: depositId, provider: data.provider, providerReference: initiation.providerReference,
        amountCents: data.amountCents, currency, status: 'pending', sandbox: initiation.sandbox,
        redirectUrl: initiation.redirectUrl, instructions: initiation.instructions,
        createdAt: new Date().toISOString(), confirmedAt: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider initiation failed';
      await this.db.query(
        `UPDATE deposits SET status = 'failed', metadata = metadata || $2::jsonb WHERE id = $1`,
        [depositId, JSON.stringify({ failure: message })],
      );
      await audit(this.db, 'deposit.initiation_failed', 'deposit', depositId, { message }, { type: 'user', id: userId });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(message);
    }
  }

  async requestWithdrawal(userId: string, input: unknown): Promise<PaymentSummary> {
    const data = withdrawalSchema.parse(input);
    const adapter = this.adapter(data.provider);
    await this.assertProviderAllowed(userId, adapter, 'withdrawal');
    await this.auth.assertRealMoneyEligible(userId);
    await this.eligibility.assertAmountWithinPolicy(userId, data.amountCents, 'withdrawal');
    const currency = await this.eligibility.userCurrency(userId);
    const wallet = await this.ledger.walletView(userId, currency);
    if (wallet.availableCents < data.amountCents) {
      throw conflict(`Insufficient available funds: ${formatMoney(wallet.availableCents, currency)}`);
    }
    const withdrawalId = uuid();
    await this.db.transaction(async (tx) => {
      const accounts = await this.ledger.ensureUserAccounts(tx, userId, currency);
      await tx.query(
        `INSERT INTO withdrawals
          (id, user_id, provider, amount_cents, currency, status, sandbox, destination, metadata)
         VALUES ($1,$2,$3,$4,$5,'pending',FALSE,$6,$7::jsonb)`,
        [withdrawalId, userId, data.provider, data.amountCents, currency, data.destination,
          JSON.stringify({ phone: data.destination })],
      );
      await this.ledger.postTransaction({
        type: 'withdrawal_hold', reference: `WHD-${withdrawalId}`,
        idempotencyKey: `withdrawal-hold:${withdrawalId}`,
        description: `Hold for withdrawal ${withdrawalId}`,
        entries: [
          { accountId: accounts.availableId, amountCents: -data.amountCents },
          { accountId: accounts.reservedId, amountCents: data.amountCents },
        ],
        currency,
        createdBy: userId, metadata: { withdrawalId },
      }, tx);
      await audit(tx, 'withdrawal.requested', 'withdrawal', withdrawalId, { provider: data.provider, amountCents: data.amountCents }, { type: 'user', id: userId });
    });
    try {
      const initiation = await adapter.initiateWithdrawal({
        reference: withdrawalId, amountCents: data.amountCents, currency,
        userId, metadata: { phone: data.destination },
      });
      await this.db.query(
        `UPDATE withdrawals SET provider_reference = $2, status = 'processing', metadata = metadata || $3::jsonb WHERE id = $1`,
        [withdrawalId, initiation.providerReference, JSON.stringify(initiation.metadata)],
      );
      return {
        id: withdrawalId, provider: data.provider, providerReference: initiation.providerReference,
        amountCents: data.amountCents, currency, status: 'processing', sandbox: initiation.sandbox,
        redirectUrl: null, instructions: initiation.instructions,
        createdAt: new Date().toISOString(), confirmedAt: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider payout failed';
      await this.failWithdrawal(withdrawalId, message);
      await audit(this.db, 'withdrawal.initiation_failed', 'withdrawal', withdrawalId, { message }, { type: 'user', id: userId });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(message);
    }
  }

  private async failWithdrawal(withdrawalId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query<Row>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [withdrawalId]);
      const row = result.rows[0];
      if (!row || ['completed', 'failed', 'cancelled'].includes(String(row.status))) return;
      const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
      const accounts = await this.ledger.ensureUserAccounts(tx, String(row.user_id), currency);
      await this.ledger.postTransaction({
        type: 'withdrawal_release',
        currency, reference: `WRL-${withdrawalId}`,
        idempotencyKey: `withdrawal-release:${withdrawalId}`,
        description: `Release failed withdrawal hold: ${reason.slice(0, 100)}`,
        entries: [
          { accountId: accounts.reservedId, amountCents: -Number(row.amount_cents) },
          { accountId: accounts.availableId, amountCents: Number(row.amount_cents) },
        ],
        metadata: { withdrawalId, reason },
      }, tx);
      await tx.query(
        `UPDATE withdrawals SET status = 'failed', metadata = metadata || $2::jsonb WHERE id = $1`,
        [withdrawalId, JSON.stringify({ failure: reason })],
      );
      await notify(tx, String(row.user_id), {
        type: 'withdrawal_failed', title: 'Withdrawal failed',
        body: `Your ${formatMoney(Number(row.amount_cents), currency)} withdrawal was not completed; the funds were returned to your available balance.`,
        link: '/wallet',
      });
    });
  }

  /** Never credits from a callback body; always confirms with the provider API. */
  async handleCallback(providerId: ProviderId, rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{
    duplicate: boolean; authenticated: boolean; processed: string[]; ignored: string[];
  }> {
    const adapter = this.adapter(providerId);
    const callback = adapter.parseCallback(rawBody, headers);
    const eventId = callback.eventId || `${providerId}:${sha256(rawBody)}`;
    const inserted = await this.db.query<Row>(
      `INSERT INTO payment_provider_events (provider, event_id, kind, signature_valid, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [providerId, eventId, 'callback', callback.authenticated, JSON.stringify({ raw: callback.raw, reason: callback.reason ?? null })],
    );
    if (!inserted.rows.length) return { duplicate: true, authenticated: callback.authenticated, processed: [], ignored: [] };
    if (!callback.authenticated && !callback.allowUnauthenticatedLookup) {
      await audit(this.db, 'payment.callback_rejected', 'provider_event', String(inserted.rows[0].id), {
        provider: providerId, reason: callback.reason,
      }, { type: 'provider', id: providerId });
      await this.db.query('UPDATE payment_provider_events SET processed_at = now() WHERE id = $1', [inserted.rows[0].id]);
      return { duplicate: false, authenticated: false, processed: [], ignored: ['invalid_signature'] };
    }
    const operations = await this.findByReferences(providerId, callback.references);
    const processed: string[] = [];
    const ignored: string[] = [];
    for (const operation of operations) {
      try {
        const outcome = operation.kind === 'deposit'
          ? await this.confirmDeposit(operation.id)
          : await this.confirmWithdrawal(operation.id);
        if (outcome.changed) processed.push(`${operation.kind}:${operation.id}`);
        else ignored.push(`${operation.kind}:${operation.id}:${outcome.status}`);
      } catch (error) {
        this.log.warn({ providerId, operation, err: (error as Error).message }, 'callback processing failed');
        ignored.push(`${operation.kind}:${operation.id}:error`);
      }
    }
    await this.db.query('UPDATE payment_provider_events SET processed_at = now() WHERE id = $1', [inserted.rows[0].id]);
    return { duplicate: false, authenticated: callback.authenticated, processed, ignored };
  }

  private async findByReferences(providerId: ProviderId, references: string[]): Promise<Array<{ id: string; kind: 'deposit' | 'withdrawal' }>> {
    const refs = [...new Set(references)].filter(Boolean).slice(0, 20);
    if (!refs.length) return [];
    const rows = await this.db.query<Row>(`
      SELECT id::text, 'deposit' AS kind FROM deposits
      WHERE provider = $1 AND (id::text = ANY($2::text[]) OR provider_reference = ANY($2::text[])
        OR metadata->>'clientCorrelator' = ANY($2::text[]) OR metadata->>'transferReference' = ANY($2::text[]))
      UNION ALL
      SELECT id::text, 'withdrawal' AS kind FROM withdrawals
      WHERE provider = $1 AND (id::text = ANY($2::text[]) OR provider_reference = ANY($2::text[])
        OR metadata->>'transferReference' = ANY($2::text[]))`, [providerId, refs]);
    return rows.rows.map((r) => ({ id: String(r.id), kind: r.kind as 'deposit' | 'withdrawal' }));
  }

  private async statusFor(adapter: PaymentAdapter, row: Row, kind: 'deposit' | 'withdrawal'): Promise<ProviderStatus> {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return adapter.checkStatus({
      reference: String(row.id),
      providerReference: row.provider_reference ? String(row.provider_reference) : null,
      metadata: { ...metadata, kind, providerReference: row.provider_reference },
    });
  }

  async confirmDeposit(depositId: string): Promise<{ status: string; changed: boolean; reason?: string }> {
    const result = await this.db.query<Row>('SELECT * FROM deposits WHERE id = $1', [depositId]);
    const row = result.rows[0];
    if (!row) throw notFound('Deposit not found');
    if (row.status !== 'pending') return { status: String(row.status), changed: false };
    const adapter = this.adapter(row.provider as ProviderId);
    let status: ProviderStatus;
    try { status = await this.statusFor(adapter, row, 'deposit'); }
    catch (error) { return { status: 'pending', changed: false, reason: (error as Error).message }; }
    if (!status.authoritative) return { status: 'pending', changed: false, reason: 'Provider response was not authenticated/verified' };
    if (status.currency !== String(row.currency ?? LEDGER_BASE_CURRENCY).toUpperCase()) return { status: 'failed', changed: true, reason: 'Currency mismatch' };
    if (status.amountCents !== null && status.amountCents !== Number(row.amount_cents)) {
      await this.db.query(
        `UPDATE deposits SET status = 'failed', metadata = metadata || $2::jsonb WHERE id = $1 AND status = 'pending'`,
        [depositId, JSON.stringify({ providerAmountCents: status.amountCents, reason: 'amount_mismatch' })],
      );
      await audit(this.db, 'deposit.amount_mismatch', 'deposit', depositId, {
        expectedCents: Number(row.amount_cents), reportedCents: status.amountCents,
      }, { type: 'provider', id: String(row.provider) });
      return { status: 'failed', changed: true, reason: 'Amount mismatch' };
    }
    if (status.state === 'paid') {
      await this.creditDeposit(depositId, status);
      return { status: 'confirmed', changed: true };
    }
    if (['failed', 'cancelled'].includes(status.state)) {
      await this.db.query(
        `UPDATE deposits SET status = $2, provider_reference = COALESCE(provider_reference, $3) WHERE id = $1 AND status = 'pending'`,
        [depositId, status.state, status.providerReference || null],
      );
      return { status: status.state, changed: true };
    }
    if (status.state === 'reversed') {
      await this.reverseDeposit(depositId, status);
      return { status: 'reversed', changed: true };
    }
    return { status: 'pending', changed: false, reason: `Provider status: ${status.state}` };
  }

  private async creditDeposit(depositId: string, providerStatus: ProviderStatus): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query<Row>('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId]);
      const row = result.rows[0];
      if (!row || row.status !== 'pending') return;
      const amount = Number(row.amount_cents);
      const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
      const accounts = await this.ledger.ensureUserAccounts(tx, String(row.user_id), currency);
      const externalId = await this.ledger.systemAccountId(tx, currency, 'external');
      const journal = await this.ledger.postTransaction({
        type: row.sandbox ? 'test_deposit_credit' : 'deposit_credit',
        currency,
        reference: `DEP-${depositId}`,
        idempotencyKey: `deposit-credit:${depositId}`,
        description: row.sandbox ? 'INTERNAL SANDBOX TEST CREDIT (no cash value)' : 'Verified provider deposit',
        entries: [
          { accountId: externalId, amountCents: -amount },
          { accountId: accounts.availableId, amountCents: amount },
        ],
        createdBy: String(row.user_id),
        metadata: {
          provider: row.provider, providerReference: providerStatus.providerReference,
          sandbox: Boolean(row.sandbox), testCredit: Boolean(row.sandbox),
        },
      }, tx);
      await tx.query(
        `UPDATE deposits SET status = 'confirmed', confirmed_at = now(),
           provider_reference = COALESCE(provider_reference, $2),
           ledger_transaction_id = $3, metadata = metadata || $4::jsonb
         WHERE id = $1`,
        [depositId, providerStatus.providerReference || null, journal.id,
          JSON.stringify({ verification: providerStatus.state, verifiedAt: new Date().toISOString() })],
      );
      await notify(tx, String(row.user_id), {
        type: 'deposit_confirmed', title: row.sandbox ? 'Sandbox test credit added' : 'Deposit confirmed',
        body: `${formatMoney(amount, currency)} ${row.sandbox ? 'sandbox test credit (no cash value)' : 'verified provider deposit'} is now available.`,
        link: '/wallet',
      });
      await audit(tx, 'deposit.confirmed', 'deposit', depositId, {
        amount, sandbox: Boolean(row.sandbox), providerReference: providerStatus.providerReference,
      }, { type: 'provider', id: String(row.provider) });
    });
  }

  private async reverseDeposit(depositId: string, providerStatus: ProviderStatus): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query<Row>('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId]);
      const row = result.rows[0];
      if (!row) return;
      if (row.status === 'confirmed') {
        const amount = Number(row.amount_cents);
        const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
        const accounts = await this.ledger.ensureUserAccounts(tx, String(row.user_id), currency);
        const externalId = await this.ledger.systemAccountId(tx, currency, 'external');
        try {
          const journal = await this.ledger.postTransaction({
            type: 'deposit_reversal',
            currency, reference: `DREV-${depositId}`,
            idempotencyKey: `deposit-reversal:${depositId}`,
            description: 'Compensating entry for a provider-reversed deposit',
            entries: [
              { accountId: accounts.availableId, amountCents: -amount },
              { accountId: externalId, amountCents: amount },
            ],
            metadata: { depositId, providerStatus: providerStatus.state },
          }, tx);
          await tx.query(
            `UPDATE deposits SET status = 'reversed', metadata = metadata || $2::jsonb WHERE id = $1`,
            [depositId, JSON.stringify({ reversalTransactionId: journal.id })],
          );
          await audit(tx, 'deposit.reversed', 'deposit', depositId, { amount }, { type: 'provider', id: String(row.provider) });
        } catch (error) {
          // Never silently write off a reversed deposit when the user has spent it.
          await audit(tx, 'deposit.reversal_blocked', 'deposit', depositId, {
            amount, reason: (error as Error).message, requiresManualReview: true,
          }, { type: 'provider', id: String(row.provider) });
          throw conflict('Provider reversal requires manual review: the deposit was already spent');
        }
      } else {
        await tx.query(`UPDATE deposits SET status = 'reversed' WHERE id = $1`, [depositId]);
      }
    });
  }

  async confirmWithdrawal(withdrawalId: string): Promise<{ status: string; changed: boolean; reason?: string }> {
    const result = await this.db.query<Row>('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    const row = result.rows[0];
    if (!row) throw notFound('Withdrawal not found');
    if (!['pending', 'processing'].includes(String(row.status))) return { status: String(row.status), changed: false };
    const adapter = this.adapter(row.provider as ProviderId);
    let status: ProviderStatus;
    try { status = await this.statusFor(adapter, row, 'withdrawal'); }
    catch (error) { return { status: String(row.status), changed: false, reason: (error as Error).message }; }
    if (!status.authoritative) return { status: String(row.status), changed: false, reason: 'Provider response was not verified' };
    if (status.state === 'completed') {
      await this.completeWithdrawal(withdrawalId, status);
      return { status: 'completed', changed: true };
    }
    if (['failed', 'cancelled', 'reversed'].includes(status.state)) {
      await this.failWithdrawal(withdrawalId, `Provider status: ${status.state}`);
      return { status: 'failed', changed: true };
    }
    return { status: String(row.status), changed: false, reason: `Provider status: ${status.state}` };
  }

  private async completeWithdrawal(withdrawalId: string, providerStatus: ProviderStatus): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query<Row>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [withdrawalId]);
      const row = result.rows[0];
      if (!row || row.status === 'completed') return;
      const amount = Number(row.amount_cents);
      const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
      const accounts = await this.ledger.ensureUserAccounts(tx, String(row.user_id), currency);
      const externalId = await this.ledger.systemAccountId(tx, currency, 'external');
      const journal = await this.ledger.postTransaction({
        type: 'withdrawal_complete',
        currency, reference: `WCP-${withdrawalId}`,
        idempotencyKey: `withdrawal-complete:${withdrawalId}`,
        description: 'Provider-confirmed withdrawal',
        entries: [
          { accountId: accounts.reservedId, amountCents: -amount },
          { accountId: externalId, amountCents: amount },
        ],
        metadata: { withdrawalId, providerReference: providerStatus.providerReference },
      }, tx);
      await tx.query(
        `UPDATE withdrawals SET status = 'completed', completed_at = now(),
           provider_reference = COALESCE(provider_reference, $2),
           ledger_transaction_id = $3, metadata = metadata || $4::jsonb WHERE id = $1`,
        [withdrawalId, providerStatus.providerReference || null, journal.id,
          JSON.stringify({ verification: providerStatus.state, verifiedAt: new Date().toISOString() })],
      );
      await notify(tx, String(row.user_id), {
        type: 'withdrawal_completed', title: 'Withdrawal completed',
        body: `${formatMoney(amount, currency)} was sent to ${row.destination}.`, link: '/wallet',
      });
      await audit(tx, 'withdrawal.completed', 'withdrawal', withdrawalId, { amount }, { type: 'provider', id: String(row.provider) });
    });
  }

  async grantTestCredits(userId: string, amountCents: number, actorId: string): Promise<string> {
    if (!this.compliance.testMode || !env.testFundsEnabled) {
      throw forbidden('Test credits are only available in the isolated internal test environment');
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000) throw badRequest('Invalid test credit amount');
    const reference = uuid();
    const currency = await this.eligibility.userCurrency(userId);
    await this.db.transaction(async (tx) => {
      const accounts = await this.ledger.ensureUserAccounts(tx, userId, currency);
      const externalId = await this.ledger.systemAccountId(tx, currency, 'external');
      await this.ledger.postTransaction({
        type: 'test_credit_grant',
        currency, reference: `TST-${reference}`,
        idempotencyKey: `test-credit:${reference}`,
        description: 'INTERNAL TEST CREDIT - no cash value, not withdrawable',
        entries: [
          { accountId: externalId, amountCents: -amountCents },
          { accountId: accounts.availableId, amountCents },
        ],
        createdBy: actorId, metadata: { testCredit: true, noCashValue: true },
      }, tx);
      await notify(tx, userId, {
        type: 'test_credit', title: 'Test credits added',
        body: `${formatMoney(amountCents, currency)} of internal test credit was added. It has no cash value.`, link: '/wallet',
      });
      await audit(tx, 'test_credit.granted', 'user', userId, { amountCents }, { type: 'system', id: actorId });
    });
    return reference;
  }

  async listDeposits(userId: string): Promise<Row[]> {
    const result = await this.db.query<Row>(
      'SELECT id, provider, provider_reference, amount_cents, currency, status, sandbox, initiated_at, confirmed_at, destination FROM deposits WHERE user_id = $1 ORDER BY initiated_at DESC LIMIT 100',
      [userId],
    );
    return result.rows;
  }

  async listWithdrawals(userId: string): Promise<Row[]> {
    const result = await this.db.query<Row>(
      'SELECT id, provider, provider_reference, amount_cents, currency, status, sandbox, requested_at, completed_at, destination FROM withdrawals WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 100',
      [userId],
    );
    return result.rows;
  }

  async walletTransactions(userId: string, filters: { type?: string; status?: string; from?: string; to?: string; minCents?: number; maxCents?: number; limit?: number; offset?: number; currency?: string } = {}): Promise<Row[]> {
    const currency = filters.currency ?? await this.eligibility.userCurrency(userId);
    const rows = await this.ledger.transactions(userId, { ...filters, currency });
    return rows.filter((row) => {
      const amount = Number(row.amount_cents);
      if (filters.minCents !== undefined && amount < filters.minCents) return false;
      if (filters.maxCents !== undefined && amount > filters.maxCents) return false;
      return true;
    });
  }

  private csvCell(value: unknown): string {
    let text = value === null || value === undefined ? '' : String(value);
    // Prevent spreadsheet formula injection in downloaded statements.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  async statementCsv(userId: string, filters: Parameters<PaymentService['walletTransactions']>[1] = {}): Promise<string> {
    const rows = await this.walletTransactions(userId, { ...filters, limit: 200 });
    const header = ['date', 'reference', 'type', 'description', 'status', 'currency', 'amount'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        this.csvCell(row.created_at), this.csvCell(row.reference), this.csvCell(row.type),
        this.csvCell(row.description), this.csvCell(row.status),
        this.csvCell(row.currency ?? LEDGER_BASE_CURRENCY),
        this.csvCell((Number(row.amount_cents) / 100).toFixed(2)),
      ].join(','));
    }
    return lines.join('\n');
  }

  async receipt(userId: string, transactionId: string): Promise<{ transaction: Row; entries: Row[] }> {
    const txn = await this.db.query<Row>(`
      SELECT lt.* FROM ledger_transactions lt
      JOIN ledger_entries le ON le.transaction_id = lt.id
      JOIN wallet_accounts wa ON wa.id = le.wallet_account_id
      WHERE lt.id = $1 AND wa.owner_type = 'user' AND wa.owner_id = $2 LIMIT 1`, [transactionId, userId]);
    if (!txn.rows.length) throw notFound('Receipt not found');
    const entries = await this.db.query<Row>(`
      SELECT le.line_no, le.amount_cents, le.currency, wa.owner_type, wa.purpose
      FROM ledger_entries le JOIN wallet_accounts wa ON wa.id = le.wallet_account_id
      WHERE le.transaction_id = $1 ORDER BY le.line_no`, [transactionId]);
    return { transaction: txn.rows[0], entries: entries.rows };
  }

  async providerEvents(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(
      'SELECT id, provider, event_id, kind, signature_valid, received_at, processed_at FROM payment_provider_events ORDER BY received_at DESC LIMIT $1',
      [limit],
    );
    return result.rows;
  }

  async reconcilePending(limit = 25): Promise<{ checked: number; changed: number; errors: string[] }> {
    const pending = await this.db.query<Row>(`
      SELECT id, 'deposit' AS kind FROM deposits WHERE status = 'pending' AND initiated_at < now() - interval '1 minute'
      UNION ALL
      SELECT id, 'withdrawal' AS kind FROM withdrawals WHERE status IN ('pending','processing') AND requested_at < now() - interval '1 minute'
      ORDER BY id LIMIT $1`, [limit]);
    let changed = 0;
    const errors: string[] = [];
    for (const row of pending.rows) {
      try {
        const outcome = row.kind === 'deposit'
          ? await this.confirmDeposit(String(row.id))
          : await this.confirmWithdrawal(String(row.id));
        if (outcome.changed) changed++;
      } catch (error) {
        errors.push(`${row.kind}:${row.id}: ${(error as Error).message}`);
      }
    }
    return { checked: pending.rows.length, changed, errors };
  }
}
