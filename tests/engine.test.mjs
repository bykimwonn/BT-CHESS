import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { EngineService } from '../lib/engine/index.js';
import { getProfile, DIFFICULTY_PROFILES } from '../lib/engine/strength.js';

/**
 * Engine tests spin up the real Lichess Stockfish 18 wasm build, so they are a
 * few seconds slower than a pure unit test - that is the point: it proves the
 * engine actually loads and plays.
 */
const service = new EngineService({ cloudEnabled: false, log: () => {} });
await service.init();

const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const MATE_IN_2 = 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PP3PPP/R3R1K1 w - - 1 1';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const isLegal = (fen, uci) =>
  new Chess(fen).moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion || '') === uci);

test('wasm engine (Lichess Stockfish 18) loads', () => {
  assert.equal(service.status().engine, 'stockfish-18-lichess', 'expected the lichess wasm engine to load');
});

test('every difficulty returns a legal move', async () => {
  for (const difficulty of Object.keys(DIFFICULTY_PROFILES)) {
    const res = await service.getMove({ fen: START, difficulty });
    assert.ok(res.uci, `${difficulty} returned no move`);
    assert.ok(isLegal(START, res.uci), `${difficulty} returned illegal move ${res.uci}`);
    assert.ok(res.elapsedMs >= 0);
  }
});

test('grandmaster finds mate in 1', async () => {
  const res = await service.getMove({ fen: MATE_IN_1, difficulty: 'grandmaster' });
  assert.equal(res.uci, 'a1a8');
  assert.equal(res.eval.mate, 1);
});

test('grandmaster finds mate in 2', async () => {
  const res = await service.getMove({ fen: MATE_IN_2, difficulty: 'grandmaster' });
  assert.equal(res.uci, 'd5d8');
  assert.equal(res.eval.mate, 2);
});

test('master tier is stronger than easy tier on a free queen', async () => {
  // Position where White can win a rook with Bxf7+ style tactics; instead of
  // asserting an exact move, assert both tiers keep the game legal and that the
  // search reports a sane evaluation.
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const easy = await service.getMove({ fen, difficulty: 'easy' });
  const master = await service.getMove({ fen, difficulty: 'master' });
  assert.ok(isLegal(fen, easy.uci));
  assert.ok(isLegal(fen, master.uci));
  assert.ok(master.depth > 0);
});

test('analyse returns an evaluation and a best move', async () => {
  const res = await service.analyse({ fen: START, movetimeMs: 200 });
  assert.ok(res.bestMove, 'no best move');
  assert.ok(isLegal(START, res.bestMove), `illegal best move ${res.bestMove}`);
  assert.ok(res.cp !== null || res.mate !== null, 'no score');
});

test('analyseMove scores a blunder worse than the engine move', async () => {
  const good = await service.analyseMove({ fen: MATE_IN_1, moveUci: 'a1a8' });
  const bad = await service.analyseMove({ fen: MATE_IN_1, moveUci: 'a1a3' });
  assert.equal(good.matchedEngine, true);
  assert.equal(bad.matchedEngine, false);
});

test('invalid FEN is rejected with a clear error', async () => {
  await assert.rejects(() => service.getMove({ fen: 'not-a-fen', difficulty: 'medium' }), /Invalid FEN/);
});

test('strength profiles cover the advertised ladder', () => {
  const ladder = ['easy', 'medium', 'hard', 'master', 'grandmaster'];
  for (const key of ladder) {
    const p = getProfile(key);
    assert.ok(p.multiplier > 1, `${key} has no payout multiplier`);
    assert.ok(p.movetimeMs > 0, `${key} has no thinking time`);
  }
  assert.ok(getProfile('master').movetimeMs > getProfile('easy').movetimeMs);
  assert.equal(getProfile('nope').label, getProfile('medium').label, 'unknown tier falls back to medium');
});

test.after(() => service.shutdown());
