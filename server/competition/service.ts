import crypto from 'node:crypto';
import {
  canonicalTerms, formatMoney, quoteTerms, TERMS_VERSION, LEDGER_BASE_CURRENCY,
  type ChallengeKind, type ChallengeView, type CompetitionTerms, type TimeControl,
  type OperatingMode,
} from '../../shared/contracts.js';
import {
  challengeCreateSchema, matchmakingSchema, normalizeTimeControl, quoteSchema,
} from '../../shared/validation.js';
import type { Database, Queryable, Row } from '../db/client.js';
import type { ComplianceState } from '../config/compliance.js';
import { env } from '../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../services/errors.js';
import { audit, notify } from '../services/audit.js';
import { uuid, randomToken, sha256 } from '../services/ids.js';
import type { AppLogger } from '../services/logger.js';
import type { AuthService } from '../auth/service.js';
import type { ConfigService } from '../services/config-service.js';
import type { GameService } from '../games/service.js';
import type { LedgerService } from '../finance/ledger.js';
import type { EligibilityService } from '../eligibility/service.js';

interface QuoteContext {
  context: 'challenge' | 'matchmaking';
  kind: ChallengeKind;
  opponentUsername?: string;
  timeControl: TimeControl;
  stakeCents: number;
  feeBps: number;
  ratingRange: number;
  mode: OperatingMode;
  terms: CompetitionTerms | null;
}

