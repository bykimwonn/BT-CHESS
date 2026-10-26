import type { Database, Queryable, Row } from '../db/client.js';
import type { AppLogger } from '../services/logger.js';
import { audit, notify } from '../services/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../services/errors.js';
import { uuid } from '../services/ids.js';
import { normalizeTimeControl, tournamentCreateSchema } from '../../shared/validation.js';
import type {
  OperatingMode, TimeControl, TournamentPairing, TournamentStanding, TournamentView,
} from '../../shared/contracts.js';
import type { GameService } from '../games/service.js';
import type { EligibilityService } from '../eligibility/service.js';

export interface PairingSeed {
  userId: string;
  rating: number;
  points: number;
}

export interface PairResult {
  roundNo: number;
  boardNo: number;
  whiteId: string;
  blackId: string;
}

/** Deterministic score-group Swiss pairing without fabricated participants. */
export function pairEntrants(seeds: PairingSeed[], previousOpponents: Map<string, Set<string>>, roundNo: number): { pairs: PairResult[]; bye: string | null } {
  const pool = [...seeds].sort((a, b) =>
    b.points - a.points || b.rating - a.rating || a.userId.localeCompare(b.userId));
  const pairs: PairResult[] = [];
  let boardNo = 1;
  while (pool.length >= 2) {
    const first = pool.shift()!;
    let index = pool.findIndex((candidate) => !previousOpponents.get(first.userId)?.has(candidate.userId));
    if (index < 0) index = 0;
    const second = pool.splice(index, 1)[0];
    const whiteFirst = (roundNo + boardNo) % 2 === 0;
    pairs.push({
      roundNo, boardNo,
      whiteId: whiteFirst ? first.userId : second.userId,
      blackId: whiteFirst ? second.userId : first.userId,
    });
    boardNo++;
  }
  return { pairs, bye: pool.length ? pool[0].userId : null };
}

