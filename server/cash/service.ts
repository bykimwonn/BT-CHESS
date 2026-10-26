import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type { ComplianceState } from '../config/compliance.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../services/errors.js';
import { audit, adminAction, notify } from '../services/audit.js';
import { sha256, uuid } from '../services/ids.js';
import { formatMoney, LEDGER_BASE_CURRENCY } from '../../shared/contracts.js';
import type { LedgerService } from '../finance/ledger.js';
import type { AppLogger } from '../services/logger.js';

/**
 * Cash-agent voucher rail.
 *
 * The teller takes cash and issues a short code; the player redeems the code
 * against their balance. Withdrawals run the other way: the player requests
 * cash, receives a code, and an agent pays it out after checking ID.
 *
 * Every movement is a balanced journal. The agent's float account is the
 * counter-account to the player wallet, so the cash an agent is holding is
 * always visible as `cashHeldCents` and can be reconciled or remitted.
 *
 * The rail is deliberately gated:
 *  - `CASH_AGENTS_ENABLED` must be true;
 *  - free mode (no test or authorised real-money operation) refuses everything;
 *  - test mode issues sandbox vouchers only, which credit test credits that
 *    cannot be withdrawn;
 *  - cash payouts are real-money only.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const MIN_VOUCHER_CENTS = 100; // $1
const MIN_PAYOUT_CENTS = 500; // $5
const DEFAULT_DEPOSIT_EXPIRY_MINUTES = 60;
const MAX_DEPOSIT_EXPIRY_MINUTES = 24 * 60;
const PAYOUT_EXPIRY_HOURS = 72;
const PLAYER_DAILY_REDEEM_CENTS = 500_000; // $5,000 per player per day

export type VoucherKind = 'deposit' | 'payout';
export type VoucherStatus = 'issued' | 'redeemed' | 'paid' | 'cancelled' | 'expired';

export interface VoucherView {
  id: string;
  kind: VoucherKind;
  status: VoucherStatus;
  amountCents: number;
  currency: string;
  agentId: string;
  agentCode: string;
  agentName: string;
  playerId: string | null;
  playerUsername: string | null;
  reference: string | null;
  sandbox: boolean;
  issuedAt: string;
  expiresAt: string;
  settledAt: string | null;
  codeLast4: string;
}

export interface IssuedVoucher { voucher: VoucherView; code: string }

export interface AgentView {
  id: string;
  userId: string;
  username: string;
  name: string;
  code: string;
  status: 'active' | 'suspended' | 'closed';
  location: string | null;
  currency: string;
  cashHeldCents: number;
  voucherLimitCents: number;
  dailyDepositLimitCents: number;
  dailyPayoutLimitCents: number;
  todayDepositCents: number;
  todayPayoutCents: number;
  openVouchers: number;
}

/** Normalise a code typed by a human: case, spaces and dashes are ignored. */
export function normalizeVoucherCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isWellFormedCode(input: string): boolean {
  const code = normalizeVoucherCode(input);
  return code.length >= 6 && code.length <= 12;
}

