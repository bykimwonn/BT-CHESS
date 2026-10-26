import type { Database, Queryable, Row } from '../db/client.js';
import type { ComplianceState } from '../config/compliance.js';
import type { AppLogger } from '../services/logger.js';
import { adminAction, audit } from '../services/audit.js';
import { badRequest, forbidden, notFound, unavailable } from '../services/errors.js';
import { uuid } from '../services/ids.js';
import {
  GLOBAL_POLICY, UNDISCLOSED_COUNTRY, countryName,
} from '../../shared/countries.js';
import type {
  CurrencyCode, EligibilityView, JurisdictionPolicy, OperatingMode,
} from '../../shared/contracts.js';

export interface JurisdictionPolicyInput {
  code: string;
  label: string;
  freePlayAllowed: boolean;
  realMoneyAllowed: boolean;
  ageVerificationRequired: boolean;
  identityVerificationRequired: boolean;
  permittedCompetitionTypes: OperatingMode[];
  allowedProviders: string[];
  depositLimitCents?: number | null;
  withdrawalLimitCents?: number | null;
  reason: string;
}

export interface ExchangeRateInput {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveAt: string;
  source: string;
  evidenceRef?: string;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').map((v) => v.replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

function policyFromRow(row: Row): JurisdictionPolicy {
  return {
    code: String(row.code),
    label: String(row.label ?? countryName(String(row.code))),
    freePlayAllowed: Boolean(row.free_play_allowed),
    realMoneyAllowed: Boolean(row.real_money_allowed),
    ageVerificationRequired: Boolean(row.age_verification_required),
    identityVerificationRequired: Boolean(row.identity_verification_required),
    permittedCompetitionTypes: asArray(row.permitted_competition_types) as OperatingMode[],
    allowedProviders: asArray(row.allowed_providers),
    depositLimitCents: row.deposit_limit_cents === null || row.deposit_limit_cents === undefined ? null : Number(row.deposit_limit_cents),
    withdrawalLimitCents: row.withdrawal_limit_cents === null || row.withdrawal_limit_cents === undefined ? null : Number(row.withdrawal_limit_cents),
    reason: String(row.reason ?? ''),
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    version: row.version === undefined || row.version === null ? undefined : Number(row.version),
  };
}

function rateScaled(rate: string): bigint {
  const [whole = '0', fraction = ''] = String(rate).split('.');
  const padded = (fraction + '0'.repeat(12)).slice(0, 12);
  return BigInt(whole) * 1_000_000_000_000n + BigInt(padded || '0');
}

export class EligibilityService {
  constructor(
    private readonly db: Database,
    private readonly compliance: ComplianceState,
    private readonly log: AppLogger,
  ) {}

  async globalFreePlayEnabled(): Promise<boolean> {
    const result = await this.db.query<Row>("SELECT value FROM platform_config WHERE key = 'global_free_play_enabled'");
    return Boolean(result.rows[0]?.value ?? true);
  }

  async policy(code: string): Promise<JurisdictionPolicy> {
    const wanted = String(code || GLOBAL_POLICY).toUpperCase();
    const result = await this.db.query<Row>('SELECT * FROM jurisdiction_policies WHERE code = $1', [wanted]);
    if (result.rows.length) return policyFromRow(result.rows[0]);
    const fallback = await this.db.query<Row>('SELECT * FROM jurisdiction_policies WHERE code = $1', [GLOBAL_POLICY]);
    if (!fallback.rows.length) throw new Error('Global jurisdiction policy is missing');
    return policyFromRow(fallback.rows[0]);
  }

  private async userRow(userId: string | null | undefined): Promise<Row | null> {
    if (!userId) return null;
    const result = await this.db.query<Row>(`
      SELECT id, status, email_verified, age_verified, identity_verified,
             country, country_shared, eligibility_jurisdiction, eligibility_verified_at,
             eligibility_provider_ref, location_verified_at, account_currency,
             timezone, timezone_shared
      FROM users WHERE id = $1`, [userId]);
    return result.rows[0] ?? null;
  }

