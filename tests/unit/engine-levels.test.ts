import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEVEL_ID, ENGINE_LEVELS, coachRequest, evalBarPercent, evalLabel, levelById, levelRequest,
  parseUciMove, randomMove, whitePerspective,
} from '../../web/src/features/engine/levels.js';

test('the ladder is ordered, complete and monotonically harder', () => {
  assert.equal(ENGINE_LEVELS.length, 8);
  assert.deepEqual(ENGINE_LEVELS.map((level) => level.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 1; i < ENGINE_LEVELS.length; i++) {
    const previous = ENGINE_LEVELS[i - 1];
    const current = ENGINE_LEVELS[i];
    assert.ok(current.rating > previous.rating, 'rating must rise');
    assert.ok(current.skill > previous.skill, 'skill must rise');
    assert.ok(current.depth > previous.depth, 'depth must rise');
    assert.ok(current.timeMs > previous.timeMs, 'think time must rise');
    assert.ok(current.blunderChance <= previous.blunderChance, 'blunder rate must fall');
    assert.ok(current.name && current.note, 'each level is labelled and explained');
  }
  assert.equal(ENGINE_LEVELS.at(-1)?.skill, 20, 'the top level is full engine strength');
  assert.equal(ENGINE_LEVELS.at(-1)?.blunderChance, 0);
  assert.equal(ENGINE_LEVELS[0].blunderChance > 0.2, true, 'the easiest level must actually be beatable');
});

test('level lookup falls back to the default instead of throwing', () => {
  assert.equal(levelById(1).name, 'Beginner');
  assert.equal(levelById(99).id, DEFAULT_LEVEL_ID);
  assert.equal(levelById(-3).id, DEFAULT_LEVEL_ID);
});

test('practice requests use the level, coaching requests ignore it', () => {
  const beginner = levelById(1);
  assert.deepEqual(levelRequest(beginner), { depth: 1, timeMs: 120, skillLevel: 0 });
  assert.deepEqual(coachRequest(13, 700), { depth: 13, timeMs: 700, skillLevel: 20 });
});

test('UCI moves parse strictly', () => {
  assert.deepEqual(parseUciMove('e2e4'), { from: 'e2', to: 'e4', promotion: undefined });
  assert.deepEqual(parseUciMove('E7E8Q'), { from: 'e7', to: 'e8', promotion: 'q' });
  assert.deepEqual(parseUciMove(' a7a8n '), { from: 'a7', to: 'a8', promotion: 'n' });
  for (const junk of ['', 'e2', 'e2e9', 'z2z4', 'e2e4k', '0000', '(none)', null, undefined]) {
    assert.equal(parseUciMove(junk as string), null, `expected ${String(junk)} to be rejected`);
  }
});

test('random moves stay inside the legal list and respect the RNG bounds', () => {
  const moves = ['e2e4', 'd2d4', 'g1f3'];
  assert.equal(randomMove(moves, () => 0), 'e2e4');
  assert.equal(randomMove(moves, () => 0.999999), 'g1f3');
  assert.equal(randomMove(moves, () => 1), 'g1f3', 'an out-of-range RNG must not return undefined');
  assert.equal(randomMove([], () => 0.5), null);
});

test('evaluations convert to a white-perspective bar', () => {
  // Score from White's search.
  assert.deepEqual(whitePerspective({ scoreCp: 120, mate: null }, 1), { cp: 120, mate: null });
  // Score from Black's search: a +120 for Black is -120 for White.
  assert.deepEqual(whitePerspective({ scoreCp: 120, mate: null }, -1), { cp: -120, mate: null });
  // Mate scores are mirrored too, and pinned to the ends of the bar.
  assert.deepEqual(whitePerspective({ scoreCp: null, mate: 3 }, 1), { cp: 1500, mate: 3 });
  assert.deepEqual(whitePerspective({ scoreCp: null, mate: 3 }, -1), { cp: 1500, mate: -3 });
});

test('the evaluation bar stays inside its 2-98% band', () => {
  assert.equal(evalBarPercent(0), 50);
  assert.ok(evalBarPercent(5000) <= 98);
  assert.ok(evalBarPercent(-5000) >= 2);
  assert.ok(evalBarPercent(200) > 50 && evalBarPercent(200) < 98);
  assert.ok(evalBarPercent(-200) < 50 && evalBarPercent(-200) > 2);
});

test('evaluation labels are human readable', () => {
  assert.equal(evalLabel(0, null), '+0.00');
  assert.equal(evalLabel(65, null), '+0.65');
  assert.equal(evalLabel(-65, null), '-0.65');
  assert.equal(evalLabel(1500, 4), 'M4');
  assert.equal(evalLabel(1500, -4), 'M4');
});