function tournamentFromRow(row: Row): TournamentView {
  return {
    id: String(row.id),
    name: String(row.name),
    mode: String(row.mode) as OperatingMode,
    status: String(row.status) as TournamentView['status'],
    timeControl: row.time_control as TimeControl,
    maxPlayers: Number(row.max_players),
    currentRound: Number(row.current_round),
    rated: Boolean(row.rated),
    createdBy: String(row.created_by),
    creatorUsername: String(row.creator_username ?? 'Unknown'),
    startsAt: row.starts_at ? new Date(String(row.starts_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    entrants: Number(row.entrants ?? 0),
  };
}

export class TournamentService {
  constructor(
    private readonly db: Database,
    private readonly games: GameService,
    private readonly eligibility: EligibilityService,
    private readonly log: AppLogger,
  ) {}

  async list(): Promise<TournamentView[]> {
    const result = await this.db.query<Row>(`
      SELECT t.*, cu.username AS creator_username,
             (SELECT COUNT(*)::int FROM tournament_entries te
              WHERE te.tournament_id = t.id AND te.status = 'active') AS entrants
      FROM tournaments t JOIN users cu ON cu.id = t.created_by
      ORDER BY t.created_at DESC LIMIT 100`);
    return result.rows.map(tournamentFromRow);
  }

  async create(userId: string, input: unknown): Promise<TournamentView> {
    const data = tournamentCreateSchema.parse(input);
    await this.eligibility.assertFreePlayAllowed(userId);
    const timeControl = normalizeTimeControl(data.timeControl);
    const id = uuid();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO tournaments
          (id, name, mode, status, time_control, max_players, rated, created_by, starts_at)
         VALUES ($1,$2,'free','registration',$3::jsonb,$4,$5,$6,$7)`,
        [id, data.name, JSON.stringify(timeControl), data.maxPlayers, data.rated, userId,
          data.startsAt ?? null],
      );
      await audit(tx, 'tournament.created', 'tournament', id, {
        name: data.name, timeControl, maxPlayers: data.maxPlayers, rated: data.rated,
      }, { type: 'user', id: userId });
    });
    const result = await this.db.query<Row>(`
      SELECT t.*, cu.username AS creator_username, 0 AS entrants
      FROM tournaments t JOIN users cu ON cu.id = t.created_by WHERE t.id = $1`, [id]);
    return tournamentFromRow(result.rows[0]);
  }

  private async lockTournament(tx: Queryable, id: string): Promise<Row> {
    const result = await tx.query<Row>('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rows.length) throw notFound('Tournament not found');
    return result.rows[0];
  }

  private async assertDirector(tx: Queryable, tournament: Row, userId: string): Promise<void> {
    const result = await tx.query<Row>('SELECT role FROM users WHERE id = $1', [userId]);
    if (String(tournament.created_by) !== userId && result.rows[0]?.role !== 'admin') {
      throw forbidden('Only the tournament director or an administrator can start or pair a round.');
    }
  }

  async join(userId: string, tournamentId: string): Promise<{ ok: true }> {
    await this.eligibility.assertFreePlayAllowed(userId);
    await this.db.transaction(async (tx) => {
      const tournament = await this.lockTournament(tx, tournamentId);
      if (String(tournament.status) !== 'registration') throw conflict('Registration is closed for this tournament.');
      const count = await tx.query<Row>(
        `SELECT COUNT(*)::int AS n FROM tournament_entries WHERE tournament_id = $1 AND status = 'active'`,
        [tournamentId],
      );
      if (Number(count.rows[0]?.n ?? 0) >= Number(tournament.max_players)) throw conflict('Tournament is full.');
      const inserted = await tx.query(
        `INSERT INTO tournament_entries (id, tournament_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT (tournament_id, user_id) DO NOTHING RETURNING id`,
        [uuid(), tournamentId, userId],
      );
      if (!inserted.rows.length) throw conflict('You already joined this tournament.');
      await audit(tx, 'tournament.joined', 'tournament', tournamentId, { userId }, { type: 'user', id: userId });
    });
    return { ok: true };
  }

  async start(userId: string, tournamentId: string): Promise<{ round: number; pairings: TournamentPairing[] }> {
    return this.db.transaction(async (tx) => {
      const tournament = await this.lockTournament(tx, tournamentId);
      await this.assertDirector(tx, tournament, userId);
      if (String(tournament.status) !== 'registration') throw conflict('Tournament has already started or finished.');
      const entries = await tx.query<Row>(
        `SELECT user_id FROM tournament_entries
         WHERE tournament_id = $1 AND status = 'active'`, [tournamentId],
      );
      if (entries.rows.length < 2) throw conflict('At least two real entrants are required to start a tournament.');
      await tx.query(`UPDATE tournaments SET status = 'active', current_round = 1, updated_at = now() WHERE id = $1`, [tournamentId]);
      await this.pairRoundInTx(tx, { ...tournament, current_round: 0, status: 'active' }, 1, userId);
      return { round: 1, pairings: await this.pairingsFromTx(tx, tournamentId, 1) };
    });
  }

  async pairNextRound(userId: string, tournamentId: string): Promise<{ round: number; pairings: TournamentPairing[] }> {
    return this.db.transaction(async (tx) => {
      const tournament = await this.lockTournament(tx, tournamentId);
      await this.assertDirector(tx, tournament, userId);
      if (String(tournament.status) !== 'active') throw conflict('Tournament is not active.');
      const unfinished = await tx.query<Row>(`
        SELECT tp.id FROM tournament_pairings tp
        LEFT JOIN games g ON g.id = tp.game_id
        WHERE tp.tournament_id = $1 AND (g.id IS NULL OR g.status NOT IN ('finished','void'))
        LIMIT 1`, [tournamentId]);
      if (unfinished.rows.length) throw conflict('All current-round games must finish before pairing the next round.');
      const nextRound = Number(tournament.current_round) + 1;
      await tx.query('UPDATE tournaments SET current_round = $2, updated_at = now() WHERE id = $1', [tournamentId, nextRound]);
      await this.pairRoundInTx(tx, tournament, nextRound, userId);
      return { round: nextRound, pairings: await this.pairingsFromTx(tx, tournamentId, nextRound) };
    });
  }

  private async pairRoundInTx(tx: Queryable, tournament: Row, roundNo: number, actorId: string): Promise<void> {
    const entries = await tx.query<Row>(`
      SELECT te.user_id, te.points, p.rating
      FROM tournament_entries te JOIN profiles p ON p.user_id = te.user_id
      WHERE te.tournament_id = $1 AND te.status = 'active'
      ORDER BY te.points DESC, p.rating DESC, te.joined_at ASC`, [tournament.id]);
    const previousResult = await tx.query<Row>(`
      SELECT white_id, black_id FROM tournament_pairings
      WHERE tournament_id = $1 AND round_no < $2`, [tournament.id, roundNo]);
    const previous = new Map<string, Set<string>>();
    for (const row of previousResult.rows) {
      const white = String(row.white_id), black = String(row.black_id);
      if (!previous.has(white)) previous.set(white, new Set());
      if (!previous.has(black)) previous.set(black, new Set());
      previous.get(white)!.add(black);
      previous.get(black)!.add(white);
    }
    const seeds: PairingSeed[] = entries.rows.map((row) => ({
      userId: String(row.user_id), points: Number(row.points), rating: Number(row.rating),
    }));
    const { pairs, bye } = pairEntrants(seeds, previous, roundNo);
    const timeControl = tournament.time_control as TimeControl;
    for (const pair of pairs) {
      const created = await this.games.createGame({
        whiteId: pair.whiteId, blackId: pair.blackId, mode: 'free', timeControl,
        tournamentId: String(tournament.id),
      }, tx);
      await tx.query(
        `INSERT INTO tournament_pairings
          (id, tournament_id, round_no, board_no, white_id, black_id, game_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), tournament.id, roundNo, pair.boardNo, pair.whiteId, pair.blackId, created.gameId],
      );
      const link = `/game/${created.gameId}`;
      await notify(tx, pair.whiteId, { type: 'tournament_pairing', title: 'Tournament pairing', body: `Round ${roundNo}, board ${pair.boardNo}: you play White.`, link });
      await notify(tx, pair.blackId, { type: 'tournament_pairing', title: 'Tournament pairing', body: `Round ${roundNo}, board ${pair.boardNo}: you play Black.`, link });
    }
    if (bye) {
      await tx.query(
        `UPDATE tournament_entries SET points = points + 2 WHERE tournament_id = $1 AND user_id = $2`,
        [tournament.id, bye],
      );
      await notify(tx, bye, { type: 'tournament_bye', title: 'Tournament bye', body: `Round ${roundNo}: you received a bye (2 points).`, link: `/tournaments/${tournament.id}` });
    }
    await audit(tx, 'tournament.paired', 'tournament', String(tournament.id), {
      roundNo, pairs: pairs.length, bye, entrants: seeds.length,
    }, { type: 'user', id: actorId });
    this.log.info({ tournamentId: tournament.id, roundNo, pairs: pairs.length, bye }, 'tournament round paired');
  }

  private async pairingsFromTx(tx: Queryable, tournamentId: string, roundNo?: number): Promise<TournamentPairing[]> {
    const params: unknown[] = [tournamentId];
    let clause = '';
    if (roundNo !== undefined) { params.push(roundNo); clause = 'AND tp.round_no = $2'; }
    const result = await tx.query<Row>(`
      SELECT tp.*, wu.username AS white_username, bu.username AS black_username
      FROM tournament_pairings tp
      JOIN users wu ON wu.id = tp.white_id JOIN users bu ON bu.id = tp.black_id
      WHERE tp.tournament_id = $1 ${clause}
      ORDER BY tp.round_no DESC, tp.board_no ASC`, params);
    return result.rows.map((row) => ({
      id: String(row.id), roundNo: Number(row.round_no), boardNo: Number(row.board_no),
      whiteId: String(row.white_id), whiteUsername: String(row.white_username),
      blackId: String(row.black_id), blackUsername: String(row.black_username),
      gameId: row.game_id ? String(row.game_id) : null,
      result: row.result ? String(row.result) : null,
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
  }

  async standings(tournamentId: string): Promise<TournamentStanding[]> {
    const result = await this.db.query<Row>(`
      SELECT row_number() OVER (ORDER BY te.points DESC, p.rating DESC, te.joined_at ASC) AS rank,
             te.user_id, u.username, u.country, u.country_shared, p.rating, te.points, te.status
      FROM tournament_entries te JOIN users u ON u.id = te.user_id
      JOIN profiles p ON p.user_id = te.user_id
      WHERE te.tournament_id = $1 AND te.status = 'active'
      ORDER BY te.points DESC, p.rating DESC`, [tournamentId]);
    return result.rows.map((row) => ({
      rank: Number(row.rank), userId: String(row.user_id), username: String(row.username),
      country: String(row.country), countryShared: Boolean(row.country_shared),
      rating: Number(row.rating), points: Number(row.points), status: String(row.status),
    }));
  }

  async get(tournamentId: string): Promise<{ tournament: TournamentView; standings: TournamentStanding[]; pairings: TournamentPairing[] }> {
    const result = await this.db.query<Row>(`
      SELECT t.*, cu.username AS creator_username,
             (SELECT COUNT(*)::int FROM tournament_entries te
              WHERE te.tournament_id = t.id AND te.status = 'active') AS entrants
      FROM tournaments t JOIN users cu ON cu.id = t.created_by WHERE t.id = $1`, [tournamentId]);
    if (!result.rows.length) throw notFound('Tournament not found');
    return {
      tournament: tournamentFromRow(result.rows[0]),
      standings: await this.standings(tournamentId),
      pairings: await this.pairingsFromTx(this.db, tournamentId),
    };
  }
}
