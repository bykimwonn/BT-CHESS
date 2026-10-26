import { Chess, type Square } from 'chess.js';
import type {
  CompetitionTerms, GameResult, GameSnapshot, MoveRecord, PlayerSeat,
  Termination, TimeControl,
} from '../../shared/contracts.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound } from '../services/errors.js';
import { audit, notify } from '../services/audit.js';
import { uuid } from '../services/ids.js';
import type { AppLogger } from '../services/logger.js';
import type { SettlementService, SettlementGameRow } from '../finance/settlement.js';
import {
  START_FEN, allLegalUci, applyMove, claimToTermination, claimableDraw,
  makeChess, pgnWithHeaders, replayMoves, resultForWinner, terminalAfterMove,
} from './rules.js';

export interface PresenceTracker { isConnected(userId: string): boolean }

export interface CreateGameInput {
  whiteId: string;
  blackId: string;
  mode: 'free' | 'test' | 'real';
  timeControl: TimeControl;
  challengeId?: string | null;
  terms?: CompetitionTerms | null;
  termsHash?: string | null;
  tournamentId?: string | null;
  initialFen?: string;
}

export interface GameEvents {
  stateGameIds: string[];
  notifications: { userId: string; type: string; title: string; body: string; link: string | null }[];
  terminal: { gameId: string; result: GameResult | null; termination: Termination | null } | null;
}

const events = (): GameEvents => ({ stateGameIds: [], notifications: [], terminal: null });

interface GameRow extends Row {
  id: string;
  white_id: string;
  black_id: string;
  mode: string;
  status: string;
  result: string | null;
  termination: string | null;
  time_control: TimeControl;
  initial_fen: string;
  current_fen: string;
  pgn: string;
  version: number;
  white_clock_ms: number;
  black_clock_ms: number;
  turn_started_at: string | null;
  clock_paused: boolean;
  terms: CompetitionTerms | null;
  tournament_id: string | null;
  draw_offer_by: string | null;
  started_at: string;
  ended_at: string | null;
}

function clockRemaining(game: Pick<GameRow, 'current_fen' | 'white_clock_ms' | 'black_clock_ms' | 'turn_started_at' | 'clock_paused'>): number {
  const side = game.current_fen.split(' ')[1];
  const stored = side === 'w' ? Number(game.white_clock_ms) : Number(game.black_clock_ms);
  if (game.clock_paused || !game.turn_started_at) return stored;
  const elapsed = Math.max(0, Date.now() - new Date(game.turn_started_at).getTime());
  return Math.max(0, stored - elapsed);
}

/** A side with only a king, or king plus one minor piece, cannot force mate. */
function canForceMate(fen: string, color: 'w' | 'b'): boolean {
  const placement = fen.split(' ')[0];
  const pieces = placement.split('').filter((ch) => /[a-zA-Z]/.test(ch) && (color === 'w' ? ch === ch.toUpperCase() : ch === ch.toLowerCase()));
  const attackers = pieces.filter((p) => p.toLowerCase() !== 'k');
  if (attackers.some((p) => ['p', 'r', 'q'].includes(p.toLowerCase()))) return true;
  if (attackers.length >= 2 && attackers.some((p) => p.toLowerCase() === 'b') && attackers.some((p) => p.toLowerCase() === 'n')) return true;
  if (attackers.filter((p) => p.toLowerCase() === 'b').length >= 2) return true;
  return false;
}

export class GameService {
  presence: PresenceTracker = { isConnected: () => false };

  constructor(
    private readonly db: Database,
    private readonly settlement: SettlementService,
    private readonly log: AppLogger,
  ) {}

  async createGame(input: CreateGameInput, tx?: Queryable): Promise<{ gameId: string; snapshot: GameSnapshot }> {
    if (tx) return this.createGameInTx(tx, input);
    const result = await this.db.transaction((inner) => this.createGameInTx(inner, input));
    return result;
  }

