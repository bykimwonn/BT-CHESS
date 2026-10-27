import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeUsers } from '../helpers.js';
import { FIDE } from '../../shared/rating.js';

const BLITZ = { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 };

test('a finished free game is rated with FIDE arithmetic and recorded as such', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Rate');
  const before = await harness.db.query('SELECT user_id, rating, games_played FROM profiles WHERE user_id IN ($1,$2)', [whiteId, blackId]);
  for (const row of before.rows) {
    assert.equal(Number(row.rating), FIDE.seed, 'a new account starts on the FIDE seed');
    assert.equal(Number(row.games_played), 0);
  }

  const created = await harness.ctx.games.createGame({ whiteId, blackId, mode: 'free', timeControl: BLITZ });
  await harness.ctx.games.resign(blackId, created.gameId);

  const after = await harness.db.query(
    'SELECT user_id, rating, peak_rating, games_played, wins, losses FROM profiles WHERE user_id IN ($1,$2)',
    [whiteId, blackId],
  );
  const white = after.rows.find((r) => String(r.user_id) === whiteId)!;
  const black = after.rows.find((r) => String(r.user_id) === blackId)!;
  // Both are new to the list, so K = 40 and a win between equals is +20.
  assert.equal(Number(white.rating), FIDE.seed + 20);
  assert.equal(Number(black.rating), FIDE.seed - 20);
  assert.equal(Number(white.peak_rating), FIDE.seed + 20);
  assert.equal(Number(white.games_played), 1);
  assert.equal(Number(white.wins), 1);
  assert.equal(Number(black.losses), 1);

  const history = await harness.db.query(
    'SELECT user_id, rating_before, rating_after, delta, reason FROM rating_history WHERE game_id = $1',
    [created.gameId],
  );
  assert.equal(history.rows.length, 2);
  const whiteHistory = history.rows.find((r) => String(r.user_id) === whiteId)!;
  assert.equal(Number(whiteHistory.rating_before), FIDE.seed);
  assert.equal(Number(whiteHistory.rating_after), FIDE.seed + 20);
  assert.equal(Number(whiteHistory.delta), 20);
  assert.match(String(whiteHistory.reason), /^game:white:k40$/);
});

test('the 1400 floor is enforced in the database and by the rating change', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Floor');
  await harness.db.query('UPDATE profiles SET rating = 1400, peak_rating = 1400 WHERE user_id = $1', [whiteId]);
  await assert.rejects(
    () => harness.db.query('UPDATE profiles SET rating = 1399 WHERE user_id = $1', [whiteId]),
    /profiles_rating_check/,
  );
  const created = await harness.ctx.games.createGame({ whiteId, blackId, mode: 'free', timeControl: BLITZ });
  await harness.ctx.games.resign(whiteId, created.gameId);
  const row = await harness.db.query('SELECT rating, games_played FROM profiles WHERE user_id = $1', [whiteId]);
  assert.equal(Number(row.rows[0].rating), 1400, 'a loss at the floor cannot go below it');
});

test('a player who has played 30 games is rated at K = 20, not K = 40', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Established');
  await harness.db.query(
    'UPDATE profiles SET games_played = 30, wins = 15, losses = 15 WHERE user_id = $1', [whiteId],
  );
  const created = await harness.ctx.games.createGame({ whiteId, blackId, mode: 'free', timeControl: BLITZ });
  await harness.ctx.games.resign(blackId, created.gameId);
  const history = await harness.db.query(
    'SELECT delta, reason FROM rating_history WHERE game_id = $1 AND user_id = $2', [created.gameId, whiteId],
  );
  assert.match(String(history.rows[0].reason), /:k20$/, 'established players use K = 20');
  assert.equal(Number(history.rows[0].delta), 10, 'a win between equals at K = 20 is worth 10');
});