export class CompetitionService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly games: GameService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly eligibility: EligibilityService,
    private readonly compliance: ComplianceState,
    private readonly log: AppLogger,
  ) {}

  private modeFor(stakeCents: number): OperatingMode {
    if (stakeCents === 0) return 'free';
    if (!this.compliance.competitionsEnabled) {
      throw forbidden('Paid competitions are disabled in free-chess mode');
    }
    if (this.compliance.testMode) return 'test';
    if (!this.compliance.realMoneyEnabled) {
      throw forbidden(`Real-money competitions are not authorised: ${this.compliance.blockers.join('; ')}`);
    }
    return 'real';
  }

  private agreementPayload(ctx: QuoteContext): string {
    return JSON.stringify({
      schema: 'rookstone-agreement-v1',
      context: ctx.context, kind: ctx.kind, opponent: ctx.opponentUsername ?? null,
      timeControl: ctx.timeControl, stakeCents: ctx.stakeCents, feeBps: ctx.feeBps,
      ratingRange: ctx.ratingRange, mode: ctx.mode,
      terms: ctx.terms ? canonicalTerms(ctx.terms) : null,
      termsVersion: TERMS_VERSION,
    });
  }

  termsHash(ctx: QuoteContext): string { return sha256(this.agreementPayload(ctx)); }

  async quote(input: unknown, viewerId?: string | null): Promise<{
    terms: CompetitionTerms | null;
    termsHash: string | null;
    feeBps: number;
    mode: OperatingMode;
    label: string;
    disclosures: string[];
    allowed: boolean;
    blockers: string[];
  }> {
    const data = quoteSchema.parse(input);
    const timeControl = normalizeTimeControl(data.timeControl);
    const feeBps = await this.config.commissionBps();
    const mode: OperatingMode = data.stakeCents === 0 ? 'free'
      : this.compliance.testMode ? 'test'
        : this.compliance.realMoneyEnabled ? 'real' : 'free';
    const terms = data.stakeCents > 0 ? quoteTerms(data.stakeCents, feeBps) : null;
    const eligibility = await this.eligibility.stateFor(viewerId);
    const blockers: string[] = [];
    if (data.stakeCents > 0) {
      if (!this.compliance.competitionsEnabled) blockers.push('Paid competitions are disabled in free-chess mode.');
      if (mode === 'real' && !this.compliance.realMoneyEnabled) blockers.push(...this.compliance.blockers);
      if (!eligibility.freePlay.allowed) blockers.push(eligibility.freePlay.reason);
      if (mode === 'test' && !eligibility.policy.permittedCompetitionTypes.includes('test')) {
        blockers.push(`Internal test-credit matches are not permitted in ${eligibility.policy.label}.`);
      }
      if (mode === 'real') blockers.push(...eligibility.moneyMatches.blockers);
      if (!viewerId) blockers.push('Sign in and verify eligibility before entering a money match.');
    }
    const allowed = data.stakeCents === 0 || blockers.length === 0;
    const ctx: QuoteContext = {
      context: data.context, kind: data.kind, opponentUsername: data.opponentUsername,
      timeControl, stakeCents: data.stakeCents, feeBps, ratingRange: data.ratingRange, mode, terms,
    };
    const disclosures = terms ? [
      `Each player commits ${formatMoney(terms.stakeCents, terms.currency)}; the total pot is ${formatMoney(terms.potCents, terms.currency)}.`,
      `Platform commission is ${(terms.feeBps / 100).toFixed(2)}% = ${formatMoney(terms.feeCents, terms.currency)}, charged only on a decisive result.`,
      `The winner receives ${formatMoney(terms.payoutCents, terms.currency)}. A draw or void refunds both ${formatMoney(terms.stakeCents, terms.currency)} stakes with no commission.`,
      mode === 'test' ? 'INTERNAL TEST CREDITS ONLY: no real money is used or withdrawable.' : 'Funds are reserved atomically and only released by the authoritative game result.',
    ] : ['This is a free chess game. No funds are reserved and no fee is charged.'];
    return {
      terms, termsHash: terms ? this.termsHash(ctx) : null,
      feeBps, mode,
      label: mode === 'test' ? 'Internal test credits' : mode === 'real' ? 'Authorised USD competition' : 'Free chess',
      disclosures, allowed, blockers: allowed ? [] : [...new Set(blockers)],
    };
  }

  private async assertEligible(userId: string, stakeCents: number): Promise<void> {
    const mode = stakeCents === 0 ? 'free' : this.modeFor(stakeCents);
    await this.eligibility.assertCompetitionAllowed(userId, mode, stakeCents);
    if (stakeCents === 0) return;
    await this.auth.assertNotRestricted(userId, stakeCents);
    const currency = await this.eligibility.userCurrency(userId);
    const wallet = await this.ledger.walletView(userId, currency);
    if (wallet.availableCents < stakeCents) {
      throw conflict(`Insufficient available funds: ${formatMoney(wallet.availableCents, currency)} available, ${formatMoney(stakeCents, currency)} required`);
    }
  }

  private async viewFromRow(row: Row): Promise<ChallengeView> {
    const creator = await this.db.query<Row>(`
      SELECT u.id, u.username, p.rating FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [row.creator_id]);
    let opponent: { id: string; username: string; rating: number } | null = null;
    if (row.opponent_id) {
      const result = await this.db.query<Row>(`
        SELECT u.id, u.username, p.rating FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [row.opponent_id]);
      if (result.rows[0]) opponent = {
        id: String(result.rows[0].id), username: String(result.rows[0].username), rating: Number(result.rows[0].rating),
      };
    }
    const c = creator.rows[0];
    const rating = Number(c?.rating ?? 1200);
    const range = Number(row.rating_range ?? 300);
    return {
      id: String(row.id), kind: row.kind as ChallengeKind,
      creator: { id: String(row.creator_id), username: String(c?.username ?? 'Unknown'), rating },
      opponent,
      timeControl: row.time_control as TimeControl,
      stakeCents: Number(row.stake_cents),
      terms: (row.terms as CompetitionTerms | null) ?? null,
      ratingMin: Math.max(100, rating - range), ratingMax: rating + range,
      status: row.status as ChallengeView['status'],
      expiresAt: String(row.expires_at), createdAt: String(row.created_at),
      inviteUrl: null, gameId: row.game_id ? String(row.game_id) : null,
      requiresAcceptance: Number(row.stake_cents) > 0,
    };
  }

  async createChallenge(userId: string, input: unknown): Promise<{ challenge: ChallengeView; inviteUrl: string | null; quote: Awaited<ReturnType<CompetitionService['quote']>> }> {
    const data = challengeCreateSchema.parse(input);
    const timeControl = normalizeTimeControl(data.timeControl);
    const quote = await this.quote({
      context: 'challenge', kind: data.kind, opponentUsername: data.opponentUsername,
      timeControl: data.timeControl, stakeCents: data.stakeCents, ratingRange: data.ratingRange,
    }, userId);
    if (data.stakeCents > 0 && !quote.allowed) {
      throw forbidden(`Money matches are not available: ${quote.blockers.join('; ')}`);
    }
    if (quote.terms && data.acceptedTermsHash !== quote.termsHash) {
      throw badRequest('You must review and accept the exact disclosed competition terms');
    }
    await this.assertEligible(userId, data.stakeCents);
    const openCount = await this.db.query<Row>(
      `SELECT COUNT(*)::int AS n FROM challenges WHERE creator_id = $1 AND status = 'open' AND expires_at > now()`,
      [userId],
    );
    if (Number(openCount.rows[0]?.n ?? 0) >= 5) throw conflict('Too many open challenges. Cancel one first.');

    let opponentId: string | null = null;
    if (data.kind === 'direct') {
      const result = await this.db.query<Row>('SELECT id, status FROM users WHERE lower(username) = lower($1)', [data.opponentUsername]);
      if (!result.rows.length) throw notFound('Opponent not found');
      if (String(result.rows[0].id) === userId) throw conflict('You cannot challenge yourself');
      if (result.rows[0].status !== 'active') throw forbidden('That account is not active');
      opponentId = String(result.rows[0].id);
    }
    const challengeId = uuid();
    const inviteToken = data.kind === 'open' ? null : randomToken(24);
    const expiresAt = new Date(Date.now() + (data.kind === 'direct' ? 30 : 20) * 60_000);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO challenges
          (id, creator_id, opponent_id, kind, invite_token_hash, time_control, stake_cents,
           fee_bps, terms, terms_hash, rating_range, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,'open',$12)`,
        [challengeId, userId, opponentId, data.kind, inviteToken ? sha256(inviteToken) : null,
          JSON.stringify(timeControl), data.stakeCents, quote.feeBps,
          JSON.stringify(quote.terms), quote.termsHash, data.ratingRange, expiresAt.toISOString()],
      );
      if (quote.terms && quote.termsHash) {
        await tx.query(
          `INSERT INTO competition_agreements (id, challenge_id, user_id, terms_hash, terms)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [uuid(), challengeId, userId, quote.termsHash, JSON.stringify(quote.terms)],
        );
      }
      if (inviteToken) {
        await tx.query(
          `INSERT INTO game_invitations (id, challenge_id, invitee_id, token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuid(), challengeId, opponentId, sha256(inviteToken), expiresAt.toISOString()],
        );
      }
      await audit(tx, 'challenge.created', 'challenge', challengeId, {
        kind: data.kind, stakeCents: data.stakeCents, mode: quote.mode, termsHash: quote.termsHash,
      }, { type: 'user', id: userId });
    });
    const challenge = await this.getChallenge(challengeId, userId);
    return {
      challenge,
      inviteUrl: inviteToken ? `${env.publicOrigin}/challenge/${inviteToken}` : null,
      quote,
    };
  }

  async getChallenge(challengeId: string, _viewerId?: string): Promise<ChallengeView> {
    const result = await this.db.query<Row>('SELECT * FROM challenges WHERE id = $1', [challengeId]);
    if (!result.rows.length) throw notFound('Challenge not found');
    return this.viewFromRow(result.rows[0]);
  }

  async getChallengeByInvite(token: string): Promise<ChallengeView> {
    const result = await this.db.query<Row>(
      'SELECT * FROM challenges WHERE invite_token_hash = $1', [sha256(token)],
    );
    if (!result.rows.length) throw notFound('Invitation not found');
    const row = result.rows[0];
    if (row.status !== 'open' || new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw conflict('This invitation has expired or was used');
    }
    return this.viewFromRow(row);
  }

  async createInvite(userId: string, challengeId: string): Promise<string> {
    const result = await this.db.query<Row>('SELECT creator_id, expires_at, status FROM challenges WHERE id = $1', [challengeId]);
    if (!result.rows.length) throw notFound('Challenge not found');
    if (String(result.rows[0].creator_id) !== userId) throw forbidden('Only the creator can create an invitation');
    if (result.rows[0].status !== 'open') throw conflict('This challenge is no longer open');
    const token = randomToken(24);
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE game_invitations SET status = $2 WHERE challenge_id = $1', [challengeId, 'revoked']);
      await tx.query('UPDATE challenges SET invite_token_hash = $2 WHERE id = $1', [challengeId, sha256(token)]);
      await tx.query(
        `INSERT INTO game_invitations (id, challenge_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4)`, [uuid(), challengeId, sha256(token), String(result.rows[0].expires_at)],
      );
      await audit(tx, 'challenge.invite_rotated', 'challenge', challengeId, {}, { type: 'user', id: userId });
    });
    return `${env.publicOrigin}/challenge/${token}`;
  }

  async listChallenges(filters: {
    status?: string; kind?: string; timeCategory?: string; stakeCents?: number;
    search?: string; sort?: string; limit?: number; offset?: number;
  } = {}): Promise<{ items: ChallengeView[]; total: number; limit: number; offset: number }> {
    await this.expireChallenges();
    const params: unknown[] = [];
    const clauses: string[] = [`c.status = 'open'`];
    if (filters.kind) { params.push(filters.kind); clauses.push(`c.kind = $${params.length}`); }
    if (filters.timeCategory) { params.push(filters.timeCategory); clauses.push(`c.time_control->>'category' = $${params.length}`); }
    if (filters.stakeCents !== undefined) { params.push(filters.stakeCents); clauses.push(`c.stake_cents = $${params.length}`); }
    if (filters.search) {
      params.push(`%${filters.search.toLowerCase()}%`);
      clauses.push(`(lower(cu.username) LIKE $${params.length} OR lower(ou.username) LIKE $${params.length})`);
    }
    const where = clauses.join(' AND ');
    const count = await this.db.query<Row>(`
      SELECT COUNT(*)::int AS total FROM challenges c
      JOIN users cu ON cu.id = c.creator_id
      LEFT JOIN users ou ON ou.id = c.opponent_id WHERE ${where}`, params);
    const sort = filters.sort === 'stake' ? 'c.stake_cents DESC, c.created_at DESC'
      : filters.sort === 'rating' ? 'cp.rating DESC, c.created_at DESC'
        : filters.sort === 'expiry' ? 'c.expires_at ASC'
          : 'c.created_at DESC';
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const offset = Math.max(filters.offset ?? 0, 0);
    const result = await this.db.query<Row>(`
      SELECT c.* FROM challenges c
      JOIN users cu ON cu.id = c.creator_id
      JOIN profiles cp ON cp.user_id = c.creator_id
      LEFT JOIN users ou ON ou.id = c.opponent_id
      WHERE ${where} ORDER BY ${sort} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    const items = await Promise.all(result.rows.map((r) => this.viewFromRow(r)));
    return { items, total: Number(count.rows[0]?.total ?? 0), limit, offset };
  }

  async cancelChallenge(userId: string, challengeId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE challenges SET status = 'cancelled' WHERE id = $1 AND creator_id = $2 AND status = 'open'`,
      [challengeId, userId],
    );
    if (!result.rowCount) throw conflict('Challenge could not be cancelled');
    await audit(this.db, 'challenge.cancelled', 'challenge', challengeId, {}, { type: 'user', id: userId });
  }

  async expireChallenges(): Promise<number> {
    const result = await this.db.query(
      `UPDATE challenges SET status = 'expired' WHERE status = 'open' AND expires_at <= now()`,
    );
    return result.rowCount;
  }

  private async reserveStakes(
    tx: Queryable,
    challengeId: string,
    whiteId: string,
    blackId: string,
    terms: CompetitionTerms,
  ): Promise<void> {
    const currency = String(terms.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
    const white = await this.ledger.ensureUserAccounts(tx, whiteId, currency);
    const black = await this.ledger.ensureUserAccounts(tx, blackId, currency);
    const stake = terms.stakeCents;
    const entries = [
      { accountId: white.availableId, amountCents: -stake },
      { accountId: white.reservedId, amountCents: stake },
      { accountId: black.availableId, amountCents: -stake },
      { accountId: black.reservedId, amountCents: stake },
    ];
    await this.ledger.postTransaction({
      type: 'stake_reservation', reference: `RSV-${challengeId}`,
      idempotencyKey: `reservation:${challengeId}`,
      description: `Atomic reservation of two ${formatMoney(stake, currency)} stakes`,
      entries, currency, metadata: { challengeId, terms },
    }, tx);
  }

  private async assertAgreements(tx: Queryable, challengeId: string, expectedHash: string, userIds: string[]): Promise<void> {
    const result = await tx.query<Row>(
      'SELECT user_id, terms_hash, terms FROM competition_agreements WHERE challenge_id = $1', [challengeId],
    );
    for (const userId of userIds) {
      const row = result.rows.find((r) => String(r.user_id) === userId);
      if (!row) throw conflict('Both players must accept the same competition terms');
      if (String(row.terms_hash) !== expectedHash) throw conflict('Competition terms changed after acceptance');
    }
  }

  async acceptChallenge(
    userId: string,
    challengeId: string,
    input: { acceptedTermsHash?: string; inviteToken?: string },
  ): Promise<{ gameId: string; snapshot: Awaited<ReturnType<GameService['getSnapshot']>> }> {
    // Eligibility reads happen before the transaction to avoid nested reads on
    // a single embedded database connection. The financial checks inside the
    // transaction remain authoritative.
    const preflight = await this.db.query<Row>('SELECT stake_cents, status, creator_id FROM challenges WHERE id = $1', [challengeId]);
    if (!preflight.rows.length) throw notFound('Challenge not found');
    const preStake = Number(preflight.rows[0].stake_cents);
    const preMode = preStake === 0 ? 'free' : this.modeFor(preStake);
    await this.eligibility.assertCompetitionAllowed(userId, preMode, preStake);
    await this.eligibility.assertCompetitionAllowed(String(preflight.rows[0].creator_id), preMode, preStake);
    await this.auth.assertNotRestricted(userId, preStake);
    await this.auth.assertNotRestricted(String(preflight.rows[0].creator_id), preStake);
    const result = await this.db.transaction(async (tx) => {
      const found = await tx.query<Row>('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [challengeId]);
      const challenge = found.rows[0];
      if (!challenge) throw notFound('Challenge not found');
      if (challenge.status !== 'open') throw conflict('This challenge is no longer open');
      if (new Date(String(challenge.expires_at)).getTime() <= Date.now()) throw conflict('This challenge has expired');
      if (String(challenge.creator_id) === userId) throw conflict('You cannot accept your own challenge');
      if (challenge.opponent_id && String(challenge.opponent_id) !== userId) throw forbidden('This challenge is for a different player');
      if (challenge.kind === 'private') {
        if (!input.inviteToken || sha256(input.inviteToken) !== String(challenge.invite_token_hash)) {
          throw forbidden('A valid private invitation is required');
        }
      }
      const stake = Number(challenge.stake_cents);
      const terms = (challenge.terms as CompetitionTerms | null) ?? null;
      if (terms && input.acceptedTermsHash !== String(challenge.terms_hash)) {
        throw badRequest('You must accept the exact disclosed competition terms');
      }
      const ratings = await tx.query<Row>(
        'SELECT user_id, rating FROM profiles WHERE user_id IN ($1,$2)', [challenge.creator_id, userId],
      );
      const creatorRating = Number(ratings.rows.find((r) => String(r.user_id) === String(challenge.creator_id))?.rating ?? 1200);
      const accepterRating = Number(ratings.rows.find((r) => String(r.user_id) === userId)?.rating ?? 1200);
      const range = Number(challenge.rating_range ?? 300);
      if (challenge.kind === 'open' && Math.abs(creatorRating - accepterRating) > range) {
        throw forbidden('Your rating is outside this challenge’s range');
      }
      if (stake > 0) {
        if (!terms || !challenge.terms_hash) throw new Error('Paid challenge is missing locked terms');
        await tx.query(
          `INSERT INTO competition_agreements (id, challenge_id, user_id, terms_hash, terms)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (challenge_id, user_id) DO NOTHING`,
          [uuid(), challengeId, userId, String(challenge.terms_hash), JSON.stringify(terms)],
        );
        await this.assertAgreements(tx, challengeId, String(challenge.terms_hash), [String(challenge.creator_id), userId]);
        const whiteId = crypto.randomInt(2) === 0 ? String(challenge.creator_id) : userId;
        const blackId = whiteId === String(challenge.creator_id) ? userId : String(challenge.creator_id);
        await this.reserveStakes(tx, challengeId, whiteId, blackId, terms);
        const created = await this.games.createGame({
          whiteId, blackId, mode: this.modeFor(stake),
          timeControl: challenge.time_control as TimeControl,
          challengeId, terms, termsHash: String(challenge.terms_hash),
        }, tx);
        await tx.query(`UPDATE game_invitations SET status = 'accepted', accepted_at = now() WHERE challenge_id = $1`, [challengeId]);
        return { ...created, creatorId: String(challenge.creator_id) };
      }
      const whiteId = crypto.randomInt(2) === 0 ? String(challenge.creator_id) : userId;
      const blackId = whiteId === String(challenge.creator_id) ? userId : String(challenge.creator_id);
      const created = await this.games.createGame({
        whiteId, blackId, mode: 'free',
        timeControl: challenge.time_control as TimeControl, challengeId, terms: null,
      }, tx);
      await tx.query(`UPDATE game_invitations SET status = 'accepted', accepted_at = now() WHERE challenge_id = $1`, [challengeId]);
      return { ...created, creatorId: String(challenge.creator_id) };
    });
    await notify(this.db, result.creatorId, {
      type: 'challenge_accepted', title: 'Challenge accepted',
      body: 'Your opponent accepted. The game is starting.', link: `/game/${result.gameId}`,
    });
    return { gameId: result.gameId, snapshot: result.snapshot };
  }

  async createMatchTicket(userId: string, input: unknown): Promise<
    { status: 'queued'; ticketId: string; quote: Awaited<ReturnType<CompetitionService['quote']>> } |
    { status: 'matched'; gameId: string; ticketId: string; quote: Awaited<ReturnType<CompetitionService['quote']>> }
  > {
    const data = matchmakingSchema.parse(input);
    const timeControl = normalizeTimeControl(data.timeControl);
    const quote = await this.quote({
      context: 'matchmaking', kind: 'open', timeControl: data.timeControl,
      stakeCents: data.stakeCents, ratingRange: data.ratingRange,
    }, userId);
    if (data.stakeCents > 0 && !quote.allowed) {
      throw forbidden(`Money matches are not available: ${quote.blockers.join('; ')}`);
    }
    if (quote.terms && data.acceptedTermsHash !== quote.termsHash) {
      throw badRequest('You must review and accept the exact disclosed competition terms');
    }
    await this.assertEligible(userId, data.stakeCents);
    const ticketId = uuid();
    const profile = await this.db.query<Row>('SELECT rating FROM profiles WHERE user_id = $1', [userId]);
    const rating = Number(profile.rows[0]?.rating ?? 1200);
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    const outcome = await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE matchmaking_tickets SET status = 'cancelled' WHERE user_id = $1 AND status = 'queued'`, [userId]);
      await tx.query(
        `INSERT INTO matchmaking_tickets
          (id, user_id, rating, time_category, stake_cents, terms, terms_hash, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'queued',$8)`,
        [ticketId, userId, rating, timeControl.category, data.stakeCents,
          JSON.stringify(quote.terms), quote.termsHash, expiresAt.toISOString()],
      );
      const candidate = await tx.query<Row>(`
        SELECT * FROM matchmaking_tickets
        WHERE status = 'queued' AND id <> $1 AND user_id <> $2
          AND time_category = $3 AND stake_cents = $4 AND terms_hash IS NOT DISTINCT FROM $5
          AND expires_at > now() AND ABS(rating - $6) <= $7
        ORDER BY ABS(rating - $6), created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1`,
        [ticketId, userId, timeControl.category, data.stakeCents, quote.termsHash, rating, data.ratingRange],
      );
      const other = candidate.rows[0];
      if (!other) return { status: 'queued' as const, ticketId };
      const challengeId = uuid();
      const terms = (quote.terms as CompetitionTerms | null);
      await tx.query(
        `INSERT INTO challenges
          (id, creator_id, opponent_id, kind, time_control, stake_cents, fee_bps, terms,
           terms_hash, rating_range, status, expires_at, accepted_at)
         VALUES ($1,$2,$3,'open',$4::jsonb,$5,$6,$7::jsonb,$8,$9,'matched',now() + interval '1 hour',now())`,
        [challengeId, other.user_id, userId, JSON.stringify(timeControl), data.stakeCents,
          quote.feeBps, JSON.stringify(terms), quote.termsHash, data.ratingRange],
      );
      if (terms && quote.termsHash) {
        for (const playerId of [String(other.user_id), userId]) {
          await tx.query(
            `INSERT INTO competition_agreements (id, challenge_id, user_id, terms_hash, terms)
             VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [uuid(), challengeId, playerId, quote.termsHash, JSON.stringify(terms)],
          );
        }
        await this.assertAgreements(tx, challengeId, quote.termsHash, [String(other.user_id), userId]);
      }
      const whiteId = crypto.randomInt(2) === 0 ? String(other.user_id) : userId;
      const blackId = whiteId === String(other.user_id) ? userId : String(other.user_id);
      if (terms) await this.reserveStakes(tx, challengeId, whiteId, blackId, terms);
      const created = await this.games.createGame({
        whiteId, blackId, mode: this.modeFor(data.stakeCents),
        timeControl, challengeId, terms, termsHash: quote.termsHash,
      }, tx);
      await tx.query(
        `UPDATE matchmaking_tickets SET status = 'matched', matched_game_id = $2 WHERE id IN ($1,$3)`,
        [ticketId, created.gameId, String(other.id)],
      );
      await audit(tx, 'matchmaking.matched', 'game', created.gameId, {
        ticketA: ticketId, ticketB: String(other.id), ratingGap: Math.abs(Number(other.rating) - rating),
      });
      return { status: 'matched' as const, gameId: created.gameId, ticketId };
    });
    return { ...outcome, quote };
  }

  async cancelMatchTicket(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE matchmaking_tickets SET status = 'cancelled' WHERE user_id = $1 AND status = 'queued'`, [userId],
    );
  }

  async cleanupTickets(): Promise<number> {
    const result = await this.db.query(
      `UPDATE matchmaking_tickets SET status = 'expired' WHERE status = 'queued' AND expires_at <= now()`,
    );
    return result.rowCount;
  }
}