  async userCurrency(userId: string): Promise<CurrencyCode> {
    const row = await this.userRow(userId);
    return String(row?.account_currency ?? 'USD').trim() || 'USD';
  }

  async stateFor(userId?: string | null): Promise<EligibilityView> {
    const row = await this.userRow(userId);
    const globalFree = await this.globalFreePlayEnabled();
    const country = String(row?.country ?? UNDISCLOSED_COUNTRY).trim() || UNDISCLOSED_COUNTRY;
    const verifiedJurisdiction = row?.eligibility_jurisdiction ? String(row.eligibility_jurisdiction).trim() : null;
    // A selected country is never sufficient for real-money eligibility. It is
    // used only for free-play policy; real money uses verifiedJurisdiction.
    // Country of residence is voluntary and only selects a free-play/test policy.
    // Real-money decisions always require verifiedJurisdiction below.
    const policyCode = verifiedJurisdiction ?? (country || GLOBAL_POLICY);
    const policy = await this.policy(policyCode);
    const platformMode: OperatingMode = this.compliance.testMode ? 'test'
      : this.compliance.realMoneyEnabled ? 'real' : 'free';

    const freeAllowed = globalFree && policy.freePlayAllowed && (!row || String(row.status) === 'active');
    const freeReason = !globalFree ? 'Free play has been disabled by an operator policy.'
      : !policy.freePlayAllowed ? policy.reason
        : row && String(row.status) !== 'active' ? 'Account is not active.'
          : 'Free chess is available internationally without a payment method.';

    const blockers: string[] = [];
    if (!this.compliance.realMoneyEnabled) blockers.push(...this.compliance.blockers);
    if (!row) blockers.push('Sign in before entering a money match.');
    if (row) {
      if (String(row.status) !== 'active') blockers.push('Account is not active.');
      if (!row.email_verified) blockers.push('Verify your email address.');
      if (!row.age_verified) blockers.push('Provider-verified 18+ age check is required.');
      if (!row.identity_verified) blockers.push('Identity verification is required.');
      if (!verifiedJurisdiction || !row.eligibility_verified_at) blockers.push('A verified eligibility jurisdiction is required; a selected country or IP address is not sufficient.');
      if (!row.location_verified_at) blockers.push('Location verification is required for money matches.');
    }
    if (!policy.realMoneyAllowed) blockers.push(policy.reason);
    if (!policy.permittedCompetitionTypes.includes('real')) blockers.push('This jurisdiction does not permit real-money competitions.');
    if (policy.ageVerificationRequired && !row?.age_verified) blockers.push('Age verification is required by this jurisdiction.');
    if (policy.identityVerificationRequired && !row?.identity_verified) blockers.push('Identity verification is required by this jurisdiction.');

    return {
      authenticated: !!row,
      countryOfResidence: country,
      countryShared: Boolean(row?.country_shared),
      verifiedEligibilityJurisdiction: verifiedJurisdiction,
      eligibilityVerifiedAt: row?.eligibility_verified_at ? String(row.eligibility_verified_at) : null,
      accountCurrency: String(row?.account_currency ?? 'USD').trim() || 'USD',
      timezone: String(row?.timezone ?? 'UTC'),
      timezoneShared: Boolean(row?.timezone_shared),
      policyCode,
      policy,
      freePlay: { allowed: freeAllowed, reason: freeReason },
      moneyMatches: {
        allowed: blockers.length === 0,
        blockers: [...new Set(blockers)],
        permittedTypes: policy.permittedCompetitionTypes,
        allowedProviders: policy.allowedProviders,
      },
      platform: {
        mode: platformMode,
        realMoneyEnabled: this.compliance.realMoneyEnabled,
        competitionsEnabled: this.compliance.competitionsEnabled,
      },
    };
  }

  async assertFreePlayAllowed(userId?: string | null): Promise<void> {
    const state = await this.stateFor(userId);
    if (!state.freePlay.allowed) throw forbidden(state.freePlay.reason);
  }

