'use strict';

/**
 * Elo rating engine.
 *
 * The rating system is pure and side-effect-free: it takes the two players'
 * ratings, the result and the number of rated games each has played, and
 * returns the new ratings plus the deltas. Everything in the game layer
 * (server.js) stays declarative - it calls `updateElo()` after a decisive
 * result and persists what comes back.
 *
 * Notes on the choices here:
 *
 *  - Expected score is the standard logistic curve 1 / (1 + 10^((Rb-Ra)/400)).
 *  - K depends on experience (FIDE style) so a new player's rating converges
 *    fast and an established player's rating moves slowly:
 *        provisional (< 25 rated games) -> 40,
 *        established                    -> 24.
 *    Rated games against the engine count toward the provisional counter.
 *  - Provisional ratings are shown with a `?` in the UI until the player has
 *    played PROVISIONAL_GAMES rated games.
 *  - The rating delta returned for the *player* is always what a casual chess
 *    app shows ("+8", "-5") even when the engine side is a fixed-AI opponent
 *    whose rating never changes.
 */

const START_RATING = 1200;
const MIN_RATING = 100;
const PROVISIONAL_GAMES = 25;
const K_PROVISIONAL = 40;
const K_ESTABLISHED = 24;

/** Result score from player A's point of view: 1 win, 0 loss, 0.5 draw. */
const SCORE = { win: 1, loss: 0, draw: 0.5 };

function kFactorFor(ratedGames = 0) {
  return ratedGames < PROVISIONAL_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
}

/** Expected score of player A in an A-vs-B pairing. */
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (Number(ratingB) - Number(ratingA)) / 400));
}

/**
 * Update two human players' ratings after a game.
 *
 * @param {object} a            player A: { rating, ratedGames?, name? }
 * @param {object} b            player B: { rating, ratedGames?, name? }
 * @param {string} resultForA   'win' | 'loss' | 'draw' (A's result)
 * @returns {{a:{rating:number,delta:number},b:{rating:number,delta:number}}}
 */
function updateElo(a, b, resultForA) {
  const scoreA = resultForA === 'win' ? SCORE.win : resultForA === 'loss' ? SCORE.loss : SCORE.draw;
  const scoreB = 1 - scoreA;
  const expA = expectedScore(a.rating, b.rating);
  const expB = 1 - expA;
  const kA = kFactorFor(a.ratedGames);
  const kB = kFactorFor(b.ratedGames);
  const deltaA = Math.round(kA * (scoreA - expA));
  const deltaB = Math.round(kB * (scoreB - expB));
  return {
    a: { rating: Math.max(MIN_RATING, Math.round(a.rating) + deltaA), delta: deltaA },
    b: { rating: Math.max(MIN_RATING, Math.round(b.rating) + deltaB), delta: deltaB },
  };
}

/**
 * Rating change for a human playing against a fixed-strength engine tier.
 * The engine's "rating" never moves (it is a piece of software, not a player),
 * so we return the human's delta only.
 *
 * Beating a much stronger tier pays more Elo; losing to a much weaker one
 * costs more - standard expectations.
 *
 * @param {object} player      { rating, ratedGames? }
 * @param {number} engineElo   the tier's target Elo (see strength profiles)
 * @param {string} result      'win' | 'loss' | 'draw'
 */
function vsEngine(player, engineElo, result) {
  const exp = expectedScore(player.rating, engineElo);
  const score = result === 'win' ? SCORE.win : result === 'loss' ? SCORE.loss : SCORE.draw;
  const k = kFactorFor(player.ratedGames);
  const delta = Math.round(k * (score - exp));
  return {
    rating: Math.max(MIN_RATING, Math.round(player.rating) + delta),
    delta,
    expected: Number(exp.toFixed(3)),
  };
}

/** Puzzle/tactic rating uses its own tighter K so it moves half as fast as games. */
function puzzleDelta(puzzleRating, puzzleDifficulty, solved) {
  const exp = expectedScore(puzzleRating, puzzleDifficulty);
  const score = solved ? 1 : 0;
  const k = 16;
  return Math.round(k * (score - exp));
}

/** True while a player has fewer than PROVISIONAL_GAMES rated games. */
function isProvisional(ratedGames = 0) {
  return ratedGames < PROVISIONAL_GAMES;
}

/** Coarse skill tier labels for the UI (lichess-style bands). */
function ratingBand(rating) {
  const r = Number(rating) || START_RATING;
  if (r < 600) return { label: 'Novice', color: '#94a3b8' };
  if (r < 1000) return { label: 'Beginner', color: '#7dd3fc' };
  if (r < 1400) return { label: 'Casual', color: '#34d399' };
  if (r < 1700) return { label: 'Club', color: '#a3e635' };
  if (r < 2000) return { label: 'Expert', color: '#fbbf24' };
  if (r < 2300) return { label: 'Master', color: '#fb923c' };
  return { label: 'Grandmaster', color: '#c084fc' };
}

/** Short summary string like "1240 ±40 • provisional". */
function describe(rating, ratedGames) {
  const band = ratingBand(rating);
  const k = kFactorFor(ratedGames);
  return `${Math.round(rating)} ${isProvisional(ratedGames) ? '?' : ''} · ${band.label}${isProvisional(ratedGames) ? ` · K${k}` : ''}`;
}

module.exports = {
  START_RATING,
  MIN_RATING,
  PROVISIONAL_GAMES,
  K_PROVISIONAL,
  K_ESTABLISHED,
  kFactorFor,
  expectedScore,
  updateElo,
  vsEngine,
  puzzleDelta,
  isProvisional,
  ratingBand,
  describe,
};
