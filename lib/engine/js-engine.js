'use strict';

/**
 * Pure-JavaScript fallback engine.
 *
 * This is the last line of defence: if the Stockfish wasm module cannot load
 * (ancient runtime, missing files, ...) the app must still be able to play, so
 * we ship a small negamax + alpha-beta + quiescence searcher. It is nowhere
 * near Stockfish, but it is far stronger than the "grab the biggest piece"
 * heuristic this repo used before and it has zero dependencies.
 */

const { Chess } = require('chess.js');

const MATE = 100000;
const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Standard "simplified evaluation function" tables, written from White's point
// of view with rank 8 first.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

function squareIndex(sq, color) {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49; // 0..7
  return color === 'w' ? (7 - rank) * 8 + file : rank * 8 + file;
}

function evaluate(chess) {
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const table = PST[piece.type] || null;
      const pst = table ? table[squareIndex(piece.square || fileRank(f, r), piece.color)] : 0;
      const value = PIECE_VALUE[piece.type] + pst;
      score += piece.color === 'w' ? value : -value;
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

function fileRank(f, r) {
  return String.fromCharCode(97 + f) + (8 - r);
}

const TIME_UP = Symbol('time-up');

class JsEngine {
  constructor() {
    this.nodes = 0;
  }

  /**
   * @param {object} opts
   * @param {string} opts.fen
   * @param {number} [opts.movetimeMs]
   * @param {number} [opts.depth]  0 = decide from the time budget
   * @param {number} [opts.skill]  0..20 (mapped onto search depth)
   * @returns {{uci: string|null, cp: number|null, mate: number|null, pv: string[], depth: number, nodes: number}}
   */
  search({ fen, movetimeMs = 400, depth = 0, skill = 20 }) {
    const chess = new Chess(fen);
    const legal = chess.moves({ verbose: true });
    if (!legal.length) return { uci: null, cp: null, mate: null, pv: [], depth: 0, nodes: 0 };

    const maxDepth = depth > 0 ? depth : Math.max(2, Math.min(5, 1 + Math.floor(skill / 5)));
    const deadline = Date.now() + Math.max(50, movetimeMs);
    this.nodes = 0;
    this.deadline = deadline;

    let best = legal[0];
    let bestScore = -Infinity;
    let bestPv = [];
    let reachedDepth = 0;

    try {
      for (let d = 1; d <= maxDepth; d++) {
        const result = this._searchRoot(chess, d, deadline);
        best = result.move || best;
        bestScore = result.score;
        bestPv = result.pv;
        reachedDepth = d;
        if (Math.abs(bestScore) > MATE - 1000) break; // mate found
        if (Date.now() > deadline) break;
      }
    } catch (e) {
      if (e !== TIME_UP) throw e;
    }

    const uci = best ? best.from + best.to + (best.promotion || '') : null;
    return {
      uci,
      cp: Math.abs(bestScore) > MATE - 1000 ? null : Math.round(bestScore),
      mate: Math.abs(bestScore) > MATE - 1000 ? this._mateDistance(bestScore) : null,
      pv: bestPv,
      depth: reachedDepth,
      nodes: this.nodes,
    };
  }

  _mateDistance(score) {
    const plies = MATE - Math.abs(score);
    const moves = Math.ceil(plies / 2);
    return score > 0 ? moves : -moves;
  }

  _checkClock(deadline) {
    if ((this.nodes & 1023) === 0 && Date.now() > deadline) throw TIME_UP;
  }

  _searchRoot(chess, depth, deadline) {
    const moves = this._orderedMoves(chess, null);
    let bestScore = -Infinity;
    let bestMove = null;
    let bestPv = [];
    let alpha = -Infinity;

    for (const move of moves) {
      this.nodes++;
      this._checkClock(deadline);
      chess.move(move);
      const score = -this._negamax(chess, depth - 1, -Infinity, -alpha, deadline, 1);
      const pv = this._pvLine(chess, depth - 1, deadline);
      chess.undo();
      const line = [move.from + move.to + (move.promotion || ''), ...pv];
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        bestPv = line;
        if (score > alpha) alpha = score;
      }
    }
    return { move: bestMove, score: bestScore, pv: bestPv };
  }

  _pvLine() {
    // Full PV collection is expensive; the root line plus the best move is
    // enough for this fallback engine.
    return [];
  }

  _negamax(chess, depth, alpha, beta, deadline, ply) {
    this.nodes++;
    this._checkClock(deadline);

    if (chess.isGameOver()) {
      if (chess.isCheckmate()) return -MATE + ply;
      return 0; // draw / stalemate
    }
    if (depth <= 0) return this._quiescence(chess, alpha, beta, deadline, ply);

    const moves = this._orderedMoves(chess, null);
    let best = -Infinity;
    for (const move of moves) {
      chess.move(move);
      const score = -this._negamax(chess, depth - 1, -beta, -alpha, deadline, ply + 1);
      chess.undo();
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  _quiescence(chess, alpha, beta, deadline, ply) {
    this.nodes++;
    this._checkClock(deadline);
    let stand = evaluate(chess);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    const captures = this._orderedMoves(chess, true);
    for (const move of captures) {
      chess.move(move);
      const score = -this._quiescence(chess, -beta, -alpha, deadline, ply + 1);
      chess.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  _orderedMoves(chess, capturesOnly) {
    const moves = chess.moves({ verbose: true });
    const scored = [];
    for (const move of moves) {
      const isCapture = !!move.captured;
      const isPromotion = !!move.promotion;
      if (capturesOnly && !isCapture && !isPromotion) continue;
      let score = 0;
      if (isCapture) {
        const victim = PIECE_VALUE[move.captured] || 0;
        const attacker = PIECE_VALUE[move.piece] || 0;
        score += 10000 + victim * 10 - attacker; // MVV-LVA
      }
      if (isPromotion) score += 8000 + (PIECE_VALUE[move.promotion] || 0);
      scored.push({ move, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.move);
  }
}

module.exports = { JsEngine, evaluate, MATE };
