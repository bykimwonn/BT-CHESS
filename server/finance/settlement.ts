import { canonicalTerms, formatMoney, quoteTerms, LEDGER_BASE_CURRENCY, type CompetitionTerms, type GameResult, type Termination } from '../../shared/contracts.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { badRequest, conflict } from '../services/errors.js';
import { audit, notify } from '../services/audit.js';
import { uuid } from '../services/ids.js';
import type { AppLogger } from '../services/logger.js';
import { LedgerService, SYSTEM_ACCOUNTS, type JournalEntry } from './ledger.js';

export interface SettlementOutcome {
  status: 'posted' | 'duplicate' | 'blocked' | 'skipped';
  settlementId?: string;
  reason?: string;
  payoutCents?: number;
  feeCents?: number;
}

export interface SettlementGameRow extends Row {
  id: string;
  white_id: string;
  black_id: string;
  mode: string;
  terms: CompetitionTerms | null;
}

export class SettlementService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly log: AppLogger,
  ) {}

  /** Derive payout journal lines from locked match terms. Pure and independently testable. */
  static entriesFor(
    terms: CompetitionTerms,
    result: GameResult,
    white: { availableId: string; reservedId: string },
    black: { availableId: string; reservedId: string },
    winnerId: string | null,
    feeAccountId: string = SYSTEM_ACCOUNTS.platformFee,
  ): { entries: JournalEntry[]; payoutCents: number; feeCents: number } {
    const expected = quoteTerms(terms.stakeCents, terms.feeBps);
    if (canonicalTerms(expected) !== canonicalTerms(terms)) {
      throw badRequest('Locked competition terms failed integrity validation');
    }
    const stake = terms.stakeCents;
    const entries: JournalEntry[] = [
      { accountId: white.reservedId, amountCents: -stake },
      { accountId: black.reservedId, amountCents: -stake },
    ];
    if (result === 'draw' || result === 'void' || !winnerId) {
      entries.push(
        { accountId: white.availableId, amountCents: stake },
        { accountId: black.availableId, amountCents: stake },
      );
      return { entries, payoutCents: stake, feeCents: 0 };
    }
    entries.push(
      { accountId: winnerId === white.availableId ? white.availableId : black.availableId, amountCents: terms.payoutCents },
      { accountId: feeAccountId, amountCents: terms.feeCents },
    );
    return { entries, payoutCents: terms.payoutCents, feeCents: terms.feeCents };
  }

  /**
   * Idempotent settlement. Must be called inside the same transaction that
   * marks the game finished. The unique game_id settlement row and the unique
   * ledger idempotency key prevent double payouts under concurrent requests.
   */
  async settleInTransaction(
    tx: Queryable,
    game: SettlementGameRow,
    result: GameResult,
    termination: Termination | string,
    options: { actorId?: string; reason?: string; retryBlocked?: boolean } = {},
  ): Promise<SettlementOutcome> {
    const terms = game.terms as CompetitionTerms | null;
    const stake = terms?.stakeCents ?? 0;
    if (!terms || stake <= 0) return { status: 'skipped', reason: 'Free game: no funds reserved' };
    const currency = String(terms.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();

    const openDispute = await tx.query<Row>(
      `SELECT id FROM disputes WHERE game_id = $1 AND status IN ('open','under_review') LIMIT 1`,
      [game.id],
    );
    const winnerId = result === 'white' ? String(game.white_id)
      : result === 'black' ? String(game.black_id) : null;
    const refund = result === 'draw' || result === 'void' || !winnerId;
    if (openDispute.rows.length && !options.retryBlocked) {
      // Record a blocked settlement so administrators can see why funds were
      // withheld; no ledger journal is posted.
      const blocked = await tx.query<Row>(
        `INSERT INTO settlements
          (id, game_id, idempotency_key, status, result, winner_id, stake_cents,
           pot_cents, fee_cents, payout_cents, reason, currency)
         VALUES ($1,$2,$3,'blocked',$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (game_id) DO UPDATE SET
           status = 'blocked', result = EXCLUDED.result, winner_id = EXCLUDED.winner_id,
           fee_cents = EXCLUDED.fee_cents, payout_cents = EXCLUDED.payout_cents,
           reason = EXCLUDED.reason
         WHERE settlements.status <> 'posted'
         RETURNING id`,
        [uuid(), game.id, `settlement:${game.id}`, result, winnerId, stake,
          terms.potCents, refund ? 0 : terms.feeCents, refund ? stake : terms.payoutCents,
          options.reason ?? 'An unresolved dispute prevents automatic settlement', currency],
      );
      return {
        status: blocked.rows.length ? 'blocked' : 'duplicate',
        settlementId: blocked.rows[0] ? String(blocked.rows[0].id) : undefined,
        reason: 'An unresolved dispute prevents automatic settlement',
      };
    }

    const white = await this.ledger.ensureUserAccounts(tx, String(game.white_id), currency);
    const black = await this.ledger.ensureUserAccounts(tx, String(game.black_id), currency);
    const feeAccountId = await this.ledger.systemAccountId(tx, currency, 'platformFee');
    const { entries, payoutCents, feeCents } = SettlementService.entriesFor(
      terms, result, white, black,
      winnerId === String(game.white_id) ? white.availableId
        : winnerId === String(game.black_id) ? black.availableId : null,
      feeAccountId,
    );

    const idempotencyKey = `settlement:${game.id}`;
    let settlementId: string | null = null;
    const existing = await tx.query<Row>(
      'SELECT id, status FROM settlements WHERE game_id = $1 FOR UPDATE', [game.id],
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.status === 'posted') return { status: 'duplicate', settlementId: String(row.id) };
      if (row.status === 'blocked' && !options.retryBlocked) {
        return { status: 'blocked', settlementId: String(row.id), reason: 'Settlement is blocked pending dispute resolution' };
      }
      settlementId = String(row.id);
      await tx.query(
        `UPDATE settlements SET status = 'pending', result = $2, winner_id = $3,
          payout_cents = $4, fee_cents = $5, reason = $6, currency = $7 WHERE id = $1`,
        [settlementId, result, winnerId, payoutCents, feeCents, options.reason ?? '', currency],
      );
    } else {
      settlementId = uuid();
      const inserted = await tx.query<Row>(
        `INSERT INTO settlements
          (id, game_id, idempotency_key, status, result, winner_id, stake_cents,
           pot_cents, fee_cents, payout_cents, reason, currency)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (game_id) DO NOTHING RETURNING id`,
        [settlementId, game.id, idempotencyKey, result, winnerId, stake,
          terms.potCents, feeCents, payoutCents, options.reason ?? '', currency],
      );
      if (!inserted.rows.length) return { status: 'duplicate', reason: 'Concurrent settlement already exists' };
    }

    const journal = await this.ledger.postTransaction({
      type: 'competition_settlement',
      reference: `STL-${game.id}`,
      idempotencyKey: `settlement-ledger:${game.id}`,
      description: `Competition settlement for game ${game.id}`,
      entries,
      currency,
      gameId: String(game.id),
      createdBy: options.actorId ?? null,
      metadata: { result, termination, terms, winnerId },
    }, tx);

    await tx.query(
      `UPDATE settlements SET status = 'posted', posted_at = now(), ledger_transaction_id = $2 WHERE id = $1`,
      [settlementId, journal.id],
    );
    await audit(tx, 'settlement.posted', 'game', String(game.id), {
      result, termination, payoutCents, feeCents, winnerId,
    }, options.actorId ? { type: 'admin', id: options.actorId } : { type: 'system', id: null });

    const title = 'Competition settled';
    for (const userId of [String(game.white_id), String(game.black_id)]) {
      const body = result === 'draw' || result === 'void'
        ? `Your ${formatMoney(stake, currency)} stake was refunded (no fee for a draw or void).`
        : userId === winnerId
          ? `You won ${formatMoney(payoutCents, currency)} (pot ${formatMoney(terms.potCents, currency)} less ${formatMoney(feeCents, currency)} fee).`
          : `The match ended. The winner received ${formatMoney(payoutCents, currency)}.`;
      await notify(tx, userId, { type: 'settlement', title, body, link: `/game/${game.id}` });
    }
    return { status: 'posted', settlementId, payoutCents, feeCents };
  }

  /** Recovery job: settle any finished, funded game whose journal did not post. */
  async settlePending(limit = 50): Promise<{ checked: number; posted: number; blocked: number; failed: string[] }> {
    const candidates = await this.db.query<Row>(`
      SELECT g.id, g.white_id, g.black_id, g.mode, g.terms, g.result, g.termination
      FROM games g
      LEFT JOIN settlements s ON s.game_id = g.id
      WHERE g.status = 'finished' AND g.terms IS NOT NULL
        AND (g.terms->>'stakeCents')::bigint > 0
        AND (s.id IS NULL OR s.status <> 'posted')
      ORDER BY g.ended_at ASC LIMIT $1`, [limit]);
    let posted = 0, blocked = 0;
    const failed: string[] = [];
    for (const row of candidates.rows) {
      try {
        const outcome = await this.db.transaction((tx) => this.settleInTransaction(tx, {
          id: String(row.id), white_id: String(row.white_id), black_id: String(row.black_id),
          mode: String(row.mode), terms: row.terms as CompetitionTerms,
        }, row.result as GameResult, String(row.termination ?? 'unknown')));
        if (outcome.status === 'posted') posted++;
        if (outcome.status === 'blocked') blocked++;
      } catch (error) {
        failed.push(`${row.id}: ${(error as Error).message}`);
        this.log.error({ gameId: row.id, err: (error as Error).message }, 'settlement recovery failed');
      }
    }
    return { checked: candidates.rows.length, posted, blocked, failed };
  }

  async getForGame(gameId: string): Promise<Row | null> {
    const result = await this.db.query<Row>('SELECT * FROM settlements WHERE game_id = $1', [gameId]);
    return result.rows[0] ?? null;
  }

  async assertNoDoublePayout(gameId: string): Promise<void> {
    const result = await this.db.query<Row>(
      `SELECT COUNT(*)::int AS n FROM ledger_transactions
       WHERE game_id = $1 AND type = 'competition_settlement' AND status = 'posted'`, [gameId],
    );
    if (Number(result.rows[0]?.n ?? 0) > 1) {
      throw conflict('Double-payout invariant violated');
    }
  }
}
