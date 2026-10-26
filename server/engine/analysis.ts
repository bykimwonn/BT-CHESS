import { START_FEN } from '../games/rules.js';
import type { Database } from '../db/client.js';
import type { AppLogger } from '../services/logger.js';
import { adminAction } from '../services/audit.js';
import { uuid } from '../services/ids.js';
import type { GameService } from '../games/service.js';
import type { EngineService } from './service.js';

export interface MoveQuality {
  ply: number;
  san: string;
  uci: string;
  bestMove: string | null;
  bestScoreCp: number | null;
  playedScoreCp: number | null;
  lossCp: number | null;
  quality: 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'not-analysed';
  depth: number;
  engine: string | null;
}

export interface GameAnalysis {
  gameId: string;
  engine: string | null;
  moves: MoveQuality[];
  summary: {
    white: { averageLossCp: number | null; blunders: number; inaccuracies: number };
    black: { averageLossCp: number | null; blunders: number; inaccuracies: number };
  };
  note: string;
}

function mateToCp(mate: number | null, cp: number | null): number | null {
  if (cp !== null) return cp;
  if (mate === null) return null;
  return mate > 0 ? 100_000 - mate * 100 : -100_000 - mate * 100;
}

function classify(lossCp: number): MoveQuality['quality'] {
  if (lossCp <= 10) return 'best';
  if (lossCp <= 35) return 'excellent';
  if (lossCp <= 80) return 'good';
  if (lossCp <= 150) return 'inaccuracy';
  if (lossCp <= 300) return 'mistake';
  return 'blunder';
}

function sideSummary(moves: MoveQuality[], color: 'w' | 'b') {
  const own = moves.filter((m, index) => (index % 2 === 0 ? 'w' : 'b') === color && m.lossCp !== null);
  const averageLossCp = own.length ? Math.round(own.reduce((sum, m) => sum + (m.lossCp ?? 0), 0) / own.length) : null;
  return {
    averageLossCp,
    blunders: own.filter((m) => m.quality === 'blunder').length,
    inaccuracies: own.filter((m) => m.quality === 'inaccuracy').length,
  };
}

export class AnalysisService {
  constructor(
    private readonly db: Database,
    private readonly games: GameService,
    private readonly engine: EngineService,
    private readonly log: AppLogger,
  ) {}

  async analyseGame(gameId: string, options: { depth?: number; timeMs?: number; maxMoves?: number } = {}): Promise<GameAnalysis> {
    const snapshot = await this.games.getSnapshot(gameId);
    if (snapshot.initialFen !== START_FEN) {
      // Custom starting positions are not currently created by the game service;
      // analysis would need the full move list from the persisted initial FEN.
      throw new Error('Analysis of non-standard starting positions is not available');
    }
    const history = snapshot.moves.slice(0, Math.min(options.maxMoves ?? 40, 60));
    const depth = Math.min(options.depth ?? 10, 18);
    const timeMs = Math.min(options.timeMs ?? 350, 2_000);
    const qualities: MoveQuality[] = [];
    let engineName: string | null = null;
    for (let i = 0; i < history.length; i++) {
      const played = history[i];
      const beforeMoves = history.slice(0, i).map((m) => m.uci);
      try {
        const before = await this.engine.analyse({
          fen: START_FEN, moves: beforeMoves, depth, timeMs, multipv: 2,
        });
        engineName = before.engine;
        const bestScore = mateToCp(before.mate, before.scoreCp);
        let playedScore = mateToCp(
          before.lines.find((l) => l.pv[0] === played.uci)?.mate ?? null,
          before.lines.find((l) => l.pv[0] === played.uci)?.scoreCp ?? null,
        );
        if (playedScore === null) {
          const after = await this.engine.analyse({
            fen: START_FEN, moves: [...beforeMoves, played.uci], depth, timeMs,
          });
          const afterScore = mateToCp(after.mate, after.scoreCp);
          playedScore = afterScore === null ? null : -afterScore;
        }
        const lossCp = bestScore !== null && playedScore !== null ? Math.max(0, bestScore - playedScore) : null;
        qualities.push({
          ply: played.ply, san: played.san, uci: played.uci,
          bestMove: before.bestMove, bestScoreCp: bestScore, playedScoreCp: playedScore,
          lossCp, quality: lossCp === null ? 'not-analysed' : classify(lossCp),
          depth: before.depth, engine: before.engine,
        });
      } catch (error) {
        this.log.warn({ gameId, ply: played.ply, err: (error as Error).message }, 'move analysis failed');
        qualities.push({
          ply: played.ply, san: played.san, uci: played.uci,
          bestMove: null, bestScoreCp: null, playedScoreCp: null, lossCp: null,
          quality: 'not-analysed', depth: 0, engine: null,
        });
      }
    }
    return {
      gameId, engine: engineName, moves: qualities,
      summary: { white: sideSummary(qualities, 'w'), black: sideSummary(qualities, 'b') },
      note: 'Evaluations come from the GPL-licensed Stockfish WASM engine. Engine similarity is a signal, not proof of cheating, and never triggers an automatic sanction.',
    };
  }

  /** Administrative fair-play signal generation. All sanctions require human review. */
  async runFairPlayReview(gameId: string, actorId: string): Promise<{ reviewId: string; gameId: string; signals: unknown[]; requiresHumanReview: boolean }> {
    const snapshot = await this.games.getSnapshot(gameId);
    const analysis = await this.analyseGame(gameId, { depth: 14, timeMs: 600, maxMoves: 40 });
    const signals: Array<{ userId: string; score: number; detail: Record<string, unknown> }> = [];
    for (const [color, userId, summary] of [
      ['white', snapshot.white.userId, analysis.summary.white],
      ['black', snapshot.black.userId, analysis.summary.black],
    ] as const) {
      const moves = analysis.moves.filter((_, i) => (i % 2 === 0 ? 'white' : 'black') === color);
      const analysed = moves.filter((m) => m.bestMove !== null);
      const engineMatches = analysed.filter((m) => m.bestMove === m.uci).length;
      const matchRate = analysed.length ? engineMatches / analysed.length : 0;
      const averageLoss = summary.averageLossCp;
      // A deliberately conservative composite signal. Exact weights are not
      // returned in player-facing responses.
      const lossComponent = averageLoss === null ? 0 : Math.max(0, 1 - averageLoss / 120);
      const score = Math.round(Math.min(100, (matchRate * 0.65 + lossComponent * 0.35) * 100));
      await this.games.fairPlaySignal(gameId, userId, 'engine_similarity', score, {
        analysedMoves: analysed.length, engineMatches, averageLossCp: averageLoss,
        depth: 14, engine: analysis.engine,
      });
      signals.push({ userId, score, detail: { analysedMoves: analysed.length, engineMatches, averageLossCp: averageLoss } });
    }
    const requiresHumanReview = signals.some((s) => s.score >= 80);
    const reviewId = uuid();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO match_reviews (id, game_id, status, reason) VALUES ($1,$2,'open',$3)`,
        [reviewId, gameId, 'Administrative engine-similarity review requested'],
      );
      await adminAction(tx, {
        actorId, action: 'fair_play.review', targetType: 'game', targetId: gameId,
        reason: 'Engine-analysis signal generation for human review',
        outcome: requiresHumanReview ? 'flagged for review' : 'no elevated signal',
        metadata: { reviewId, signals },
      });
    });
    return { reviewId, gameId, signals, requiresHumanReview };
  }
}