export function generateVoucherCode(): string {
  const raw = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function voucherHash(code: string): string {
  return sha256(`rookstone-voucher:${normalizeVoucherCode(code)}`);
}

/**
 * Decide whether the rail may run, and in which mode. Kept as a pure function
 * so the fail-closed rules can be tested without a database.
 */
export function complianceMode(
  state: Pick<ComplianceState, 'realMoneyEnabled' | 'testMode'>,
): 'free' | 'test' | 'real' {
  return state.realMoneyEnabled ? 'real' : state.testMode ? 'test' : 'free';
}

export function cashRailMode(
  state: Pick<ComplianceState, 'realMoneyEnabled' | 'testMode' | 'blockers'>,
  enabled: boolean,
  action: 'deposit' | 'payout',
): 'test' | 'real' {
  if (!enabled) {
    throw unavailable('Cash-agent vouchers are disabled. An operator must set CASH_AGENTS_ENABLED=true.');
  }
  const mode = complianceMode(state);
  if (mode === 'free') {
    throw forbidden(`Cash-agent vouchers are unavailable: ${state.blockers.join('; ')}`);
  }
  if (action === 'payout' && mode !== 'real') {
    throw forbidden('Cash payouts are only available in authorised real-money mode. Test credits cannot be withdrawn.');
  }
  return mode;
}

export class CashVoucherService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceState,
    private readonly log: AppLogger,
  ) {}

  // --------------------------------------------------------------- gating

  private assertEnabled(action: 'deposit' | 'payout'): 'test' | 'real' {
    return cashRailMode(this.compliance, env.cashAgentsEnabled, action);
  }

  private async floatAccount(tx: Queryable, agentId: string, currency = LEDGER_BASE_CURRENCY): Promise<string> {
    const code = String(currency || LEDGER_BASE_CURRENCY).toUpperCase();
    const existing = await tx.query<Row>('SELECT float_account_id FROM cash_agents WHERE id = $1', [agentId]);
    if (!existing.rows.length) throw notFound('Cash agent not found');
    return String(existing.rows[0].float_account_id);
  }

  private async agentForUser(userId: string): Promise<Row> {
    const result = await this.db.query<Row>('SELECT * FROM cash_agents WHERE user_id = $1', [userId]);
    if (!result.rows.length) throw forbidden('This account is not a cash agent');
    if (result.rows[0].status !== 'active') throw forbidden('This cash-agent account is suspended');
    return result.rows[0];
  }

  private mapVoucher(row: Row): VoucherView {
    return {
      id: String(row.id),
      kind: row.kind as VoucherKind,
      status: row.status as VoucherStatus,
      amountCents: Number(row.amount_cents),
      currency: String(row.currency).trim(),
      agentId: String(row.agent_id),
      agentCode: String(row.agent_code ?? ''),
      agentName: String(row.agent_name ?? ''),
      playerId: row.player_id ? String(row.player_id) : null,
      playerUsername: row.player_username ? String(row.player_username) : null,
      reference: row.reference ? String(row.reference) : null,
      sandbox: Boolean(row.sandbox),
      issuedAt: new Date(String(row.issued_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      settledAt: row.settled_at ? new Date(String(row.settled_at)).toISOString() : null,
      codeLast4: String(row.code_last4 ?? ''),
    };
  }

  private readonly voucherSelect = `
    SELECT v.*, a.code AS agent_code, a.name AS agent_name, u.username AS player_username
    FROM cash_vouchers v
    JOIN cash_agents a ON a.id = v.agent_id
    LEFT JOIN users u ON u.id = v.player_id`;

  // ------------------------------------------------------- agent management

  async registerAgent(actorId: string, input: {
    usernameOrEmail: string;
    code: string;
    name: string;
    location?: string;
    voucherLimitCents?: number;
    dailyDepositLimitCents?: number;
    dailyPayoutLimitCents?: number;
    reason: string;
  }): Promise<AgentView> {
    const code = normalizeVoucherCode(input.code);
    if (!/^[A-Z0-9]{3,12}$/.test(code)) throw badRequest('Agent code must be 3–12 letters or digits');
    const voucherLimit = input.voucherLimitCents ?? 100_000;
    const depositLimit = input.dailyDepositLimitCents ?? 500_000;
    const payoutLimit = input.dailyPayoutLimitCents ?? 500_000;
    for (const [label, value] of [['voucher limit', voucherLimit], ['daily deposit limit', depositLimit], ['daily payout limit', payoutLimit]] as const) {
      if (!Number.isSafeInteger(value) || value < MIN_VOUCHER_CENTS) throw badRequest(`The ${label} must be a whole number of cents of at least ${MIN_VOUCHER_CENTS}`);
    }

    const agentId = await this.db.transaction(async (tx) => {
      const user = await tx.query<Row>(
        'SELECT id, role, status FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
        [input.usernameOrEmail],
      );
      if (!user.rows.length) throw notFound('No account matches that username or email');
      const row = user.rows[0];
      if (row.role === 'admin') throw conflict('Administrator accounts cannot be cash agents');
      if (row.status !== 'active') throw conflict('The account is not active');
      const already = await tx.query('SELECT id FROM cash_agents WHERE user_id = $1', [row.id]);
      if (already.rows.length) throw conflict('That account is already a cash agent');

      const id = uuid();
      const floatAccountId = uuid();
      await tx.query(
        `INSERT INTO wallet_accounts (id, owner_type, owner_id, currency, purpose, kind)
         VALUES ($1,'cash_agent',$2,$3,'general','asset')`,
        [floatAccountId, id, LEDGER_BASE_CURRENCY],
      );
      await tx.query(
        `INSERT INTO cash_agents
          (id, user_id, code, name, currency, float_account_id, voucher_limit_cents,
           daily_deposit_limit_cents, daily_payout_limit_cents, location, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, row.id, code, input.name.trim(), LEDGER_BASE_CURRENCY, floatAccountId,
          voucherLimit, depositLimit, payoutLimit, input.location?.trim() || null, actorId],
      );
      await tx.query("UPDATE users SET role = 'agent', updated_at = now() WHERE id = $1", [row.id]);
      await adminAction(tx, {
        actorId, action: 'cash_agent.register', targetType: 'cash_agent', targetId: id,
        reason: input.reason, outcome: `agent ${code} created`,
        metadata: { userId: String(row.id), voucherLimit, depositLimit, payoutLimit },
      });
      return id;
    });
    const agent = await this.agentById(agentId);
    if (!agent) throw notFound('Cash agent could not be read back');
    return agent;
  }

  async setAgentStatus(actorId: string, agentId: string, status: 'active' | 'suspended' | 'closed', reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query<Row>('SELECT id, code, status, user_id FROM cash_agents WHERE id = $1 FOR UPDATE', [agentId]);
      if (!result.rows.length) throw notFound('Cash agent not found');
      const row = result.rows[0];
      if (status === 'closed') {
        const open = await tx.query<Row>(
          "SELECT COUNT(*)::int AS n FROM cash_vouchers WHERE agent_id = $1 AND status = 'issued'",
          [agentId],
        );
        if (Number(open.rows[0]?.n ?? 0) > 0) throw conflict('Cancel or settle the open vouchers before closing this agent');
      }
      await tx.query('UPDATE cash_agents SET status = $2, updated_at = now() WHERE id = $1', [agentId, status]);
      await tx.query(
        "UPDATE users SET role = $2, updated_at = now() WHERE id = $1",
        [String(row.user_id), status === 'closed' ? 'player' : 'agent'],
      );
      await adminAction(tx, {
        actorId, action: 'cash_agent.status', targetType: 'cash_agent', targetId: agentId,
        reason, outcome: `${row.status} → ${status}`, metadata: { code: String(row.code) },
      });
    });
  }

  private async agentById(agentId: string): Promise<AgentView | null> {
    const result = await this.db.query<Row>(`
      SELECT a.*, u.username, w.available_cents,
        COALESCE((SELECT SUM(amount_cents) FROM cash_vouchers
          WHERE agent_id = a.id AND kind = 'deposit' AND status IN ('issued','redeemed')
            AND issued_at >= date_trunc('day', now())), 0) AS today_deposits,
        COALESCE((SELECT SUM(amount_cents) FROM cash_vouchers
          WHERE agent_id = a.id AND kind = 'payout' AND status IN ('issued','paid')
            AND issued_at >= date_trunc('day', now())), 0) AS today_payouts,
        COALESCE((SELECT COUNT(*) FROM cash_vouchers WHERE agent_id = a.id AND status = 'issued'), 0) AS open_vouchers
      FROM cash_agents a
      JOIN users u ON u.id = a.user_id
      JOIN wallet_accounts w ON w.id = a.float_account_id
      WHERE a.id = $1`, [agentId]);
    const row = result.rows[0];
    return row ? this.mapAgent(row) : null;
  }

  private mapAgent(row: Row): AgentView {
    // Custody accounts are negative; cash on hand is the inverse.
    const cashHeldCents = -Number(row.available_cents ?? 0);
    return {
      id: String(row.id),
      userId: String(row.user_id),
      username: String(row.username),
      name: String(row.name),
      code: String(row.code),
      status: row.status as AgentView['status'],
      location: row.location ? String(row.location) : null,
      currency: String(row.currency).trim(),
      cashHeldCents,
      voucherLimitCents: Number(row.voucher_limit_cents),
      dailyDepositLimitCents: Number(row.daily_deposit_limit_cents),
      dailyPayoutLimitCents: Number(row.daily_payout_limit_cents),
      todayDepositCents: Number(row.today_deposits ?? 0),
      todayPayoutCents: Number(row.today_payouts ?? 0),
      openVouchers: Number(row.open_vouchers ?? 0),
    };
  }

  async agents(): Promise<AgentView[]> {
    const result = await this.db.query<Row>(`
      SELECT a.*, u.username, w.available_cents,
        COALESCE((SELECT SUM(amount_cents) FROM cash_vouchers
          WHERE agent_id = a.id AND kind = 'deposit' AND status IN ('issued','redeemed')
            AND issued_at >= date_trunc('day', now())), 0) AS today_deposits,
        COALESCE((SELECT SUM(amount_cents) FROM cash_vouchers
          WHERE agent_id = a.id AND kind = 'payout' AND status IN ('issued','paid')
            AND issued_at >= date_trunc('day', now())), 0) AS today_payouts,
        COALESCE((SELECT COUNT(*) FROM cash_vouchers WHERE agent_id = a.id AND status = 'issued'), 0) AS open_vouchers
      FROM cash_agents a
      JOIN users u ON u.id = a.user_id
      JOIN wallet_accounts w ON w.id = a.float_account_id
      ORDER BY a.code`);
    return result.rows.map((row) => this.mapAgent(row));
  }

  async agentDashboard(agentUserId: string): Promise<{
    agent: AgentView;
    vouchers: VoucherView[];
    mode: 'free' | 'test' | 'real';
    /** The console hides the payout form until real money is authorised. */
    payoutsEnabled: boolean;
  }> {
    const agent = await this.agentForUser(agentUserId);
    const vouchers = await this.vouchersForAgent(String(agent.id), 50);
    const view = await this.agentById(String(agent.id));
    if (!view) throw notFound('Cash agent not found');
    const mode = complianceMode(this.compliance);
    return { agent: view, vouchers, mode, payoutsEnabled: mode === 'real' };
  }

  async vouchersForAgent(agentId: string, limit = 50): Promise<VoucherView[]> {
    const result = await this.db.query<Row>(
      `${this.voucherSelect} WHERE v.agent_id = $1 ORDER BY v.issued_at DESC LIMIT $2`,
      [agentId, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((row) => this.mapVoucher(row));
  }

  async vouchersForPlayer(playerId: string, limit = 50): Promise<VoucherView[]> {
    const result = await this.db.query<Row>(
      `${this.voucherSelect} WHERE v.player_id = $1 ORDER BY v.issued_at DESC LIMIT $2`,
      [playerId, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((row) => this.mapVoucher(row));
  }

  async allVouchers(limit = 100): Promise<VoucherView[]> {
    const result = await this.db.query<Row>(
      `${this.voucherSelect} ORDER BY v.issued_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => this.mapVoucher(row));
  }

  // --------------------------------------------------------------- deposits

  /** Agent takes cash from a player and receives a code to hand over. */
  async issueDeposit(agentUserId: string, input: {
    amountCents: number;
    playerUsername?: string;
    reference?: string;
    expiresMinutes?: number;
  }): Promise<IssuedVoucher> {
    const mode = this.assertEnabled('deposit');
    const agent = await this.agentForUser(agentUserId);
    const amount = input.amountCents;
    if (!Number.isSafeInteger(amount) || amount < MIN_VOUCHER_CENTS) {
      throw badRequest(`A cash-in voucher must be at least ${formatMoney(MIN_VOUCHER_CENTS)}`);
    }
    if (amount > Number(agent.voucher_limit_cents)) {
      throw badRequest(`This agent may issue at most ${formatMoney(Number(agent.voucher_limit_cents))} per voucher`);
    }
    const expiresMinutes = Math.min(Math.max(input.expiresMinutes ?? DEFAULT_DEPOSIT_EXPIRY_MINUTES, 5), MAX_DEPOSIT_EXPIRY_MINUTES);

    let playerId: string | null = null;
    if (input.playerUsername?.trim()) {
      const player = await this.db.query<Row>(
        'SELECT id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
        [input.playerUsername.trim()],
      );
      if (!player.rows.length) throw notFound('No player matches that username or email');
      playerId = String(player.rows[0].id);
    }

    return this.db.transaction(async (tx) => {
      const today = await tx.query<Row>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_vouchers
         WHERE agent_id = $1 AND kind = 'deposit' AND status IN ('issued','redeemed')
           AND issued_at >= date_trunc('day', now())`,
        [agent.id],
      );
      if (Number(today.rows[0]?.total ?? 0) + amount > Number(agent.daily_deposit_limit_cents)) {
        throw forbidden(`This agent's daily cash-in limit of ${formatMoney(Number(agent.daily_deposit_limit_cents))} would be exceeded`);
      }

      const { code } = await this.insertVoucher(tx, {
        kind: 'deposit', amountCents: amount, agentId: String(agent.id), playerId,
        expiresAt: new Date(Date.now() + expiresMinutes * 60_000),
        sandbox: mode === 'test', issuedBy: agentUserId,
        reference: input.reference?.trim() || null, withdrawalId: null,
      });
      const row = await tx.query<Row>(`${this.voucherSelect} WHERE v.code_hash = $1`, [voucherHash(code)]);
      await audit(tx, 'cash.voucher_issued', 'cash_voucher', String(row.rows[0].id), {
        agentId: String(agent.id), amountCents: amount, playerId, sandbox: mode === 'test',
      }, { type: 'user', id: agentUserId });
      return { voucher: this.mapVoucher(row.rows[0]), code };
    });
  }

  private async insertVoucher(tx: Queryable, input: {
    kind: VoucherKind;
    amountCents: number;
    agentId: string;
    playerId: string | null;
    expiresAt: Date;
    sandbox: boolean;
    issuedBy: string;
    reference: string | null;
    withdrawalId: string | null;
  }): Promise<{ id: string; code: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateVoucherCode();
      const id = uuid();
      const inserted = await tx.query<Row>(
        `INSERT INTO cash_vouchers
          (id, code_hash, code_last4, kind, amount_cents, currency, agent_id, player_id,
           reference, sandbox, issued_by, expires_at, withdrawal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (code_hash) DO NOTHING RETURNING id`,
        [id, voucherHash(code), normalizeVoucherCode(code).slice(-4), input.kind, input.amountCents,
          LEDGER_BASE_CURRENCY, input.agentId, input.playerId, input.reference, input.sandbox,
          input.issuedBy, input.expiresAt.toISOString(), input.withdrawalId],
      );
      if (inserted.rows.length) return { id, code };
    }
    throw conflict('Could not allocate a unique voucher code; try again');
  }

  /** Player redeems a cash-in voucher. Credits only after the code checks out. */
  async redeemDeposit(playerUserId: string, input: { code: string; reference?: string }): Promise<VoucherView> {
    const mode = this.assertEnabled('deposit');
    if (!isWellFormedCode(input.code)) throw badRequest('Enter the voucher code printed on your receipt');

    return this.db.transaction(async (tx) => {
      const found = await tx.query<Row>(
        `${this.voucherSelect} WHERE v.code_hash = $1 FOR UPDATE OF v`,
        [voucherHash(input.code)],
      );
      if (!found.rows.length) throw notFound('That voucher code does not exist');
      const row = found.rows[0];
      if (row.kind !== 'deposit') throw badRequest('That is a cash-out code and must be paid at an agent');
      if (row.status !== 'issued') throw conflict(`This voucher is already ${row.status}`);
      if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
        await tx.query("UPDATE cash_vouchers SET status = 'expired' WHERE id = $1", [row.id]);
        throw badRequest('This voucher has expired; ask the agent for a new one');
      }
      if (Boolean(row.sandbox) !== (mode === 'test')) {
        throw conflict('This voucher was issued in a different operating mode and cannot be redeemed here');
      }
      if (row.player_id && String(row.player_id) !== playerUserId) {
        throw forbidden('This voucher was issued to a different account');
      }
      const player = await tx.query<Row>('SELECT id, status, email_verified FROM users WHERE id = $1', [playerUserId]);
      if (!player.rows.length) throw notFound('Account not found');
      if (player.rows[0].status !== 'active') throw forbidden('This account cannot receive credits');
      if (!player.rows[0].email_verified) throw forbidden('Verify your email address before redeeming a cash voucher');

      const amount = Number(row.amount_cents);
      const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).trim().toUpperCase();
      const today = await tx.query<Row>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_vouchers
         WHERE player_id = $1 AND kind = 'deposit' AND status = 'redeemed'
           AND settled_at >= date_trunc('day', now())`,
        [playerUserId],
      );
      if (Number(today.rows[0]?.total ?? 0) + amount > PLAYER_DAILY_REDEEM_CENTS) {
        throw forbidden(`A player may redeem at most ${formatMoney(PLAYER_DAILY_REDEEM_CENTS)} in cash vouchers per day`);
      }

      const accounts = await this.ledger.ensureUserAccounts(tx, playerUserId, currency);
      const floatId = await this.floatAccount(tx, String(row.agent_id), currency);
      const sandbox = Boolean(row.sandbox);
      const journal = await this.ledger.postTransaction({
        type: sandbox ? 'test_voucher_credit' : 'voucher_credit',
        currency,
        reference: `VCH-${row.id}`,
        idempotencyKey: `voucher-redeem:${row.id}`,
        description: sandbox
          ? 'INTERNAL TEST CASH VOUCHER (no cash value)'
          : `Cash received by agent ${row.agent_code}`,
        entries: [
          { accountId: floatId, amountCents: -amount },
          { accountId: accounts.availableId, amountCents: amount },
        ],
        createdBy: playerUserId,
        metadata: {
          voucherId: String(row.id), agentId: String(row.agent_id), agentCode: String(row.agent_code),
          sandbox, testCredit: sandbox,
        },
      }, tx);
      await tx.query(
        `UPDATE cash_vouchers
           SET status = 'redeemed', player_id = $2, settled_at = now(), settled_by = $2,
               reference = COALESCE($3, reference), ledger_transaction_id = $4
         WHERE id = $1`,
        [row.id, playerUserId, input.reference?.trim() || null, journal.id],
      );
      await notify(tx, playerUserId, {
        type: 'deposit_confirmed',
        title: sandbox ? 'Test cash voucher redeemed' : 'Cash voucher redeemed',
        body: sandbox
          ? `${formatMoney(amount, currency)} test credit added (no cash value).`
          : `${formatMoney(amount, currency)} paid in cash to agent ${row.agent_code} is now available.`,
        link: '/wallet',
      });
      await audit(tx, 'cash.voucher_redeemed', 'cash_voucher', String(row.id), {
        amount, agentId: String(row.agent_id), sandbox, transactionId: journal.id,
      }, { type: 'user', id: playerUserId });

      const updated = await tx.query<Row>(`${this.voucherSelect} WHERE v.id = $1`, [row.id]);
      return this.mapVoucher(updated.rows[0]);
    });
  }

  // --------------------------------------------------------------- payouts

  /** Player requests cash and receives a code an agent can pay out. */
  async requestPayout(playerUserId: string, input: { amountCents: number; agentCode: string }): Promise<IssuedVoucher> {
    this.assertEnabled('payout');
    const agentCode = normalizeVoucherCode(input.agentCode);
    const agent = await this.db.query<Row>(
      "SELECT id, code FROM cash_agents WHERE code = $1 AND status = 'active'",
      [agentCode],
    );
    if (!agent.rows.length) throw notFound('No active cash agent has that code');
    const amount = input.amountCents;
    if (!Number.isSafeInteger(amount) || amount < MIN_PAYOUT_CENTS) {
      throw badRequest(`The smallest cash payout is ${formatMoney(MIN_PAYOUT_CENTS)}`);
    }
    if (amount > Number((await this.db.query<Row>('SELECT voucher_limit_cents FROM cash_agents WHERE id = $1', [agent.rows[0].id])).rows[0].voucher_limit_cents)) {
      throw badRequest('This payout exceeds the agent voucher limit; choose a smaller amount or another agent');
    }

    return this.db.transaction(async (tx) => {
      const player = await tx.query<Row>('SELECT id, status, email_verified, age_verified, identity_verified FROM users WHERE id = $1', [playerUserId]);
      if (!player.rows.length) throw notFound('Account not found');
      const p = player.rows[0];
      if (p.status !== 'active') throw forbidden('This account cannot request a payout');
      if (!p.email_verified) throw forbidden('Verify your email address before requesting a cash payout');
      if (!p.age_verified || !p.identity_verified) {
        throw forbidden('Complete age and identity verification before requesting a cash payout');
      }

      const currency = LEDGER_BASE_CURRENCY;
      const accounts = await this.ledger.ensureUserAccounts(tx, playerUserId, currency);
      const withdrawalId = uuid();
      const today = await tx.query<Row>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_vouchers
         WHERE agent_id = $1 AND kind = 'payout' AND status IN ('issued','paid')
           AND issued_at >= date_trunc('day', now())`,
        [agent.rows[0].id],
      );
      const limit = await tx.query<Row>('SELECT daily_payout_limit_cents FROM cash_agents WHERE id = $1', [agent.rows[0].id]);
      if (Number(today.rows[0]?.total ?? 0) + amount > Number(limit.rows[0].daily_payout_limit_cents)) {
        throw forbidden("This agent's daily cash-out limit would be exceeded; try another agent or tomorrow");
      }

      await tx.query(
        `INSERT INTO withdrawals (id, user_id, provider, amount_cents, currency, status, sandbox, destination, metadata)
         VALUES ($1,$2,'cash_agent',$3,$4,'processing',FALSE,$5,$6::jsonb)`,
        [withdrawalId, playerUserId, amount, currency, `agent:${agentCode}`,
          JSON.stringify({ agentCode, method: 'cash_voucher' })],
      );
      await this.ledger.postTransaction({
        type: 'withdrawal_hold',
        currency,
        reference: `WHD-${withdrawalId}`,
        idempotencyKey: `withdrawal-hold:${withdrawalId}`,
        description: `Hold for cash payout ${withdrawalId}`,
        entries: [
          { accountId: accounts.availableId, amountCents: -amount },
          { accountId: accounts.reservedId, amountCents: amount },
        ],
        createdBy: playerUserId,
        metadata: { withdrawalId, agentCode },
      }, tx);

      const { code } = await this.insertVoucher(tx, {
        kind: 'payout', amountCents: amount, agentId: String(agent.rows[0].id), playerId: playerUserId,
        expiresAt: new Date(Date.now() + PAYOUT_EXPIRY_HOURS * 3_600_000),
        sandbox: false, issuedBy: playerUserId, reference: null, withdrawalId,
      });
      await audit(tx, 'cash.payout_requested', 'withdrawal', withdrawalId, {
        amount, agentCode,
      }, { type: 'user', id: playerUserId });
      const row = await tx.query<Row>(`${this.voucherSelect} WHERE v.code_hash = $1`, [voucherHash(code)]);
      return { voucher: this.mapVoucher(row.rows[0]), code };
    });
  }

  /** Agent pays cash against a payout code, after checking the player's ID. */
  async settlePayout(agentUserId: string, input: { code: string; reference?: string }): Promise<VoucherView> {
    this.assertEnabled('payout');
    const agent = await this.agentForUser(agentUserId);
    if (!isWellFormedCode(input.code)) throw badRequest('Enter the cash-out code the player presented');

    return this.db.transaction(async (tx) => {
      const found = await tx.query<Row>(
        `${this.voucherSelect} WHERE v.code_hash = $1 FOR UPDATE OF v`,
        [voucherHash(input.code)],
      );
      if (!found.rows.length) throw notFound('That code does not exist');
      const row = found.rows[0];
      if (row.kind !== 'payout') throw badRequest('That is a cash-in voucher; the player must redeem it themselves');
      if (String(row.agent_id) !== String(agent.id)) throw forbidden('This cash-out code belongs to a different agent');
      if (row.status !== 'issued') throw conflict(`This voucher is already ${row.status}`);
      if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
        await this.releaseExpired(tx, row);
        throw badRequest('This cash-out code has expired and the funds were returned to the player');
      }
      const amount = Number(row.amount_cents);
      const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).trim().toUpperCase();
      const floatId = await this.floatAccount(tx, String(agent.id), currency);
      const float = await tx.query<Row>('SELECT available_cents FROM wallet_accounts WHERE id = $1 FOR UPDATE', [floatId]);
      const cashHeld = -Number(float.rows[0]?.available_cents ?? 0);
      if (cashHeld < amount) {
        throw conflict(`Agent float is too low: ${formatMoney(cashHeld, currency)} on hand, ${formatMoney(amount, currency)} required. Remit or receive more cash first.`);
      }
      const withdrawal = await tx.query<Row>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [row.withdrawal_id]);
      if (!withdrawal.rows.length) throw notFound('The withdrawal behind this code is missing');
      const accounts = await this.ledger.ensureUserAccounts(tx, String(withdrawal.rows[0].user_id), currency);
      const journal = await this.ledger.postTransaction({
        type: 'withdrawal_cash_paid',
        currency,
        reference: `WCP-${row.withdrawal_id}`,
        idempotencyKey: `withdrawal-cash-paid:${row.withdrawal_id}`,
        description: `Cash paid out by agent ${row.agent_code}`,
        entries: [
          { accountId: accounts.reservedId, amountCents: -amount },
          { accountId: floatId, amountCents: amount },
        ],
        createdBy: agentUserId,
        metadata: { voucherId: String(row.id), agentId: String(agent.id), agentCode: String(row.agent_code) },
      }, tx);
      await tx.query(
        `UPDATE withdrawals SET status = 'completed', completed_at = now(), provider_reference = $2,
           ledger_transaction_id = $3 WHERE id = $1`,
        [row.withdrawal_id, String(row.code_last4), journal.id],
      );
      await tx.query(
        `UPDATE cash_vouchers SET status = 'paid', settled_at = now(), settled_by = $2,
           reference = COALESCE($3, reference), ledger_transaction_id = $4 WHERE id = $1`,
        [row.id, agentUserId, input.reference?.trim() || null, journal.id],
      );
      await notify(tx, String(withdrawal.rows[0].user_id), {
        type: 'withdrawal_completed', title: 'Cash payout completed',
        body: `${formatMoney(amount, currency)} was paid out by agent ${row.agent_code}.`,
        link: '/wallet',
      });
      await audit(tx, 'cash.payout_settled', 'cash_voucher', String(row.id), {
        amount, agentId: String(agent.id), withdrawalId: String(row.withdrawal_id),
      }, { type: 'user', id: agentUserId });
      const updated = await tx.query<Row>(`${this.voucherSelect} WHERE v.id = $1`, [row.id]);
      return this.mapVoucher(updated.rows[0]);
    });
  }

  private async releaseExpired(tx: Queryable, row: Row): Promise<void> {
    const amount = Number(row.amount_cents);
    const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).trim().toUpperCase();
    if (row.kind === 'payout' && row.withdrawal_id) {
      const withdrawal = await tx.query<Row>('SELECT user_id, status FROM withdrawals WHERE id = $1 FOR UPDATE', [row.withdrawal_id]);
      if (withdrawal.rows.length && !['completed', 'failed', 'cancelled'].includes(String(withdrawal.rows[0].status))) {
        const accounts = await this.ledger.ensureUserAccounts(tx, String(withdrawal.rows[0].user_id), currency);
        await this.ledger.postTransaction({
          type: 'withdrawal_release',
          currency,
          reference: `WRL-${row.withdrawal_id}`,
          idempotencyKey: `withdrawal-release:${row.withdrawal_id}`,
          description: 'Release hold for an expired cash-out code',
          entries: [
            { accountId: accounts.reservedId, amountCents: -amount },
            { accountId: accounts.availableId, amountCents: amount },
          ],
          metadata: { voucherId: String(row.id), reason: 'voucher_expired' },
        }, tx);
        await tx.query("UPDATE withdrawals SET status = 'cancelled' WHERE id = $1", [row.withdrawal_id]);
        await notify(tx, String(withdrawal.rows[0].user_id), {
          type: 'withdrawal_failed', title: 'Cash-out code expired',
          body: `${formatMoney(amount, currency)} was returned to your available balance because the code expired.`,
          link: '/wallet',
        });
      }
    }
    await tx.query("UPDATE cash_vouchers SET status = 'expired' WHERE id = $1 AND status = 'issued'", [row.id]);
    await audit(tx, 'cash.voucher_expired', 'cash_voucher', String(row.id), { amount }, { type: 'system', id: null });
  }

  async cancelVoucher(actorId: string, actorRole: 'agent' | 'admin', voucherId: string, reason: string): Promise<VoucherView> {
    // Resolve the agent before opening the transaction: a PGlite database has a
    // single connection, so an outside query inside an open transaction blocks
    // until the transaction ends.
    const agent = actorRole === 'agent' ? await this.agentForUser(actorId) : null;
    return this.db.transaction(async (tx) => {
      const found = await tx.query<Row>(`${this.voucherSelect} WHERE v.id = $1 FOR UPDATE OF v`, [voucherId]);
      if (!found.rows.length) throw notFound('Voucher not found');
      const row = found.rows[0];
      if (row.status !== 'issued') throw conflict(`This voucher is already ${row.status}`);
      if (agent && String(row.agent_id) !== String(agent.id)) {
        throw forbidden('This voucher belongs to a different agent');
      }
      if (row.kind === 'payout' && row.withdrawal_id) {
        const withdrawal = await tx.query<Row>('SELECT user_id, status FROM withdrawals WHERE id = $1 FOR UPDATE', [row.withdrawal_id]);
        if (withdrawal.rows.length && !['completed', 'failed', 'cancelled'].includes(String(withdrawal.rows[0].status))) {
          const amount = Number(row.amount_cents);
          const currency = String(row.currency ?? LEDGER_BASE_CURRENCY).trim().toUpperCase();
          const accounts = await this.ledger.ensureUserAccounts(tx, String(withdrawal.rows[0].user_id), currency);
          await this.ledger.postTransaction({
            type: 'withdrawal_release',
            currency,
            reference: `WRL-${row.withdrawal_id}`,
            idempotencyKey: `withdrawal-release:${row.withdrawal_id}`,
            description: `Cash-out cancelled: ${reason.slice(0, 80)}`,
            entries: [
              { accountId: accounts.reservedId, amountCents: -amount },
              { accountId: accounts.availableId, amountCents: amount },
            ],
            metadata: { voucherId, reason },
          }, tx);
          await tx.query("UPDATE withdrawals SET status = 'cancelled' WHERE id = $1", [row.withdrawal_id]);
        }
      }
      await tx.query(
        "UPDATE cash_vouchers SET status = 'cancelled', settled_at = now(), settled_by = $2, reference = COALESCE(reference, $3) WHERE id = $1",
        [voucherId, actorId, `cancelled: ${reason.slice(0, 80)}`],
      );
      await audit(tx, 'cash.voucher_cancelled', 'cash_voucher', voucherId, { reason }, { type: actorRole === 'admin' ? 'admin' : 'user', id: actorId });
      const updated = await tx.query<Row>(`${this.voucherSelect} WHERE v.id = $1`, [voucherId]);
      return this.mapVoucher(updated.rows[0]);
    });
  }

  /** Admin records cash physically handed in by an agent (remittance). */
  async remit(actorId: string, agentId: string, input: { amountCents: number; reference: string; reason: string }): Promise<{ cashHeldCents: number }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('Remittance must be a positive amount');
    return this.db.transaction(async (tx) => {
      const agent = await tx.query<Row>('SELECT id, code, currency, float_account_id FROM cash_agents WHERE id = $1 FOR UPDATE', [agentId]);
      if (!agent.rows.length) throw notFound('Cash agent not found');
      const currency = String(agent.rows[0].currency ?? LEDGER_BASE_CURRENCY).trim().toUpperCase();
      const floatId = String(agent.rows[0].float_account_id);
      const float = await tx.query<Row>('SELECT available_cents FROM wallet_accounts WHERE id = $1 FOR UPDATE', [floatId]);
      const cashHeld = -Number(float.rows[0]?.available_cents ?? 0);
      if (input.amountCents > cashHeld) {
        throw conflict(`The agent is holding ${formatMoney(cashHeld, currency)}; a larger remittance cannot be recorded`);
      }
      const bankId = await this.ledger.systemAccountId(tx, currency, 'platformBank');
      await this.ledger.postTransaction({
        type: 'cash_agent_remittance',
        currency,
        reference: `CAR-${uuid()}`,
        idempotencyKey: `cash-agent-remit:${uuid()}`,
        description: `Cash handed in by agent ${agent.rows[0].code}`,
        entries: [
          { accountId: floatId, amountCents: input.amountCents },
          { accountId: bankId, amountCents: -input.amountCents },
        ],
        createdBy: actorId,
        metadata: { agentId, agentCode: String(agent.rows[0].code), reference: input.reference },
      }, tx);
      await adminAction(tx, {
        actorId, action: 'cash_agent.remit', targetType: 'cash_agent', targetId: agentId,
        reason: input.reason, outcome: `${formatMoney(input.amountCents, currency)} remitted`,
        metadata: { reference: input.reference, cashHeldBefore: cashHeld },
      });
      return { cashHeldCents: cashHeld - input.amountCents };
    });
  }

  /** Expire stale codes and release any holds behind them. */
  async expireStale(limit = 50): Promise<{ expired: number }> {
    const stale = await this.db.query<Row>(
      `SELECT * FROM cash_vouchers WHERE status = 'issued' AND expires_at <= now() ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let expired = 0;
    for (const row of stale.rows) {
      try {
        await this.db.transaction((tx) => this.releaseExpired(tx, row));
        expired += 1;
      } catch (error) {
        this.log.warn({ voucherId: String(row.id), err: (error as Error).message }, 'cash voucher expiry failed');
      }
    }
    return { expired };
  }
}
