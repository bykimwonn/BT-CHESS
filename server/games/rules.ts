import { Chess, type Move, type Square } from 'chess.js';
import type { GameResult, Termination } from '../../shared/contracts.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface TerminalResult { result: GameResult; termination: Termination }
export type DrawClaim = 'threefold-repetition' | 'fifty-move-rule' | null;

export function validFen(fen: string): boolean {
  try { new Chess(fen); return true; } catch { return false; }
}

export function makeChess(fen = START_FEN): Chess {
  const chess = new Chess();
  if (fen !== START_FEN) chess.load(fen);
  return chess;
}

export function replayMoves(initialFen: string, uciMoves: string[]): Chess {
  const chess = makeChess(initialFen);
  for (const uci of uciMoves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let move;
    try { move = chess.move({ from, to, promotion }); }
    catch { throw new Error(`Persisted move ${uci} is illegal in ${initialFen}`); }
    if (!move) throw new Error(`Persisted move ${uci} is illegal in ${initialFen}`);
  }
  return chess;
}

export function applyMove(chess: Chess, input: { from: string; to: string; promotion?: string }): Move {
  const candidates = chess.moves({ verbose: true }).filter((m) =>
    m.from === input.from && m.to === input.to && (!input.promotion || m.promotion === input.promotion));
  if (!candidates.length) throw new Error('Illegal move');
  return chess.move({ from: input.from, to: input.to, promotion: input.promotion });
}

/**
 * Automatic terminal detection. Threefold repetition and the fifty-move rule
 * are claimable by either player rather than silently ending the game.
 */
export function terminalAfterMove(chess: Chess): TerminalResult | null {
  if (chess.isCheckmate()) return { result: chess.turn() === 'w' ? 'black' : 'white', termination: 'checkmate' };
  if (chess.isStalemate()) return { result: 'draw', termination: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: 'draw', termination: 'insufficient-material' };
  return null;
}

export function claimableDraw(chess: Chess): DrawClaim {
  if (chess.isThreefoldRepetition()) return 'threefold-repetition';
  if (chess.isDrawByFiftyMoves()) return 'fifty-move-rule';
  return null;
}

export function claimToTermination(claim: Exclude<DrawClaim, null>): Termination {
  return claim === 'threefold-repetition' ? 'threefold-repetition' : 'fifty-move-rule';
}

export function legalMovesFrom(chess: Chess, square: string): string[] {
  return chess.moves({ square: square as Square, verbose: true }).map((m) => m.to + (m.promotion ? `=${m.promotion}` : ''));
}

export function allLegalUci(chess: Chess): string[] {
  return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
}

export function pgnWithHeaders(chess: Chess, headers: Record<string, string>): string {
  for (const [key, value] of Object.entries(headers)) chess.setHeader(key, value);
  return chess.pgn();
}

export { capturedPieces } from '../../shared/contracts.js';

export function colorToSide(color: 'w' | 'b'): 'white' | 'black' { return color === 'w' ? 'white' : 'black'; }

export function resultForWinner(color: 'w' | 'b' | null): GameResult {
  return color === 'w' ? 'white' : color === 'b' ? 'black' : 'draw';
}
