import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  START_FEN, validFen, makeChess, replayMoves, applyMove, terminalAfterMove,
  claimableDraw, allLegalUci, capturedPieces, pgnWithHeaders,
} from '../../server/games/rules.js';

test('FEN validation and replay reconstruct a legal position', () => {
  assert.equal(validFen(START_FEN), true);
  assert.equal(validFen('not a fen'), false);
  const chess = replayMoves(START_FEN, ['e2e4', 'e7e5', 'g1f3']);
  assert.equal(chess.fen().split(' ')[1], 'b');
  assert.equal(chess.history().join(' '), 'e4 e5 Nf3');
  assert.throws(() => replayMoves(START_FEN, ['e2e5']), /illegal/);
});

test('checkmate, stalemate and insufficient material are terminal', () => {
  const mate = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
  mate.move('a1a8');
  assert.equal(mate.isCheckmate(), true);
  assert.deepEqual(terminalAfterMove(mate), { result: 'white', termination: 'checkmate' });
  const stalemate = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
  assert.deepEqual(terminalAfterMove(makeChess(stalemate)), { result: 'draw', termination: 'stalemate' });
  const insufficient = '8/8/4k3/8/8/4K3/8/8 w - - 0 1';
  assert.deepEqual(terminalAfterMove(makeChess(insufficient)), { result: 'draw', termination: 'insufficient-material' });
});

test('threefold repetition and fifty-move rule are claimable', () => {
  const chess = new Chess();
  for (let i = 0; i < 2; i++) {
    chess.move('Nf3'); chess.move('Nf6'); chess.move('Ng1'); chess.move('Ng8');
  }
  assert.equal(claimableDraw(chess), 'threefold-repetition');
  const fifty = '8/8/8/4k3/8/4K3/8/7R w - - 100 80';
  assert.equal(validFen(fifty), true);
  assert.equal(claimableDraw(makeChess(fifty)), 'fifty-move-rule');
});

test('promotion is required on the last rank and produces legal SAN/PGN', () => {
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const chess = makeChess(fen);
  assert.equal(allLegalUci(chess).length > 0, true);
  const promotionPosition = makeChess('7k/P7/8/8/8/8/8/7K w - - 0 1');
  const move = applyMove(promotionPosition, { from: 'a7', to: 'a8', promotion: 'q' });
  assert.equal(move.san, 'a8=Q+');
  const pgn = pgnWithHeaders(promotionPosition, { White: 'Alice', Black: 'Bob' });
  assert.match(pgn, /\[White "Alice"\]/);
  assert.match(pgn, /a8=Q/);
});

test('shipped puzzle solutions are genuine mate-in-one positions', () => {
  const puzzles = [
    ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8'],
    ['6k1/5ppp/8/8/8/8/5PPP/2R3K1 w - - 0 1', 'c1c8'],
    ['6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8'],
    ['7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', 'f7g7'],
    ['1r4k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1', 'b1b8'],
  ];
  for (const [fen, uci] of puzzles) {
    const chess = makeChess(fen);
    const move = chess.move({ from: uci.slice(0, 2) as never, to: uci.slice(2, 4) as never });
    assert.ok(move, `${fen} solution ${uci} should be legal`);
    assert.equal(chess.isCheckmate(), true, `${fen} solution ${uci} should be checkmate`);
  }
});

test('captured pieces reflect missing material', () => {
  const captures = capturedPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(captures.white, ['wP']);
  assert.deepEqual(captures.black, []);
});
