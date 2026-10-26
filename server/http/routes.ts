import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Chess, type Square } from 'chess.js';
import { formatCents, formatMoney, quoteTerms, LEDGER_BASE_CURRENCY, type PlatformStatus } from '../../shared/contracts.js';
import {
  challengeCreateSchema, conversionQuoteSchema, depositSchema, eligibilityVerificationSchema,
  emailSchema, exchangeRateSchema, internationalProfileSchema, jurisdictionPolicySchema,
  matchmakingSchema, moveSchema, quoteSchema, registerSchema, resetSchema,
  tournamentCreateSchema, withdrawalSchema, passwordSchema,
} from '../../shared/validation.js';
import { env } from '../config/env.js';
import type { AppContext } from '../services/context.js';
import { audit } from '../services/audit.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../services/errors.js';
import { uuid } from '../services/ids.js';
import { findSession, requireAdmin, requireAgent, requireAuth, requireCsrf, type AuthedRequest } from '../auth/session.js';
import { validFen } from '../games/rules.js';
import type { GameEvents } from '../games/service.js';
import { ProviderError } from '../payments/types.js';
import { createLogger } from '../services/logger.js';
import { verificationEmail } from '../services/email-templates.js';
const errorLog = createLogger();
import type { ProviderId } from '../payments/types.js';

type AsyncHandler = (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown> | unknown;
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req as AuthedRequest, res, next)).catch(next);
};
const user = (req: AuthedRequest) => {
  if (!req.auth) throw unauthorized();
  return req.auth;
};
const intParam = (value: unknown, fallback: number, max = 200): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), max) : fallback;
};

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(48).optional(),
  bio: z.string().trim().max(500).optional(),
  avatarUrl: z.string().trim().url().max(300).nullable().optional(),
});
const notificationReadSchema = z.object({ id: z.string().uuid() });
const disputeSchema = z.object({ reason: z.string().trim().min(8).max(200), detail: z.string().trim().max(2000).default('') });
const analysisSchema = z.object({
  fen: z.string().trim().min(20).max(120),
  moves: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)).max(200).default([]),
  depth: z.number().int().min(1).max(18).default(12),
  timeMs: z.number().int().min(50).max(5000).default(env.engineMaxTimeMs),
  multipv: z.number().int().min(1).max(5).default(1),
});
const testCreditSchema = z.object({ amountCents: z.number().int().min(50).max(10_000) });
const selfExcludeSchema = z.object({ confirm: z.literal(true), reason: z.string().trim().min(8).max(300) });
const adminActionSchema = z.object({
  confirm: z.literal(true), reason: z.string().trim().min(8).max(500),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});
// ------------------------------------------------------- cash-agent vouchers
const voucherIssueSchema = z.object({
  amountCents: z.number().int().min(100).max(10_000_000),
  playerUsername: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().max(120).optional(),
  expiresMinutes: z.number().int().min(5).max(1440).optional(),
});
const voucherCodeSchema = z.object({
  code: z.string().trim().min(4).max(24),
  reference: z.string().trim().max(120).optional(),
});
const cashPayoutSchema = z.object({
  amountCents: z.number().int().min(500).max(10_000_000),
  agentCode: z.string().trim().min(3).max(12),
});
const cashAgentCreateSchema = adminActionSchema.extend({
  usernameOrEmail: z.string().trim().min(3).max(200),
  code: z.string().trim().min(3).max(12),
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().max(160).optional(),
  voucherLimitCents: z.number().int().min(100).max(100_000_000).optional(),
  dailyDepositLimitCents: z.number().int().min(100).max(100_000_000).optional(),
  dailyPayoutLimitCents: z.number().int().min(100).max(100_000_000).optional(),
});
const cashAgentStatusSchema = adminActionSchema.extend({ status: z.enum(['active', 'suspended', 'closed']) });
const cashRemitSchema = adminActionSchema.extend({
  amountCents: z.number().int().min(1).max(100_000_000),
  reference: z.string().trim().min(2).max(120),
});
const cashCancelSchema = adminActionSchema.extend({ reason: z.string().trim().min(8).max(500) }).omit({ confirm: true });