  private async createGameInTx(tx: Queryable, input: CreateGameInput): Promise<{ gameId: string; snapshot: GameSnapshot }> {
    if (input.whiteId === input.blackId) throw conflict('A player cannot play against themselves');
    const users = await tx.query<Row>(
      'SELECT id, username, status FROM users WHERE id = ANY($1::uuid[])',
      [[input.whiteId, input.blackId]],
    );
    if (users.rows.length !== 2) throw badRequest('Both players must exist');
    if (users.rows.some((r) => r.status !== 'active')) throw forbidden('A player account is not active');
    const gameId = uuid();
    const fen = input.initialFen ?? START_FEN;
    const base = Math.trunc(input.timeControl.baseMs);
    await tx.query(
      `INSERT INTO games
        (id, challenge_id, tournament_id, white_id, black_id, mode, status, time_control, initial_fen,
         current_fen, pgn, version, white_clock_ms, black_clock_ms, turn_started_at,
         started_at, terms, terms_hash)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,$8,'',1,$9,$9,now(),now(),$10::jsonb,$11)`,
      [gameId, input.challengeId ?? null, input.tournamentId ?? null, input.whiteId, input.blackId, input.mode,
        JSON.stringify(input.timeControl), fen, base, JSON.stringify(input.terms ?? null), input.termsHash ?? null],
    );
    if (input.challengeId) {
      await tx.query(
        `UPDATE challenges SET status = 'matched', game_id = $2, accepted_at = COALESCE(accepted_at, now()) WHERE id = $1`,
        [input.challengeId, gameId],
      );
    }
    await audit(tx, 'game.created', 'game', gameId, {
      whiteId: input.whiteId, blackId: input.blackId, mode: input.mode,
      timeControl: input.timeControl, stakeCents: input.terms?.stakeCents ?? 0,
    });
    const snapshot = await this.snapshotFromTx(tx, gameId, input.whiteId);
    return { gameId, snapshot };
  }

  private async lockGame(tx: Queryable, gameId: string): Promise<GameRow> {
    const result = await tx.query<Row>(`SELECT * FROM games WHERE id = $1 FOR UPDATE`, [gameId]);
    if (!result.rows.length) throw notFound('Game not found');
    return result.rows[0] as unknown as GameRow;
  }

  private async moveRows(tx: Queryable, gameId: string): Promise<Row[]> {
    const result = await tx.query<Row>(
      `SELECT ply, san, uci, fen_after, color, clock_ms, created_at FROM moves
       WHERE game_id = $1 ORDER BY ply ASC`, [gameId],
    );
    return result.rows;
  }

  async snapshotFromTx(tx: Queryable, gameId: string, viewerId: string | null): Promise<GameSnapshot> {
    const game = await this.lockGame(tx, gameId);
    return this.toSnapshot(tx, game, await this.moveRows(tx, gameId), viewerId);
  }

  async getSnapshot(gameId: string, viewerId: string | null = null): Promise<GameSnapshot> {
    const game = await this.db.query<Row>('SELECT * FROM games WHERE id = $1', [gameId]);
    if (!game.rows.length) throw notFound('Game not found');
    const moves = await this.moveRows(this.db, gameId);
    return this.toSnapshot(this.db, game.rows[0] as unknown as GameRow, moves, viewerId);
  }

