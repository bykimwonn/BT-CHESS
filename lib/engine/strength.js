'use strict';

/**
 * Difficulty -> engine strength mapping.
 *
 * The app sells "beat the engine" bets, so every tier must map to something
 * reproducible on the engine side:
 *
 *   - `skill`          Stockfish `Skill Level` (0..20). Low values make SF pick
 *                      sub-optimal moves in its own search.
 *   - `limitStrength`  Enables Stockfish `UCI_LimitStrength` + `UCI_Elo`.
 *   - `elo`            Target Elo used when `limitStrength` is on (SF clamps to 1320..3190).
 *   - `movetimeMs`     How long the engine thinks.
 *   - `depth`          Hard depth cap (0 = no cap, rely on movetime).
 *   - `multiPv`        How many candidate moves we ask for.
 *   - `pickRank`       Which PV line to play (1 = best). >1 only for weak tiers,
 *                      combined with `blunderChance` it makes the engine beatable.
 *   - `blunderChance`  Probability of deliberately playing a worse move.
 *   - `fullStrength`   True for tiers that should play the objectively best move
 *                      (these are the only tiers allowed to use the Lichess
 *                      cloud eval, which is always full strength).
 */

const DIFFICULTY_PROFILES = {
  easy: {
    label: 'Easy',
    elo: 800,
    multiplier: 1.6,
    color: '#81b64c',
    desc: 'Beginner',
    skill: 0,
    limitStrength: false,
    targetElo: null,
    movetimeMs: 120,
    depth: 4,
    multiPv: 4,
    pickRank: 3,
    blunderChance: 0.35,
    fullStrength: false,
  },
  medium: {
    label: 'Medium',
    elo: 1250,
    multiplier: 2.5,
    color: '#f1c40f',
    desc: 'Casual',
    skill: 6,
    limitStrength: false,
    targetElo: null,
    movetimeMs: 250,
    depth: 8,
    multiPv: 3,
    pickRank: 2,
    blunderChance: 0.18,
    fullStrength: false,
  },
  hard: {
    label: 'Hard',
    elo: 1800,
    multiplier: 4.2,
    color: '#e67e22',
    desc: 'Club',
    skill: 20,
    limitStrength: true,
    targetElo: 1800,
    movetimeMs: 500,
    depth: 0,
    multiPv: 1,
    pickRank: 1,
    blunderChance: 0.05,
    fullStrength: false,
  },
  master: {
    label: 'Master',
    elo: 2400,
    multiplier: 8.0,
    color: '#e74c3c',
    desc: 'Master + Jackpot',
    skill: 20,
    limitStrength: true,
    targetElo: 2400,
    movetimeMs: 800,
    depth: 0,
    multiPv: 1,
    pickRank: 1,
    blunderChance: 0,
    fullStrength: true,
  },
  grandmaster: {
    label: 'Grandmaster',
    elo: 2850,
    multiplier: 15.0,
    color: '#9b59b6',
    desc: '15x + Jackpot!',
    skill: 20,
    limitStrength: true,
    targetElo: 2850,
    movetimeMs: 1200,
    depth: 0,
    multiPv: 1,
    pickRank: 1,
    blunderChance: 0,
    fullStrength: true,
  },
};

const DEFAULT_DIFFICULTY = 'medium';

function getProfile(difficulty) {
  return DIFFICULTY_PROFILES[difficulty] || DIFFICULTY_PROFILES[DEFAULT_DIFFICULTY];
}

/** Subset that is safe to ship to the browser (no engine internals we care about, but keep it small). */
function publicProfiles() {
  const out = {};
  for (const [key, p] of Object.entries(DIFFICULTY_PROFILES)) {
    out[key] = {
      label: p.label,
      elo: p.elo,
      multiplier: p.multiplier,
      color: p.color,
      desc: p.desc,
      movetimeMs: p.movetimeMs,
      fullStrength: p.fullStrength,
    };
  }
  return out;
}

module.exports = { DIFFICULTY_PROFILES, DEFAULT_DIFFICULTY, getProfile, publicProfiles };