export function createApiRouter(ctx: AppContext): Router {
  const router = Router();
  const db = ctx.db;

  const globalLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many requests' } },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many authentication attempts' } },
  });
  const financialLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  });
  const analysisLimiter = rateLimit({
    windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  });
  // A compromised administrator session must not be able to use the platform as
  // a bulk mail sender.
  const emailTestLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many test emails requested' } },
  });
  router.use(globalLimiter);

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => requireAuth(db, req, res, next);
  const csrfMiddleware = (req: Request, res: Response, next: NextFunction) => requireCsrf(db, req, res, next);
  const adminMiddleware = (req: Request, res: Response, next: NextFunction) => requireAdmin(db, req, res, next);
  const agentMiddleware = (req: Request, res: Response, next: NextFunction) => requireAgent(db, req, res, next);
  const privileged = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const actor = user(req as AuthedRequest);
      if (env.isProduction && !actor.mfaEnabled) {
        throw forbidden('Set up multi-factor authentication before using administrator controls');
      }
      if (actor.mfaEnabled) {
        const code = String(req.headers['x-mfa-code'] ?? (req.body as Record<string, unknown> | undefined)?.mfaCode ?? '');
        if (!await ctx.auth.verifyMfaCode(actor.id, code)) throw unauthorized('A valid MFA code is required');
      }
      next();
    })().catch(next);
  };
  const protectedRoute = [authMiddleware, csrfMiddleware];
  const adminRoute = [adminMiddleware, privileged, csrfMiddleware];
  const agentRoute = [agentMiddleware, csrfMiddleware];

  // ---------------------------------------------------------------- health
  router.get('/health', wrap(async (_req, res) => {
    const result = await db.query('SELECT now() AS time');
    res.json({ status: 'ok', database: db.driver, time: result.rows[0]?.time });
  }));

  router.get('/status', wrap(async (_req, res) => {
    const [feeBps, engine] = await Promise.all([ctx.config.commissionBps(), ctx.engine.health()]);
    const body: PlatformStatus = {
      mode: ctx.compliance.testMode ? 'test' : ctx.compliance.realMoneyEnabled ? 'real' : 'free',
      freeChessEnabled: true,
      competitionsEnabled: ctx.compliance.competitionsEnabled,
      realMoneyEnabled: ctx.compliance.realMoneyEnabled,
      realMoneyBlockers: ctx.compliance.blockers,
      feeBps,
      testFundsEnabled: env.testFundsEnabled && ctx.compliance.testMode,
      providerHealth: ctx.payments.health(),
      engine: { available: engine.available, name: engine.name, version: engine.version, license: engine.license },
      legalNotice: ctx.compliance.notice,
      ledgerBaseCurrency: LEDGER_BASE_CURRENCY,
      freePlayGlobal: await ctx.eligibility.globalFreePlayEnabled(),
    };
    res.json(body);
  }));

  router.get('/payments/providers', wrap(async (_req, res) => {
    res.json({ providers: ctx.payments.health(), docs: ctx.payments.docs() });
  }));

  router.get('/leaderboard', wrap(async (req, res) => {
    const rows = await ctx.games.leaderboard(intParam(req.query.limit, 50, 100));
    res.json({ items: rows.map((r) => ({
      rank: Number(r.rank), userId: String(r.user_id), username: String(r.username),
      displayName: String(r.display_name), rating: Number(r.rating),
      gamesPlayed: Number(r.games_played), wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws),
    })) });
  }));

  // ------------------------------------------------------- raw provider hooks
  // Mounted before express.json by the server so the exact raw bytes remain
  // available for hash / HMAC verification.
  router.post('/payments/webhook/:provider', wrap(async (req, res) => {
    const provider = z.enum(['paynow', 'ecocash', 'onemoney', 'pesepay']).parse(req.params.provider) as ProviderId;
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const outcome = await ctx.payments.handleCallback(provider, raw, req.headers as Record<string, string | string[] | undefined>);
    res.status(200).json({ received: true, ...outcome });
  }));

  // ------------------------------------------------------------- auth flows
  router.post('/auth/register', authLimiter, wrap(async (req, res) => {
    const result = await ctx.auth.register(registerSchema.parse(req.body), req, res);
    res.status(201).json(result);
  }));
  router.post('/auth/login', authLimiter, wrap(async (req, res) => {
    res.json(await ctx.auth.login(req.body, req, res));
  }));
  router.post('/auth/logout', protectedRoute, wrap(async (req, res) => {
    await ctx.auth.logout(req, res);
    res.json({ ok: true });
  }));
  router.get('/auth/session', wrap(async (req, res) => {
    const session = await ctx.auth.session(req);
    res.json({ ...session, mfaEnabled: (await db.query<{ mfa_enabled: boolean }>(
      'SELECT mfa_enabled FROM users WHERE id = $1', [session.user.id])).rows[0]?.mfa_enabled ?? false });
  }));
  router.post('/auth/forgot', authLimiter, wrap(async (req, res) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    res.json(await ctx.auth.forgotPassword(email));
  }));
  router.post('/auth/reset', authLimiter, wrap(async (req, res) => {
    const { token, password } = resetSchema.parse(req.body);
    await ctx.auth.consumeOneTimeToken(token, 'password_reset', password);
    res.json({ ok: true });
  }));
  router.post('/auth/verify-email', authLimiter, wrap(async (req, res) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(req.body);
    await ctx.auth.consumeOneTimeToken(token, 'email_verify');
    res.json({ ok: true });
  }));
  router.post('/auth/change-password', protectedRoute, wrap(async (req, res) => {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1), newPassword: passwordSchema,
    }).parse(req.body);
    await ctx.auth.changePassword(user(req).id, currentPassword, newPassword);
    res.clearCookie('rs_session', { path: '/' });
    res.clearCookie('rs_csrf', { path: '/' });
    res.json({ ok: true, sessionsRevoked: true });
  }));
  router.get('/auth/sessions', protectedRoute, wrap(async (req, res) => {
    const result = await db.query(
      `SELECT id, ip_hash, user_agent, created_at, last_seen_at, expires_at, revoked_at
       FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [user(req).id]);
    res.json({ items: result.rows });
  }));
  router.delete('/auth/sessions/:id', protectedRoute, wrap(async (req, res) => {
    const result = await db.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [req.params.id, user(req).id]);
    if (!result.rowCount) throw notFound('Session not found');
    res.json({ ok: true });
  }));
  router.post('/auth/revoke-sessions', protectedRoute, wrap(async (req, res) => {
    const count = await ctx.auth.revokeAllSessions(user(req).id, user(req).sessionId);
    res.json({ ok: true, revoked: count });
  }));
  router.post('/auth/mfa/setup', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.auth.setupMfa(user(req).id));
  }));
  router.post('/auth/mfa/verify', protectedRoute, wrap(async (req, res) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    res.json({ enabled: await ctx.auth.enableMfa(user(req).id, code) });
  }));
  router.post('/auth/mfa/disable', protectedRoute, wrap(async (req, res) => {
    const { code, password } = z.object({ code: z.string().regex(/^\d{6}$/), password: z.string().min(1) }).parse(req.body);
    res.json({ disabled: await ctx.auth.disableMfa(user(req).id, code, password) });
  }));
  router.post('/auth/age-verification', wrap(async (req, res) => {
    const input = z.object({
      userId: z.string().uuid(), providerReference: z.string().min(3).max(120),
      verified: z.boolean(), signature: z.string().length(64),
      jurisdiction: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
      identityVerified: z.boolean().optional(), locationVerified: z.boolean().optional(),
    }).parse(req.body);
    const { signature: _signature, ...rawPayload } = (req.body ?? {}) as Record<string, unknown>;
    await ctx.auth.ageVerificationCallback({ ...input, rawPayload: JSON.stringify(rawPayload) });
    res.json({ ok: true });
  }));
  router.post('/auth/eligibility-verification', wrap(async (req, res) => {
    const input = eligibilityVerificationSchema.parse(req.body);
    const { signature: _signature, ...rawPayload } = (req.body ?? {}) as Record<string, unknown>;
    await ctx.auth.ageVerificationCallback({ ...input, rawPayload: JSON.stringify(rawPayload) });
    res.json({ ok: true });
  }));
  router.get('/eligibility', wrap(async (req, res) => {
    const session = await findSession(db, req.headers).catch(() => null);
    res.json(await ctx.eligibility.stateFor(session?.id ?? null));
  }));
  router.get('/me/international', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.eligibility.stateFor(user(req).id));
  }));
  router.patch('/me/international', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.auth.updateInternational(user(req).id, internationalProfileSchema.parse(req.body)));
  }));
  router.post('/auth/email-verification/send', protectedRoute, wrap(async (req, res) => {
    const u = user(req);
    if (!ctx.mailer.configured) {
      const status = ctx.mailer.status();
      throw new AppError(503, 'email_unavailable',
        `Email delivery is not configured: ${status.problems.join('; ') || 'SMTP is not configured'}`);
    }
    const { token, email } = await ctx.auth.createOneTimeToken(u.id, 'email_verify');
    const delivery = await ctx.mailer.sendContent(
      email,
      verificationEmail(`${env.publicOrigin}/verify-email?token=${encodeURIComponent(token)}`),
    );
    res.json({ delivered: delivery.delivered, reason: delivery.reason });
  }));

  // ----------------------------------------------------------- public chess
  router.get('/games/:id', wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await ctx.games.getSnapshot(id, (req as AuthedRequest).auth?.id ?? null));
  }));
  router.get('/games/:id/pgn', wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const snapshot = await ctx.games.getSnapshot(id);
    res.type('application/x-chess-pgn').set('Content-Disposition', `attachment; filename="rookstone-${id}.pgn"`).send(snapshot.pgn);
  }));
  router.get('/games/:id/analysis', authMiddleware, analysisLimiter, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await ctx.analysis.analyseGame(id, { depth: intParam(req.query.depth, 10, 18), maxMoves: intParam(req.query.maxMoves, 40, 60) }));
  }));
  router.post('/analysis', authMiddleware, csrfMiddleware, analysisLimiter, wrap(async (req, res) => {
    const input = analysisSchema.parse(req.body);
    if (!validFen(input.fen)) throw badRequest('Invalid FEN');
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.json(await ctx.engine.analyse({ ...input, signal: controller.signal }));
  }));

  router.get('/users/:username/profile', wrap(async (req, res) => {
    const found = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!found.rows.length) throw notFound('Player not found');
    const id = String(found.rows[0].id);
    const stats = await ctx.games.profileStats(id);
    const games = await ctx.games.listGames(id, { limit: 8 });
    const achievements = await achievementsFor(id, stats);
    res.json({
      user: {
        id, username: String(stats.username), displayName: String(stats.display_name),
        rating: Number(stats.rating), puzzleRating: Number(stats.puzzle_rating),
        gamesPlayed: Number(stats.games_played), wins: Number(stats.wins),
        losses: Number(stats.losses), draws: Number(stats.draws),
        winPercentage: Number(stats.games_played) ? Math.round((Number(stats.wins) / Number(stats.games_played)) * 1000) / 10 : 0,
        favouriteTimeControl: stats.favourite_time_control, ratingHistory: stats.rating_history ?? [],
        country: Boolean(stats.country_shared) ? String(stats.country) : 'ZZ',
        countryShared: Boolean(stats.country_shared),
        timezone: Boolean(stats.timezone_shared) ? String(stats.timezone) : null,
        timezoneShared: Boolean(stats.timezone_shared),
        accountCurrency: String(stats.account_currency ?? 'USD'),
        memberSince: new Date(String(stats.created_at)).toISOString(),
        emailVerified: Boolean(stats.email_verified), ageVerified: Boolean(stats.age_verified),
      },
      recentGames: games, achievements,
    });
  }));
  router.get('/users/:username/games', wrap(async (req, res) => {
    const found = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!found.rows.length) throw notFound('Player not found');
    res.json({ items: await ctx.games.listGames(String(found.rows[0].id), {
      limit: intParam(req.query.limit, 25, 100), offset: intParam(req.query.offset, 0, 10_000),
      result: typeof req.query.result === 'string' ? req.query.result : undefined,
    }) });
  }));

  async function achievementsFor(userId: string, stats: Record<string, unknown>): Promise<Array<{ id: string; title: string; earnedAt: string | null }>> {
    const firstGame = await db.query<{ ended_at: string }>(`
      SELECT g.ended_at FROM games g WHERE g.status = 'finished' AND (g.white_id = $1 OR g.black_id = $1)
      ORDER BY g.ended_at ASC LIMIT 1`, [userId]);
    const firstWin = await db.query<{ ended_at: string }>(`
      SELECT g.ended_at FROM games g WHERE g.status = 'finished' AND
        ((g.result = 'white' AND g.white_id = $1) OR (g.result = 'black' AND g.black_id = $1))
      ORDER BY g.ended_at ASC LIMIT 1`, [userId]);
    const ratingPeak = await db.query<{ created_at: string }>(`
      SELECT created_at FROM rating_history WHERE user_id = $1 AND rating_after >= 1500
      ORDER BY created_at ASC LIMIT 1`, [userId]);
    return [
      { id: 'first-game', title: 'First rated game', earnedAt: firstGame.rows[0]?.ended_at ? String(firstGame.rows[0].ended_at) : null },
      { id: 'first-win', title: 'First victory', earnedAt: firstWin.rows[0]?.ended_at ? String(firstWin.rows[0].ended_at) : null },
      { id: 'ten-games', title: 'Ten rated games', earnedAt: Number(stats.games_played) >= 10 && firstGame.rows[0]?.ended_at ? String(firstGame.rows[0].ended_at) : null },
      { id: 'rating-1500', title: 'Reached 1500 rating', earnedAt: ratingPeak.rows[0]?.created_at ? String(ratingPeak.rows[0].created_at) : null },
    ];
  }

  // ------------------------------------------------------------- puzzles
  router.get('/puzzles', wrap(async (_req, res) => {
    const result = await db.query('SELECT id, fen, theme, rating, source FROM puzzles ORDER BY rating ASC LIMIT 20');
    res.json({ items: result.rows });
  }));
  router.post('/puzzles/:id/attempt', protectedRoute, wrap(async (req, res) => {
    const input = z.object({ moves: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)).max(8) }).parse(req.body);
    const result = await db.query<{ fen: string; solution: string[]; rating: number }>(
      'SELECT fen, solution, rating FROM puzzles WHERE id = $1', [req.params.id]);
    const puzzle = result.rows[0];
    if (!puzzle) throw notFound('Puzzle not found');
    const correct = verifyPuzzle(puzzle.fen, puzzle.solution, input.moves);
    const delta = correct ? 8 : -5;
    await db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO puzzle_attempts (user_id, puzzle_id, correct, rating_delta) VALUES ($1,$2,$3,$4)',
        [user(req).id, req.params.id, correct, delta]);
      await tx.query(
        'UPDATE profiles SET puzzle_rating = GREATEST(100, LEAST(4000, puzzle_rating + $2)), updated_at = now() WHERE user_id = $1',
        [user(req).id, delta]);
    });
    res.json({ correct, ratingDelta: delta, solution: correct ? puzzle.solution : undefined });
  }));

  function verifyPuzzle(fen: string, solution: string[], moves: string[]): boolean {
    if (moves.length !== solution.length) return false;
    const chess = new Chess();
    try { chess.load(fen); } catch { return false; }
    for (let i = 0; i < moves.length; i++) {
      if (moves[i] !== solution[i]) return false;
      const move = chess.move({ from: moves[i].slice(0, 2) as Square, to: moves[i].slice(2, 4) as Square, promotion: moves[i][4] });
      if (!move) return false;
    }
    return chess.isCheckmate();
  }

  // -------------------------------------------------------------- account
  router.get('/me', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.games.profileStats(user(req).id));
  }));
  router.patch('/me', protectedRoute, wrap(async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    const fields: string[] = [];
    const params: unknown[] = [user(req).id];
    for (const [key, column] of [['displayName', 'display_name'], ['bio', 'bio'], ['avatarUrl', 'avatar_url']] as const) {
      if (input[key] !== undefined) { params.push(input[key]); fields.push(`${column} = $${params.length}`); }
    }
    if (!fields.length) throw badRequest('No profile fields supplied');
    await db.query(`UPDATE profiles SET ${fields.join(', ')}, updated_at = now() WHERE user_id = $1`, params);
    res.json({ ok: true });
  }));
  router.get('/notifications', protectedRoute, wrap(async (req, res) => {
    const result = await db.query(
      'SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [user(req).id]);
    res.json({
      items: result.rows.map((r) => ({
        id: String(r.id), type: String(r.type), title: String(r.title), body: String(r.body),
        link: r.link ? String(r.link) : null, readAt: r.read_at ? String(r.read_at) : null,
        createdAt: String(r.created_at),
      })),
      unread: result.rows.filter((r) => !r.read_at).length,
    });
  }));
  router.post('/notifications/:id/read', protectedRoute, wrap(async (req, res) => {
    const { id } = notificationReadSchema.parse(req.params);
    await db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2', [id, user(req).id]);
    res.json({ ok: true });
  }));
  router.post('/notifications/read-all', protectedRoute, wrap(async (req, res) => {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user(req).id]);
    res.json({ ok: true });
  }));
  router.get('/responsible-play/restrictions', protectedRoute, wrap(async (req, res) => {
    const result = await db.query(
      `SELECT id, type, value_cents, value_minutes, expires_at, active, reason, created_at
       FROM responsible_play_restrictions WHERE user_id = $1 ORDER BY created_at DESC`, [user(req).id]);
    res.json({ items: result.rows });
  }));
  router.post('/responsible-play/limits', protectedRoute, wrap(async (req, res) => {
    const input = z.object({
      confirm: z.literal(true),
      dailyDepositCents: z.number().int().min(0).max(500_000).nullable(),
      dailyStakeCents: z.number().int().min(0).max(500_000).nullable(),
    }).parse(req.body);
    const u = user(req);
    await db.transaction(async (tx) => {
      for (const [type, value] of [
        ['daily_deposit_limit', input.dailyDepositCents],
        ['daily_stake_limit', input.dailyStakeCents],
      ] as const) {
        if (value === null) {
          await tx.query(
            'UPDATE responsible_play_restrictions SET active = FALSE WHERE user_id = $1 AND type = $2 AND active = TRUE',
            [u.id, type]);
        } else {
          await tx.query(
            'UPDATE responsible_play_restrictions SET active = FALSE WHERE user_id = $1 AND type = $2 AND active = TRUE',
            [u.id, type]);
          await tx.query(
            `INSERT INTO responsible_play_restrictions
              (id, user_id, type, value_cents, active, created_by, reason)
             VALUES ($1,$2,$3,$4,TRUE,$2,'Player-set responsible-play limit')`,
            [uuid(), u.id, type, value]);
        }
      }
      await audit(tx, 'responsible_play.limits_changed', 'user', u.id, {
        dailyDepositCents: input.dailyDepositCents, dailyStakeCents: input.dailyStakeCents,
      }, { type: 'user', id: u.id });
    });
    res.json({ ok: true });
  }));
  router.post('/responsible-play/self-exclude', protectedRoute, wrap(async (req, res) => {
    const { reason } = selfExcludeSchema.parse(req.body);
    const u = user(req);
    const expiresAt = new Date(Date.now() + 180 * 24 * 3_600_000);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO responsible_play_restrictions
          (id, user_id, type, expires_at, active, reason) VALUES ($1,$2,'self_exclusion',$3,TRUE,$4)`,
        [uuid(), u.id, expiresAt.toISOString(), reason]);
      await tx.query("UPDATE users SET status = 'self_excluded', updated_at = now() WHERE id = $1", [u.id]);
      await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await audit(tx, 'responsible_play.self_excluded', 'user', u.id, { reason, expiresAt }, { type: 'user', id: u.id });
    });
    res.clearCookie('rs_session', { path: '/' });
    res.clearCookie('rs_csrf', { path: '/' });
    res.json({ ok: true, expiresAt, message: 'Self-exclusion is active. Contact support after the cooling-off period to request review.' });
  }));

  // ---------------------------------------------------------------- wallet
  router.get('/wallet', protectedRoute, wrap(async (req, res) => {
    const currency = await ctx.eligibility.userCurrency(user(req).id);
    res.json(await ctx.ledger.walletView(user(req).id, currency));
  }));
  router.get('/wallet/transactions', protectedRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.payments.walletTransactions(user(req).id, {
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
      minCents: req.query.minCents === undefined ? undefined : Number(req.query.minCents),
      maxCents: req.query.maxCents === undefined ? undefined : Number(req.query.maxCents),
      limit: intParam(req.query.limit, 50, 200), offset: intParam(req.query.offset, 0, 10_000),
    }) });
  }));
  router.get('/wallet/statement.csv', protectedRoute, wrap(async (req, res) => {
    const csv = await ctx.payments.statementCsv(user(req).id, {
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    });
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="rookstone-statement.csv"').send(csv);
  }));
  router.get('/wallet/receipt/:id', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.payments.receipt(user(req).id, z.string().uuid().parse(req.params.id)));
  }));
  // -------------------------------------------------------- cash vouchers
  // Player side: redeem a cash-in code, or request cash and receive a code.
  router.post('/wallet/vouchers/redeem', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const input = voucherCodeSchema.parse(req.body);
    res.json(await ctx.cash.redeemDeposit(user(req).id, input));
  }));
  router.get('/wallet/vouchers', protectedRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.cash.vouchersForPlayer(user(req).id) });
  }));
  router.post('/wallet/cash-out', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const input = cashPayoutSchema.parse(req.body);
    const result = await ctx.cash.requestPayout(user(req).id, input);
    res.status(201).json(result);
  }));

  // Agent console.
  router.get('/cash/agent', agentRoute, wrap(async (req, res) => res.json(await ctx.cash.agentDashboard(user(req).id))));
  router.post('/cash/agent/vouchers', agentRoute, financialLimiter, wrap(async (req, res) => {
    const input = voucherIssueSchema.parse(req.body);
    res.status(201).json(await ctx.cash.issueDeposit(user(req).id, input));
  }));
  router.post('/cash/agent/payouts/settle', agentRoute, financialLimiter, wrap(async (req, res) => {
    const input = voucherCodeSchema.parse(req.body);
    res.json(await ctx.cash.settlePayout(user(req).id, input));
  }));
  router.post('/cash/agent/vouchers/:id/cancel', agentRoute, wrap(async (req, res) => {
    const input = cashCancelSchema.parse(req.body);
    const role = user(req).role === 'admin' ? 'admin' : 'agent';
    res.json(await ctx.cash.cancelVoucher(user(req).id, role, z.string().uuid().parse(req.params.id), input.reason));
  }));

  router.get('/wallet/deposits', protectedRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.payments.listDeposits(user(req).id) });
  }));
  router.get('/wallet/withdrawals', protectedRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.payments.listWithdrawals(user(req).id) });
  }));
  router.post('/wallet/deposit', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const result = await ctx.payments.initiateDeposit(user(req).id, depositSchema.parse(req.body));
    res.status(202).json(result);
  }));
  router.post('/wallet/withdraw', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const result = await ctx.payments.requestWithdrawal(user(req).id, withdrawalSchema.parse(req.body));
    res.status(202).json(result);
  }));
  router.post('/wallet/test-credits', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const { amountCents } = testCreditSchema.parse(req.body);
    const reference = await ctx.payments.grantTestCredits(user(req).id, amountCents, user(req).id);
    res.json({ ok: true, reference, amountCents, label: 'INTERNAL TEST CREDIT — no cash value' });
  }));
  router.post('/wallet/deposits/:id/confirm', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const owned = await db.query('SELECT id FROM deposits WHERE id = $1 AND user_id = $2', [id, user(req).id]);
    if (!owned.rows.length) throw notFound('Deposit not found');
    res.json(await ctx.payments.confirmDeposit(id));
  }));
  router.post('/wallet/withdrawals/:id/confirm', protectedRoute, financialLimiter, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const owned = await db.query('SELECT id FROM withdrawals WHERE id = $1 AND user_id = $2', [id, user(req).id]);
    if (!owned.rows.length) throw notFound('Withdrawal not found');
    res.json(await ctx.payments.confirmWithdrawal(id));
  }));

  // ---------------------------------------------------------- competitions
  router.post('/competitions/quote', wrap(async (req, res) => {
    const viewer = await findSession(db, req.headers).catch(() => null);
    res.json(await ctx.competition.quote(quoteSchema.parse(req.body), viewer?.id ?? null));
  }));
  router.post('/competitions/fee-preview', wrap(async (req, res) => {
    const input = z.object({ stakeCents: z.number().int().min(50).max(50_000), feeBps: z.number().int().min(0).max(2500).default(500) }).parse(req.body);
    res.json({ quote: quoteTerms(input.stakeCents, input.feeBps), explanation: formatCents(quoteTerms(input.stakeCents, input.feeBps).payoutCents) });
  }));
  router.get('/challenges', wrap(async (req, res) => {
    res.json(await ctx.competition.listChallenges({
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      timeCategory: typeof req.query.timeCategory === 'string' ? req.query.timeCategory : undefined,
      stakeCents: req.query.stakeCents === undefined ? undefined : Number(req.query.stakeCents),
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      limit: intParam(req.query.limit, 20, 100), offset: intParam(req.query.offset, 0, 10_000),
    }));
  }));
  router.get('/challenges/:id', wrap(async (req, res) => {
    res.json(await ctx.competition.getChallenge(z.string().uuid().parse(req.params.id)));
  }));
  router.get('/invites/:token', wrap(async (req, res) => {
    res.json(await ctx.competition.getChallengeByInvite(z.string().min(20).parse(req.params.token)));
  }));
  router.post('/challenges', protectedRoute, wrap(async (req, res) => {
    const result = await ctx.competition.createChallenge(user(req).id, challengeCreateSchema.parse(req.body));
    await ctx.realtime?.emitChallenge(result.challenge.id, 'created');
    res.status(201).json(result);
  }));
  router.post('/challenges/:id/invite', protectedRoute, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json({ inviteUrl: await ctx.competition.createInvite(user(req).id, id) });
  }));
  router.post('/challenges/:id/accept', protectedRoute, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = z.object({
      acceptedTermsHash: z.string().length(64).optional(), inviteToken: z.string().min(10).optional(),
    }).parse(req.body ?? {});
    const result = await ctx.competition.acceptChallenge(user(req).id, id, input);
    await ctx.realtime?.emitChallenge(id, 'matched');
    await ctx.realtime?.publishGameState(result.gameId);
    ctx.realtime?.emitMatchFound(result.snapshot.white.userId, result.gameId);
    ctx.realtime?.emitMatchFound(result.snapshot.black.userId, result.gameId);
    res.status(201).json({ gameId: result.gameId });
  }));
  router.delete('/challenges/:id', protectedRoute, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await ctx.competition.cancelChallenge(user(req).id, id);
    await ctx.realtime?.emitChallenge(id, 'updated');
    res.json({ ok: true });
  }));
  router.post('/matchmaking', protectedRoute, wrap(async (req, res) => {
    const result = await ctx.competition.createMatchTicket(user(req).id, matchmakingSchema.parse(req.body));
    if (result.status === 'matched') {
      const snapshot = await ctx.games.getSnapshot(result.gameId);
      await ctx.realtime?.publishGameState(result.gameId);
      ctx.realtime?.emitMatchFound(snapshot.white.userId, result.gameId);
      ctx.realtime?.emitMatchFound(snapshot.black.userId, result.gameId);
      res.status(201).json(result);
    } else {
      res.status(202).json(result);
    }
  }));
  router.delete('/matchmaking', protectedRoute, wrap(async (req, res) => {
    await ctx.competition.cancelMatchTicket(user(req).id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------- game API
  router.get('/games', protectedRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.games.listGames(user(req).id, {
      limit: intParam(req.query.limit, 25, 100), offset: intParam(req.query.offset, 0, 10_000),
      result: typeof req.query.result === 'string' ? req.query.result : undefined,
      timeCategory: typeof req.query.timeCategory === 'string' ? req.query.timeCategory : undefined,
    }) });
  }));
  router.post('/games/:id/moves', protectedRoute, wrap(async (req, res) => {
    const input = moveSchema.parse({ ...(req.body as Record<string, unknown>), gameId: req.params.id });
    const result = await ctx.games.submitMove(user(req).id, input);
    await ctx.realtime?.publishEvents(result.events);
    res.json({ snapshot: result.snapshot, duplicate: result.duplicate });
  }));
  const gameAction = (path: string, fn: (id: string, userId: string) => Promise<GameEvents>) => {
    router.post(`/games/:id/${path}`, protectedRoute, wrap(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      await ctx.realtime?.publishEvents(await fn(id, user(req).id));
      res.json({ ok: true });
    }));
  };
  gameAction('resign', (id, userId) => ctx.games.resign(userId, id));
  gameAction('draw-offer', (id, userId) => ctx.games.offerDraw(userId, id));
  gameAction('claim-draw', (id, userId) => ctx.games.claimDraw(userId, id));
  router.post('/games/:id/draw-answer', protectedRoute, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    await ctx.realtime?.publishEvents(await ctx.games.answerDraw(user(req).id, id, accept));
    res.json({ ok: true });
  }));
  router.post('/games/:id/dispute', protectedRoute, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { reason, detail } = disputeSchema.parse(req.body);
    res.status(201).json(await ctx.games.openDispute(user(req).id, id, reason, detail));
  }));

  // ------------------------------------------------------------ tournaments
  router.get('/tournaments', wrap(async (_req, res) => {
    res.json({ items: await ctx.tournaments.list() });
  }));
  router.get('/tournaments/:id', wrap(async (req, res) => {
    res.json(await ctx.tournaments.get(z.string().uuid().parse(req.params.id)));
  }));
  router.post('/tournaments', protectedRoute, wrap(async (req, res) => {
    res.status(201).json(await ctx.tournaments.create(user(req).id, tournamentCreateSchema.parse(req.body)));
  }));
  router.post('/tournaments/:id/join', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.tournaments.join(user(req).id, z.string().uuid().parse(req.params.id)));
  }));
  router.post('/tournaments/:id/start', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.tournaments.start(user(req).id, z.string().uuid().parse(req.params.id)));
  }));
  router.post('/tournaments/:id/pair', protectedRoute, wrap(async (req, res) => {
    res.json(await ctx.tournaments.pairNextRound(user(req).id, z.string().uuid().parse(req.params.id)));
  }));

  // ------------------------------------------------------------ admin API
  router.get('/admin/overview', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.overview())));
  router.get('/admin/users', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.users({
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    limit: intParam(req.query.limit, 50, 200), offset: intParam(req.query.offset, 0, 10_000),
  }) })));
  router.post('/admin/users/:id/status', adminRoute, wrap(async (req, res) => {
    const input = adminActionSchema.extend({ status: z.enum(['active', 'suspended', 'self_excluded']) }).parse(req.body);
    await ctx.admin.setUserStatus(user(req).id, req.params.id, input.status, input.reason, input.confirm);
    res.json({ ok: true });
  }));
  router.get('/admin/games', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.gameList({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    limit: intParam(req.query.limit, 50, 200), offset: intParam(req.query.offset, 0, 10_000),
  }) })));
  router.get('/admin/games/:id', adminRoute, wrap(async (req, res) => res.json(await ctx.admin.inspectGame(req.params.id))));
  router.get('/admin/disputes', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.disputes() })));
  router.post('/admin/disputes/:id/resolve', adminRoute, wrap(async (req, res) => {
    const input = adminActionSchema.extend({ decision: z.enum(['reject', 'void', 'review']), notes: z.string().min(8) }).parse(req.body);
    const outcome = await ctx.admin.resolveDispute(user(req).id, req.params.id, input.decision, input.notes, input.confirm);
    await ctx.realtime?.publishGameState(String(req.params.id));
    res.json(outcome);
  }));
  router.post('/admin/fair-play/:gameId/review', adminRoute, wrap(async (req, res) => {
    res.json(await ctx.admin.fairPlayReview(req.params.gameId, user(req).id));
  }));
  router.get('/admin/reviews', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.reviews() })));
  router.post('/admin/reviews/:id/close', adminRoute, wrap(async (req, res) => {
    const input = adminActionSchema.extend({ decision: z.string().min(3), notes: z.string().min(8) }).parse(req.body);
    await ctx.admin.closeReview(user(req).id, req.params.id, input.decision, input.notes, input.confirm);
    res.json({ ok: true });
  }));
  router.get('/admin/ledger', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.ledgerJournal(intParam(req.query.limit, 100, 500)) })));
  router.get('/admin/reconciliation', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.reconciliation())));
  router.get('/admin/commission', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.commissionReport())));
  router.post('/admin/settlements/reconcile', adminRoute, wrap(async (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    res.json(await ctx.admin.reconcileSettlements());
  }));
  router.get('/admin/settlements', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.settlements(intParam(req.query.limit, 100, 500)) })));
  router.get('/admin/deposits', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.deposits() })));
  router.get('/admin/withdrawals', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.withdrawals() })));
  router.get('/admin/cash-agents', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.cash.agents() })));
  router.post('/admin/cash-agents', adminRoute, wrap(async (req, res) => {
    const input = cashAgentCreateSchema.parse(req.body);
    res.status(201).json(await ctx.cash.registerAgent(user(req).id, { ...input, reason: input.reason }));
  }));
  router.post('/admin/cash-agents/:id/status', adminRoute, wrap(async (req, res) => {
    const input = cashAgentStatusSchema.parse(req.body);
    await ctx.cash.setAgentStatus(user(req).id, z.string().uuid().parse(req.params.id), input.status, input.reason);
    res.json({ ok: true });
  }));
  router.post('/admin/cash-agents/:id/remit', adminRoute, wrap(async (req, res) => {
    const input = cashRemitSchema.parse(req.body);
    res.json(await ctx.cash.remit(user(req).id, z.string().uuid().parse(req.params.id), { ...input, reason: input.reason }));
  }));
  router.get('/admin/cash-vouchers', adminRoute, wrap(async (req, res) => {
    res.json({ items: await ctx.cash.allVouchers(intParam(req.query.limit, 100, 500)) });
  }));
  router.post('/admin/cash-vouchers/:id/cancel', adminRoute, wrap(async (req, res) => {
    const input = cashCancelSchema.parse(req.body);
    res.json(await ctx.cash.cancelVoucher(user(req).id, 'admin', z.string().uuid().parse(req.params.id), input.reason));
  }));
  router.get('/admin/provider-events', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.providerEvents() })));
  router.get('/admin/providers', adminRoute, wrap(async (_req, res) => res.json({ providers: ctx.payments.health(), docs: ctx.payments.docs() })));
  router.get('/admin/email', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.emailStatus())));
  router.post('/admin/email/test', adminRoute, emailTestLimiter, wrap(async (req, res) => {
    const input = adminActionSchema.extend({ to: emailSchema }).parse(req.body);
    res.json(await ctx.admin.sendTestEmail(user(req).id, input.to, input.reason));
  }));
  router.get('/admin/system-health', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.systemHealth())));
  router.get('/admin/security-events', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.securityEvents(intParam(req.query.limit, 100, 500)) })));
  router.get('/admin/audit-logs', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.auditLogs(intParam(req.query.limit, 100, 500)) })));
  router.get('/admin/actions', adminRoute, wrap(async (req, res) => res.json({ items: await ctx.admin.adminActions(intParam(req.query.limit, 100, 500)) })));
  router.get('/admin/compliance', adminRoute, wrap(async (_req, res) => res.json(await ctx.admin.complianceStatus())));
  router.get('/admin/config', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.configItems() })));
  router.post('/admin/config/commission', adminRoute, wrap(async (req, res) => {
    const input = adminActionSchema.extend({ bps: z.number().int().min(0).max(2500) }).parse(req.body);
    res.json({ commissionBps: await ctx.admin.setCommission(user(req).id, input.bps, input.reason, input.confirm) });
  }));
  router.get('/admin/responsible-play', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.admin.restrictions() })));
  router.post('/admin/responsible-play', adminRoute, wrap(async (req, res) => {
    const input = adminActionSchema.extend({
      userId: z.string().uuid(),
      type: z.enum(['daily_deposit_limit', 'daily_stake_limit', 'session_limit', 'self_exclusion']),
      valueCents: z.number().int().min(0).optional(), valueMinutes: z.number().int().min(1).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    }).parse(req.body);
    const id = await ctx.admin.setRestriction(user(req).id, input, input.confirm);
    res.status(201).json({ id });
  }));
  router.get('/admin/jurisdictions', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.eligibility.listPolicies() })));
  router.post('/admin/jurisdictions', adminRoute, wrap(async (req, res) => {
    const input = jurisdictionPolicySchema.parse(req.body);
    const policy = await ctx.eligibility.setPolicy(user(req).id, input, input.reason);
    res.json({ item: policy });
  }));
  router.get('/admin/currencies/rates', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.eligibility.listExchangeRates() })));
  router.post('/admin/currencies/rates', adminRoute, wrap(async (req, res) => {
    const input = exchangeRateSchema.parse(req.body);
    res.status(201).json({ item: await ctx.eligibility.recordExchangeRate(user(req).id, input, input.reason) });
  }));
  router.get('/admin/currencies/quotes', adminRoute, wrap(async (_req, res) => res.json({ items: await ctx.eligibility.listConversionQuotes() })));
  router.post('/admin/currencies/quotes', adminRoute, wrap(async (req, res) => {
    const input = conversionQuoteSchema.parse(req.body);
    res.status(201).json({ quote: await ctx.eligibility.quoteConversion(user(req).id, input) });
  }));

  return router;
}