  private async toSnapshot(tx: Queryable, game: GameRow, moves: Row[], viewerId: string | null): Promise<GameSnapshot> {
    const players = await tx.query<Row>(`
      SELECT u.id, u.username, u.country, u.country_shared, u.timezone, u.timezone_shared,
             p.rating FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE u.id IN ($1,$2)`, [game.white_id, game.black_id]);
    const seat = (id: string): PlayerSeat => {
      const row = players.rows.find((r) => String(r.id) === id);
      const shared = Boolean(row?.country_shared);
      const timezoneShared = Boolean(row?.timezone_shared);
      return {
        userId: id, username: String(row?.username ?? 'Unknown'), rating: Number(row?.rating ?? 1200),
        connected: this.presence.isConnected(id),
        country: shared ? String(row?.country ?? 'ZZ') : undefined,
        countryShared: shared,
        timezone: timezoneShared ? String(row?.timezone ?? 'UTC') : null,
        timezoneShared,
      };
    };
    const history: MoveRecord[] = moves.map((m) => ({
      ply: Number(m.ply), san: String(m.san), uci: String(m.uci), fen: String(m.fen_after),
      color: m.color as 'w' | 'b', clockMs: Number(m.clock_ms), createdAt: String(m.created_at),
    }));
    const chess = makeChess(game.current_fen);
    const last = history.at(-1);
    const whiteClock = game.current_fen.split(' ')[1] === 'w' && game.status === 'active'
      ? clockRemaining(game) : Number(game.white_clock_ms);
    const blackClock = game.current_fen.split(' ')[1] === 'b' && game.status === 'active'
      ? clockRemaining(game) : Number(game.black_clock_ms);
    return {
      id: game.id,
      version: Number(game.version),
      status: game.status as GameSnapshot['status'],
      mode: game.mode as GameSnapshot['mode'],
      fen: game.current_fen,
      initialFen: game.initial_fen,
      pgn: game.pgn,
      moves: history,
      white: seat(game.white_id),
      black: seat(game.black_id),
      timeControl: game.time_control,
      whiteClockMs: whiteClock,
      blackClockMs: blackClock,
      turnStartedAt: game.turn_started_at ? new Date(String(game.turn_started_at)).toISOString() : null,
      startedAt: new Date(String(game.started_at)).toISOString(),
      serverTime: new Date().toISOString(),
      result: game.result as GameResult | null,
      termination: game.termination as Termination | null,
      lastMove: last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null,
      drawOfferBy: game.draw_offer_by,
      inCheck: chess.isCheck(),
      competition: game.terms ?? null,
      connection: this.presence.isConnected(viewerId ?? '') ? 'connected' : 'offline',
      legalMoves: game.status === 'active' ? allLegalUci(chess) : [],
    };
  }

  async submitMove(userId: string, input: { gameId: string; version: number; from: string; to: string; promotion?: string; nonce: string }): Promise<{ snapshot: GameSnapshot; events: GameEvents; duplicate: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, input.gameId);
      const out = events();
      const color = userId === game.white_id ? 'w' : userId === game.black_id ? 'b' : null;
      if (!color) throw forbidden('You are not a player in this game');
      const duplicate = await tx.query(
        'SELECT id FROM moves WHERE game_id = $1 AND by_user_id = $2 AND client_nonce = $3',
        [input.gameId, userId, input.nonce],
      );
      if (duplicate.rows.length) {
        return { snapshot: await this.snapshotFromTx(tx, input.gameId, userId), duplicate: true, out };
      }
      if (game.status !== 'active') throw conflict('This game is no longer active');
      if (Number(input.version) !== Number(game.version)) {
        throw conflict(`Stale game state: expected version ${game.version}`, { currentVersion: Number(game.version), snapshot: await this.snapshotFromTx(tx, input.gameId, userId) });
      }
      const moveRows = await this.moveRows(tx, input.gameId);
      const chess = replayMoves(game.initial_fen, moveRows.map((m) => String(m.uci)));
      if (chess.fen() !== game.current_fen) throw new Error('Persisted game state is inconsistent');
      if (chess.turn() !== color) throw conflict('It is not your turn');

      // Timeout is adjudicated from the server database clock before the move.
      const remaining = clockRemaining(game);
      if (remaining <= 0) {
        await this.adjudicateTimeoutInTx(tx, game, chess, out);
        return { snapshot: await this.snapshotFromTx(tx, input.gameId, userId), duplicate: false, out };
      }

