import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIDE, expectedScore, fideKFactor, fidePeriodK, fideRatingChange, fideRatingDifference,
  isJunior, roundHalfAwayFromZero,
} from '../../shared/rating.js';

const adult = (rating: number, ratedGames = 100, peakRating = rating) => ({ rating, ratedGames, peakRating });

test('K follows the FIDE brackets: new, established, master', () => {
  assert.equal(fideKFactor({ rating: 1500, ratedGames: 0 }), 40, 'new to the list');
  assert.equal(fideKFactor({ rating: 1500, ratedGames: 29 }), 40, 'still new at 29 games');
  assert.equal(fideKFactor({ rating: 1500, ratedGames: 30 }), 20, 'established at 30 games');
  assert.equal(fideKFactor(adult(2399)), 20);
  assert.equal(fideKFactor(adult(2400)), 10, 'reaching 2400 drops K for good');
  assert.equal(fideKFactor({ rating: 2380, ratedGames: 200, peakRating: 2410 }), 10,
    'a published 2400 keeps K = 10 after the rating falls back');
});

test('juniors keep K = 40 under 2300 until the end of their 18th-birthday year', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const birthYear = 2010; // turns 16 in 2026
  assert.equal(isJunior(birthYear, now), true);
  assert.equal(isJunior(2000, now), false);
  assert.equal(fideKFactor({ rating: 1800, ratedGames: 200, birthYear }, now), 40);
  assert.equal(fideKFactor({ rating: 2350, ratedGames: 200, birthYear }, now), 20,
    'juniors at or above 2300 use the standard coefficient');
  assert.equal(fideKFactor({ rating: 1800, ratedGames: 200 }, now), 20, 'no year of birth, no junior rule');
  // Born 2009, 18th birthday falls in 2027, so 2027 is still a junior year.
  assert.equal(isJunior(2009, new Date('2027-01-01T00:00:00Z')), true, 'the whole calendar year counts');
  assert.equal(isJunior(2009, new Date('2027-12-31T23:59:59Z')), true);
  assert.equal(isJunior(2008, new Date('2027-01-01T00:00:00Z')), false, 'the year after their 18th is not junior');
});

test('the 400-point rule applies below 2650 and not at the top', () => {
  assert.equal(fideRatingDifference(1500, 2200), 400);
  assert.equal(fideRatingDifference(1500, 1100), -400);
  assert.equal(fideRatingDifference(1600, 1900), 300);
  assert.equal(fideRatingDifference(2650, 2200), -450, 'full difference from 2650');
  assert.equal(fideRatingDifference(2700, 2200), -500);
  assert.ok(Math.abs(expectedScore(1500, 2200) - 1 / 11) < 1e-12, 'capped difference gives 1/11');
});

test('a symmetric game is worth exactly half the K-factor', () => {
  const change = fideRatingChange(adult(1500), 1500, 1);
  assert.equal(change.k, 20);
  assert.equal(change.expected, 0.5);
  assert.equal(change.delta, 10);
  assert.equal(change.ratingAfter, 1510);
  assert.equal(fideRatingChange(adult(1500), 1500, 0.5).delta, 0);
  assert.equal(fideRatingChange(adult(1500), 1500, 0).delta, -10);
});

test('a first game is worth K = 40 to a new player', () => {
  const change = fideRatingChange({ rating: FIDE.seed, ratedGames: 0 }, FIDE.seed, 1);
  assert.equal(change.k, 40);
  assert.equal(change.delta, 20);
  assert.equal(change.ratingAfter, FIDE.seed + 20);
});

test('changes round to the nearest whole number, .5 away from zero', () => {
  assert.equal(roundHalfAwayFromZero(4.5), 5);
  assert.equal(roundHalfAwayFromZero(-4.5), -5);
  assert.equal(roundHalfAwayFromZero(9.49), 9);
  assert.equal(roundHalfAwayFromZero(-9.51), -10);
  assert.equal(roundHalfAwayFromZero(0), 0);
});

test('a player at 2650+ uses the true gap while a lower-rated one is capped', () => {
  // A draw against a 650-point stronger opponent. Capped at 400 the expected
  // score is 1/11 and the draw is worth +4; uncapped it is worth +5.
  const capped = fideRatingChange(adult(2649), 3299, 0.5);
  assert.equal(capped.delta, 4, 'a 2649 player still sees the 400-point cap');
  const uncapped = fideRatingChange(adult(2700), 3350, 0.5);
  assert.equal(uncapped.delta, 5, 'from 2650 the true difference counts');
});

test('the rating period ceiling limits K × n to 700', () => {
  assert.equal(fidePeriodK(40, 17), 40, '40 × 17 = 680 is fine');
  assert.equal(fidePeriodK(40, 18), 38, '40 × 18 exceeds 700, so K drops');
  assert.equal(fidePeriodK(20, 20), 20);
  assert.equal(fidePeriodK(40, 50), 14);
  const change = fideRatingChange({ rating: 1500, ratedGames: 20, gamesThisPeriod: 20 }, 1500, 1);
  assert.equal(change.k, 33, 'a 21st game this month reduces K from 40 to 33');
  assert.equal(fideRatingChange({ rating: 1500, ratedGames: 20 }, 1500, 1).k, 40,
    'without a period count the base coefficient is used');
});

test('the published rating never falls below 1400', () => {
  const nearFloor = fideRatingChange({ rating: 1401, ratedGames: 100, peakRating: 1401 }, 1700, 0);
  assert.equal(nearFloor.ratingAfter, FIDE.floor);
  assert.equal(nearFloor.atFloor, true);
  const above = fideRatingChange({ rating: 1600, ratedGames: 100 }, 1600, 0);
  assert.equal(above.atFloor, false);
  assert.equal(above.ratingAfter, 1590);
});
