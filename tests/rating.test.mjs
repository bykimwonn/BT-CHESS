/**
 * Rating engine tests — the Elo math that backs rated ladder games, PvP and
 * the tactics trainer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedScore, updateElo, vsEngine, puzzleDelta,
  isProvisional, ratingBand, START_RATING, PROVISIONAL_GAMES, kFactorFor,
} from '../lib/rating.js';

test('expected score is 0.5 for equal ratings and 1 against a minimum-rated opponent', () => {
  assert.equal(expectedScore(1500, 1500), 0.5);
  assert.ok(expectedScore(1500, 100) > 0.99);
  assert.ok(expectedScore(100, 1500) < 0.01);
});

test('equal-rated players split rating points on a win (newcomer K=40)', () => {
  const res = updateElo(
    { rating: 1200, ratedGames: 0 },
    { rating: 1200, ratedGames: 0 },
    'win',
  );
  assert.equal(res.a.delta, 20);
  assert.equal(res.b.delta, -20);
  assert.equal(res.a.rating, 1220);
  assert.equal(res.b.rating, 1180);
});

test('draw between equal players changes nothing', () => {
  const res = updateElo(
    { rating: 1500, ratedGames: 40 },
    { rating: 1500, ratedGames: 40 },
    'draw',
  );
  assert.equal(res.a.delta, 0);
  assert.equal(res.b.delta, 0);
});

test('established players use a lower K factor', () => {
  assert.equal(kFactorFor(0), 40);
  assert.equal(kFactorFor(PROVISIONAL_GAMES - 1), 40);
  assert.equal(kFactorFor(PROVISIONAL_GAMES), 24);
});

test('beating a much stronger engine pays more Elo than beating an easy one', () => {
  const beatGM = vsEngine({ rating: 1200, ratedGames: 30 }, 2850, 'win');
  const beatEasy = vsEngine({ rating: 1200, ratedGames: 30 }, 800, 'win');
  assert.ok(beatGM.delta > beatEasy.delta, `GM ${beatGM.delta} vs easy ${beatEasy.delta}`);
  assert.ok(beatGM.delta >= 20);
});

test('losing to a much weaker engine costs more Elo', () => {
  const lostToEasy = vsEngine({ rating: 1500, ratedGames: 30 }, 800, 'loss');
  const lostToGM = vsEngine({ rating: 1500, ratedGames: 30 }, 2850, 'loss');
  assert.ok(lostToEasy.delta < lostToGM.delta, `easy ${lostToEasy.delta} vs GM ${lostToGM.delta}`);
  assert.ok(lostToEasy.delta <= -20);
  assert.ok(lostToGM.delta >= -2); // expected to lose to GM — barely moves
});

test('rating never drops below the floor and provisional flag works', () => {
  const r = vsEngine({ rating: 100, ratedGames: 0 }, 2850, 'loss');
  assert.ok(r.rating >= 100);
  assert.equal(isProvisional(0), true);
  assert.equal(isProvisional(PROVISIONAL_GAMES), false);
});

test('new players start at the canonical starting rating', () => {
  assert.equal(START_RATING, 1200);
  assert.equal(ratingBand(1200).label, 'Casual');
  assert.equal(ratingBand(900).label, 'Beginner');
  assert.equal(ratingBand(2100).label, 'Master');
  assert.equal(ratingBand(2400).label, 'Grandmaster');
});

test('puzzle deltas are small and positive for a solve, negative for a miss', () => {
  const solved = puzzleDelta(1200, 1500, true);
  const missed = puzzleDelta(1200, 1500, false);
  assert.ok(solved > 0);
  assert.ok(missed < 0);
  assert.ok(solved <= 16); // puzzle K is tight
});
