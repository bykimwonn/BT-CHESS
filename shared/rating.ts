/**
 * FIDE rating mathematics, following the FIDE Rating Regulations (Handbook
 * B.02, in force from 1 March 2024, with the 400-point amendment effective
 * 1 October 2025).
 *
 * What the regulations describe, and what is reproduced here:
 *
 *  - K = 40 for a player new to the rating list until they complete 30 games.
 *  - K = 20 while a player's rating remains under 2400.
 *  - K = 10 once a player's published rating has reached 2400, permanently,
 *    even if the rating later falls below 2400.
 *  - K = 40 for a player until the end of the year of their 18th birthday,
 *    as long as their rating stays under 2300.
 *  - A rating difference greater than 400 points counts as 400 points for
 *    players rated below 2650; for players rated 2650 and above the full
 *    difference is used.
 *  - If K × n exceeds 700 for a rating period, K is the largest whole number
 *    such that K × n does not exceed 700.
 *  - The rating change is rounded to the nearest whole number, with .5 away
 *    from zero.
 *  - The minimum published rating is 1400.
 *
 * Two things are deliberately not modelled here: FIDE's monthly list process
 * (this platform rates each game as it finishes, so the "rating period" is the
 * calendar month) and initial ratings from performance (an account starts at
 * the seeded rating below and is then rated game by game). Those are
 * publication mechanics, not the arithmetic of a rating change.
 */

export const FIDE = {
  /** Lowest rating FIDE publishes. */
  floor: 1400,
  /** Rating a new account starts at before its first rated game. */
  seed: 1500,
  maxRating: 4000,
  /** Games needed to leave the "new to the rating list" bracket. */
  gamesForEstablished: 30,
  kNew: 40,
  kStandard: 20,
  kMaster: 10,
  /** Published rating at which K drops to 10 for good. */
  masterThreshold: 2400,
  /** Juniors keep K = 40 only while below this rating. */
  juniorThreshold: 2300,
  juniorAge: 18,
  /** Rating differences above this count as this much (below 2650). */
  maxDifference: 400,
  /** Players at or above this use their full rating difference. */
  fullDifferenceFrom: 2650,
  /** K × games per rating period may not exceed this. */
  maxPeriodProduct: 700,
} as const;

export interface FidePlayerState {
  /** Current rating on the list. */
  rating: number;
  /** Rated games completed so far. */
  ratedGames: number;
  /** Highest rating this player has ever held; defaults to `rating`. */
  peakRating?: number | null;
  /** Year of birth, when known — enables the junior K = 40 rule. */
  birthYear?: number | null;
  /** Games already completed in the current rating period, excluding this one. */
  gamesThisPeriod?: number;
}

/** True while the player is inside the "year of their 18th birthday" window. */
export function isJunior(birthYear: number | null | undefined, now: Date = new Date()): boolean {
  if (!birthYear || !Number.isFinite(birthYear)) return false;
  return now.getUTCFullYear() <= birthYear + FIDE.juniorAge;
}

/**
 * Development coefficient for one game. Precedence follows the regulations:
 * a rating that has ever reached 2400 keeps K = 10; juniors under 2300 use 40;
 * new players use 40 until 30 games; everyone else uses 20.
 */
export function fideKFactor(player: FidePlayerState, now: Date = new Date()): number {
  const rating = Number(player.rating);
  const peak = Math.max(rating, Number(player.peakRating ?? rating));
  if (peak >= FIDE.masterThreshold) return FIDE.kMaster;
  if (rating < FIDE.juniorThreshold && isJunior(player.birthYear, now)) return FIDE.kNew;
  if (Number(player.ratedGames) < FIDE.gamesForEstablished) return FIDE.kNew;
  return FIDE.kStandard;
}

/**
 * The rating difference used for calculation. FIDE scales anything wider than
 * 400 points down to 400 for players below 2650, and uses the true difference
 * for players at 2650 or above.
 */
export function fideRatingDifference(ownRating: number, opponentRating: number): number {
  const raw = Number(opponentRating) - Number(ownRating);
  const magnitude = Math.abs(raw);
  const scaled = Number(ownRating) >= FIDE.fullDifferenceFrom ? magnitude : Math.min(magnitude, FIDE.maxDifference);
  return Math.sign(raw) * scaled;
}

/** Expected score for the player, in [0, 1]. */
export function expectedScore(ownRating: number, opponentRating: number): number {
  const diff = fideRatingDifference(ownRating, opponentRating);
  return 1 / (1 + 10 ** (diff / 400));
}

/** Round to the nearest whole number, .5 away from zero, as FIDE specifies. */
export function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

/**
 * Applies FIDE's K × n ≤ 700 ceiling for a rating period. `n` is the number of
 * games in the period including this one; a player who plays enough games in a
 * month has their K reduced so the total swing stays bounded.
 */
export function fidePeriodK(baseK: number, gamesInPeriod: number): number {
  const n = Math.max(1, Math.trunc(Number(gamesInPeriod) || 1));
  if (baseK * n <= FIDE.maxPeriodProduct) return baseK;
  return Math.max(1, Math.floor(FIDE.maxPeriodProduct / n));
}

export interface FideRatingChange {
  k: number;
  expected: number;
  delta: number;
  ratingAfter: number;
  /** True when the player was held at the 1400 floor. */
  atFloor: boolean;
}

/**
 * One game's rating change for one player.
 *
 * `score` is 1 for a win, 0.5 for a draw and 0 for a loss. The result is the
 * FIDE arithmetic: ΔR = K × (score − expected), rounded as the regulations
 * require, then floored at the minimum published rating.
 */
export function fideRatingChange(
  player: FidePlayerState,
  opponentRating: number,
  score: number,
  now: Date = new Date(),
): FideRatingChange {
  const rating = Number(player.rating);
  const baseK = fideKFactor(player, now);
  const periodGames = player.gamesThisPeriod === undefined
    ? undefined
    : Math.max(1, Math.trunc(player.gamesThisPeriod) + 1);
  const k = periodGames === undefined ? baseK : fidePeriodK(baseK, periodGames);
  const expected = expectedScore(rating, opponentRating);
  const delta = roundHalfAwayFromZero(k * (score - expected));
  const raw = rating + delta;
  const ratingAfter = Math.min(FIDE.maxRating, Math.max(FIDE.floor, raw));
  return { k, expected, delta, ratingAfter, atFloor: ratingAfter === FIDE.floor && raw < FIDE.floor };
}
