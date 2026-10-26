/**
 * Opponent strength ladder for practice against the bundled Stockfish build.
 *
 * The numbers are deliberately conservative and honest: they describe what the
 * engine is allowed to do (UCI `Skill Level`, search depth, think time and the
 * chance of a deliberate weak move), not a measured Elo. The label is a familiar
 * anchor for a human player, not a rating claim, and practice games never touch
 * the rated leaderboard or any wallet.
 */
export interface EngineLevel {
  /** 1 = easiest, 8 = strongest. */
  id: number;
  name: string;
  /** Familiar strength anchor shown next to the name. */
  rating: number;
  /** UCI `Skill Level`, 0-20. */
  skill: number;
  depth: number;
  timeMs: number;
  /** Probability of playing a random legal move instead of the engine's choice. */
  blunderChance: number;
  note: string;
}

export const ENGINE_LEVELS: readonly EngineLevel[] = [
  { id: 1, name: 'Beginner', rating: 400, skill: 0, depth: 1, timeMs: 120, blunderChance: 0.35, note: 'Plays almost at random and gives pieces away. Learn how the pieces move.' },
  { id: 2, name: 'Casual', rating: 700, skill: 2, depth: 2, timeMs: 200, blunderChance: 0.25, note: 'Sees one move ahead and misses most tactics. Practise basic captures.' },
  { id: 3, name: 'Club player', rating: 1000, skill: 4, depth: 4, timeMs: 300, blunderChance: 0.15, note: 'Takes free material but still walks into simple forks.' },
  { id: 4, name: 'Intermediate', rating: 1300, skill: 7, depth: 6, timeMs: 400, blunderChance: 0.08, note: 'Punishes obvious mistakes and plays reasonable developing moves.' },
  { id: 5, name: 'Advanced', rating: 1600, skill: 10, depth: 8, timeMs: 500, blunderChance: 0.04, note: 'Finds short tactics and defends accurately. A solid sparring partner.' },
  { id: 6, name: 'Strong', rating: 1900, skill: 13, depth: 10, timeMs: 700, blunderChance: 0.02, note: 'Rarely gives anything away; you need a real plan to win.' },
  { id: 7, name: 'Expert', rating: 2200, skill: 16, depth: 12, timeMs: 900, blunderChance: 0, note: 'Deep, accurate play. Expect long defences and precise endgames.' },
  { id: 8, name: 'Master', rating: 2500, skill: 20, depth: 16, timeMs: 1200, blunderChance: 0, note: 'Full engine strength within a short think time. Hard to beat.' },
];

export const DEFAULT_LEVEL_ID = 4;

export function levelById(id: number): EngineLevel {
  return ENGINE_LEVELS.find((level) => level.id === id) ?? ENGINE_LEVELS[DEFAULT_LEVEL_ID - 1];
}

/** UCI request for the engine's own move at a level. */
export function levelRequest(level: EngineLevel): { depth: number; timeMs: number; skillLevel: number } {
  return { depth: level.depth, timeMs: level.timeMs, skillLevel: level.skill };
}

/** UCI request for coaching (hints, move review): always full strength. */
export function coachRequest(depth = 13, timeMs = 900): { depth: number; timeMs: number; skillLevel: number } {
  return { depth, timeMs, skillLevel: 20 };
}

/** `e2e4q` -> `{ from: 'e2', to: 'e4', promotion: 'q' }`, or null for junk. */
export function parseUciMove(uci: string | null | undefined): { from: string; to: string; promotion?: string } | null {
  if (!uci) return null;
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim().toLowerCase());
  if (!match) return null;
  return { from: match[1], to: match[2], promotion: match[3] };
}

/** Pick one legal UCI move uniformly at random (used for low-level blunders). */
export function randomMove<T extends string>(moves: readonly T[], random: () => number = Math.random): T | null {
  if (!moves.length) return null;
  const index = Math.min(moves.length - 1, Math.max(0, Math.floor(random() * moves.length)));
  return moves[index];
}

/**
 * Convert an engine score into a white-perspective centipawn value for the
 * evaluation bar. `sign` is +1 when the search was from White's side to move.
 */
export function whitePerspective(
  score: { scoreCp: number | null; mate: number | null },
  sign: 1 | -1,
): { cp: number; mate: number | null } {
  if (score.mate !== null && score.mate !== undefined) {
    return { cp: score.mate >= 0 ? 1500 : -1500, mate: score.mate * sign };
  }
  return { cp: (score.scoreCp ?? 0) * sign, mate: null };
}

/** Share of the bar (2–98 %) given to White for a centipawn score. */
export function evalBarPercent(cp: number): number {
  return Math.max(2, Math.min(98, 50 + Math.tanh(cp / 400) * 48));
}

/** Human label for an evaluation, e.g. `+0.65` or `M4`. */
export function evalLabel(cp: number, mate: number | null): string {
  if (mate !== null && mate !== undefined) return `M${Math.abs(mate)}`;
  const pawns = cp / 100;
  return `${pawns > 0 ? '+' : pawns < 0 ? '' : '+'}${pawns.toFixed(2)}`;
}

/** SAN-style description of a UCI move in the given position, for coach text. */
export function describeUci(fen: string, uci: string | null, moveToSan: (fen: string, uci: string) => string | null): string | null {
  if (!uci) return null;
  return moveToSan(fen, uci);
}
