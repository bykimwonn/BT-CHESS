import type { ComplianceState } from '../config/compliance.js';
import type { Database, Queryable, Row } from '../db/client.js';
import type { AppLogger } from '../services/logger.js';
import { adminAction, audit } from '../services/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../services/errors.js';
import { uuid } from '../services/ids.js';
import type { ConfigService } from '../services/config-service.js';
import type { AuthService } from '../auth/service.js';
import type { GameService } from '../games/service.js';
import type { LedgerService } from '../finance/ledger.js';
import { SYSTEM_ACCOUNTS } from '../finance/ledger.js';
import type { SettlementService, SettlementGameRow } from '../finance/settlement.js';
import type { PaymentService } from '../payments/service.js';
import type { EngineService } from '../engine/service.js';
import type { AnalysisService } from '../engine/analysis.js';
import type { CompetitionTerms, GameResult } from '../../shared/contracts.js';

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(name.length - 1, 5)))}@${domain}`;
}

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly compliance: ComplianceState,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly games: GameService,
    private readonly ledger: LedgerService,
    private readonly settlement: SettlementService,
    private readonly payments: PaymentService,
    private readonly engine: EngineService,
    private readonly analysis: AnalysisService,
    private readonly log: AppLogger,
  ) {}

  private async count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.db.query<Row>(sql, params);
    return Number(result.rows[0]?.n ?? 0);
  }

  async overview(): Promise<Record<string, unknown>> {
    const [
      users, activeGames, finishedGames, openDisputes, pendingSettlements,
      postedSettlements, pendingDeposits, pendingWithdrawals, openChallenges,
    ] = await Promise.all([
      this.count('SELECT COUNT(*)::int AS n FROM users'),
      this.count("SELECT COUNT(*)::int AS n FROM games WHERE status = 'active'"),
      this.count("SELECT COUNT(*)::int AS n FROM games WHERE status = 'finished'"),
      this.count("SELECT COUNT(*)::int AS n FROM disputes WHERE status IN ('open','under_review')"),
      this.count("SELECT COUNT(*)::int AS n FROM settlements WHERE status IN ('pending','blocked')"),
      this.count("SELECT COUNT(*)::int AS n FROM settlements WHERE status = 'posted'"),
      this.count("SELECT COUNT(*)::int AS n FROM deposits WHERE status = 'pending'"),
      this.count("SELECT COUNT(*)::int AS n FROM withdrawals WHERE status IN ('pending','processing')"),
      this.count("SELECT COUNT(*)::int AS n FROM challenges WHERE status = 'open'"),
    ]);
    return {
      users, activeGames, finishedGames, openDisputes, pendingSettlements,
      postedSettlements, pendingDeposits, pendingWithdrawals, openChallenges,
      reconciliation: await this.ledger.reconcile(),
      compliance: this.compliance,
      providerHealth: this.payments.health(),
    };
  }

  async users(options: { search?: string; status?: string; limit?: number; offset?: number } = {}): Promise<Row[]> {
    const params: unknown[] = [];
    const clauses: string[] = ['1=1'];
    if (options.search) { params.push(`%${options.search.toLowerCase()}%`); clauses.push(`(lower(u.username) LIKE $${params.length} OR lower(u.email) LIKE $${params.length})`); }
    if (options.status) { params.push(options.status); clauses.push(`u.status = $${params.length}`); }
    params.push(Math.min(options.limit ?? 50, 200), Math.max(options.offset ?? 0, 0));
    const result = await this.db.query<Row>(`
      SELECT u.id, u.username, u.email, u.role, u.status, u.email_verified, u.age_verified,
             u.country, u.created_at, u.last_login_at, p.rating, p.games_played, p.wins, p.losses, p.draws
      FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE ${clauses.join(' AND ')} ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return result.rows.map((row) => ({ ...row, email: maskEmail(String(row.email)) }));
  }

  async setUserStatus(actorId: string, userId: string, status: 'active' | 'suspended' | 'self_excluded', reason: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw badRequest('High-impact account actions require explicit confirmation');
    if (reason.trim().length < 8) throw badRequest('A documented reason of at least 8 characters is required');
    if (actorId === userId) throw forbidden('You cannot change your own account status');
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING id', [userId, status],
      );
      if (!result.rows.length) throw notFound('User not found');
      if (status !== 'active') await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await adminAction(tx, {
        actorId, action: 'user.status', targetType: 'user', targetId: userId,
        reason, outcome: status,
      });
    });
  }

  async gameList(options: { status?: string; limit?: number; offset?: number } = {}): Promise<Row[]> {
    const params: unknown[] = [];
    let where = '1=1';
    if (options.status) { params.push(options.status); where += ` AND g.status = $${params.length}`; }
    params.push(Math.min(options.limit ?? 50, 200), Math.max(options.offset ?? 0, 0));
    const result = await this.db.query<Row>(`
      SELECT g.id, g.status, g.result, g.termination, g.mode, g.started_at, g.ended_at, g.time_control,
             wu.username AS white, bu.username AS black,
             s.status AS settlement_status, s.fee_cents, s.payout_cents
      FROM games g JOIN users wu ON wu.id = g.white_id JOIN users bu ON bu.id = g.black_id
      LEFT JOIN settlements s ON s.game_id = g.id
      WHERE ${where} ORDER BY g.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return result.rows;
  }

  async inspectGame(gameId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.games.getSnapshot(gameId);
    const [settlement, disputes, signals] = await Promise.all([
      this.settlement.getForGame(gameId),
      this.db.query<Row>('SELECT * FROM disputes WHERE game_id = $1 ORDER BY created_at DESC', [gameId]),
      this.db.query<Row>('SELECT * FROM fair_play_signals WHERE game_id = $1 ORDER BY created_at DESC', [gameId]),
    ]);
    return { snapshot, settlement, disputes: disputes.rows, signals: signals.rows };
  }

  async disputes(): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT d.*, u.username AS opened_by_username, g.result, g.termination, s.status AS settlement_status
      FROM disputes d JOIN users u ON u.id = d.opened_by
      JOIN games g ON g.id = d.game_id
      LEFT JOIN settlements s ON s.game_id = d.game_id
      ORDER BY CASE d.status WHEN 'open' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END, d.created_at DESC LIMIT 200`);
    return result.rows;
  }

  /**
   * Resolve a dispute without accepting a client-supplied game result.
   * Decisions: reject (settle authoritative result), void (documented refund
   * or audited correction), review (keep blocked for another reviewer).
   */
  async resolveDispute(actorId: string, disputeId: string, decision: 'reject' | 'void' | 'review', notes: string, confirmed: boolean): Promise<{ outcome: string }> {
    if (!confirmed) throw badRequest('High-impact dispute actions require explicit confirmation');
    if (notes.trim().length < 8) throw badRequest('Resolution notes must be at least 8 characters');
    return this.db.transaction(async (tx) => {
      const disputeResult = await tx.query<Row>('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
      const dispute = disputeResult.rows[0];
      if (!dispute) throw notFound('Dispute not found');
      if (!['open', 'under_review'].includes(String(dispute.status))) throw conflict('Dispute is already resolved');
      const gameId = String(dispute.game_id);
      const gameResult = await tx.query<Row>('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
      const game = gameResult.rows[0];
      if (!game) throw notFound('Game not found');
      const settlementResult = await tx.query<Row>('SELECT * FROM settlements WHERE game_id = $1 FOR UPDATE', [gameId]);
      const settlement = settlementResult.rows[0] ?? null;
      let outcome = 'kept under review';

      if (decision === 'review') {
        await tx.query("UPDATE disputes SET status = 'under_review' WHERE id = $1", [disputeId]);
      } else if (decision === 'void') {
        if (settlement?.status === 'posted' && String(settlement.result) !== 'void') {
          await this.correctPostedSettlement(tx, game, settlement, actorId, notes);
          outcome = 'voided with audited compensating correction';
        } else {
          await tx.query(
            `UPDATE games SET status = 'finished', result = 'void', termination = 'void',
               ended_at = COALESCE(ended_at, now()), version = version + 1 WHERE id = $1`, [gameId],
          );
          await tx.query("UPDATE disputes SET status = 'resolved' WHERE id = $1", [disputeId]);
          if (game.terms) {
            await this.settlement.settleInTransaction(tx, {
              id: gameId, white_id: String(game.white_id), black_id: String(game.black_id),
              mode: String(game.mode), terms: game.terms as CompetitionTerms,
            } as SettlementGameRow, 'void', 'void', { actorId, reason: `Dispute ${disputeId}: ${notes}`, retryBlocked: true });
          }
          outcome = 'voided and both stakes refunded';
        }
      } else {
        await tx.query("UPDATE disputes SET status = 'resolved' WHERE id = $1", [disputeId]);
        await tx.query(
          `UPDATE games SET status = 'finished', ended_at = COALESCE(ended_at, now()), version = version + 1 WHERE id = $1`,
          [gameId],
        );
        if (game.terms && game.result) {
          await this.settlement.settleInTransaction(tx, {
            id: gameId, white_id: String(game.white_id), black_id: String(game.black_id),
            mode: String(game.mode), terms: game.terms as CompetitionTerms,
          } as SettlementGameRow, game.result as GameResult, String(game.termination ?? 'unknown'),
          { actorId, reason: `Dispute ${disputeId} rejected: ${notes}`, retryBlocked: true });
        }
        outcome = 'dispute rejected; authoritative result settled';
      }
      await tx.query(
        `UPDATE disputes SET resolution = $2, resolved_by = $3, resolved_at = now(),
          status = CASE WHEN status = 'under_review' AND $4 = 'review' THEN 'under_review' ELSE 'resolved' END
         WHERE id = $1`,
        [disputeId, notes, actorId, decision],
      );
      await adminAction(tx, {
        actorId, action: 'dispute.resolve', targetType: 'dispute', targetId: disputeId,
        reason: notes, outcome: decision, metadata: { gameId, outcome },
      });
      return { outcome };
    });
  }

  private async correctPostedSettlement(tx: Queryable, game: Row, settlement: Row, actorId: string, reason: string): Promise<void> {
    const terms = game.terms as CompetitionTerms | null;
    if (!terms) throw conflict('Cannot correct a settlement without locked terms');
    const white = await this.ledger.ensureUserAccounts(tx, String(game.white_id));
    const black = await this.ledger.ensureUserAccounts(tx, String(game.black_id));
    const winnerId = settlement.winner_id ? String(settlement.winner_id) : null;
    const winnerAccount = winnerId === String(game.white_id) ? white.availableId
      : winnerId === String(game.black_id) ? black.availableId : null;
    const payout = Number(settlement.payout_cents);
    const fee = Number(settlement.fee_cents);
    const stake = terms.stakeCents;
    const entries = [
      // Reverse the original posted distribution with compensating entries.
      ...(winnerAccount && payout > 0 ? [{ accountId: winnerAccount, amountCents: -payout }] : []),
      ...(fee > 0 ? [{ accountId: SYSTEM_ACCOUNTS.platformFee, amountCents: -fee }] : []),
      { accountId: white.reservedId, amountCents: stake },
      { accountId: black.reservedId, amountCents: stake },
      // Refund both reservations without commission.
      { accountId: white.reservedId, amountCents: -stake },
      { accountId: white.availableId, amountCents: stake },
      { accountId: black.reservedId, amountCents: -stake },
      { accountId: black.availableId, amountCents: stake },
    ];
    const journal = await this.ledger.postTransaction({
      type: 'settlement_correction', reference: `COR-${String(settlement.id)}`,
      idempotencyKey: `settlement-correction:${String(settlement.id)}`,
      description: `Audited dispute correction for game ${String(game.id)}`,
      entries, gameId: String(game.id), createdBy: actorId,
      metadata: { settlementId: settlement.id, reason, fromResult: settlement.result, toResult: 'void' },
    }, tx);
    await tx.query(
      `INSERT INTO settlement_corrections
        (id, settlement_id, game_id, actor_id, reason, ledger_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), settlement.id, game.id, actorId, reason, journal.id],
    );
    await tx.query("UPDATE settlements SET status = 'reversed', reason = $2 WHERE id = $1", [settlement.id, reason]);
    await tx.query(
      `UPDATE games SET status = 'finished', result = 'void', termination = 'void',
         ended_at = COALESCE(ended_at, now()), version = version + 1 WHERE id = $1`, [game.id],
    );
    await audit(tx, 'settlement.corrected', 'game', String(game.id), {
      settlementId: settlement.id, reason, journalId: journal.id,
    }, { type: 'admin', id: actorId });
  }

  async fairPlayReview(gameId: string, actorId: string) {
    return this.analysis.runFairPlayReview(gameId, actorId);
  }

  async reviews(): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT mr.*, g.result, g.termination, u.username AS reviewer
      FROM match_reviews mr JOIN games g ON g.id = mr.game_id
      LEFT JOIN users u ON u.id = mr.reviewer_id
      ORDER BY mr.created_at DESC LIMIT 200`);
    return result.rows;
  }

  async closeReview(actorId: string, reviewId: string, decision: string, notes: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw badRequest('High-impact review actions require explicit confirmation');
    if (notes.trim().length < 8) throw badRequest('Review notes must be at least 8 characters');
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE match_reviews SET status = 'closed', decision = $2, notes = $3,
           reviewer_id = $4, resolved_at = now() WHERE id = $1 RETURNING id`,
        [reviewId, decision, notes, actorId],
      );
      if (!result.rows.length) throw notFound('Review not found');
      await adminAction(tx, {
        actorId, action: 'fair_play.close_review', targetType: 'match_review', targetId: reviewId,
        reason: notes, outcome: decision,
      });
    });
  }

  async ledgerJournal(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT lt.id, lt.type, lt.reference, lt.status, lt.created_at, lt.description,
             le.line_no, le.amount_cents, wa.owner_type, wa.owner_id, wa.purpose
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le.transaction_id = lt.id
      JOIN wallet_accounts wa ON wa.id = le.wallet_account_id
      ORDER BY lt.created_at DESC, le.line_no ASC LIMIT $1`, [Math.min(limit, 500)]);
    return result.rows;
  }

  async reconciliation(): Promise<ReturnType<LedgerService['reconcile']>> { return this.ledger.reconcile(); }

  async commissionReport(): Promise<Row> {
    const result = await this.db.query<Row>(`
      SELECT
        (SELECT available_cents FROM wallet_accounts WHERE id = $1) AS fee_account_cents,
        (SELECT COALESCE(SUM(fee_cents), 0) FROM settlements WHERE status = 'posted') AS posted_fee_cents,
        (SELECT COALESCE(SUM(pot_cents), 0) FROM settlements WHERE status = 'posted') AS total_pot_cents,
        (SELECT COUNT(*)::int FROM settlements WHERE status = 'posted') AS settled_competitions,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE wallet_account_id = $1) AS ledger_fee_cents`,
      [SYSTEM_ACCOUNTS.platformFee]);
    return result.rows[0];
  }

  async deposits(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id
      ORDER BY d.initiated_at DESC LIMIT $1`, [Math.min(limit, 500)]);
    return result.rows;
  }

  async withdrawals(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id
      ORDER BY w.requested_at DESC LIMIT $1`, [Math.min(limit, 500)]);
    return result.rows;
  }

  async settlements(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT s.*, g.termination, g.mode FROM settlements s JOIN games g ON g.id = s.game_id
      ORDER BY s.created_at DESC LIMIT $1`, [Math.min(limit, 500)]);
    return result.rows;
  }

  async reconcileSettlements(): Promise<Awaited<ReturnType<SettlementService['settlePending']>>> {
    return this.settlement.settlePending();
  }

  async securityEvents(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT s.*, u.username FROM security_events s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT $1`, [Math.min(limit, 500)]);
    return result.rows;
  }

  async auditLogs(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 500)]);
    return result.rows;
  }

  async adminActions(limit = 100): Promise<Row[]> {
    const result = await this.db.query<Row>('SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 500)]);
    return result.rows;
  }

  async providerEvents(): Promise<Row[]> { return this.payments.providerEvents(); }

  async configItems(): Promise<Row[]> { return this.config.all(); }

  async setCommission(actorId: string, bps: number, reason: string, confirmed: boolean): Promise<number> {
    if (!confirmed) throw badRequest('Configuration changes require explicit confirmation');
    return this.config.setCommissionBps(actorId, bps, reason);
  }

  async restrictions(): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT r.*, u.username FROM responsible_play_restrictions r JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC LIMIT 200`);
    return result.rows;
  }

  async setRestriction(actorId: string, input: {
    userId: string; type: 'daily_deposit_limit' | 'daily_stake_limit' | 'session_limit' | 'self_exclusion';
    valueCents?: number; valueMinutes?: number; expiresAt?: string | null; reason: string;
  }, confirmed: boolean): Promise<string> {
    if (!confirmed) throw badRequest('Responsible-play changes require explicit confirmation');
    if (input.reason.trim().length < 8) throw badRequest('A documented reason is required');
    const id = uuid();
    await this.db.transaction(async (tx) => {
      const user = await tx.query('SELECT id FROM users WHERE id = $1', [input.userId]);
      if (!user.rows.length) throw notFound('User not found');
      await tx.query('UPDATE responsible_play_restrictions SET active = FALSE WHERE user_id = $1 AND type = $2 AND active = TRUE', [input.userId, input.type]);
      await tx.query(
        `INSERT INTO responsible_play_restrictions
          (id, user_id, type, value_cents, value_minutes, expires_at, active, created_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)`,
        [id, input.userId, input.type, input.valueCents ?? null, input.valueMinutes ?? null,
          input.expiresAt ?? null, actorId, input.reason],
      );
      await adminAction(tx, {
        actorId, action: 'responsible_play.restriction', targetType: 'user', targetId: input.userId,
        reason: input.reason, outcome: input.type, metadata: { id, valueCents: input.valueCents ?? null },
      });
    });
    return id;
  }

  async complianceStatus(): Promise<Record<string, unknown>> {
    return {
      ...this.compliance,
      operatingMode: process.env.OPERATING_MODE ?? 'free',
      legalAuthorisationVerified: process.env.LEGAL_AUTHORISATION_VERIFIED === 'true',
      providerApprovalVerified: process.env.PROVIDER_MERCHANT_APPROVAL_VERIFIED === 'true',
      ageVerificationProvider: process.env.AGE_VERIFICATION_PROVIDER ?? null,
      activation: this.compliance.activation,
      providerHealth: this.payments.health(),
    };
  }

  async systemHealth(): Promise<Record<string, unknown>> {
    const [engine, reconciliation, dbResult] = await Promise.all([
      this.engine.health(),
      this.ledger.reconcile(),
      this.db.query<Row>('SELECT now() AS server_time, version() AS postgres_version'),
    ]);
    return {
      status: reconciliation.discrepancies.length === 0 && reconciliation.unbalancedTransactions.length === 0 ? 'healthy' : 'degraded',
      database: { driver: this.db.driver, time: dbResult.rows[0]?.server_time, version: dbResult.rows[0]?.postgres_version },
      engine,
      reconciliation,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      operatingMode: this.compliance.testMode ? 'test' : this.compliance.realMoneyEnabled ? 'real' : 'free',
    };
  }
}