  async assertCompetitionAllowed(userId: string, mode: OperatingMode, stakeCents: number): Promise<void> {
    const state = await this.stateFor(userId);
    if (!state.freePlay.allowed) throw forbidden(state.freePlay.reason);
    if (stakeCents <= 0) return;
    if (mode === 'test') {
      if (!this.compliance.testMode) throw forbidden('Internal test-credit competitions are not enabled.');
      if (!state.policy.permittedCompetitionTypes.includes('test')) {
        throw forbidden(`Internal test-credit competitions are not permitted in ${state.policy.label}: ${state.policy.reason}`);
      }
      return;
    }
    if (mode === 'real') {
      if (!state.moneyMatches.allowed) throw forbidden(`Money matches are not available: ${state.moneyMatches.blockers.join('; ')}`);
      if (!state.policy.permittedCompetitionTypes.includes('real')) throw forbidden('This jurisdiction does not permit real-money competitions.');
      return;
    }
    throw badRequest('A staked match cannot use free mode');
  }

  async assertRealMoneyEligible(userId: string): Promise<void> {
    const state = await this.stateFor(userId);
    if (!state.moneyMatches.allowed) throw forbidden(`Money matches are not available: ${state.moneyMatches.blockers.join('; ')}`);
  }

  async assertPaymentProviderAllowed(userId: string, providerId: string): Promise<void> {
    const state = await this.stateFor(userId);
    if (!state.policy.allowedProviders.includes(providerId)) {
      throw forbidden(`${providerId} is not an approved payment provider for ${state.policy.label}.`);
    }
    if (this.compliance.testMode) {
      if (!state.policy.permittedCompetitionTypes.includes('test')) throw forbidden('Sandbox payments are not permitted in this jurisdiction.');
      return;
    }
    if (!state.moneyMatches.allowed) throw forbidden(`Payments are not available: ${state.moneyMatches.blockers.join('; ')}`);
  }

  async assertAmountWithinPolicy(userId: string, amountCents: number, kind: 'deposit' | 'withdrawal'): Promise<void> {
    const state = await this.stateFor(userId);
    const limit = kind === 'deposit' ? state.policy.depositLimitCents : state.policy.withdrawalLimitCents;
    if (limit !== null && amountCents > limit) {
      throw forbidden(`${state.policy.label} ${kind} limit is ${limit} USD cents.`);
    }
  }

  async listPolicies(): Promise<JurisdictionPolicy[]> {
    const result = await this.db.query<Row>('SELECT * FROM jurisdiction_policies ORDER BY code');
    return result.rows.map(policyFromRow);
  }

  async setPolicy(actorId: string, input: JurisdictionPolicyInput, reason: string): Promise<JurisdictionPolicy> {
    const code = input.code.toUpperCase();
    const result = await this.db.transaction(async (tx: Queryable) => {
      const rows = await tx.query<Row>(`
        INSERT INTO jurisdiction_policies
          (code, label, free_play_allowed, real_money_allowed, age_verification_required,
           identity_verification_required, permitted_competition_types, allowed_providers,
           deposit_limit_cents, withdrawal_limit_cents, reason, updated_by, updated_at, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,now(),1)
        ON CONFLICT (code) DO UPDATE SET
          label = EXCLUDED.label,
          free_play_allowed = EXCLUDED.free_play_allowed,
          real_money_allowed = EXCLUDED.real_money_allowed,
          age_verification_required = EXCLUDED.age_verification_required,
          identity_verification_required = EXCLUDED.identity_verification_required,
          permitted_competition_types = EXCLUDED.permitted_competition_types,
          allowed_providers = EXCLUDED.allowed_providers,
          deposit_limit_cents = EXCLUDED.deposit_limit_cents,
          withdrawal_limit_cents = EXCLUDED.withdrawal_limit_cents,
          reason = EXCLUDED.reason,
          updated_by = EXCLUDED.updated_by,
          updated_at = now(),
          version = jurisdiction_policies.version + 1
        RETURNING *`,
        [code, input.label, input.freePlayAllowed, input.realMoneyAllowed,
          input.ageVerificationRequired, input.identityVerificationRequired,
          input.permittedCompetitionTypes, input.allowedProviders,
          input.depositLimitCents ?? null, input.withdrawalLimitCents ?? null,
          input.reason, actorId],
      );
      await adminAction(tx, {
        actorId, action: 'jurisdiction.policy', targetType: 'jurisdiction_policy', targetId: code,
        reason, outcome: input.realMoneyAllowed ? 'real money permitted' : 'real money restricted',
        metadata: input as unknown as Record<string, unknown>,
      });
      await audit(tx, 'jurisdiction.policy_changed', 'jurisdiction_policy', code,
        input as unknown as Record<string, unknown>, { type: 'admin', id: actorId });
      return policyFromRow(rows.rows[0]);
    });
    this.log.info({ code, actorId }, 'jurisdiction policy updated');
    return result;
  }