      let move;
      try {
        move = applyMove(chess, { from: input.from as Square, to: input.to as Square, promotion: input.promotion });
      } catch {
        throw badRequest('Illegal move');
      }
      const increment = Number(game.time_control.incrementMs ?? 0);
      const moverClock = remaining + increment;
      const whiteClock = color === 'w' ? moverClock : Number(game.white_clock_ms);
      const blackClock = color === 'b' ? moverClock : Number(game.black_clock_ms);
      const uci = move.from + move.to + (move.promotion ?? '');
      const pgn = pgnWithHeaders(chess, {
        White: (await this.username(tx, game.white_id)), Black: (await this.username(tx, game.black_id)),
        Date: new Date(game.started_at).toISOString().slice(0, 10).replace(/-/g, '.'),
        Event: 'Rookstone Arena rated game', Site: 'Rookstone Arena',
      });
      await tx.query(
        `INSERT INTO moves (game_id, ply, san, uci, fen_after, color, by_user_id, clock_ms, client_nonce)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.gameId, moveRows.length + 1, move.san, uci, chess.fen(), color, userId, moverClock, input.nonce],
      );
      await tx.query(
        `UPDATE games SET current_fen = $2, pgn = $3, white_clock_ms = $4, black_clock_ms = $5,
           turn_started_at = now(), last_move_at = now(), version = version + 1,
           draw_offer_by = NULL, clock_paused = FALSE, paused_at = NULL
         WHERE id = $1`,
        [input.gameId, chess.fen(), pgn, whiteClock, blackClock],
      );
      out.stateGameIds.push(input.gameId);
      const terminal = terminalAfterMove(chess);
      if (terminal) {
        await this.finishInTx(tx, input.gameId, terminal.result, terminal.termination, out, userId);
      } else if (claimableDraw(chess)) {
        await tx.query(`UPDATE games SET draw_claim = $2 WHERE id = $1`, [input.gameId, claimableDraw(chess)]);
      } else {
        await tx.query(`UPDATE games SET draw_claim = NULL WHERE id = $1`, [input.gameId]);
      }
      return { snapshot: await this.snapshotFromTx(tx, input.gameId, userId), duplicate: false, out };
    });
    return { snapshot: result.snapshot, events: result.out, duplicate: result.duplicate };
  }

  private async username(tx: Queryable, userId: string): Promise<string> {
    const result = await tx.query<Row>('SELECT username FROM users WHERE id = $1', [userId]);
    return String(result.rows[0]?.username ?? 'Unknown');
  }

  private async adjudicateTimeoutInTx(tx: Queryable, game: GameRow, chess: Chess, out: GameEvents): Promise<void> {
    const sideToMove = chess.turn();
    const other = sideToMove === 'w' ? 'b' : 'w';
    const result: GameResult = canForceMate(chess.fen(), other) ? resultForWinner(other) : 'draw';
    // Persist the adjudicated clock so replays show the real terminal time.
    await tx.query(
      `UPDATE games SET white_clock_ms = $2, black_clock_ms = $3 WHERE id = $1`,
      [game.id, sideToMove === 'w' ? 0 : Number(game.white_clock_ms), sideToMove === 'b' ? 0 : Number(game.black_clock_ms)],
    );
    await this.finishInTx(tx, String(game.id), result, 'timeout', out, null);
  }

  async adjudicateTimeout(gameId: string): Promise<GameEvents> {
    const out = events();
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      if (game.status !== 'active' || game.clock_paused || !game.turn_started_at) return;
      if (clockRemaining(game) > 0) return;
      const moves = await this.moveRows(tx, gameId);
      const chess = replayMoves(game.initial_fen, moves.map((m) => String(m.uci)));
      await this.adjudicateTimeoutInTx(tx, game, chess, out);
    });
    return out;
  }

  async checkTimeouts(limit = 100): Promise<GameEvents> {
    const candidates = await this.db.query<Row>(
      `SELECT * FROM games WHERE status = 'active' AND clock_paused = FALSE
         AND turn_started_at IS NOT NULL ORDER BY turn_started_at ASC LIMIT $1`, [limit]);
    const out = events();
    for (const row of candidates.rows) {
      const game = row as unknown as GameRow;
      if (clockRemaining(game) > 0) continue;
      const result = await this.adjudicateTimeout(String(row.id)).catch((error) => {
        this.log.warn({ gameId: row.id, err: (error as Error).message }, 'timeout adjudication failed');
        return events();
      });
      out.stateGameIds.push(...result.stateGameIds);
      out.notifications.push(...result.notifications);
      if (result.terminal) out.terminal = result.terminal;
    }
    return out;
  }

  async resign(userId: string, gameId: string): Promise<GameEvents> {
    const out = events();
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      if (game.status !== 'active') throw conflict('This game is already finished');
      const winner: GameResult = userId === String(game.white_id) ? 'black' : userId === String(game.black_id) ? 'white' : (() => { throw forbidden('You are not a player in this game'); })();
      await this.finishInTx(tx, gameId, winner, 'resignation', out, userId);
    });
    return out;
  }

  async offerDraw(userId: string, gameId: string): Promise<GameEvents> {
    const out = events();
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      this.assertPlayer(userId, game);
      if (game.status !== 'active') throw conflict('This game is no longer active');
      if (game.draw_offer_by === userId) throw conflict('You already offered a draw');
      if (game.draw_offer_by && game.draw_offer_by !== userId) {
        // A counter-offer is treated as acceptance of the standing offer.
        await this.finishInTx(tx, gameId, 'draw', 'agreed-draw', out, userId);
        return;
      }
      await tx.query('UPDATE games SET draw_offer_by = $2, version = version + 1 WHERE id = $1', [gameId, userId]);
      out.stateGameIds.push(gameId);
      const opponent = userId === String(game.white_id) ? game.black_id : game.white_id;
      out.notifications.push({ userId: String(opponent), type: 'draw_offer', title: 'Draw offered', body: 'Your opponent offered a draw.', link: `/game/${gameId}` });
    });
    return out;
  }

  async answerDraw(userId: string, gameId: string, accept: boolean): Promise<GameEvents> {
    const out = events();
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      this.assertPlayer(userId, game);
      if (game.status !== 'active') throw conflict('This game is no longer active');
      if (!game.draw_offer_by || game.draw_offer_by === userId) throw conflict('There is no opponent draw offer to answer');
      if (accept) {
        await this.finishInTx(tx, gameId, 'draw', 'agreed-draw', out, userId);
      } else {
        await tx.query('UPDATE games SET draw_offer_by = NULL, version = version + 1 WHERE id = $1', [gameId]);
        out.stateGameIds.push(gameId);
      }
    });
    return out;
  }

  async claimDraw(userId: string, gameId: string): Promise<GameEvents> {
    const out = events();
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      this.assertPlayer(userId, game);
      if (game.status !== 'active') throw conflict('This game is no longer active');
      const moves = await this.moveRows(tx, gameId);
      const chess = replayMoves(game.initial_fen, moves.map((m) => String(m.uci)));
      const claim = claimableDraw(chess);
      if (!claim) throw conflict('No claimable draw is available');
      await this.finishInTx(tx, gameId, 'draw', claimToTermination(claim), out, userId);
    });
    return out;
  }

  private assertPlayer(userId: string, game: GameRow): void {
    if (userId !== String(game.white_id) && userId !== String(game.black_id)) throw forbidden('You are not a player in this game');
  }

  private async finishInTx(
    tx: Queryable,
    gameId: string,
    result: GameResult,
    termination: Termination,
    out: GameEvents,
    actorId: string | null,
  ): Promise<void> {
    const game = await this.lockGame(tx, gameId);
    if (!['active', 'disputed'].includes(String(game.status))) {
      out.stateGameIds.push(gameId);
      return;
    }
    const openDispute = await tx.query<Row>(
      `SELECT id FROM disputes WHERE game_id = $1 AND status IN ('open','under_review') LIMIT 1`, [gameId],
    );
    const status = openDispute.rows.length ? 'disputed' : 'finished';
    await tx.query(
      `UPDATE games SET status = $2, result = $3, termination = $4, ended_at = now(),
         turn_started_at = NULL, clock_paused = FALSE, draw_offer_by = NULL,
         disconnect_deadline = NULL, version = version + 1
       WHERE id = $1`,
      [gameId, status, result, termination],
    );
    if (status === 'finished' && result !== 'void') await this.updateRatings(tx, game, result);
    if (game.tournament_id && status === 'finished') {
      const whitePoints = result === 'white' ? 2 : result === 'draw' ? 1 : 0;
      const blackPoints = result === 'black' ? 2 : result === 'draw' ? 1 : 0;
      await tx.query(
        `UPDATE tournament_entries SET points = points + CASE
           WHEN user_id = $2 THEN $3 WHEN user_id = $4 THEN $5 ELSE 0 END
         WHERE tournament_id = $1 AND user_id IN ($2,$4)`,
        [game.tournament_id, String(game.white_id), whitePoints, String(game.black_id), blackPoints],
      );
      await tx.query('UPDATE tournament_pairings SET result = $2 WHERE game_id = $1', [gameId, result]);
    }
    if (game.terms) {
      const settlement = await this.settlement.settleInTransaction(tx, {
        id: String(game.id), white_id: String(game.white_id), black_id: String(game.black_id),
        mode: String(game.mode), terms: game.terms as CompetitionTerms,
      } as SettlementGameRow, result, termination, { reason: termination });
      if (settlement.status === 'blocked') {
        this.log.warn({ gameId }, 'Settlement blocked by an open dispute');
      }
    }
    await audit(tx, 'game.finished', 'game', gameId, { result, termination, status },
      actorId ? { type: 'user', id: actorId } : { type: 'system', id: null });
    out.stateGameIds.push(gameId);
    out.terminal = { gameId, result, termination };
    for (const userId of [String(game.white_id), String(game.black_id)]) {
      const body = `Game ended: ${result === 'draw' ? 'draw' : `${result} wins`} (${termination}).`;
      out.notifications.push({ userId, type: 'game_result', title: 'Game finished', body, link: `/game/${gameId}` });
      await notify(tx, userId, { type: 'game_result', title: 'Game finished', body, link: `/game/${gameId}` });
    }
  }

  private async updateRatings(tx: Queryable, game: GameRow, result: GameResult): Promise<void> {
    const profiles = await tx.query<Row>(
      'SELECT user_id, rating, games_played, wins, losses, draws FROM profiles WHERE user_id IN ($1,$2)',
      [game.white_id, game.black_id],
    );
    const white = profiles.rows.find((r) => String(r.user_id) === String(game.white_id));
    const black = profiles.rows.find((r) => String(r.user_id) === String(game.black_id));
    if (!white || !black) return;
    const whiteRating = Number(white.rating), blackRating = Number(black.rating);
    const whiteScore = result === 'white' ? 1 : result === 'black' ? 0 : 0.5;
    const expected = 1 / (1 + 10 ** ((blackRating - whiteRating) / 400));
    const kWhite = Number(white.games_played) < 20 ? 40 : 20;
    const kBlack = Number(black.games_played) < 20 ? 40 : 20;
    const whiteDelta = Math.round(kWhite * (whiteScore - expected));
    const blackDelta = Math.round(kBlack * ((1 - whiteScore) - (1 - expected)));
    for (const [row, delta, score] of [[white, whiteDelta, whiteScore], [black, blackDelta, 1 - whiteScore]] as const) {
      const userId = String(row.user_id);
      const before = Number(row.rating);
      const after = Math.max(100, before + delta);
      await tx.query(
        `UPDATE profiles SET rating = $2, games_played = games_played + 1,
           wins = wins + CASE WHEN $3::numeric = 1 THEN 1 ELSE 0 END,
           losses = losses + CASE WHEN $3::numeric = 0 THEN 1 ELSE 0 END,
           draws = draws + CASE WHEN $3::numeric = 0.5 THEN 1 ELSE 0 END,
           updated_at = now() WHERE user_id = $1`,
        [userId, after, score],
      );
      await tx.query(
        `INSERT INTO rating_history (user_id, game_id, rating_before, rating_after, delta, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, game.id, before, after, after - before, `game:${result}`],
      );
      const favourite = await tx.query<Row>(`
        SELECT time_control->>'category' AS category, COUNT(*) AS n
        FROM games WHERE (white_id = $1 OR black_id = $1) AND status = 'finished'
        GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 1`, [userId]);
      if (favourite.rows.length) {
        await tx.query('UPDATE profiles SET favourite_time_control = $2 WHERE user_id = $1',
          [userId, String(favourite.rows[0].category)]);
      }
    }
  }

  async listGames(userId: string, options: { limit?: number; offset?: number; result?: string; timeCategory?: string } = {}): Promise<Row[]> {
    const params: unknown[] = [userId];
    const clauses = ['(g.white_id = $1 OR g.black_id = $1)'];
    if (options.result) { params.push(options.result); clauses.push(`g.result = $${params.length}`); }
    if (options.timeCategory) { params.push(options.timeCategory); clauses.push(`g.time_control->>'category' = $${params.length}`); }
    params.push(Math.min(options.limit ?? 25, 100), Math.max(options.offset ?? 0, 0));
    const result = await this.db.query<Row>(`
      SELECT g.id, g.status, g.result, g.termination, g.mode, g.time_control, g.started_at, g.ended_at,
             g.pgn, g.current_fen, g.white_id, g.black_id, t.name AS tournament_name,
             wu.username AS white_name, bu.username AS black_name,
             CASE WHEN g.white_id = $1 THEN TRUE ELSE FALSE END AS played_white,
             CASE WHEN g.result = 'draw' THEN 'draw'
                  WHEN (g.result = 'white' AND g.white_id = $1) OR (g.result = 'black' AND g.black_id = $1) THEN 'win'
                  WHEN g.result IS NULL THEN 'ongoing' ELSE 'loss' END AS outcome
      FROM games g JOIN users wu ON wu.id = g.white_id JOIN users bu ON bu.id = g.black_id
      LEFT JOIN tournaments t ON t.id = g.tournament_id
      WHERE ${clauses.join(' AND ')} ORDER BY g.started_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return result.rows;
  }

  async profileStats(userId: string): Promise<Row> {
    const result = await this.db.query<Row>(`
      SELECT p.*, u.username, u.created_at, u.status, u.email_verified, u.age_verified,
             u.country, u.country_shared, u.timezone, u.timezone_shared, u.account_currency,
        (SELECT json_agg(json_build_object('rating', rating_after, 'at', created_at, 'delta', delta) ORDER BY created_at DESC)
         FROM (SELECT rating_after, created_at, delta FROM rating_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30) rh) AS rating_history
      FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`, [userId]);
    if (!result.rows.length) throw notFound('Profile not found');
    return result.rows[0];
  }

  async leaderboard(limit = 50): Promise<Row[]> {
    const result = await this.db.query<Row>(`
      SELECT row_number() OVER (ORDER BY p.rating DESC, p.wins DESC, p.user_id) AS rank,
             p.user_id, u.username, p.display_name, p.rating, p.games_played, p.wins, p.losses, p.draws,
             u.country, u.country_shared
      FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE p.games_played > 0 ORDER BY p.rating DESC, p.wins DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  async openDispute(userId: string, gameId: string, reason: string, detail: string): Promise<{ id: string; settlementBlocked: boolean }> {
    if (reason.trim().length < 8) throw badRequest('Please describe the issue (at least 8 characters)');
    return this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      this.assertPlayer(userId, game);
      const settlement = await tx.query<Row>('SELECT status FROM settlements WHERE game_id = $1 FOR UPDATE', [gameId]);
      const posted = settlement.rows[0]?.status === 'posted';
      const id = uuid();
      await tx.query(
        `INSERT INTO disputes (id, game_id, opened_by, reason, detail, status) VALUES ($1,$2,$3,$4,$5,'open')`,
        [id, gameId, userId, reason.trim().slice(0, 200), detail.trim().slice(0, 2000)],
      );
      // An active game continues, but its eventual settlement is blocked while
      // the dispute is open. finishInTx sets status='disputed' at termination.
      // A posted journal is never silently modified. A dispute opened after
      // payout requires an audited administrative correction, not a rollback.
      await audit(tx, 'dispute.opened', 'game', gameId,
        { reason, settlementAlreadyPosted: posted }, { type: 'user', id: userId });
      return { id, settlementBlocked: !posted };
    });
  }

  async markDisconnect(gameId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE games SET disconnect_deadline = now() + interval '90 seconds'
       WHERE id = $1 AND status = 'active' AND (white_id = $2 OR black_id = $2)`,
      [gameId, userId],
    );
  }

  async clearDisconnectDeadline(gameId: string): Promise<void> {
    await this.db.query('UPDATE games SET disconnect_deadline = NULL WHERE id = $1 AND status = $2', [gameId, 'active']);
  }

  async resumeIfBothConnected(gameId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const game = await this.lockGame(tx, gameId);
      if (game.status !== 'active') return;
      const both = this.presence.isConnected(String(game.white_id)) && this.presence.isConnected(String(game.black_id));
      if (!both) return;
      await tx.query('UPDATE games SET disconnect_deadline = NULL WHERE id = $1', [gameId]);
      if (game.clock_paused) {
        await tx.query('UPDATE games SET clock_paused = FALSE, paused_at = NULL, turn_started_at = now(), version = version + 1 WHERE id = $1', [gameId]);
      }
    });
  }

  /** Freeze clocks on graceful shutdown; the persisted turn timestamp resumes them. */
  async pauseAllClocks(): Promise<number> {
    const candidates = await this.db.query<Row>(
      `SELECT id FROM games WHERE status = 'active' AND clock_paused = FALSE AND turn_started_at IS NOT NULL`);
    let count = 0;
    for (const row of candidates.rows) {
      await this.db.transaction(async (tx) => {
        const game = await this.lockGame(tx, String(row.id));
        if (game.status !== 'active' || game.clock_paused || !game.turn_started_at) return;
        const remaining = clockRemaining(game);
        const side = game.current_fen.split(' ')[1];
        await tx.query(
          `UPDATE games SET white_clock_ms = $2, black_clock_ms = $3, clock_paused = TRUE,
             paused_at = now(), turn_started_at = NULL, version = version + 1 WHERE id = $1`,
          [game.id, side === 'w' ? remaining : Number(game.white_clock_ms), side === 'b' ? remaining : Number(game.black_clock_ms)],
        );
        count++;
      });
    }
    return count;
  }

  /** After an ungraceful restart, pause games that were idle for over a minute. */
  async recoverClocks(): Promise<number> {
    const candidates = await this.db.query<Row>(`
      SELECT id FROM games WHERE status = 'active' AND clock_paused = FALSE
        AND turn_started_at IS NOT NULL AND turn_started_at < now() - interval '60 seconds'`);
    let count = 0;
    for (const row of candidates.rows) {
      await this.db.transaction(async (tx) => {
        const game = await this.lockGame(tx, String(row.id));
        if (game.status !== 'active' || game.clock_paused || !game.turn_started_at) return;
        const side = game.current_fen.split(' ')[1];
        await tx.query(
          `UPDATE games SET white_clock_ms = $2, black_clock_ms = $3, clock_paused = TRUE,
             paused_at = now(), turn_started_at = NULL, version = version + 1 WHERE id = $1`,
          [game.id, side === 'w' ? Math.max(0, Number(game.white_clock_ms) - 60_000) : Number(game.white_clock_ms),
            side === 'b' ? Math.max(0, Number(game.black_clock_ms) - 60_000) : Number(game.black_clock_ms)],
        );
        count++;
      });
    }
    return count;
  }

  async checkAbandonment(): Promise<GameEvents> {
    const candidates = await this.db.query<Row>(`
      SELECT id, white_id, black_id FROM games
      WHERE status = 'active' AND disconnect_deadline IS NOT NULL AND disconnect_deadline <= now() LIMIT 50`);
    const out = events();
    for (const game of candidates.rows) {
      await this.db.transaction(async (tx) => {
        const locked = await this.lockGame(tx, String(game.id));
        if (locked.status !== 'active') return;
        const white = this.presence.isConnected(String(game.white_id));
        const black = this.presence.isConnected(String(game.black_id));
        if (white && black) {
          await tx.query('UPDATE games SET disconnect_deadline = NULL WHERE id = $1', [game.id]);
          return;
        }
        const result: GameResult = white && !black ? 'white' : black && !white ? 'black' : 'draw';
        const termination: Termination = result === 'draw' ? 'void' : 'abandonment';
        await this.finishInTx(tx, String(game.id), result, termination, out, null);
      });
    }
    return out;
  }

  async fairPlaySignal(gameId: string, userId: string, kind: string, score: number, detail: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO fair_play_signals (game_id, user_id, kind, score, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [gameId, userId, kind, score, JSON.stringify(detail)],
    );
  }
}