const FIELD_LABELS: Record<string, string> = {
  username: 'Username',
  email: 'Email address',
  password: 'Password',
  confirmPassword: 'Password confirmation',
  displayName: 'Display name',
  birthDate: 'Date of birth',
  country: 'Country',
  timezone: 'Time zone',
  accountCurrency: 'Currency',
  stakeCents: 'Stake',
  mfaCode: 'Authenticator code',
};

/**
 * Validation failures used to be reported as a bare "Invalid request", which told
 * the person submitting the form nothing (a password missing an uppercase letter
 * looked identical to a malformed request). Report the first problem in plain
 * language, and every problem per field, so the client can show it next to the
 * input that needs changing.
 */
export function validationErrorBody(issues: z.ZodIssue[]) {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const primary = issues[0];
  if (!primary) return { code: 'validation_error', message: 'Request could not be validated', fields, detail: issues };
  const label = FIELD_LABELS[primary.path.map(String).join('.')] ?? '';
  const message = label ? `${label}: ${primary.message}` : primary.message;
  return { code: 'validation_error', message, fields, detail: issues };
}

export function apiErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, detail: err.detail } });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: validationErrorBody(err.issues) });
    return;
  }
  if (err instanceof ProviderError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502)
      .json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    return;
  }
  errorLog.error({ err: err instanceof Error ? err.message : String(err), path: req.path }, 'unhandled API error');
  res.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } });
}