  async listExchangeRates(limit = 50): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT id, from_currency, to_currency, rate::text AS rate, effective_at, source,
             evidence_ref, created_by, created_at
      FROM currency_exchange_rates ORDER BY effective_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  async recordExchangeRate(actorId: string, input: ExchangeRateInput, reason: string): Promise<Row> {
    const id = uuid();
    await this.db.transaction(async (tx: Queryable) => {
      await tx.query(
        `INSERT INTO currency_exchange_rates
          (id, from_currency, to_currency, rate, effective_at, source, evidence_ref, created_by)
         VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8)`,
        [id, input.fromCurrency, input.toCurrency, input.rate, input.effectiveAt,
          input.source, input.evidenceRef ?? '', actorId],
      );
      await adminAction(tx, {
        actorId, action: 'currency.exchange_rate', targetType: 'currency_exchange_rate', targetId: id,
        reason, outcome: `${input.fromCurrency}/${input.toCurrency} ${input.rate}`,
        metadata: input as unknown as Record<string, unknown>,
      });
    });
    const result = await this.db.query<Row>('SELECT * FROM currency_exchange_rates WHERE id = $1', [id]);
    return result.rows[0];
  }

  /** Returns an explicit, stored conversion quote. It never changes a balance. */
  async quoteConversion(actorId: string, input: { fromCurrency: string; toCurrency: string; amountCents: number }): Promise<Record<string, unknown>> {
    const rateResult = await this.db.query<Row>(`
      SELECT id, from_currency, to_currency, rate::text AS rate, effective_at, source
      FROM currency_exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND effective_at <= now()
      ORDER BY effective_at DESC LIMIT 1`, [input.fromCurrency, input.toCurrency]);
    if (!rateResult.rows.length) throw unavailable('No explicit exchange rate is recorded for this currency pair.');
    const rateRow = rateResult.rows[0];
    const rate = String(rateRow.rate);
    const converted = (BigInt(input.amountCents) * rateScaled(rate)) / 1_000_000_000_000n;
    if (converted <= 0n) throw badRequest('Amount is too small to convert at this rate.');
    const id = uuid();
    await this.db.query(
      `INSERT INTO currency_conversion_quotes
        (id, from_currency, to_currency, amount_cents, rate_exchange_id, rate,
         converted_cents, source, applied, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,FALSE,$9)`,
      [id, input.fromCurrency, input.toCurrency, input.amountCents, rateRow.id,
        rate, Number(converted), String(rateRow.source), actorId],
    );
    return {
      id, fromCurrency: input.fromCurrency, toCurrency: input.toCurrency,
      amountCents: input.amountCents, rate, convertedCents: Number(converted),
      effectiveAt: String(rateRow.effective_at), source: String(rateRow.source),
      applied: false, warning: 'Quote only. No wallet balance was converted; posting a conversion requires a separate audited multi-currency journal.',
    };
  }

  async listConversionQuotes(limit = 50): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT * FROM currency_conversion_quotes ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }
}
